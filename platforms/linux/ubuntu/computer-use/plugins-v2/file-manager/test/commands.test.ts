import assert from "node:assert/strict"
import test from "node:test"

import { EXPLORER_SLASH, explorerCommandNames } from "../src/commands.ts"

test("Explorer exposes all supported slash command names", () => {
  assert.deepEqual(EXPLORER_SLASH, { name: "explorer", aliases: ["editor", "files"] })
  assert.deepEqual(explorerCommandNames(), ["explorer", "editor", "files"])
})
