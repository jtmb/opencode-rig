import assert from "node:assert/strict"
import test from "node:test"

import { getTreeSitterClient } from "@opentui/core"

import { BUNDLED_FILETYPES, managedParserAssets, parserAvailability, parserHighlightRangeToUtf16 } from "../src/parsers.ts"

test("preserves bounded UTF-16 highlight offsets by default and in character mode", () => {
  for (const [content, start, end] of [
    ["😀 const value = 1", 3, 8],
    ["東京 😀 const value = 1", 6, 11],
  ] as const) {
    assert.deepEqual(parserHighlightRangeToUtf16(content, start, end), { start, end })
    assert.deepEqual(parserHighlightRangeToUtf16(content, start, end, "characters"), { start, end })
    assert.equal(content.slice(start, end), "const")
  }
})

test("converts explicit UTF-8 byte ranges to UTF-16 offsets", () => {
  const content = "東京 😀 const value"
  const expectedStart = content.indexOf("const")
  const expectedEnd = expectedStart + "const".length
  const encoder = new TextEncoder()
  const start = encoder.encode(content.slice(0, expectedStart)).byteLength
  const end = encoder.encode(content.slice(0, expectedEnd)).byteLength

  assert.deepEqual(parserHighlightRangeToUtf16(content, start, end, "bytes"), {
    start: expectedStart,
    end: expectedEnd,
  })
  assert.equal(content.slice(expectedStart, expectedEnd), "const")
  assert.deepEqual(parserHighlightRangeToUtf16("😀x", 1, 4, "bytes"), { start: 0, end: 2 })
})

test("clamps malformed highlight ranges to finite UTF-16 bounds", () => {
  const content = "😀ab"
  assert.deepEqual(parserHighlightRangeToUtf16(content, -10, 100), { start: 0, end: content.length })
  assert.deepEqual(parserHighlightRangeToUtf16(content, 3.9, 1.2), { start: 3, end: 3 })
  assert.deepEqual(parserHighlightRangeToUtf16(content, Number.NaN, Number.POSITIVE_INFINITY), { start: 0, end: 0 })
  assert.deepEqual(parserHighlightRangeToUtf16(content, Number.NEGATIVE_INFINITY, 2), { start: 0, end: 2 })
  assert.deepEqual(parserHighlightRangeToUtf16(content, -10, Number.MAX_VALUE, "bytes"), { start: 0, end: content.length })
  const invalidBytes = parserHighlightRangeToUtf16(content, Number.NaN, Number.NEGATIVE_INFINITY, "bytes")
  assert.deepEqual(invalidBytes, { start: 0, end: 0 })
  assert.ok(Number.isFinite(invalidBytes.start) && Number.isFinite(invalidBytes.end))
})

test("manifest covers managed languages while OpenTUI languages stay bundled", () => {
  assert.equal(managedParserAssets("/tmp/test-parser-cache").length, 21)
  assert.equal(parserAvailability().get("typescript"), "bundled")
  const unavailable = parserAvailability([{ filetype: "css", registered: false }])
  assert.equal(unavailable.get("scss"), "unavailable")
  assert.ok(BUNDLED_FILETYPES.has("markdown"))
})

test("real tree-sitter worker highlights bundled content when native support is available", async (context) => {
  const client = getTreeSitterClient()
  if (!client.isInitialized()) {
    try {
      await client.initialize()
    } catch (error) {
      context.skip(`OpenTUI tree-sitter worker unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }

  try {
    for (const content of ["😀 const value = 1", "東京 😀 const value = 1"]) {
      const result = await client.highlightOnce(content, "typescript")
      assert.equal(result.error, undefined)
      const keyword = result.highlights?.find(([, , capture]) => capture === "keyword")
      assert.ok(keyword, `expected a keyword capture for ${JSON.stringify(content)}`)
      const [start, end] = keyword
      assert.equal(content.slice(start, end), "const")
      const range = parserHighlightRangeToUtf16(content, start, end)
      assert.equal(content.slice(range.start, range.end), "const")
    }
  } finally {
    await client.destroy()
  }
})
