import assert from "node:assert/strict"
import test from "node:test"

import { parseOptions, parseTuiOptions } from "../src/types.ts"

const options = {
  enabled: true,
  refreshMs: 5_000,
  powershell: {
    preferred: "auto",
    timeoutMs: 10_000,
    maxOutputBytes: 262_144,
  },
  raw: {
    enabled: true,
    tokenTtlMs: 60_000,
    maxScriptBytes: 65_536,
    maxTokens: 128,
  },
}

test("accepts only a complete strict option object", () => {
  assert.deepEqual(parseOptions(options), options)
  assert.equal(parseOptions({ ...options, enabled: false }).enabled, false)
})

test("rejects missing, malformed, out-of-range, and unknown options", () => {
  assert.throws(() => parseOptions(undefined), /must be an object/u)
  assert.throws(() => parseOptions({ ...options, enabled: "yes" }), /enabled/u)
  assert.throws(() => parseOptions({ ...options, refreshMs: 100 }), /refreshMs/u)
  assert.throws(() => parseOptions({ ...options, unexpected: true }), /unsupported/u)
  assert.throws(() => parseOptions({ ...options, raw: { ...options.raw, maxTokens: 0 } }), /maxTokens/u)
})

test("defaults absent CLI options to read-only TUI status settings", () => {
  const expected = { enabled: true, refreshMs: 5_000 }
  assert.throws(() => parseOptions({}), /options\.enabled is required/u)
  assert.deepEqual(parseTuiOptions(undefined), expected)
  assert.deepEqual(parseTuiOptions({}), expected)
  assert.deepEqual(parseTuiOptions({ enabled: false }), { ...expected, enabled: false })
})

test("validates supplied TUI options and returns no server capabilities", () => {
  assert.deepEqual(parseTuiOptions({ enabled: true, refreshMs: 10_000 }), { enabled: true, refreshMs: 10_000 })
  assert.deepEqual(parseTuiOptions({ ...options, raw: { ...options.raw, enabled: false } }), { enabled: true, refreshMs: 5_000 })
  assert.throws(() => parseTuiOptions({ enabled: "yes" }), /options.enabled/u)
  assert.throws(() => parseTuiOptions({ enabled: false, refreshMs: 100 }), /refreshMs/u)
  assert.throws(() => parseTuiOptions({ unexpected: true }), /unsupported/u)
  assert.throws(() => parseTuiOptions(null), /must be an object/u)
  assert.throws(() => parseTuiOptions({ ...options, raw: { ...options.raw, enabled: false, maxTokens: 0 } }), /maxTokens/u)
})
