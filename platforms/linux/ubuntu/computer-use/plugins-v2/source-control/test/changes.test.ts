import assert from "node:assert/strict"
import test from "node:test"

import { leftTruncate, normalizeChanges, statusLetter, visibleChanges } from "../src/changes.ts"

test("normalizes, filters, and sorts working-tree changes", () => {
  assert.deepEqual(
    normalizeChanges([
      { file: "z.ts", additions: 2.9, deletions: -1, status: "modified" },
      { file: "a.ts", additions: 4, deletions: 3, status: "added" },
      { file: "ignored", additions: 1, deletions: 1, status: "renamed" },
      { file: "invalid", additions: 1, deletions: 1 },
    ]),
    [
      { file: "a.ts", additions: 4, deletions: 3, status: "added" },
      { file: "z.ts", additions: 2, deletions: 0, status: "modified" },
    ],
  )
})

test("formats status letters and left-truncates long paths", () => {
  assert.equal(statusLetter("added"), "A")
  assert.equal(statusLetter("deleted"), "D")
  assert.equal(statusLetter("modified"), "M")
  assert.equal(leftTruncate("src/a/very/long/path/file.ts", 11), ".../file.ts")
  assert.deepEqual(
    visibleChanges(
      [
        { file: "a", additions: 0, deletions: 0, status: "modified" },
        { file: "b", additions: 0, deletions: 0, status: "modified" },
      ],
      1,
    ),
    [{ file: "a", additions: 0, deletions: 0, status: "modified" }],
  )
})
