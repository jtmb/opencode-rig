import assert from "node:assert/strict"
import test from "node:test"

import {
  leftTruncate,
  moreFilesPageSize,
  normalizeChanges,
  pagedChanges,
  sourceControlPage,
  statusLetter,
  visibleChanges,
} from "../src/changes.ts"

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

test("formats status letters and keeps hostile paths on one sanitized line", () => {
  assert.equal(statusLetter("added"), "A")
  assert.equal(statusLetter("deleted"), "D")
  assert.equal(statusLetter("modified"), "M")
  assert.equal(leftTruncate("src/a/very/long/path/file.ts", 11), ".../file.ts")
  assert.equal(normalizeChanges([{ file: "src/long\nname\tfile.ts", additions: 1, deletions: 0, status: "modified" }])[0]?.file, "src/long name file.ts")
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

const changes = Array.from({ length: 10 }, (_, index) => ({
  file: `file-${index}.ts`,
  additions: index,
  deletions: index + 1,
  status: index % 2 === 0 ? "added" as const : "deleted" as const,
}))

test("paginates first, middle, and last pages without rendering an unbounded list", () => {
  assert.deepEqual(pagedChanges(changes, 0, 3).items.map((change) => change.file), ["file-0.ts", "file-1.ts", "file-2.ts"])
  assert.deepEqual(pagedChanges(changes, 1, 3).items.map((change) => change.file), ["file-3.ts", "file-4.ts", "file-5.ts"])
  assert.deepEqual(pagedChanges(changes, 3, 3).items.map((change) => change.file), ["file-9.ts"])
  assert.deepEqual(sourceControlPage(9, 99, 3), { page: 2, pageCount: 3, start: 6, end: 9 })
  assert.deepEqual(sourceControlPage(9, -1, 3), { page: 0, pageCount: 3, start: 0, end: 3 })
})

test("handles exact boundaries, short lists, zero omitted files, and large counts", () => {
  assert.deepEqual(sourceControlPage(6, 1, 3), { page: 1, pageCount: 2, start: 3, end: 6 })
  assert.deepEqual(sourceControlPage(2, 0, 6), { page: 0, pageCount: 1, start: 0, end: 2 })
  assert.deepEqual(pagedChanges([], 4, 6), { items: [], range: { page: 0, pageCount: 0, start: 0, end: 0 } })
  assert.equal("items" in sourceControlPage(100_000, 16_666, 6), false)
  assert.deepEqual(sourceControlPage(100_000, 16_666, 6), { page: 16_666, pageCount: 16_667, start: 99_996, end: 100_000 })
})

test("derives a bounded page size from viewport height and safely shrinks it", () => {
  assert.equal(moreFilesPageSize(60), 6)
  assert.equal(moreFilesPageSize(12), 4)
  assert.equal(moreFilesPageSize(20, 3), 6)
  assert.equal(moreFilesPageSize(12, 3), 1)
  assert.equal(moreFilesPageSize(8), 1)
  assert.equal(moreFilesPageSize(2), 1)
  assert.equal(moreFilesPageSize(Number.NaN), 1)
  assert.equal(sourceControlPage(7, 2, 6).page, 1)
  assert.equal(sourceControlPage(7, 1, 2).page, 1)
})
