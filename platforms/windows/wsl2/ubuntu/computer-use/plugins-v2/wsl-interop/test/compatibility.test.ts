import assert from "node:assert/strict"
import test from "node:test"

import { loadCompatibilityPolicy, runtimeCompatibility } from "../src/compatibility.ts"

const policy = await loadCompatibilityPolicy()

test("accepts the minimum and current tested versions", () => {
  assert.equal(runtimeCompatibility("2.0.7", policy).supported, true)
  assert.equal(runtimeCompatibility("2.0.11", policy).supported, true)
  assert.equal(runtimeCompatibility("opencode v2.0.11", policy).supported, true)
})

test("fails closed for old, future, and unrecognized versions", () => {
  assert.equal(runtimeCompatibility("2.0.6", policy).supported, false)
  assert.equal(runtimeCompatibility("2.0.12", policy).supported, false)
  assert.equal(runtimeCompatibility("latest", policy).supported, false)
  assert.equal(runtimeCompatibility("2.1.0-beta.1", policy).supported, false)
})
