import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
const cli = JSON.parse(await readFile(new URL("../../../config/v2-cli.example.json", import.meta.url), "utf8"))

test("source control coexists with plugins that replace sidebar content", () => {
  assert.match(source, /append: "sidebar\.footer"/)
  assert.match(source, /context\.keymap\.dispatch\("diff\.open"\)/)
  assert.equal(cli.diffs.source, "working")
})
