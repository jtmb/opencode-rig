import assert from "node:assert/strict"
import test from "node:test"

import {
  createScreenManager,
  inputPayload,
  normalizeScreenIntent,
  parseScreenList,
  type ScreenBackend,
  type ScreenSession,
} from "../src/screen-terminal.ts"

function fakeBackend() {
  const sessions = new Map<string, ScreenSession>([["existing", { pid: 42, name: "existing", state: "Detached" }]])
  const calls: string[] = []
  const backend: ScreenBackend = {
    list: async () => [...sessions.values()],
    capture: async (name) => ({ text: `capture:${name}`, bytes: 16, truncated: false }),
    start: async (intent) => {
      calls.push(`start:${intent.name}`)
      sessions.set(intent.name, { pid: 43, name: intent.name, state: "Detached" })
    },
    input: async (intent) => { calls.push(`input:${intent.kind}`) },
    resize: async (intent) => { calls.push(`resize:${intent.columns}x${intent.rows}`) },
    stop: async (name) => {
      calls.push(`stop:${name}`)
      sessions.delete(name)
    },
  }
  return { backend, sessions, calls }
}

test("parses only bounded valid GNU Screen session records", () => {
  assert.deepEqual(parseScreenList("There is a screen on:\n\t123.demo\t(09/18/2026 07:34:02 PM)\t(Detached)\n\tbad.nope\t(Attached)\n1 Socket\n"), [
    { pid: 123, name: "demo", state: "Detached" },
  ])
})

test("normalizes bounded OpenCode-only terminal intents", () => {
  assert.deepEqual(normalizeScreenIntent({ action: "start", name: "acceptance", directory: "/repo", continue: true }), {
    action: "start",
    name: "acceptance",
    directory: "/repo",
    continue: true,
  })
  assert.deepEqual(normalizeScreenIntent({ action: "input", name: "acceptance", kind: "mouse", x: 4, y: 5 }), {
    action: "input",
    name: "acceptance",
    kind: "mouse",
    x: 4,
    y: 5,
  })
  assert.deepEqual(normalizeScreenIntent({ action: "input", name: "acceptance", kind: "key", key: "ctrl+x,b" }), {
    action: "input",
    name: "acceptance",
    kind: "key",
    key: "ctrl+x,b",
  })
  assert.equal(normalizeScreenIntent({ action: "input", name: "acceptance", kind: "key", key: "pagedown" }).action, "input")
  assert.equal(inputPayload({ action: "input", name: "acceptance", kind: "key", key: "ctrl+a" }), "\u0001")
  assert.equal(inputPayload({ action: "input", name: "acceptance", kind: "key", key: "ctrl+p" }), "\u0010")
  assert.equal(inputPayload({ action: "input", name: "acceptance", kind: "key", key: "ctrl+s" }), "\u0013")
  assert.throws(() => normalizeScreenIntent({ action: "input", name: "acceptance", kind: "text", text: "bad\ntext" }), /printable ASCII/)
  assert.throws(() => normalizeScreenIntent({ action: "resize", name: "acceptance", columns: 999, rows: 24 }), /columns/)
  assert.throws(() => normalizeScreenIntent({ action: "start", name: "bad/name", directory: "/repo" }), /name/)
})

test("supports read-only list and bounded capture without preview tokens", async () => {
  const { backend } = fakeBackend()
  const manager = createScreenManager(backend)
  assert.deepEqual(await manager.invoke({ action: "list" }, "ses", "build"), {
    sessions: [{ pid: 42, name: "existing", state: "Detached" }],
    maximumSessions: 64,
  })
  assert.deepEqual(await manager.invoke({ action: "capture", name: "existing" }, "ses", "build"), {
    name: "existing",
    text: "capture:existing",
    bytes: 16,
    truncated: false,
    untrusted: true,
  })
  await assert.rejects(manager.invoke({ action: "capture", name: "missing" }, "ses", "build"), /not found/)
})

test("previews, binds, applies, and invalidates screen mutations", async () => {
  const { backend, sessions, calls } = fakeBackend()
  let now = 1000
  const manager = createScreenManager(backend, () => now)
  const preview = await manager.invoke({ action: "input", name: "existing", kind: "key", key: "return" }, "ses", "build")
  assert.equal(preview.dryRun, true)
  assert.deepEqual(calls, [])
  const applied = await manager.invoke({
    action: "input",
    name: "existing",
    kind: "key",
    key: "return",
    apply: true,
    expectToken: preview.expectToken,
  }, "ses", "build")
  assert.equal(applied.dryRun, false)
  assert.deepEqual(calls, ["input:key"])

  const stale = await manager.invoke({ action: "resize", name: "existing", columns: 120, rows: 35 }, "ses", "build")
  sessions.set("existing", { pid: 99, name: "existing", state: "Detached" })
  await assert.rejects(manager.invoke({
    action: "resize",
    name: "existing",
    columns: 120,
    rows: 35,
    apply: true,
    expectToken: stale.expectToken,
  }, "ses", "build"), /state changed/)

  const expired = await manager.invoke({ action: "stop", name: "existing" }, "ses", "build")
  now += 60_001
  await assert.rejects(manager.invoke({ action: "stop", name: "existing", apply: true, expectToken: expired.expectToken }, "ses", "build"), /missing or expired/)
})
