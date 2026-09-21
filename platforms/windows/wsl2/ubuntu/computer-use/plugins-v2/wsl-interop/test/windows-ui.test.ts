import assert from "node:assert/strict"
import test from "node:test"

import { canonicalSnapshot, normalizeHostItems, parseFindResult, validateWindowsAct, validateWindowsFind } from "../src/windows-ui.ts"

const snapshot = {
  processId: 1234,
  runtimeId: "42.7.1",
  name: "Save",
  automationId: "saveButton",
  controlType: "ControlType.Button",
  className: "Button",
  enabled: true,
  offscreen: false,
  bounds: { x: 10, y: 20, width: 100, height: 30 },
}

test("normalizes PowerShell 5.1 singleton list results", () => {
  const item = { processId: 1234, title: "Settings" }
  assert.deepEqual(normalizeHostItems(item, "Windows app"), [item])
  assert.deepEqual(normalizeHostItems([item], "Windows app"), [item])
  assert.throws(() => normalizeHostItems(null, "Windows app"), /invalid result/u)
})

test("accepts bounded exact Windows UI selectors", () => {
  assert.doesNotThrow(() => validateWindowsFind({
    processId: 1234,
    automationId: "saveButton",
    controlType: "Button",
    maxDepth: 6,
    maxNodes: 500,
    maxResults: 1,
  }))
})

test("rejects missing selectors, invalid bounds, and control separators", () => {
  assert.throws(() => validateWindowsFind({ processId: 1234 }), /selector/u)
  assert.throws(() => validateWindowsFind({ processId: 0, name: "Save" }), /processId/u)
  assert.throws(() => validateWindowsFind({ processId: 1234, name: "Save\nNow" }), /name/u)
  assert.throws(() => validateWindowsFind({ processId: 1234, name: "Save", maxNodes: 2001 }), /maxNodes/u)
})

test("requires setValue data only for the setValue action", () => {
  assert.doesNotThrow(() => validateWindowsAct({ processId: 1234, automationId: "name", action: "setValue", value: "Jane Smith" }))
  assert.throws(() => validateWindowsAct({ processId: 1234, automationId: "name", action: "setValue" }), /requires a value/u)
  assert.throws(() => validateWindowsAct({ processId: 1234, automationId: "save", action: "invoke", value: "unexpected" }), /only/u)
})

test("requires explicit complete discovery and canonical bounded snapshots", () => {
  assert.deepEqual(parseFindResult({ items: [snapshot], visited: 7, truncated: false }), {
    items: [snapshot],
    visited: 7,
    truncated: false,
  })
  assert.throws(() => parseFindResult({ items: [snapshot], visited: 7 }), /truncation/u)
  assert.throws(() => canonicalSnapshot({ ...snapshot, runtimeId: "not-an-id" }), /runtimeId/u)
  assert.throws(() => canonicalSnapshot({ ...snapshot, bounds: { ...snapshot.bounds, width: -1 } }), /width/u)
  assert.throws(() => canonicalSnapshot({ ...snapshot, name: "x".repeat(1_025) }), /unbounded/u)
})
