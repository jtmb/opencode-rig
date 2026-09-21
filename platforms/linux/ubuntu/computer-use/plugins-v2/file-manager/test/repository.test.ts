import assert from "node:assert/strict"
import test from "node:test"

import type { FileDiffInfo } from "@opencode/client"

import type { FileNode, TreeRow } from "../src/model.ts"
import { contentKind, diffSourceLabel, effectiveDiffView, mergeRepositoryNodes, nextRepositoryFile, normalizeDiffFiles, patchHunkRows } from "../src/repository.ts"

const diff = (file: string, status: FileDiffInfo["status"] = "modified"): FileDiffInfo => ({
  file,
  patch: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new`,
  additions: 1,
  deletions: 1,
  status,
})

const node = (path: string, type: FileNode["type"] = "file"): FileNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type,
  ignored: false,
})

test("normalizes safe diff paths and rejects protected paths", () => {
  const files = normalizeDiffFiles([diff("./src/app.ts"), diff(".git/config"), diff("../outside")])
  assert.deepEqual([...files.keys()], ["src/app.ts"])
})

test("merges physical files with virtual changed and deleted paths", () => {
  const diffs = normalizeDiffFiles([diff("README.md"), diff("src/deleted.ts", "deleted"), diff("gone/nested.ts", "deleted")])
  const root = mergeRepositoryNodes("", [node("README.md"), node("src", "directory")], diffs)
  assert.deepEqual(root.map((entry) => [entry.path, entry.type, entry.virtual, entry.diffStatus]), [
    ["gone", "directory", true, undefined],
    ["src", "directory", undefined, undefined],
    ["README.md", "file", undefined, "modified"],
  ])
  assert.deepEqual(mergeRepositoryNodes("src", [], diffs), [{
    name: "deleted.ts",
    path: "src/deleted.ts",
    type: "file",
    ignored: false,
    virtual: true,
    diffStatus: "deleted",
  }])
})

test("navigates visible files and identifies source and diff content", () => {
  const rows: TreeRow[] = [
    { node: node("src", "directory"), depth: 0, expanded: true },
    { node: node("src/a.ts"), depth: 1, expanded: false },
    { node: node("src/b.ts"), depth: 1, expanded: false },
  ]
  const diffs = normalizeDiffFiles([diff("src/b.ts")])
  assert.equal(nextRepositoryFile(rows, "src/a.ts", 1), "src/b.ts")
  assert.equal(nextRepositoryFile(rows, "src/a.ts", -1), "src/b.ts")
  assert.equal(contentKind("src/a.ts", diffs), "source")
  assert.equal(contentKind("src/b.ts", diffs), "diff")
})

test("reports hunk rows and source labels", () => {
  assert.deepEqual(patchHunkRows("header\n@@ -1 +1 @@\na\n@@ -8 +8 @@\nb"), [1, 3])
  assert.equal(diffSourceLabel("working"), "working tree")
  assert.equal(diffSourceLabel("branch"), "main branch")
  assert.equal(diffSourceLabel("last-turn"), "last turn")
})

test("uses full-width unified rendering for one-sided diffs", () => {
  assert.equal(effectiveDiffView("added", "split"), "unified")
  assert.equal(effectiveDiffView("deleted", "split"), "unified")
  assert.equal(effectiveDiffView("modified", "split"), "split")
  assert.equal(effectiveDiffView("modified", "unified"), "unified")
})
