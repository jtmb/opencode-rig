import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
const cli = JSON.parse(await readFile(new URL("../../../config/v2-cli.example.json", import.meta.url), "utf8"))

test("source control stays before the native footer so working directory remains last", () => {
  assert.match(source, /before: "sidebar\.footer"/)
  assert.doesNotMatch(source, /append: "sidebar\.footer"/)
  assert.match(source, /context\.keymap\.dispatch\("diff\.open"\)/)
  assert.equal(cli.diffs.source, "working")
})

test("change rows are compact one-line previews with fixed semantic counts", () => {
  assert.match(source, /<box\s+flexDirection="row"\s+width="100%"[\s\S]+gap=\{1\}/)
  assert.match(source, /<box flexGrow=\{1\} minWidth=\{0\} flexShrink=\{1\} overflow="hidden">/)
  assert.match(source, /height=\{1\}[\s\S]+overflow="hidden"/)
  assert.match(source, /wrapMode="none"[\s\S]+truncate[\s\S]+\{change\.file\}/)
  assert.match(source, /paddingLeft=\{2\}/)
  assert.match(source, /statusColor\(props\.change\.status, props\.palette\(\)\)/)
  assert.match(source, /fg=\{palette\(\)\.action\}/)
  assert.match(source, /fg=\{props\.palette\(\)\.removal\}/)
  assert.match(source, /<u>\{props\.change\.file\}<\/u>/)
  assert.match(source, /<u>\{props\.label\}<\/u>/)
  assert.match(source, /\+\$\{omitted\(\)\.length\} more files/)
  assert.match(source, /label=\{`\+\$\{omitted\(\)\.length\} more files`\}/)
  assert.match(source, /label="next >"/)
  assert.match(source, /label="< prev"/)
  assert.match(source, /label="close"/)
  assert.match(source, /setMorePage\(0\)/)
})

test("source-control uses a cohesive heading and visibly muted secondary text", () => {
  assert.match(source, /marginTop=\{1\}/)
  assert.match(source, /attributes=\{TextAttributes\.BOLD\}[\s\S]+Source Control/)
  assert.match(source, /fg=\{palette\(\)\.primary\}/)
  assert.match(source, /fg=\{palette\(\)\.sectionCount\}/)
  assert.match(source, /attributes=\{TextAttributes\.DIM\}/)
  assert.doesNotMatch(source.slice(source.indexOf("Source Control"), source.indexOf("<Show when={!collapsed()}>")), /<box flexGrow=\{1\} \/>/)
})
