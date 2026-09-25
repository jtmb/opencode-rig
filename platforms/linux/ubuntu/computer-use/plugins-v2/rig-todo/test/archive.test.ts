import assert from "node:assert/strict"
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  ARCHIVE_MAX_EVENT_BYTES,
  ARCHIVE_MAX_PAGE,
  ARCHIVE_SEGMENT_EVENTS,
  appendTodoTransitions,
  diffTodoTransitions,
  formatArchivedTodoPage,
  formatTodoEventPage,
  materializeArchivedTodos,
  queryArchivedTodos,
  queryTodoEvents,
  todoArchiveRoot,
} from "../src/archive.ts"
import { assignTodoIds, emptyTodoIdentity, type TodoIdentity } from "../src/identity.ts"
import type { TodoItem } from "../src/store.ts"

const SESSION = "ses_archive"

async function makeRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "rig-todo-archive-"))
}

function item(content: string, status: TodoItem["status"], priority?: TodoItem["priority"]): TodoItem {
  return priority ? { content, status, priority } : { content, status }
}

function identify(items: readonly TodoItem[], identity: TodoIdentity = emptyTodoIdentity(), sessionID = SESSION) {
  return assignTodoIds(identity, items, sessionID)
}

async function segmentFileNames(root: string): Promise<string[]> {
  return (await readdir(path.join(root, "segments"))).filter((name) => name.endsWith(".jsonl")).sort()
}

test("archive root lives beside the sidebar mirror under XDG_DATA_HOME", () => {
  assert.equal(todoArchiveRoot({ XDG_DATA_HOME: "/data" }), path.join("/data", "opencode", "rig-todo", "archive"))
})

test("diff records creation, status change, content edit, and removal by stable id", () => {
  const first = identify([item("first", "pending"), item("second", "pending")])
  const created = diffTodoTransitions([], first.todos, SESSION, "2026-09-22T00:00:00.000Z")
  assert.deepEqual(created.map((draft) => [draft.content, draft.kind, draft.status]), [
    ["first", "created", "pending"],
    ["second", "created", "pending"],
  ])

  const second = identify([item("first", "in_progress"), item("second", "pending"), item("third", "pending")], first.identity)
  const transitions = diffTodoTransitions(first.todos, second.todos, SESSION, "2026-09-22T00:01:00.000Z")
  assert.deepEqual(transitions.map((draft) => [draft.content, draft.kind, draft.status, draft.previousStatus]), [
    ["first", "status_changed", "in_progress", "pending"],
    ["third", "created", "pending", undefined],
  ])

  const edited = identify([item("first renamed", "in_progress"), item("second", "pending"), item("third", "pending")], second.identity)
  const contentChange = diffTodoTransitions(second.todos, edited.todos, SESSION, "2026-09-22T00:02:00.000Z")
  assert.deepEqual(contentChange.map((draft) => [draft.content, draft.kind]), [["first renamed", "content_changed"]])
  assert.equal(contentChange[0]?.id, first.identity.entries[0]?.id)

  const removed = diffTodoTransitions(edited.todos, identify([item("second", "pending")], edited.identity).todos, SESSION, "2026-09-22T00:03:00.000Z")
  assert.deepEqual(removed.map((draft) => [draft.content, draft.kind, draft.status, draft.previousStatus]), [
    ["first renamed", "removed", "removed", "in_progress"],
    ["third", "removed", "removed", "pending"],
  ])
})

