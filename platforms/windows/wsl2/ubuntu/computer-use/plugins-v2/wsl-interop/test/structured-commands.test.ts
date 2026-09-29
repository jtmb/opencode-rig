import assert from "node:assert/strict"
import test from "node:test"

import { structuredParams, validateStructuredInput } from "../src/structured-commands.ts"

test("creates data-only bounded JSON-RPC parameters without script construction", () => {
  assert.deepEqual(structuredParams({ operation: "processes", name: "explorer'; Remove-Item C:\\ -Recurse #", maxItems: 5 }), {
    name: "explorer'; Remove-Item C:\\ -Recurse #",
    maxItems: 5,
  })
  assert.deepEqual(structuredParams({ operation: "services", maxItems: 10 }), { maxItems: 10 })
})

test("requires an absolute Windows path", () => {
  assert.throws(() => validateStructuredInput({ operation: "path", path: "relative.txt" }), /absolute/u)
  assert.doesNotThrow(() => validateStructuredInput({ operation: "path", path: "C:\\Users\\alice\\file.txt" }))
  assert.throws(() => validateStructuredInput({ operation: "path", path: "\\\\server\\share\\file.txt" }), /UNC/u)
})

test("rejects path parameters for unrelated operations and unbounded item counts", () => {
  assert.throws(() => validateStructuredInput({ operation: "processes", path: "C:\\Windows" }), /only/u)
  assert.throws(() => validateStructuredInput({ operation: "services", maxItems: 201 }), /maxItems/u)
})
