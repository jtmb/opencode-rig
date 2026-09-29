import assert from "node:assert/strict"
import test from "node:test"

import { IntegratedBrowser } from "../src/rpc.ts"

test("publishes the bounded browser RPC surface and changed event", () => {
  assert.doesNotMatch(JSON.stringify(IntegratedBrowser.methods), /"pattern"/)
  assert.deepEqual(Object.keys(IntegratedBrowser.methods), [
    "status", "launch", "close", "navigate", "newTab", "selectTab", "closeTab", "back", "forward", "reload",
    "snapshot", "console", "screenshot", "viewport", "click", "fill",
  ])
  assert.deepEqual(Object.keys(IntegratedBrowser.events), ["changed"])
  const status = IntegratedBrowser.methods.status.output as { properties: Record<string, unknown>; required: readonly string[] }
  assert.deepEqual(status.required, ["sessionID", "state", "tabs", "viewport"])
  assert.equal((status.properties.tabs as { maxItems: number }).maxItems, 12)
  const screenshot = IntegratedBrowser.methods.screenshot.output as { properties: Record<string, unknown> }
  assert.equal((screenshot.properties.mimeType as { type: string }).type, "string")
})
