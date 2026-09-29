import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8")

test("Explorer opens fullscreen and renders repository source and VCS diffs", () => {
  assert.match(source, /presentation: "fullscreen"/)
  assert.match(source, /context\.client\.vcs\.diff/)
  assert.match(source, /context\.client\.session\.diff/)
  assert.match(source, /<diff/)
  assert.match(source, /\[Diff: \{headerDiffView\(\)/)
  assert.match(source, /effectiveDiffView\(changed/)
  assert.match(source, /<code content=\{current\(\)\.content\}/)
})

test("Explorer exposes native-style review controls without replacing guarded editing", () => {
  for (const label of ["next/previous file", "next/previous hunk", "all/selected changes", "split/unified", "mark reviewed"]) {
    assert.match(source, new RegExp(label.replace("/", "\\/")))
  }
  assert.match(source, /setMode\("edit"\)/)
  assert.match(source, /void saveAll\(\)/)
  assert.match(source, /void openExternal\(\)/)
})
