import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_EXPLORER_BIND, EXPLORER_SLASH, explorerBinding, explorerCommandNames } from "../src/commands.ts"

test("Explorer leaves the native /editor command unclaimed", () => {
  assert.deepEqual(EXPLORER_SLASH, { name: "explorer", aliases: ["files"] })
  assert.deepEqual(explorerCommandNames(), ["explorer", "files"])
})

test("Explorer uses the unclaimed default binding and accepts a nonempty override", () => {
  assert.equal(DEFAULT_EXPLORER_BIND, "ctrl+alt+x")
  assert.equal(explorerBinding(undefined), "ctrl+alt+x")
  assert.equal(explorerBinding({ bind: "  ctrl+alt+z  " }), "ctrl+alt+z")
  assert.equal(explorerBinding({ bind: "" }), "ctrl+alt+x")
  assert.equal(explorerBinding({ bind: 7 }), "ctrl+alt+x")
})
