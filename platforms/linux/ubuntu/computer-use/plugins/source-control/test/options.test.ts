import assert from "node:assert/strict"
import test from "node:test"
import type { TuiKV } from "@opencode-ai/plugin/tui"

import { applyRepositionDefault, KEYS, pluginOptions, readRegistrationOrder, readRuntimeOptions } from "../src/options.ts"

function memoryKv(initial: Record<string, unknown> = {}, ready = true): TuiKV & { values: Map<string, unknown> } {
  const values = new Map(Object.entries(initial))
  return {
    ready,
    values,
    get: <Value = unknown>(key: string, fallback?: Value) =>
      values.has(key) ? (values.get(key) as Value) : (fallback as Value),
    set: (key: string, value: unknown) => {
      values.set(key, value)
    },
  }
}

test("normalizes registration options and ignores invalid values", () => {
  const parsed = pluginOptions({
    refreshMs: 20_000,
    githubRefreshMs: 60_000,
    maxFiles: 4,
    startCollapsed: false,
    whenEmpty: "show",
    github: false,
    remoteName: " upstream ",
    unknown: true,
  })
  assert.deepEqual(parsed, {
    refreshMs: 20_000,
    githubRefreshMs: 60_000,
    maxFiles: 4,
    startCollapsed: false,
    whenEmpty: "show",
    github: false,
    remoteName: "upstream",
  })
  assert.deepEqual(pluginOptions({ refreshMs: "fast", whenEmpty: "sometimes" }), {})
  assert.deepEqual(pluginOptions(null), {})
})

test("runtime options use defaults and clamp registration values", () => {
  const kv = memoryKv()
  const runtime = readRuntimeOptions(kv, {})
  assert.equal(runtime.refreshMs, 15_000)
  assert.equal(runtime.githubRefreshMs, 120_000)
  assert.equal(runtime.maxFiles, 8)
  assert.equal(runtime.startCollapsed, true)

  const clamped = readRuntimeOptions(kv, { refreshMs: 100, githubRefreshMs: 100, maxFiles: 0 })
  assert.equal(clamped.refreshMs, 5_000)
  assert.equal(clamped.githubRefreshMs, 30_000)
  assert.equal(clamped.maxFiles, 1)
})

test("runtime options re-read live kv overrides", () => {
  const kv = memoryKv({
    [KEYS.refreshMs]: 9_000,
    [KEYS.githubRefreshMs]: 45_000,
    [KEYS.maxFiles]: 3,
    [KEYS.startCollapsed]: false,
  })
  const runtime = readRuntimeOptions(kv, { refreshMs: 10_000, maxFiles: 5, startCollapsed: true })
  assert.equal(runtime.refreshMs, 9_000)
  assert.equal(runtime.githubRefreshMs, 45_000)
  assert.equal(runtime.maxFiles, 3)
  assert.equal(runtime.startCollapsed, false)

  kv.set(KEYS.maxFiles, "many")
  assert.equal(readRuntimeOptions(kv, {}).maxFiles, 8)
})

test("reposition migration minimizes the panel once", () => {
  const kv = memoryKv({ [KEYS.collapsed]: false })
  assert.equal(applyRepositionDefault(kv), true)
  assert.equal(kv.values.get(KEYS.collapsed), true)
  assert.equal(kv.values.get(KEYS.repositioned), true)
  assert.equal(applyRepositionDefault(kv), false)
  assert.equal(kv.values.get(KEYS.collapsed), true)

  const notReady = memoryKv({}, false)
  assert.equal(applyRepositionDefault(notReady), false)
  assert.equal(notReady.values.has(KEYS.collapsed), false)
})

test("reads the sidebar order override with clamping", () => {
  assert.equal(readRegistrationOrder(memoryKv()), 50)
  assert.equal(readRegistrationOrder(memoryKv({ [KEYS.order]: 450 })), 450)
  assert.equal(readRegistrationOrder(memoryKv({ [KEYS.order]: 0 })), 1)
  assert.equal(readRegistrationOrder(memoryKv({ [KEYS.order]: 1200 })), 999)
  assert.equal(readRegistrationOrder(memoryKv({ [KEYS.order]: "top" })), 50)
})
