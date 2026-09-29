import assert from "node:assert/strict"
import test from "node:test"

import { executeGitDiff, filterDiffFiles, parseGitDiffInput, renderDiff } from "../src/diff.ts"

const file = (path: string, patch: string) => ({ file: path, patch, additions: 1, deletions: 1, status: "modified" as const })

test("parses bounded defaults and rejects unsupported or unsafe input", () => {
  assert.deepEqual(parseGitDiffInput({}), { mode: "working", context: 3, maxBytes: 120_000 })
  assert.deepEqual(parseGitDiffInput({ mode: "branch", base: "main", context: 0, path: "src/app.ts", maxBytes: 1024 }), {
    mode: "branch",
    base: "main",
    context: 0,
    path: "src/app.ts",
    maxBytes: 1024,
  })
  for (const input of [
    { nope: true },
    { mode: "other" },
    { base: "main..HEAD" },
    { base: "--output" },
    { path: "/etc/passwd" },
    { path: "../secret" },
    { path: "src\\app.ts" },
    { path: "src/\napp.ts" },
    { context: 21 },
    { maxBytes: 250_001 },
  ]) assert.throws(() => parseGitDiffInput(input))
})

test("filters exact paths and directory prefixes without substring collisions", () => {
  const files = [file("src/app.ts", "app"), file("src/lib/util.ts", "util"), file("src-old.ts", "old")]
  assert.deepEqual(filterDiffFiles(files, "src"), files.slice(0, 2))
  assert.deepEqual(filterDiffFiles(files, "src/app.ts"), [files[0]])
})

test("renders bounded unified patches and fails closed on overflow", () => {
  assert.equal(renderDiff([], 1024), "No changes.")
  assert.equal(renderDiff([file("a.ts", "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new")], 1024), "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new")
  assert.throws(() => renderDiff([file("a.ts", "x".repeat(20))], 10), /output bound/)
})

test("uses the native VCS diff request and returns only the selected result", async () => {
  const calls: unknown[] = []
  const content = await executeGitDiff({ mode: "committed", base: "main", context: 2, path: "src", maxBytes: 1024 }, async (request) => {
    calls.push(request)
    return { data: [file("src/app.ts", "patch"), file("docs/readme.md", "other")] }
  })
  assert.deepEqual(calls, [{ mode: "committed", base: "main", context: 2 }])
  assert.equal(content, "patch")
})
