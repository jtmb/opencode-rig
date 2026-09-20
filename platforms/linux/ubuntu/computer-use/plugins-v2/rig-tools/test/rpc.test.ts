import assert from "node:assert/strict"
import test from "node:test"

import { RigTools } from "../src/rpc.ts"

test("RPC wire schemas avoid unsupported JSON Schema pattern keywords", () => {
  assert.doesNotMatch(JSON.stringify(RigTools.methods), /"pattern"/)
})
