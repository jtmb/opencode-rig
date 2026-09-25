import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { providerPalette } from "../src/palette.ts"

test("Provider Usage resolves health colors from active semantic theme roles", () => {
  const palette = providerPalette({
    hue: {
      green: { 200: "theme-green" },
      orange: { 200: "theme-orange" },
      red: { 200: "theme-red" },
      purple: { 200: "theme-purple" },
    },
    text: {
      default: "theme-default",
      subdued: "theme-subdued",
    },
  })
  assert.equal(palette.healthy, "theme-green")
  assert.equal(palette.measurement, "theme-orange")
  assert.equal(palette.critical, "theme-red")
  assert.equal(palette.neutral, "theme-subdued")
})

test("semantic sidebar sources contain no fixed palette literals", async () => {
  const sources = [
    "../src/palette.ts",
    "../../source-control/src/palette.ts",
    "../../rig-tools/src/palette.ts",
    "../../rig-todo/src/palette.ts",
    "../../file-manager/src/theme.ts",
  ]
  for (const relative of sources) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8")
    assert.doesNotMatch(source, /RGBA\.fromHex\(|#[0-9a-fA-F]{3,8}|\brgb\(/, relative)
  }
})
