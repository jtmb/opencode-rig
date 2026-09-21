import assert from "node:assert/strict"
import test from "node:test"

import { consoleLines, parseViewport, sanitizePanelText, statusLine } from "../src/panel-model.ts"

test("sanitizes bounded untrusted panel text", () => {
  assert.equal(sanitizePanelText("hello\u0000\u001b[31mworld", 8), "hello  [")
  assert.equal(sanitizePanelText(undefined, 20), "")
})

test("parses and bounds viewport controls", () => {
  assert.deepEqual(parseViewport(" 800 x 600 "), { width: 800, height: 600 })
  assert.throws(() => parseViewport("800"), /WIDTHxHEIGHT/)
  assert.throws(() => parseViewport("100x100"), /between 320x240/)
})

test("formats status and console output without exceeding display bounds", () => {
  assert.equal(statusLine({ sessionID: "ses_one", state: "ready", tabs: [{ id: "tab-1", url: "https://example.test/", title: "Example", loading: false }], currentTabID: "tab-1", viewport: { width: 800, height: 600 } }), "ready · 1 tab · tab-1 · viewport 800x600")
  assert.equal(consoleLines([], 100), "No console messages captured.")
  assert.equal(consoleLines([{ type: "error", text: "bad\u0000" }], 100), "[error] bad ")
})
