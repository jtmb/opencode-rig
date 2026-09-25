import assert from "node:assert/strict"
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  SUBAGENT_HISTORY_MAX_PAGE,
  SUBAGENT_HISTORY_SEGMENT_EVENTS,
  formatSubagentHistoryEventsPage,
  formatSubagentHistoryPage,
  querySubagentHistory,
  querySubagentHistoryEvents,
  recordSubagentObservations,
  subagentHistoryRoot,
} from "../src/subagent-history.ts"
import type { SubagentRow } from "../src/subagents.ts"

async function makeRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "rig-subagent-history-"))
}

function row(id: string, title: string, status: SubagentRow["status"] = "running", agent = "General"): SubagentRow {
  return { sessionID: id, agent, model: "openai/gpt-6-luna#max", title, status }
}

test("history root lives under the rig-tools data directory", () => {
  assert.equal(subagentHistoryRoot({ XDG_DATA_HOME: "/data" }), path.join("/data", "opencode", "rig-tools", "subagent-history"))
})

test("records one event per change and skips unchanged polling ticks", async () => {
  const root = await makeRoot()
  try {
    const first = await recordSubagentObservations(root, [row("ses_a", "First task"), row("ses_b", "Second task")], "2026-09-22T10:00:00.000Z")
    assert.equal(first, 2)
    const unchanged = await recordSubagentObservations(root, [row("ses_a", "First task"), row("ses_b", "Second task")], "2026-09-22T10:00:01.000Z")
    assert.equal(unchanged, 0)
    const changed = await recordSubagentObservations(root, [row("ses_a", "First task", "idle"), row("ses_b", "Second task")], "2026-09-22T10:00:02.000Z")
    assert.equal(changed, 1)

    const page = await querySubagentHistory(root, { limit: SUBAGENT_HISTORY_MAX_PAGE })
    assert.equal(page.rows.length, 2)
    assert.deepEqual(page.rows.map((entry) => [entry.title, entry.status]), [
      ["First task", "idle"],
      ["Second task", "running"],
    ])
    assert.equal(page.rows[0]?.firstSeenAt, "2026-09-22T10:00:00.000Z")
    assert.equal(page.rows[0]?.lastSeenAt, "2026-09-22T10:00:02.000Z")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("public history rows and rendered text never expose session IDs or prompts", async () => {
  const root = await makeRoot()
  try {
    await recordSubagentObservations(root, [row("ses_private_identifier", "Repair the visible sidebar")], "2026-09-22T10:00:00.000Z")
    const page = await querySubagentHistory(root)
    const serialized = JSON.stringify(page.rows)
    assert.doesNotMatch(serialized, /ses_private_identifier/)
    assert.doesNotMatch(serialized, /sessionID|prompt|reasoning|message/i)
    assert.deepEqual(Object.keys(page.rows[0]!).sort(), ["agent", "firstSeenAt", "lastSeenAt", "model", "status", "title"])
    const rendered = formatSubagentHistoryPage(page)
    assert.doesNotMatch(rendered, /ses_private_identifier/)
    assert.match(rendered, /Repair the visible sidebar/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("pages bounded history newest first and reports more available", async () => {
  const root = await makeRoot()
  try {
    const rows = Array.from({ length: 50 }, (_, index) => row(`ses_${index}`, `History task ${index}`))
    await recordSubagentObservations(root, rows, "2026-09-22T10:00:00.000Z")
    const first = await querySubagentHistory(root, { limit: 10 })
    const second = await querySubagentHistory(root, { limit: 10, offset: 10 })
    assert.deepEqual(first.rows.map((entry) => entry.title), Array.from({ length: 10 }, (_, index) => `History task ${49 - index}`))
    assert.deepEqual(second.rows.map((entry) => entry.title), Array.from({ length: 10 }, (_, index) => `History task ${39 - index}`))
    assert.equal(first.hasMore, true)
    assert.ok(first.scanned <= 11, `bounded scan expected, saw ${first.scanned}`)
    assert.equal(first.truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rotates segments and keeps every observation reachable", async () => {
  const root = await makeRoot()
  try {
    const total = SUBAGENT_HISTORY_SEGMENT_EVENTS + 25
    for (let index = 0; index < total; index += 1) {
      await recordSubagentObservations(root, [row(`ses_rot_${index}`, `Rotated task ${index}`)], `2026-09-22T10:00:${String(index % 60).padStart(2, "0")}.000Z`)
    }
    const seen = new Set<string>()
    for (let offset = 0; offset < total; offset += SUBAGENT_HISTORY_MAX_PAGE) {
      const page = await querySubagentHistory(root, { limit: SUBAGENT_HISTORY_MAX_PAGE, offset, maxScan: 10_000 })
      for (const entry of page.rows) seen.add(entry.title)
    }
    assert.equal(seen.size, total)
    assert.ok(seen.has("Rotated task 0"))
    assert.ok(seen.has(`Rotated task ${total - 1}`))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("filters by text, status, and bounded date range", async () => {
  const root = await makeRoot()
  try {
    await recordSubagentObservations(root, [
      row("ses_one", "Repair sidebar", "running", "General"),
      row("ses_two", "Audit provider usage", "idle", "Explore"),
    ], "2026-09-22T10:00:00.000Z")
    assert.deepEqual((await querySubagentHistory(root, { text: "provider" })).rows.map((entry) => entry.title), ["Audit provider usage"])
    assert.deepEqual((await querySubagentHistory(root, { status: "idle" })).rows.map((entry) => entry.title), ["Audit provider usage"])
    assert.deepEqual((await querySubagentHistory(root, { text: "explore" })).rows.map((entry) => entry.agent), ["Explore"])
    assert.equal((await querySubagentHistory(root, { from: "2026-09-22T11:00:00.000Z" })).rows.length, 0)
    assert.equal((await querySubagentHistory(root, { to: "2026-09-22T10:00:00.000Z" })).rows.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounded scan truncates instead of reading unbounded history", async () => {
  const root = await makeRoot()
  try {
    for (let index = 0; index < 40; index += 1) {
      await recordSubagentObservations(root, [row(`ses_scan_${index}`, `Scan task ${index}`)], "2026-09-22T10:00:00.000Z")
    }
    const page = await querySubagentHistory(root, { text: "no-such-history", maxScan: 15 })
    assert.equal(page.rows.length, 0)
    assert.equal(page.truncated, true)
    assert.equal(page.scanned, 15)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounds stored display text instead of writing oversized events", async () => {
  const root = await makeRoot()
  try {
    const longTitle = "t".repeat(5_000)
    await recordSubagentObservations(root, [row("ses_long", longTitle)], "2026-09-22T10:00:00.000Z")
    const page = await querySubagentHistory(root)
    assert.equal(page.rows.length, 1)
    assert.equal(page.rows[0]?.title.length, 200)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("splits one large batch across byte-bounded segments without losing the prefix", async () => {
  const root = await makeRoot()
  try {
    const title = "segment history ".repeat(12)
    const rows = Array.from({ length: 1_200 }, (_, index) => row(`ses_segment_${index}`, `${title}${index}`))
    assert.equal(await recordSubagentObservations(root, rows, "2026-09-22T10:00:00.000Z"), 1_200)

    const segmentNames = (await readdir(path.join(root, "segments"))).filter((name) => name.endsWith(".jsonl"))
    assert.ok(segmentNames.length >= 2, `expected multiple segments, saw ${segmentNames.length}`)

    const seen = new Set<string>()
    let beforeSeq: number | undefined
    for (;;) {
      const page = await querySubagentHistoryEvents(root, { limit: SUBAGENT_HISTORY_MAX_PAGE, maxScan: 5_000, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      for (const entry of page.rows) seen.add(entry.title)
      if (page.nextBeforeSeq === undefined) break
      beforeSeq = page.nextBeforeSeq
    }
    assert.equal(seen.size, 1_200)

    // A corrupt manifest rebuild must still expose every event across segments.
    await writeFile(path.join(root, "manifest.json"), "{not json", "utf8")
    const rebuilt = await querySubagentHistoryEvents(root, { limit: 5, maxScan: 5_000 })
    assert.equal(rebuilt.rows.length, 5)
    assert.equal(rebuilt.truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a beforeSeq cursor reaches every observation within a bounded scan", async () => {
  const root = await makeRoot()
  try {
    const rows = Array.from({ length: 250 }, (_, index) => row(`ses_cursor_${index}`, `Cursor task ${index}`))
    await recordSubagentObservations(root, rows, "2026-09-22T10:00:00.000Z")

    const seen = new Set<string>()
    let beforeSeq: number | undefined
    let pages = 0
    for (;;) {
      const page = await querySubagentHistoryEvents(root, { limit: 20, maxScan: 30, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      assert.ok(page.scanned <= 30, `bounded scan expected, saw ${page.scanned}`)
      for (const entry of page.rows) seen.add(entry.title)
      pages += 1
      if (page.nextBeforeSeq === undefined) break
      beforeSeq = page.nextBeforeSeq
      if (pages > 100) throw new Error("cursor did not terminate")
    }
    assert.equal(seen.size, 250)
    assert.ok(seen.has("Cursor task 0"))
    assert.ok(seen.has("Cursor task 249"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("event pages and their formatted text never expose session IDs or prompts", async () => {
  const root = await makeRoot()
  try {
    await recordSubagentObservations(root, [row("ses_event_private", "Repair the panel")], "2026-09-22T10:00:00.000Z")
    await recordSubagentObservations(root, [row("ses_event_private", "Repair the panel", "idle")], "2026-09-22T10:01:00.000Z")
    const page = await querySubagentHistoryEvents(root)
    assert.equal(page.rows.length, 2)
    const serialized = JSON.stringify(page.rows)
    assert.doesNotMatch(serialized, /ses_event_private/)
    assert.doesNotMatch(serialized, /sessionID|prompt|reasoning|message/i)
    assert.doesNotMatch(formatSubagentHistoryEventsPage(page), /ses_event_private/)
    assert.match(formatSubagentHistoryEventsPage(page), /Repair the panel/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function readAllSeq(root: string): Promise<number[]> {
  const directory = path.join(root, "segments")
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"))
  const seqs: number[] = []
  for (const file of files) {
    for (const line of (await readFile(path.join(directory, file), "utf8")).split("\n")) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as { seq?: unknown }
        if (typeof event.seq === "number") seqs.push(event.seq)
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return seqs
}

test("a filtered zero-hit event page still yields a cursor with bounded I/O", async () => {
  const root = await makeRoot()
  try {
    await recordSubagentObservations(root, [row("ses_needle", "needle oldest observation")], "2026-09-22T00:00:00.000Z")
    for (let batch = 0; batch < 18; batch += 1) {
      const noise = Array.from({ length: 25 }, (_, index) => row(`ses_noise_${batch}_${index}`, `noise ${batch}-${index}`))
      await recordSubagentObservations(root, noise, `2026-09-22T01:${String(batch).padStart(2, "0")}:00.000Z`)
    }

    const first = await querySubagentHistoryEvents(root, { text: "needle", limit: 5, maxScan: 10 })
    assert.equal(first.rows.length, 0)
    assert.equal(first.truncated, true)
    assert.notEqual(first.nextBeforeSeq, undefined)
    assert.ok(first.segmentsRead <= 2, `page 1 read ${first.segmentsRead} segments`)

    let beforeSeq = first.nextBeforeSeq
    const found: string[] = []
    let pages = 0
    let totalSegmentsRead = first.segmentsRead
    for (;;) {
      const page = await querySubagentHistoryEvents(root, { text: "needle", limit: 5, maxScan: 10, ...(beforeSeq !== undefined ? { beforeSeq } : {}) })
      totalSegmentsRead += page.segmentsRead
      assert.ok(page.segmentsRead <= 2, `a page read ${page.segmentsRead} segments`)
      for (const entry of page.rows) found.push(entry.title)
      pages += 1
      if (page.nextBeforeSeq === undefined) break
      beforeSeq = page.nextBeforeSeq
      if (pages > 300) throw new Error("cursor did not terminate")
    }
    assert.ok(found.includes("needle oldest observation"))
    assert.ok(totalSegmentsRead <= pages + 5, `read ${totalSegmentsRead} segments across ${pages} pages`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovers from a stale manifest without sequence reuse or a hidden tail", async () => {
  const root = await makeRoot()
  try {
    const first = Array.from({ length: 250 }, (_, index) => row(`ses_stale_${index}`, `stale ${index}`))
    await recordSubagentObservations(root, first, "2026-09-22T00:00:00.000Z")
    const good = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { segments: Array<{ file: string; firstSeq: number }> }
    assert.ok(good.segments.length >= 2)

    await writeFile(
      path.join(root, "manifest.json"),
      JSON.stringify({ version: 1, segments: good.segments.slice(0, good.segments.length - 1), nextSeq: good.segments[good.segments.length - 1]!.firstSeq }),
      "utf8",
    )
    await recordSubagentObservations(root, [row("ses_after_unlisted", "after unlisted")], "2026-09-22T01:00:00.000Z")

    const listed = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as Record<string, unknown>
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ ...listed, nextSeq: 1 }), "utf8")
    await recordSubagentObservations(root, [row("ses_after_stale", "after stale")], "2026-09-22T02:00:00.000Z")

    const seqs = await readAllSeq(root)
    assert.equal(seqs.length, 252)
    assert.equal(new Set(seqs).size, 252, "sequence numbers must be unique")
    const sorted = [...seqs].sort((left, right) => left - right)
    assert.equal(sorted[0], 1)
    assert.equal(sorted[sorted.length - 1], 252)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("corrupt manifest and malformed lines never throw or hide valid history", async () => {
  const root = await makeRoot()
  try {
    await recordSubagentObservations(root, [row("ses_corrupt", "Survives corruption")], "2026-09-22T10:00:00.000Z")
    await writeFile(path.join(root, "manifest.json"), "{not json", "utf8")
    const segmentFile = (await readdir(path.join(root, "segments")))[0]!
    await appendFile(path.join(root, "segments", segmentFile), "not json\n{ broken\n", "utf8")

    const page = await querySubagentHistory(root)
    assert.equal(page.rows.length, 1)
    assert.equal(page.rows[0]?.title, "Survives corruption")

    // A rebuild restores numbering and continues without overwriting history.
    const appended = await recordSubagentObservations(root, [row("ses_corrupt", "Survives corruption", "idle")], "2026-09-22T10:01:00.000Z")
    assert.equal(appended, 1)
    const changed = await querySubagentHistory(root, { status: "idle" })
    assert.equal(changed.rows.length, 1)
    assert.equal(changed.rows[0]?.title, "Survives corruption")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
