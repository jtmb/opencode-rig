import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createBasicMemoryRecoveryTool } from "../src/index.ts"

import {
  BASIC_MEMORY_RECOVERY_DEFAULTS,
  BASIC_MEMORY_RECOVERY_READY_STATUS,
  NATIVE_RUNTIME_CLEANUP_DEADLINE_MS,
  NATIVE_RUNTIME_FINGERPRINT_TIMEOUT_MS,
  NATIVE_RUNTIME_TERMINATION_GRACE_MS,
  RecoveryTimeout,
  RuntimeCleanupError,
  RuntimeExecutionError,
  classifyCallerReadNoteResult,
  createCanonicalRuntimeRunner,
  createBasicMemoryRecoveryManager,
  createNativeRuntimeRepair,
  hashPath,
  isRuntimeCleanupError,
  isRuntimeExecutionError,
  nativeStateFingerprints,
  type BasicMemoryRecoveryPolicy,
  type BasicMemoryRecoveryReport,
  type NativeRuntimeRepair,
  type NativeRuntimeRunner,
  type RecoveryRuntimeApi,
} from "../src/basic-memory-recovery.ts"

const DIRECTORY = "/srv/open-rig-clone"

class FakeClock {
  value = 0

  now = () => this.value

  wait = async (milliseconds: number) => {
    this.value += milliseconds
  }
}

function runtime(statuses: string[], clock?: FakeClock): RecoveryRuntimeApi & { reloads: number } {
  let index = 0
  const result = {
    targetDirectory: DIRECTORY,
    locationDirectory: DIRECTORY,
    projectID: "clone-project",
    reloads: 0,
    mcpList: async () => ({ data: [{ name: "basic-memory", status: { status: statuses[Math.min(index++, statuses.length - 1)] ?? "pending" } }] }),
    pluginList: async () => ({ data: [] }),
    reloadMcp: async () => {
      result.reloads += 1
      if (clock) {
        clock.value += 5_000
        throw new RecoveryTimeout("ctx.mcp.reload")
      }
    },
  }
  return result
}

function policy(overrides: Partial<BasicMemoryRecoveryPolicy> = {}): BasicMemoryRecoveryPolicy {
  return {
    ...BASIC_MEMORY_RECOVERY_DEFAULTS,
    ...overrides,
    maxRechecks: overrides.maxRechecks ?? 64,
    deadlineMs: overrides.deadlineMs ?? 90_000,
    retryDelayMs: overrides.retryDelayMs ?? 2_000,
  }
}

function fakeRuntime(verifyResults: boolean[]): NativeRuntimeRepair & { applyCalls: number; previewCalls: number } {
  const result = {
    applyCalls: 0,
    previewCalls: 0,
    verify: async () => verifyResults.shift() ?? false,
    preview: async () => {
      result.previewCalls += 1
      return { target: "canonical-mcp-runtime-marker" as const, profile: "native" as const, policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }
    },
    apply: async () => {
      result.applyCalls += 1
      return "applied" as const
    },
  }
  return result
}

test("already-connected target skips the whole-location MCP collection reload", async () => {
  const api = runtime(["connected"])
  const marker = fakeRuntime([true])
  const manager = createBasicMemoryRecoveryManager(api, marker)

  const result = await manager.recover({ identifier: "safe/health", directory: DIRECTORY }, policy())
  assert.equal(result.status, "connected-awaiting_read_note")
  assert.equal(result.recovered, false)
  assert.equal(result.readNoteProof, "not-verified")
  assert.equal(api.reloads, 0)
})

test("stale marker returns a preview and cannot reload or apply", async () => {
  const api = runtime([])
  const marker = fakeRuntime([false])
  const manager = createBasicMemoryRecoveryManager(api, marker)

  const result = await manager.recover({ identifier: "safe/health", markerAction: "preview", directory: DIRECTORY }, policy())
  assert.equal(result.status, "marker-repair-required")
  assert.ok(result.preview)
  assert.equal(marker.previewCalls, 1)
  assert.equal(marker.applyCalls, 0)
  assert.equal(api.reloads, 0)
})

