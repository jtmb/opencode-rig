import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_EDIT_BYTES,
  fileNodesFromDirectoryEntries,
  filetypeFor,
  flattenTree,
  isBinaryContent,
  isContained,
  isDirty,
  isProtectedPath,
  nextIndex,
  normalizeRelative,
  normalizeSearchResults,
  parentOf,
  sortEntries,
  tooLargeToEdit,
  visibleChildren,
  type FileNode,
} from "../src/model.ts"

function node(path: string, type: "file" | "directory", ignored = false): FileNode {
  const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path
  return { name, path, type, ignored }
}

test("normalizes relative paths to posix form", () => {
  assert.equal(normalizeRelative("./src/tui.tsx"), "src/tui.tsx")
  assert.equal(normalizeRelative("src\\tui.tsx"), "src/tui.tsx")
  assert.equal(normalizeRelative("src/tui.tsx/"), "src/tui.tsx")
  assert.equal(normalizeRelative(""), "")
})

test("protects .git paths", () => {
  assert.equal(isProtectedPath(".git"), true)
  assert.equal(isProtectedPath(".git/config"), true)
  assert.equal(isProtectedPath("src/.gitignore"), false)
  assert.equal(isProtectedPath("src/git.ts"), false)
})

test("checks containment with path resolution", () => {
  assert.equal(isContained("/project", "/project/src/a.ts"), true)
  assert.equal(isContained("/project", "/project"), true)
  assert.equal(isContained("/project", "/project-other/a.ts"), false)
  assert.equal(isContained("/project", "/tmp/absolute-file.txt"), false)
  assert.equal(isContained("/project", "/project/../secret"), false)
})

test("sorts directories before files and then by name", () => {
  const entries = [node("b.ts", "file"), node("src", "directory"), node("a.ts", "file"), node("assets", "directory")]
  assert.deepEqual(
    sortEntries(entries).map((entry) => entry.path),
    ["assets", "src", "a.ts", "b.ts"],
  )
})

test("adapts bounded PathGuard listings without retaining absolute paths", () => {
  const nodes = fileNodesFromDirectoryEntries([
    { name: "z.ts", relative: "z.ts", type: "file", size: 1, mtimeMs: 1, mode: 0o644 },
    { name: "src", relative: "src", type: "directory", size: 0, mtimeMs: 1, mode: 0o755 },
    { name: "a.ts", relative: "a.ts", type: "file", size: 1, mtimeMs: 1, mode: 0o644 },
  ])
  assert.deepEqual(nodes, [
    { name: "src", path: "src", type: "directory", ignored: false },
    { name: "a.ts", path: "a.ts", type: "file", ignored: false },
    { name: "z.ts", path: "z.ts", type: "file", ignored: false },
  ])
  assert.equal("absolute" in nodes[0], false)
})

test("filters ignored entries unless requested", () => {
  const entries = [node("a.ts", "file"), node("dist", "directory", true)]
  assert.deepEqual(
    visibleChildren(entries).map((entry) => entry.path),
    ["a.ts"],
  )
  assert.deepEqual(
    visibleChildren(entries, true).map((entry) => entry.path),
    ["dist", "a.ts"],
  )
})

test("flattens the tree by expansion state", () => {
  const children = new Map<string, FileNode[]>([
    ["", [node("src", "directory"), node("readme.md", "file")]],
    ["src", [node("src/a.ts", "file"), node("src/nested", "directory")]],
    ["src/nested", [node("src/nested/deep.ts", "file")]],
  ])
  const collapsed = flattenTree(children, new Set())
  assert.deepEqual(
    collapsed.map((row) => [row.node.path, row.depth]),
    [
      ["src", 0],
      ["readme.md", 0],
    ],
  )
  const expanded = flattenTree(children, new Set(["src", "src/nested"]))
  assert.deepEqual(
    expanded.map((row) => [row.node.path, row.depth]),
    [
      ["src", 0],
      ["src/nested", 1],
      ["src/nested/deep.ts", 2],
      ["src/a.ts", 1],
      ["readme.md", 0],
    ],
  )
})

test("maps the approved editor filetype matrix", () => {
  assert.equal(filetypeFor("src/tui.tsx"), "typescriptreact")
  assert.equal(filetypeFor("a/b/c.ts"), "typescript")
  assert.equal(filetypeFor("readme.md"), "markdown")
  assert.equal(filetypeFor("main.zig"), "zig")
  assert.equal(filetypeFor("script.py"), "python")
  assert.equal(filetypeFor("Makefile"), "make")
})

test("detects dirty state, binary content, and oversize files", () => {
  assert.equal(isDirty("a", "a"), false)
  assert.equal(isDirty("a", "b"), true)
  assert.equal(isBinaryContent(new Uint8Array([1, 2, 3])), false)
  assert.equal(isBinaryContent(new Uint8Array([1, 0, 3])), true)
  assert.equal(tooLargeToEdit(MAX_EDIT_BYTES), false)
  assert.equal(tooLargeToEdit(MAX_EDIT_BYTES + 1), true)
})

test("normalizes quick-open results and drops protected paths", () => {
  const results = ["src/a.ts", "./src/a.ts", "../escape.ts", "/tmp/absolute-file.txt", ".git/config", "", "src/b.ts"]
  assert.deepEqual(normalizeSearchResults(results, 10), ["src/a.ts", "src/b.ts"])
  assert.deepEqual(normalizeSearchResults(["a", "b", "c"], 2), ["a", "b"])
})

test("wraps navigation indices", () => {
  assert.equal(nextIndex(0, 3, -1), 2)
  assert.equal(nextIndex(2, 3, 1), 0)
  assert.equal(nextIndex(0, 0, 1), 0)
})

test("finds parent directories", () => {
  assert.equal(parentOf("src/a.ts"), "src")
  assert.equal(parentOf("src"), undefined)
  assert.equal(parentOf("a/b/c.ts"), "a/b")
})
