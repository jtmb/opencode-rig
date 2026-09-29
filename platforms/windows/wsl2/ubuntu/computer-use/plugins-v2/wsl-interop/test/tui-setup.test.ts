import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

import * as compatibility from "../src/compatibility.ts"

const sourceURL = new URL("../src/tui.tsx", import.meta.url)
const require = createRequire(sourceURL)
const source = ts.transpileModule(await readFile(sourceURL, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  fileName: sourceURL.pathname,
}).outputText
const policy = await compatibility.loadCompatibilityPolicy()
const configured = {
  enabled: true,
  refreshMs: 5_000,
  powershell: { preferred: "auto", timeoutMs: 10_000, maxOutputBytes: 262_144 },
  raw: { enabled: true, tokenTtlMs: 60_000, maxScriptBytes: 65_536, maxTokens: 128 },
}

function harness(options: Record<string, unknown>) {
  const slots: string[] = []
  const removed: string[] = []
  const intervals: number[] = []
  const cleared: number[] = []
  const calls: unknown[] = []
  const location = { directory: "/fixture/wsl-project" }
  const exports = {} as { default: { setup(context: unknown): Promise<() => void> } }
  // Node cannot load OpenTUI's Bun runtime; this checks setup, not JSX rendering.
  runInNewContext(source, {
    exports,
    require(id: string) {
      if (id === "@opencode/plugin/tui") return { Plugin: { define: (plugin: unknown) => plugin } }
      if (id === "@opentui/solid/jsx-runtime") return { jsx: () => assert.fail("unexpected JSX render"), jsxs: () => assert.fail("unexpected JSX render") }
      if (id === "./compatibility.ts") return compatibility
      if (id === "./rpc.ts") return { WslInteropRpc: {} }
      return require(id)
    },
    setInterval(_callback: () => void, delay: number) { intervals.push(delay); return 1 },
    clearInterval(id: number) { cleared.push(id) },
  }, { filename: sourceURL.pathname })
  const context = {
    ...options,
    app: { version: policy.maximumTestedOpenCode },
    location,
    client: { rpc: () => ({ status: async (...args: unknown[]) => {
      calls.push(args)
      return { text: JSON.stringify({ wsl: { isWsl: false } }) }
    } }) },
    ui: {
      slot(input: { after?: string; append?: string }) {
        const target = input.after ?? input.append!
        slots.push(target)
        return () => { removed.push(target) }
      },
      toast: { show: () => assert.fail("supported setup must not emit a warning") },
    },
  }
  return { setup: () => exports.default.setup(context), slots, removed, intervals, cleared, calls, location }
}

for (const [name, options] of [
  ["omitted options", {}],
  ["empty options from CLI discovery", { options: {} }],
  ["explicit CLI options", { options: configured }],
] as const) {
  test(`CLI setup registers status UI with ${name}`, async () => {
    const host = harness(options)
    const cleanup = await host.setup()
    try {
      assert.deepEqual(host.slots, ["sidebar.content", "app"])
      assert.deepEqual(host.intervals, [5_000])
      assert.equal(host.calls.length, 1)
      assert.equal(JSON.stringify(host.calls[0]), JSON.stringify([{}, { location: host.location }]))
    } finally {
      cleanup()
    }
    assert.deepEqual(host.removed, host.slots)
    assert.deepEqual(host.cleared, [1])
  })
}

test("explicitly disabled CLI options register no UI, RPC calls, or timer", async () => {
  const host = harness({ options: { ...configured, enabled: false } })
  const cleanup = await host.setup()
  cleanup()
  assert.deepEqual([host.slots, host.calls, host.intervals, host.cleared], [[], [], [], []])
})

for (const options of [null, [], { ...configured, enabled: "yes" }, { ...configured, refreshMs: 0 }]) {
  test(`malformed CLI options fail before registration: ${JSON.stringify(options)}`, async () => {
    const host = harness({ options })
    await assert.rejects(host.setup())
    assert.deepEqual([host.slots, host.calls, host.intervals], [[], [], []])
  })
}
