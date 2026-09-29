import assert from "node:assert/strict"
import test from "node:test"

import { RigTools } from "../src/rpc.ts"

test("RPC wire schemas avoid unsupported JSON Schema pattern keywords", () => {
  assert.doesNotMatch(JSON.stringify(RigTools.methods), /"pattern"/)
})

test("managed Screen RPC exposes only bounded name/state rows, never PIDs", () => {
  const method = JSON.stringify(RigTools.methods.managedScreens)
  assert.match(method, /"maxItems":8/u)
  assert.match(method, /"name"/u)
  assert.match(method, /"state"/u)
  assert.doesNotMatch(method, /\bpid\b/iu)
})