test("preview completion after the overall deadline cannot continue to status or reconnect", async () => {
  const clock = new FakeClock()
  const api = runtime(["pending"])
  let previewCalls = 0
  const marker: NativeRuntimeRepair = {
    verify: async () => false,
    preview: async () => {
      previewCalls += 1
      clock.value = 30_000
      return { target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }
    },
    apply: async () => "applied",
  }
  const result = await createBasicMemoryRecoveryManager(api, marker, clock.now, clock.wait).recover(
    { identifier: "safe/health", directory: DIRECTORY },
    policy({ deadlineMs: 30_000, maxRechecks: 16 }),
  )

  assert.equal(result.status, "marker-repair-failed")
  assert.equal(result.markerRepair, "preview-timeout")
  assert.equal(previewCalls, 1)
  assert.equal(api.reloads, 0)
})

test("initial runtime cleanup failure is propagated before preview, apply, or reconnect", async () => {
  const api = runtime(["pending"])
  let previewCalls = 0
  let applyCalls = 0
  const cleanup = new RuntimeCleanupError()
  const marker: NativeRuntimeRepair = {
    verify: async () => {
      throw new Error("wrapped runtime cleanup", { cause: cleanup })
    },
    preview: async () => {
      previewCalls += 1
      return { target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }
    },
    apply: async () => {
      applyCalls += 1
      return "applied"
    },
  }
  const manager = createBasicMemoryRecoveryManager(api, marker)

  await assert.rejects(
    manager.recover({ identifier: "safe/health", directory: DIRECTORY }),
    (error: unknown) => error instanceof Error && error.cause === cleanup && isRuntimeCleanupError(error),
  )
  assert.equal(previewCalls, 0)
  assert.equal(applyCalls, 0)
  assert.equal(api.reloads, 0)
})

test("initial runtime execution failure is terminal and cannot become a stale-marker preview", async () => {
  const api = runtime(["pending"])
  let previewCalls = 0
  const marker: NativeRuntimeRepair = {
    verify: async () => {
      throw new RuntimeExecutionError()
    },
    preview: async () => {
      previewCalls += 1
      return { target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }
    },
    apply: async () => "applied",
  }
  const manager = createBasicMemoryRecoveryManager(api, marker)

  await assert.rejects(manager.recover({ identifier: "safe/health", directory: DIRECTORY }), isRuntimeExecutionError)
  assert.equal(previewCalls, 0)
  assert.equal(api.reloads, 0)
})

