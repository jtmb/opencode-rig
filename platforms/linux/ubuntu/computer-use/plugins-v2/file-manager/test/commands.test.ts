import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_EXPLORER_BIND, EXPLORER_SLASH, explorerBinding, explorerCommandNames } from "../src/commands.ts"

test("Explorer exposes all supported slash command names", () => {
  assert.deepEqual(EXPLORER_SLASH, { name: "explorer", aliases: ["editor", "files"] })
  assert.deepEqual(explorerCommandNames(), ["explorer", "editor", "files"])
})

test("Explorer uses the unclaimed default binding and accepts a nonempty override", () => {
  assert.equal(DEFAULT_EXPLORER_BIND, "ctrl+alt+x")
  assert.equal(explorerBinding(undefined), "ctrl+alt+x")
  assert.equal(explorerBinding({ bind: "  ctrl+alt+z  " }), "ctrl+alt+z")
  assert.equal(explorerBinding({ bind: "" }), "ctrl+alt+x")
  assert.equal(explorerBinding({ bind: 7 }), "ctrl+alt+x")
})