test("archives priority-only changes and keeps materialized priority accurate, including removal", async () => {
  const root = await makeRoot()
  try {
    const first = identify([item("task", "pending", "medium")])
    await appendTodoTransitions(root, diffTodoTransitions([], first.todos, SESSION, "2026-09-22T00:00:00.000Z"))
    const raised = identify([item("task", "pending", "high")], first.identity)
    const change = diffTodoTransitions(first.todos, raised.todos, SESSION, "2026-09-22T00:01:00.000Z")
    assert.deepEqual(change.map((draft) => [draft.kind, draft.priority]), [["priority_changed", "high"]])
    await appendTodoTransitions(root, change)

    const latest = await queryArchivedTodos(root, { sessionID: SESSION })
    assert.equal(latest.items[0]?.priority, "high")

    const cleared = identify([item("task", "pending")], raised.identity)
    const removed = diffTodoTransitions(raised.todos, cleared.todos, SESSION, "2026-09-22T00:02:00.000Z")
    assert.deepEqual(removed.map((draft) => [draft.kind, draft.priority]), [["priority_changed", undefined]])
    await appendTodoTransitions(root, removed)

    const afterRemoval = await queryArchivedTodos(root, { sessionID: SESSION })
    assert.equal(afterRemoval.items[0]?.priority, undefined)
    const events = await queryTodoEvents(root, { sessionID: SESSION, kind: "priority_changed" })
    assert.equal(events.items.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps duplicate task text distinct in the archive", async () => {
  const root = await makeRoot()
  try {
    const list = identify([item("same text", "pending"), item("same text", "pending")])
    assert.notEqual(list.todos[0]?.id, list.todos[1]?.id)
    await appendTodoTransitions(root, diffTodoTransitions([], list.todos, SESSION, "2026-09-22T00:00:00.000Z"))
    const page = await queryArchivedTodos(root, { sessionID: SESSION })
    assert.equal(page.items.length, 2)
    assert.equal(new Set(page.items.map((todo) => todo.id)).size, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("appends immutable transitions and replays the latest state per stable id", async () => {
  const root = await makeRoot()
  try {
    const first = identify([item("alpha", "pending"), item("beta", "pending")])
    const second = identify([item("alpha", "completed"), item("beta", "pending")], first.identity)
    const third = identify([item("alpha", "completed")], second.identity)
    await appendTodoTransitions(root, diffTodoTransitions([], first.todos, SESSION, "2026-09-22T00:00:00.000Z"))
    await appendTodoTransitions(root, diffTodoTransitions(first.todos, second.todos, SESSION, "2026-09-22T00:01:00.000Z"))
    await appendTodoTransitions(root, diffTodoTransitions(second.todos, third.todos, SESSION, "2026-09-22T00:02:00.000Z"))

    const events = await queryTodoEvents(root, { sessionID: SESSION, limit: ARCHIVE_MAX_PAGE })
    assert.equal(events.items.length, 4)
    assert.deepEqual(events.items.map((event) => [event.kind, event.status]), [
      ["removed", "removed"],
      ["status_changed", "completed"],
      ["created", "pending"],
      ["created", "pending"],
    ])

    const chronological = materializeArchivedTodos([...events.items].reverse())
    const alpha = chronological.find((todo) => todo.content === "alpha")
    const beta = chronological.find((todo) => todo.content === "beta")
    assert.equal(alpha?.status, "completed")
    assert.equal(beta?.status, "removed")
    assert.equal(alpha?.updatedAt, "2026-09-22T00:01:00.000Z")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("history survives deletion of the session mirror and storage entry", async () => {
  const root = await makeRoot()
  try {
    await appendTodoTransitions(root, diffTodoTransitions([], identify([item("retained work", "completed")]).todos, SESSION, "2026-09-22T00:00:00.000Z"))
    await rm(path.join(root, "..", `${SESSION}.json`), { force: true })

    const page = await queryArchivedTodos(root, { sessionID: SESSION })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.content, "retained work")
    assert.equal(page.items[0]?.status, "completed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("paging walks bounded pages newest first and a cursor reaches the oldest transition", async () => {
  const root = await makeRoot()
  try {
    for (let batch = 0; batch < 10; batch += 1) {
      const items = Array.from({ length: 25 }, (_, index) => item(`cursor ${batch}-${index}`, "pending"))
      await appendTodoTransitions(root, diffTodoTransitions([], identify(items).todos, SESSION, `2026-09-22T00:${String(batch).padStart(2, "0")}:00.000Z`))
    }
    const seen = new Set<string>()
    let beforeSeq: number | undefined
    let pages = 0
    for (;;) {
      const page = await queryTodoEvents(root, { sessionID: SESSION, limit: 20, maxScan: 30, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      assert.ok(page.scanned <= 30, `bounded scan expected, saw ${page.scanned}`)
      for (const event of page.items) seen.add(event.content)
      pages += 1
      if (page.nextBeforeSeq === undefined) break
      beforeSeq = page.nextBeforeSeq
      if (pages > 100) throw new Error("cursor did not terminate")
    }
    assert.equal(seen.size, 250)
    assert.ok(seen.has("cursor 0-0"))
    assert.ok(seen.has("cursor 9-24"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("splits one oversized batch across byte-bounded segments without losing the prefix", async () => {
  const root = await makeRoot()
  try {
    const content = "x".repeat(40 * 1024)
    const items = Array.from({ length: 10 }, (_, index) => item(`${index}-${content}`, "pending"))
    assert.equal(await appendTodoTransitions(root, diffTodoTransitions([], identify(items).todos, SESSION, "2026-09-22T00:00:00.000Z")), 10)

    const files = await segmentFileNames(root)
    assert.ok(files.length >= 2, `expected multiple segments, saw ${files.length}`)
    for (const file of files) {
      const info = await stat(path.join(root, "segments", file))
      assert.ok(info.size <= 256 * 1024 + ARCHIVE_MAX_EVENT_BYTES, `segment ${file} is ${info.size} bytes`)
    }

    const page = await queryTodoEvents(root, { sessionID: SESSION, limit: 50 })
    assert.equal(page.items.length, 10)
    assert.equal(page.truncated, false)

    // A corrupt manifest rebuild must still see every event across the split.
    await writeFile(path.join(root, "manifest.json"), "{not json", "utf8")
    const rebuilt = await queryTodoEvents(root, { sessionID: SESSION, limit: 50 })
    assert.equal(rebuilt.items.length, 10)
    assert.ok(rebuilt.items.some((event) => event.content.startsWith("0-")))
    assert.ok(rebuilt.items.some((event) => event.content.startsWith("9-")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a single oversized event before writing anything", async () => {
  const root = await makeRoot()
  try {
    const huge = item("y".repeat(ARCHIVE_MAX_EVENT_BYTES + 1024), "pending")
    await assert.rejects(
      () => appendTodoTransitions(root, diffTodoTransitions([], identify([huge]).todos, SESSION, "2026-09-22T00:00:00.000Z")),
      /todo archive event exceeds/,
    )
    const page = await queryTodoEvents(root, { sessionID: SESSION })
    assert.equal(page.items.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rotates segments under load by event count and keeps every transition readable", async () => {
  const root = await makeRoot()
  try {
    const total = ARCHIVE_SEGMENT_EVENTS * 2 + 5
    for (let offset = 0; offset < total; offset += 5) {
      const items = Array.from({ length: Math.min(5, total - offset) }, (_, index) => item(`bulk ${offset + index}`, "pending"))
      await appendTodoTransitions(root, diffTodoTransitions([], identify(items).todos, SESSION, "2026-09-22T00:00:00.000Z"))
    }
    const all = await queryTodoEvents(root, { sessionID: SESSION, limit: ARCHIVE_MAX_PAGE, maxScan: 10_000 })
    assert.equal(all.truncated, false)
    const seen = new Set<string>()
    let beforeSeq: number | undefined
    for (;;) {
      const page = await queryTodoEvents(root, { sessionID: SESSION, limit: ARCHIVE_MAX_PAGE, maxScan: 10_000, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      for (const event of page.items) seen.add(event.content)
      if (page.nextBeforeSeq === undefined) break
      beforeSeq = page.nextBeforeSeq
    }
    assert.equal(seen.size, total)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounded scan stops and marks truncation instead of reading unbounded history", async () => {
  const root = await makeRoot()
  try {
    for (let batch = 0; batch < 20; batch += 1) {
      const items = Array.from({ length: 5 }, (_, index) => item(`scan ${batch}-${index}`, "pending"))
      await appendTodoTransitions(root, diffTodoTransitions([], identify(items).todos, SESSION, "2026-09-22T00:00:00.000Z"))
    }
    const page = await queryTodoEvents(root, { sessionID: SESSION, text: "does-not-exist", maxScan: 12 })
    assert.equal(page.items.length, 0)
    assert.equal(page.truncated, true)
    assert.equal(page.scanned, 12)
    // A zero-match bounded page still yields a cursor so older matches are reachable.
    assert.notEqual(page.nextBeforeSeq, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function collectEventSeqs(root: string): Promise<number[]> {
  const seqs: number[] = []
  let beforeSeq: number | undefined
  for (;;) {
    const page = await queryTodoEvents(root, { limit: ARCHIVE_MAX_PAGE, maxScan: 10_000, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
    for (const event of page.items) seqs.push(event.seq)
    if (page.nextBeforeSeq === undefined) break
    beforeSeq = page.nextBeforeSeq
  }
  return seqs
}

test("a heavily filtered zero-hit page reaches an old match with bounded per-page I/O", async () => {
  const root = await makeRoot()
  try {
    const match = identify([item("needle oldest match", "pending")])
    await appendTodoTransitions(root, diffTodoTransitions([], match.todos, SESSION, "2026-09-22T00:00:00.000Z"))
    for (let batch = 0; batch < 18; batch += 1) {
      const items = Array.from({ length: 25 }, (_, index) => item(`noise ${batch}-${index}`, "pending"))
      await appendTodoTransitions(root, diffTodoTransitions([], identify(items).todos, SESSION, `2026-09-22T01:${String(batch).padStart(2, "0")}:00.000Z`))
    }

    const page = await queryTodoEvents(root, { sessionID: SESSION, text: "needle", limit: 5, maxScan: 10 })
    assert.equal(page.items.length, 0)
    assert.equal(page.truncated, true)
    assert.notEqual(page.nextBeforeSeq, undefined)
    assert.ok(page.segmentsRead <= 2, `page 1 read ${page.segmentsRead} segments`)

    const found: string[] = []
    let beforeSeq: number | undefined = page.nextBeforeSeq
    let pages = 0
    let totalSegmentsRead = page.segmentsRead
    for (;;) {
      const next = await queryTodoEvents(root, { sessionID: SESSION, text: "needle", limit: 5, maxScan: 10, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      totalSegmentsRead += next.segmentsRead
      assert.ok(next.segmentsRead <= 2, `a page read ${next.segmentsRead} segments`)
      for (const event of next.items) found.push(event.content)
      pages += 1
      if (next.nextBeforeSeq === undefined) break
      beforeSeq = next.nextBeforeSeq
      if (pages > 200) throw new Error("cursor did not terminate")
    }
    assert.ok(found.includes("needle oldest match"))
    // Newer segments are skipped by seq metadata instead of being re-read.
    assert.ok(totalSegmentsRead <= pages + 5, `read ${totalSegmentsRead} segments across ${pages} pages`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovers from a stale manifest without sequence reuse or a hidden tail", async () => {
  const root = await makeRoot()
  try {
    const first = identify(Array.from({ length: 250 }, (_, index) => item(`first ${index}`, "pending")))
    await appendTodoTransitions(root, diffTodoTransitions([], first.todos, SESSION, "2026-09-22T00:00:00.000Z"))
    const good = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { segments: Array<{ file: string; firstSeq: number }> }
    assert.ok(good.segments.length >= 2)

    // Scenario 1: a failed manifest write left the rotated segment unlisted and nextSeq rolled back.
    const unlisted = { version: 1, segments: good.segments.slice(0, good.segments.length - 1), nextSeq: good.segments[good.segments.length - 1]!.firstSeq }
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(unlisted), "utf8")
    await appendTodoTransitions(root, diffTodoTransitions([], identify([item("second batch", "pending")]).todos, SESSION, "2026-09-22T01:00:00.000Z"))

    // Scenario 2: the segment is listed but nextSeq is behind the on-disk tail.
    const listed = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as Record<string, unknown>
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ ...listed, nextSeq: 1 }), "utf8")
    await appendTodoTransitions(root, diffTodoTransitions([], identify([item("third batch", "pending")]).todos, SESSION, "2026-09-22T02:00:00.000Z"))

    const seqs = await collectEventSeqs(root)
    assert.equal(seqs.length, 252)
    assert.equal(new Set(seqs).size, 252, "sequence numbers must be unique")
    const sorted = [...seqs].sort((left, right) => left - right)
    assert.equal(sorted[0], 1)
    assert.equal(sorted[sorted.length - 1], 252)
    const surfaces = await queryTodoEvents(root, { sessionID: SESSION, limit: 50, maxScan: 10_000 })
    assert.equal(surfaces.items.length, 50)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("filters by text, status, kind, session, and bounded date range", async () => {
  const root = await makeRoot()
  try {
    const first = identify([item("Deploy service", "pending"), item("Write docs", "pending")])
    const second = identify([item("Deploy service", "completed"), item("Write docs", "pending")], first.identity)
    await appendTodoTransitions(root, diffTodoTransitions([], first.todos, SESSION, "2026-09-22T10:00:00.000Z"))
    await appendTodoTransitions(root, diffTodoTransitions(first.todos, second.todos, SESSION, "2026-09-22T11:00:00.000Z"))
    await appendTodoTransitions(root, diffTodoTransitions([], identify([item("Other session", "pending")], emptyTodoIdentity(), "ses_else").todos, "ses_else", "2026-09-22T12:00:00.000Z"))

    const byText = await queryTodoEvents(root, { sessionID: SESSION, text: "deploy" })
    assert.equal(byText.items.length, 2)
    assert.ok(byText.items.every((event) => event.content === "Deploy service"))
    assert.deepEqual((await queryTodoEvents(root, { kind: "status_changed" })).items.map((event) => event.content), ["Deploy service"])
    assert.deepEqual((await queryTodoEvents(root, { status: "completed" })).items.map((event) => event.content), ["Deploy service"])
    assert.deepEqual((await queryTodoEvents(root, { sessionID: SESSION })).items.length, 3)
    assert.deepEqual((await queryTodoEvents(root, { from: "2026-09-22T11:00:00.000Z" })).items.map((event) => event.content), ["Other session", "Deploy service"])

    const latest = await queryArchivedTodos(root, { sessionID: SESSION })
    assert.deepEqual(latest.items.map((todo) => [todo.content, todo.status]), [
      ["Deploy service", "completed"],
      ["Write docs", "pending"],
    ])
    assert.equal(latest.hiddenHistory, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("formatters render bounded pages with full task text and the continuation cursor", async () => {
  const root = await makeRoot()
  try {
    const batch = identify([item("Full task text stays complete", "completed"), item("Later task", "in_progress")])
    await appendTodoTransitions(root, diffTodoTransitions([], batch.todos, SESSION, "2026-09-22T00:00:00.000Z"))
    const todos = formatArchivedTodoPage(await queryArchivedTodos(root, { sessionID: SESSION }))
    assert.match(todos, /^Archived todos: rows 1-2/)
    assert.match(todos, /\[~\] Later task \(in_progress\)/)
    assert.match(todos, /\[x\] Full task text stays complete \(completed\)/)
    assert.doesNotMatch(todos, /…|\.\.\./)

    const events = formatTodoEventPage(await queryTodoEvents(root, { sessionID: SESSION, limit: 1 }))
    assert.match(events, /^Todo transitions: rows 1-1 · more available/)
    assert.match(events, /next beforeSeq: \d+/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupt manifest and malformed lines never throw or hide valid history", async () => {
  const root = await makeRoot()
  try {
    await appendTodoTransitions(root, diffTodoTransitions([], identify([item("survives corruption", "pending")]).todos, SESSION, "2026-09-22T00:00:00.000Z"))
    await writeFile(path.join(root, "manifest.json"), "{not valid json", "utf8")
    const segmentFile = (await readdir(path.join(root, "segments")))[0]!
    await appendFile(path.join(root, "segments", segmentFile), "this is not json\n{ broken\n", "utf8")

    const page = await queryArchivedTodos(root, { sessionID: SESSION })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.content, "survives corruption")

    await appendTodoTransitions(root, diffTodoTransitions([], identify([item("after rebuild", "pending")]).todos, SESSION, "2026-09-22T00:01:00.000Z"))
    const all = await queryTodoEvents(root, { sessionID: SESSION })
    assert.equal(all.items.length, 2)
    const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { nextSeq: number }
    assert.ok(manifest.nextSeq >= 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
