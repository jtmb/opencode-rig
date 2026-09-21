import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../src/panel.tsx", import.meta.url), "utf8")

test("the focused panel owns Escape and exposes disabled controls", () => {
  assert.match(source, /useKeyboard\(\(key\) => \{/)
  assert.match(source, /if \(!props\.panel\.focused \|\| key\.name !== "escape"\) return/)
  assert.match(source, /key\.stopPropagation\(\)/)
  assert.match(source, /props\.disabled \? " \(disabled\)" : ""/)
  assert.match(source, /const rpcOptions = \{ location: context\.location \}/)
  assert.match(source, /rpc\.status\([^\n]+, rpcOptions\)/)
})
