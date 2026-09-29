import assert from "node:assert/strict"
import test from "node:test"

import { cellWidth, filetypeFor, safeOneLine, truncateToCellWidth, type FileNode, type TreeRow } from "../src/model.ts"
import { explorerTabPresentation, explorerTreeRowPresentation } from "../src/presentation.ts"

function row(path: string, type: "file" | "directory" = "file", depth = 0): TreeRow {
  const node: FileNode = { name: path.split("/").at(-1) ?? path, path, type, ignored: false }
  return { node, depth, expanded: type === "directory" }
}

test("tree labels are safe, single-line, and bounded by terminal cells", () => {
  const value = "very-long\nname\t東京"
  const display = truncateToCellWidth(value, 12)
  assert.equal(display.includes("\n"), false)
  assert.ok(cellWidth(display) <= 12)
  assert.equal(safeOneLine("a\rb\u0000c"), "a�b�c")
})

test("tree row structure includes a bounded explicit selected marker", () => {
  const selected = explorerTreeRowPresentation(row("src", "directory", 2), "src", 18)
  const unselected = explorerTreeRowPresentation(row("src", "directory", 2), "other", 18)
  assert.equal(selected.marker, "> ")
  assert.equal(selected.branch, "- ")
  assert.equal(selected.status, "")
  assert.equal(selected.selected, true)
  assert.equal(unselected.marker, "  ")
  assert.equal(unselected.selected, false)
  assert.ok(selected.cells <= 18)

  const narrow = explorerTreeRowPresentation(row("deep/東京-long-name.ts", "file", 30), "deep/東京-long-name.ts", 10)
  assert.equal(narrow.marker, "> ")
  assert.ok(narrow.cells <= 10)

  const changed = row("src/changed.ts")
  changed.node.diffStatus = "modified"
  assert.equal(explorerTreeRowPresentation(changed, "", 18).status, "M")
})

test("tab structure contributes visible bounded padding to every hitbox", () => {
  const first = explorerTabPresentation({ path: "README.md", dirty: false })
  const second = explorerTabPresentation({ path: "src/unicode-東京.ts", dirty: true })
  const rendered = `${" ".repeat(first.paddingLeft)}${first.label}${first.dirtyMarker}${" ".repeat(first.paddingRight)}${" ".repeat(second.paddingLeft)}${second.label}${second.dirtyMarker}${" ".repeat(second.paddingRight)}`
  assert.ok(rendered.includes("README.md  unicode-東京.ts"), rendered)
  assert.equal(first.paddingRight + second.paddingLeft, 2)
  assert.equal(first.cells, cellWidth(` ${first.label} `))
  assert.equal(second.cells, cellWidth(` ${second.label}${second.dirtyMarker} `))
})

test("filetype matrix covers the editor's approved extensions", () => {
  const cases: Record<string, string> = {
    "a.js": "javascript", "a.jsx": "javascriptreact", "a.ts": "typescript", "a.tsx": "typescriptreact",
    "a.md": "markdown", "a.zig": "zig", "a.jsonc": "json", "a.yaml": "yaml", "a.toml": "toml",
    "a.sh": "bash", "a.py": "python", "a.go": "go", "a.rs": "rust", "a.sql": "sql", "a.html": "html",
    "a.scss": "scss", "a.xml": "xml", "a.cpp": "cpp", "a.java": "java", "a.rb": "ruby", "a.php": "php",
    "a.lua": "lua", "Dockerfile": "dockerfile", "a.ini": "ini", "a.diff": "diff",
  }
  for (const [file, expected] of Object.entries(cases)) assert.equal(filetypeFor(file), expected, file)
})
