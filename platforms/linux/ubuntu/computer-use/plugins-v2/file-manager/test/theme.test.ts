import assert from "node:assert/strict"
import test from "node:test"

import { normalizeExplorerTheme } from "../src/theme.ts"

test("normalizes a partial theme before panel colors are read", () => {
  const fallback = normalizeExplorerTheme({})
  assert.ok(fallback.background.surface.offset)
  assert.ok(fallback.text.default)
  assert.equal(fallback.syntax.comment, fallback.text.subdued)

  const partial = normalizeExplorerTheme({
    background: { surface: { offset: "#101820" } },
    hue: { accent: { 200: "#8cc8ff" } },
    text: { default: "#eeeeee" },
  })
  assert.equal(partial.background.surface.offset, "#101820")
  assert.equal(partial.text.default, "#eeeeee")
  assert.equal(partial.text.subdued, "#eeeeee")
})
