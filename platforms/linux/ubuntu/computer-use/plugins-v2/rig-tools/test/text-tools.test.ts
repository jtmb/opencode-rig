import assert from "node:assert/strict"
import test from "node:test"

import { foldText } from "../src/text-tools.ts"

test("hard-folds bounded text without splitting Unicode code points", () => {
  assert.deepEqual(foldText({ text: "ab😀cd", width: 3, mode: "hard" }), {
    text: "ab😀\ncd",
    width: 3,
    mode: "hard",
    inputBytes: 8,
    outputBytes: 9,
    lines: 2,
    measurement: "unicode-code-points",
  })
})

test("word-folds at bounded whitespace and preserves logical newlines", () => {
  const folded = foldText({ text: "one two three\nfour", width: 7, mode: "word" })
  assert.equal(folded.text, "one\ntwo\nthree\nfour")
  assert.equal(folded.lines, 4)
})

test("rejects invalid widths and oversized inputs", () => {
  assert.throws(() => foldText({ text: "value", width: 0 }), /width/)
  assert.throws(() => foldText({ text: "x".repeat(128 * 1024 + 1) }), /input limit/)
})

test("folds the maximum single-line input without rescanning each remainder", () => {
  const folded = foldText({ text: "x".repeat(128 * 1024), width: 1, mode: "hard" })
  assert.equal(folded.lines, 128 * 1024)
  assert.equal(folded.outputBytes, 256 * 1024 - 1)
})