test("native helper output overflow is terminal before any stale-marker recovery step", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-runtime-output-"))
  const script = join(root, "overflow-runtime.py")
  await writeFile(script, "import sys\nsys.stdout.write('x' * 270000)\nsys.stdout.flush()\n")
  const baseMarker = createNativeRuntimeRepair(
    createCanonicalRuntimeRunner(script),
    async () => ({ policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
  )
  let previewCalls = 0
  let applyCalls = 0
  const marker: NativeRuntimeRepair = {
    boundedSubprocess: baseMarker.boundedSubprocess,
    cleanupGraceMs: baseMarker.cleanupGraceMs,
    verify: baseMarker.verify,
    preview: async () => {
      previewCalls += 1
      return { target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }
    },
    apply: async () => {
      applyCalls += 1
      return "applied"
    },
  }
  const api = runtime(["pending"])

  await assert.rejects(
    createBasicMemoryRecoveryManager(api, marker).recover({ identifier: "safe/health", directory: DIRECTORY }),
    isRuntimeExecutionError,
  )
  assert.equal(previewCalls, 0)
  assert.equal(applyCalls, 0)
  assert.equal(api.reloads, 0)
})

test("cleanup failures during preview, apply, reconnect, and postcheck stop later phases", async () => {
  const previewApi = runtime(["pending"])
  let previewCalls = 0
  const previewMarker: NativeRuntimeRepair = {
    verify: async () => false,
    preview: async () => {
      previewCalls += 1
      throw new RuntimeCleanupError()
    },
    apply: async () => "applied",
  }
  await assert.rejects(
    createBasicMemoryRecoveryManager(previewApi, previewMarker).recover({ identifier: "safe/health", directory: DIRECTORY }),
    isRuntimeCleanupError,
  )
  assert.equal(previewCalls, 1)
  assert.equal(previewApi.reloads, 0)

  const applyApi = runtime(["pending"])
  let applyCalls = 0
  let applyPostcheckCalls = 0
  const applyMarker: NativeRuntimeRepair = {
    verify: async () => {
      applyPostcheckCalls += 1
      return false
    },
    preview: async () => ({ target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    apply: async () => {
      applyCalls += 1
      throw new Error("wrapped apply cleanup", { cause: new RuntimeCleanupError() })
    },
  }
  const applyPreview = await applyMarker.preview()
  await assert.rejects(
    createBasicMemoryRecoveryManager(applyApi, applyMarker).recover({ identifier: "safe/health", directory: DIRECTORY, markerAction: "apply", preview: applyPreview, approval: true }),
    isRuntimeCleanupError,
  )
  assert.equal(applyCalls, 1)
  assert.equal(applyPostcheckCalls, 1)
  assert.equal(applyApi.reloads, 0)

  const reconnectApi = runtime(["pending"])
  let reconnectCalls = 0
  reconnectApi.reloadMcp = async () => {
    reconnectCalls += 1
    throw new Error("wrapped reconnect cleanup", { cause: new RuntimeCleanupError() })
  }
  await assert.rejects(
    createBasicMemoryRecoveryManager(reconnectApi, fakeRuntime([true])).recover({ identifier: "safe/health", directory: DIRECTORY }),
    isRuntimeCleanupError,
  )
  assert.equal(reconnectCalls, 1)
  assert.equal(reconnectApi.reloads, 0)

  const postcheckApi = runtime(["pending"])
  let postcheckCalls = 0
  let postcheckApplyCalls = 0
  const postcheckMarker: NativeRuntimeRepair = {
    verify: async () => {
      postcheckCalls += 1
      if (postcheckCalls === 1) return false
      throw new RuntimeCleanupError()
    },
    preview: async () => ({ target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    apply: async () => {
      postcheckApplyCalls += 1
      return "applied"
    },
  }
  const postcheckPreview = await postcheckMarker.preview()
  await assert.rejects(
    createBasicMemoryRecoveryManager(postcheckApi, postcheckMarker).recover({ identifier: "safe/health", directory: DIRECTORY, markerAction: "apply", preview: postcheckPreview, approval: true }),
    isRuntimeCleanupError,
  )
  assert.equal(postcheckCalls, 2)
  assert.equal(postcheckApplyCalls, 1)
  assert.equal(postcheckApi.reloads, 0)
})

test("explicit apply performs fresh verify, exact canonical apply, and postcheck", async () => {
  const commands: string[][] = []
  const verifyResults = [false, false, true]
  const runner: NativeRuntimeRunner = async (arguments_) => {
    commands.push([...arguments_])
    return verifyResults.shift() ?? true
  }
  const fingerprints = async () => ({ policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) })
  const marker = createNativeRuntimeRepair(runner, fingerprints)
  const preview = await marker.preview()
  const api = runtime(["pending", "connected"])
  const manager = createBasicMemoryRecoveryManager(api, marker)

  const result = await manager.recover({ identifier: "safe/health", directory: DIRECTORY, markerAction: "apply", preview, approval: true }, policy())
  assert.equal(result.status, "connected-awaiting_read_note")
  assert.deepEqual(commands, [
    ["mcp-runtime", "--profile", "native", "--quiet"],
    ["mcp-runtime", "--profile", "native", "--quiet"],
    ["mcp-runtime", "--profile", "native", "--apply", "--quiet"],
    ["mcp-runtime", "--profile", "native", "--quiet"],
  ])
  assert.equal(api.reloads, 1)
})

test("manager refuses readiness when delayed marker apply consumes the overall deadline", async () => {
  const clock = new FakeClock()
  let verifyCalls = 0
  let applyCalls = 0
  const marker: NativeRuntimeRepair = {
    verify: async () => {
      verifyCalls += 1
      clock.value += 4_000
      return false
    },
    preview: async () => ({ target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    apply: async () => {
      applyCalls += 1
      clock.value += 26_000
      return "applied"
    },
  }
  const api = runtime(["connected"])
  const manager = createBasicMemoryRecoveryManager(api, marker, clock.now, clock.wait)
  const preview = await marker.preview()
  const result = await manager.recover(
    { identifier: "safe/health", directory: DIRECTORY, markerAction: "apply", preview, approval: true },
    policy({ deadlineMs: 30_000, maxRechecks: 16 }),
  )
  assert.equal(result.recovered, false)
  assert.equal(result.status, "marker-repair-failed")
  assert.equal(verifyCalls, 1)
  assert.equal(applyCalls, 1)
  assert.equal(api.reloads, 0)
  assert.equal(clock.value, 30_000)
})

test("marker drift rejects explicit apply before canonical write", async () => {
  const commands: string[][] = []
  let state = "b".repeat(64)
  const marker = createNativeRuntimeRepair(
    async (arguments_) => {
      commands.push([...arguments_])
      return false
    },
    async () => ({ policyDigest: "a".repeat(64), stateDigest: state }),
  )
  const preview = await marker.preview()
  state = "c".repeat(64)
  const result = await marker.apply(preview, true, 60_000)
  assert.equal(result, "rejected")
  assert.deepEqual(commands, [])
})

test("native apply shares one deadline between delayed verify and apply", async () => {
  let now = 1_000
  const calls: Array<{ arguments_: string[]; timeoutMs: number }> = []
  const marker = createNativeRuntimeRepair(
    async (arguments_, timeoutMs) => {
      calls.push({ arguments_: [...arguments_], timeoutMs })
      if (arguments_.includes("--apply")) {
        now += 5
        return true
      }
      now += 4
      return false
    },
    async () => ({ policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    () => now,
  )
  const result = await marker.apply(await marker.preview(), true, 10)
  assert.equal(result, "applied")
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.timeoutMs, 10)
  assert.equal(calls[1]?.timeoutMs, 6)
  assert.equal(now, 1_009)
})

test("native apply refuses to launch after verify exhausts its shared deadline", async () => {
  let now = 1_000
  const calls: string[][] = []
  const marker = createNativeRuntimeRepair(
    async (arguments_, timeoutMs) => {
      calls.push([...arguments_])
      now += timeoutMs
      return false
    },
    async () => ({ policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    () => now,
  )
  const result = await marker.apply(await marker.preview(), true, 10)
  assert.equal(result, "rejected")
  assert.deepEqual(calls, [["mcp-runtime", "--profile", "native", "--quiet"]])
  assert.equal(now, 1_010)
})

test("stubborn native helper is SIGKILLed and reaped before manager deadline failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-runtime-"))
  const pidPath = join(root, "pid")
  const appliedPath = join(root, "applied")
  const script = join(root, "stubborn-runtime.py")
  await writeFile(
    script,
    [
      "import os",
      "import signal",
      "import sys",
      "import time",
      `pid_path = ${JSON.stringify(pidPath)}`,
      `applied_path = ${JSON.stringify(appliedPath)}`,
      "with open(pid_path, 'w', encoding='utf-8') as handle:",
      "    handle.write(str(os.getpid()))",
      "    handle.flush()",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "if '--apply' in sys.argv:",
      "    with open(applied_path, 'w', encoding='utf-8') as handle:",
      "        handle.write('applied')",
      "while True:",
      "    time.sleep(0.05)",
      "",
    ].join("\n"),
  )

  const runner = createCanonicalRuntimeRunner(script)
  const baseMarker = createNativeRuntimeRepair(runner, async () => ({ policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }))
  assert.equal(baseMarker.boundedSubprocess, true)
  let reapedAt = 0
  const marker: NativeRuntimeRepair = {
    cleanupGraceMs: baseMarker.cleanupGraceMs,
    verify: async (timeoutMs) => {
      try {
        return await baseMarker.verify(timeoutMs)
      } catch (error) {
        assert.equal(isRuntimeExecutionError(error), true)
        reapedAt = performance.now()
        return false
      }
    },
    preview: async () => ({ target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    apply: async () => "applied",
  }
  const api = runtime(["pending"])
  const wallStart = performance.now()
  const virtualNow = () => (performance.now() - wallStart >= NATIVE_RUNTIME_TERMINATION_GRACE_MS ? 30_001 : 0)
  const manager = createBasicMemoryRecoveryManager(api, marker, virtualNow)
  const result = await manager.recover(
    { identifier: "safe/health", directory: DIRECTORY },
    policy({ deadlineMs: 30_000, operationTimeoutMs: 500 }),
  )
  const reportedAt = performance.now()

  assert.equal(result.status, "marker-verification-timeout")
  assert.equal(result.markerRepair, "verification-timeout")
  assert.ok(reapedAt > 0)
  assert.ok(reportedAt >= reapedAt)
  assert.ok(reportedAt - wallStart >= NATIVE_RUNTIME_TERMINATION_GRACE_MS)
  assert.ok(reportedAt - wallStart < 500 + NATIVE_RUNTIME_CLEANUP_DEADLINE_MS + 1_000)
  const pid = Number((await readFile(pidPath, "utf8")).trim())
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  await assert.rejects(
    readFile(appliedPath, "utf8"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
  )
})

test("bounded runtime capability waits for late child reap instead of racing an outer timer", async () => {
  let reapedAt = 0
  const marker: NativeRuntimeRepair = {
    boundedSubprocess: true,
    verify: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      reapedAt = performance.now()
      return false
    },
    preview: async () => ({ target: "canonical-mcp-runtime-marker", profile: "native", policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }),
    apply: async () => "applied",
  }
  const api = runtime(["pending"])
  const wallStart = performance.now()
  const virtualNow = () => (performance.now() - wallStart >= 20 ? 30_001 : 0)
  const result = await createBasicMemoryRecoveryManager(api, marker, virtualNow).recover(
    { identifier: "safe/health", directory: DIRECTORY },
    policy({ deadlineMs: 30_000, operationTimeoutMs: 5 }),
  )
  const reportedAt = performance.now()

  assert.equal(result.status, "marker-verification-timeout")
  assert.ok(reapedAt > 0)
  assert.ok(reportedAt >= reapedAt)
  assert.equal(api.reloads, 0)
})

test("injected unbounded runtime remains bounded by the manager outer timeout", async () => {
  const runner: NativeRuntimeRunner = async () => new Promise<boolean>(() => {})
  const marker = createNativeRuntimeRepair(runner, async () => ({ policyDigest: "a".repeat(64), stateDigest: "b".repeat(64) }))
  assert.equal(marker.boundedSubprocess, false)
  const api = runtime(["pending"])
  const started = performance.now()
  const result = await createBasicMemoryRecoveryManager(api, marker).recover(
    { identifier: "safe/health", directory: DIRECTORY },
    policy({ operationTimeoutMs: 20 }),
  )

  assert.equal(result.status, "marker-verification-timeout")
  assert.ok(performance.now() - started < 500)
  assert.equal(api.reloads, 0)
})

test("reload timeout is transient, polls past twelve seconds, and never reloads twice", async () => {
  const clock = new FakeClock()
  const api = runtime(["pending", ...Array(14).fill("pending"), "connected"], clock)
  const manager = createBasicMemoryRecoveryManager(api, fakeRuntime([true]), clock.now, clock.wait)

  const result = await manager.recover({ identifier: "safe/health", directory: DIRECTORY }, policy())
  assert.equal(result.status, "connected-awaiting_read_note")
  assert.equal(api.reloads, 1)
  assert.ok(clock.value > 12_000)
  assert.ok(clock.value < 90_000)
})

test("polling reaches the finite deadline without another reload", async () => {
  const clock = new FakeClock()
  const api = runtime(Array(40).fill("pending"), clock)
  const manager = createBasicMemoryRecoveryManager(api, fakeRuntime([true]), clock.now, clock.wait)

  const result = await manager.recover({ identifier: "safe/health", directory: DIRECTORY }, policy({ deadlineMs: 30_000, maxRechecks: 16 }))
  assert.equal(result.recovered, false)
  assert.equal(result.readNoteProof, "not-verified")
  assert.equal(api.reloads, 1)
  assert.ok(clock.value <= 30_000)
})

test("location mismatch and wrong server fail closed before reload", async () => {
  const mismatchApi = runtime(["pending"])
  mismatchApi.locationDirectory = "/srv/primary"
  const mismatch = await createBasicMemoryRecoveryManager(mismatchApi, fakeRuntime([true])).recover({ identifier: "safe/health", directory: DIRECTORY }, policy())
  assert.equal(mismatch.status, "target-location-mismatch")
  assert.equal(mismatchApi.reloads, 0)

  const wrongApi = runtime(["pending"])
  wrongApi.mcpList = async () => ({ data: [{ name: "other", status: { status: "pending" } }] })
  const wrong = await createBasicMemoryRecoveryManager(wrongApi, fakeRuntime([true])).recover({ identifier: "safe/health", directory: DIRECTORY }, policy())
  assert.equal(wrong.status, "missing")
  assert.equal(wrongApi.reloads, 0)
})

test("diagnostics bound independent MCP and plugin calls without treating status as proof", async () => {
  for (const stalled of ["mcp", "plugins"] as const) {
    const api: RecoveryRuntimeApi = {
      targetDirectory: DIRECTORY,
      locationDirectory: DIRECTORY,
      mcpList: stalled === "mcp" ? () => new Promise<never>(() => {}) : async () => ({ data: [] }),
      pluginList: stalled === "plugins" ? () => new Promise<never>(() => {}) : async () => ({ data: [] }),
    }
    const manager = createBasicMemoryRecoveryManager(api, fakeRuntime([true]))
    const started = performance.now()
    const result = await manager.diagnose({ operationTimeoutMs: 10 })
    assert.ok(performance.now() - started < 1_000)
    assert.equal(result.mcp.status, stalled === "mcp" ? "unavailable" : "ok")
    assert.equal(result.plugins.status, stalled === "plugins" ? "unavailable" : "ok")
    assert.equal(JSON.stringify(result).includes("readNoteProof"), false)
    assert.equal(JSON.stringify(result).includes("authenticated"), false)
  }
})

test("structured caller result is advisory and arbitrary text or booleans are rejected", () => {
  assert.equal(classifyCallerReadNoteResult("body", "safe/health"), "malformed-or-unmatched")
  assert.equal(classifyCallerReadNoteResult(true, "safe/health"), "malformed-or-unmatched")
  assert.equal(
    classifyCallerReadNoteResult(
      { content: [{ type: "text", text: "caller result" }], structuredContent: { note: { identifier: "safe/health", content: "caller result" } } },
      "safe/health",
    ),
    "structured-identity-match-unproven",
  )
})

test("recovery source has no duplicate Basic Memory transport or tool call", async () => {
  const source = await readFile(new URL("../src/basic-memory-recovery.ts", import.meta.url), "utf8")
  assert.equal(source.includes("StdioClientTransport"), false)
  assert.equal(source.includes("basic-memory-mcp.sh"), false)
  assert.equal(source.includes("callTool"), false)
  assert.equal(source.includes("spawn("), false)
  assert.equal(source.includes("recovered: true"), false)
  assert.equal(source.includes("readdir"), false)
  assert.equal(source.includes("readFile("), false)
})

test("recovery binds only the documented collection reload API", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(source, /reloadMcp: \(\) => ctx\.mcp\.reload\(\)/)
  assert.equal(source.includes("ctx.mcp.connect"), false)
})

test("native fingerprints read only bounded marker/config inputs and exclude DB/log/WAL files", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-recovery-") )
  const configDirectory = join(root, "basic-memory", "config")
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(root, "provisioned.json"), "marker")
  await writeFile(join(configDirectory, "config.json"), '{"projects":{}}')
  const previous = process.env.OPENCODE_MCP_NATIVE_ROOT
  process.env.OPENCODE_MCP_NATIVE_ROOT = root
  try {
    const before = await nativeStateFingerprints()
    await writeFile(join(configDirectory, "memory.db"), "private")
    await writeFile(join(configDirectory, "config.log"), "private")
    await writeFile(join(configDirectory, "config.json-wal"), "private")
    const after = await nativeStateFingerprints()
    assert.deepEqual(after, before)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MCP_NATIVE_ROOT
    else process.env.OPENCODE_MCP_NATIVE_ROOT = previous
  }
})

test("native fingerprints fail before reading symlinked or oversized approved inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-recovery-") )
  const configDirectory = join(root, "basic-memory", "config")
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(root, "provisioned.json"), "marker")
  const previous = process.env.OPENCODE_MCP_NATIVE_ROOT
  process.env.OPENCODE_MCP_NATIVE_ROOT = root
  try {
    const outside = join(root, "outside.json")
    await writeFile(outside, '{"projects":{}}')
    await symlink(outside, join(configDirectory, "config.json"))
    await assert.rejects(nativeStateFingerprints(), /symlink/)
    await unlink(join(configDirectory, "config.json"))
    await writeFile(join(configDirectory, "config.json"), Buffer.alloc(4 * 1024 * 1024 + 1))
    await assert.rejects(nativeStateFingerprints(), /bounded size/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MCP_NATIVE_ROOT
    else process.env.OPENCODE_MCP_NATIVE_ROOT = previous
  }
})

test("hashPath treats only ENOENT as a missing approved input", async () => {
  const digest = () => createHash("sha256")
  await hashPath(digest(), "/missing", "fixture", { remaining: 100 }, async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" })
  })

  for (const code of ["EACCES", "EIO"]) {
    await assert.rejects(
      hashPath(digest(), "/unreadable", "fixture", { remaining: 100 }, async () => {
        throw Object.assign(new Error(code), { code })
      }),
      /could not be inspected safely/,
    )
  }
})

test("fingerprint timeout fails closed before canonical marker verification or apply", async () => {
  let runnerCalls = 0
  const marker = createNativeRuntimeRepair(
    async () => {
      runnerCalls += 1
      return true
    },
    () => new Promise<{ policyDigest: string; stateDigest: string }>(() => {}),
    () => performance.now(),
    10,
  )
  const preview = {
    target: "canonical-mcp-runtime-marker" as const,
    profile: "native" as const,
    policyDigest: "a".repeat(64),
    stateDigest: "b".repeat(64),
  }

  assert.equal(NATIVE_RUNTIME_FINGERPRINT_TIMEOUT_MS, 5_000)
  await assert.rejects(marker.preview(), RecoveryTimeout)
  await assert.rejects(marker.apply(preview, true, 100), RecoveryTimeout)
  assert.equal(runnerCalls, 0)
})

test("registered manager output remains unverified even when marker and status are healthy", async () => {
  const api = runtime(["connected"])
  const result: BasicMemoryRecoveryReport = await createBasicMemoryRecoveryManager(api, fakeRuntime([true])).recover({ identifier: "safe/health", directory: DIRECTORY }, policy())
  assert.equal(result.status, "connected-awaiting_read_note")
  assert.equal(result.recovered, false)
  assert.equal(JSON.stringify(result).includes('"readNoteProof":"verified"'), false)
})

test("actual registered tool factory forwards the supported schema to the manager", async () => {
  let received: unknown
  const tool = createBasicMemoryRecoveryTool({
    recover: async (input) => {
      received = input
      return { recovered: false, status: "connected-awaiting_read_note", readNoteProof: "not-verified" }
    },
  })
  const schema = tool.input as { properties: Record<string, unknown> }
  assert.ok(schema.properties.directory)
  assert.ok(schema.properties.markerAction)
  assert.ok(schema.properties.preview)
  assert.ok(schema.properties.approval)
  const input = { identifier: "safe/health", directory: DIRECTORY, markerAction: "preview" as const }
  const response = await tool.execute(input)
  assert.deepEqual(received, input)
  assert.match(response.content, /connected-awaiting_read_note/)
  const indexSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(indexSource, /editor\.add\(createBasicMemoryRecoveryTool\(basicMemoryRecovery\)\)/)
})

test("Python and TypeScript expose the exact canonical readiness status", async () => {
  const pythonSource = await readFile(new URL("../../../scripts/opencode-recovery.py", import.meta.url), "utf8")
  assert.equal(BASIC_MEMORY_RECOVERY_READY_STATUS, "connected-awaiting_read_note")
  assert.match(pythonSource, /READINESS_STATUS = "connected-awaiting_read_note"/)
})
