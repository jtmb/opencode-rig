import assert from "node:assert/strict"
import test from "node:test"

import { beginGeneration, invalidateGeneration, isCurrentGeneration } from "../src/generation.ts"

test("only the newest request generation can publish", () => {
  const generations = new Map<string, number>()
  const first = beginGeneration(generations, "search")
  const second = beginGeneration(generations, "search")

  assert.equal(isCurrentGeneration(generations, first), false)
  assert.equal(isCurrentGeneration(generations, second), true)
})

test("invalidating a key rejects an in-flight result", () => {
  const generations = new Map<string, number>()
  const request = beginGeneration(generations, "highlight")
  invalidateGeneration(generations, "highlight")
  assert.equal(isCurrentGeneration(generations, request), false)
})
