import assert from "node:assert/strict"
import test from "node:test"

import { parseOptions } from "../src/types.ts"

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
