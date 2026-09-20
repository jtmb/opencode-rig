import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { formatToolCatalog, RIG_TOOL_CATALOG, RIG_TOOL_NAMES, toolCatalogQuery } from "../src/tool-catalog.ts"

test("catalog names exactly match every registered rig tool", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  const toolSource = source.split("await ctx.command.transform", 1)[0]
  const registered = [...toolSource.matchAll(/editor\.add\(\{\s*\n\s*name: "([a-z_]+)"/g)].map((match) => match[1]).sort()
  assert.deepEqual([...RIG_TOOL_NAMES].sort(), registered)
  assert.equal(new Set(RIG_TOOL_NAMES).size, RIG_TOOL_NAMES.length)
})

test("every catalog entry has valid representative JSON usage", () => {
  for (const entry of RIG_TOOL_CATALOG) {
    assert.doesNotThrow(() => JSON.parse(entry.usage), `${entry.name} usage`)
    if (entry.apply) assert.doesNotThrow(() => JSON.parse(entry.apply!), `${entry.name} apply`)
  }
})

test("formats a bounded complete catalog and searchable subsets", () => {
  const complete = formatToolCatalog()
  for (const name of RIG_TOOL_NAMES) assert.ok(complete.includes(`\`${name}\``))
  assert.ok(Buffer.byteLength(complete) < 32_768)
  const screen = formatToolCatalog("screen")
  assert.match(screen, /screen_terminal/)
  assert.doesNotMatch(screen, /desktop_apps/)
  assert.equal(toolCatalogQuery("/tools runtime"), "runtime")
  assert.equal(toolCatalogQuery("tools"), "")
})
