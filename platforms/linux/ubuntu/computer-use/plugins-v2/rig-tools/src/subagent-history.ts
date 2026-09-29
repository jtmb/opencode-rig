import os from "node:os"
import path from "node:path"
import { appendFile, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises"

import type { SubagentRow, SubagentStatus } from "./subagents.ts"

/**
 * Durable, append-only subagent observation history for the `/subagents` audit
 * surface.
 *
 * A snapshot is recorded only when a child's agent, model, title, or status
 * changes, so the log grows with transitions rather than polling ticks. Batches
 * are split by serialized UTF-8 byte size and event count, so a segment file
 * never exceeds what readers scan; an oversized event is rejected before
 * anything is written. Reads are paged and bounded, and a `beforeSeq` cursor
 * lets a caller continue into older observations without an unbounded scan.
 *
 * The public projection deliberately omits the internal session identifier and
 * never stores or returns prompts, so shared UI text cannot leak either.
 */

export interface SubagentHistoryEvent {
  readonly seq: number
  readonly sessionID: string
  readonly at: string
  readonly agent: string
  readonly model: string
  readonly title: string
  readonly status: SubagentStatus
  readonly firstSeenAt: string
}

/** Public row: no session identifier, no prompt, bounded display text. */
export interface SubagentHistoryRow {
  readonly agent: string
  readonly model: string
  readonly title: string
  readonly status: SubagentStatus
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}

/** Public raw-observation row: no session identifier, no prompt. */
export interface SubagentHistoryEventRow {
  readonly at: string
  readonly agent: string
  readonly model: string
  readonly title: string
  readonly status: SubagentStatus
  readonly firstSeenAt: string
}

export interface SubagentHistoryQuery {
  readonly text?: string
  readonly status?: SubagentStatus
  readonly from?: string
  readonly to?: string
  readonly offset?: number
  readonly limit?: number
  readonly maxScan?: number
  /** Only consider events with `seq < beforeSeq` (continuation cursor). */
  readonly beforeSeq?: number
}

export interface SubagentHistoryPage {
  readonly rows: readonly SubagentHistoryRow[]
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
  readonly scanned: number
  readonly truncated: boolean
  readonly segmentsRead: number
}

export interface SubagentHistoryEventPage {
  readonly rows: readonly SubagentHistoryEventRow[]
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
  readonly scanned: number
  readonly truncated: boolean
  readonly segmentsRead: number
  /** Pass as `beforeSeq` to continue with the next older page. */
  readonly nextBeforeSeq?: number
}

export const SUBAGENT_HISTORY_SEGMENT_EVENTS = 200
export const SUBAGENT_HISTORY_SEGMENT_BYTES = 256 * 1024
export const SUBAGENT_HISTORY_MAX_EVENT_BYTES = 32 * 1024
export const SUBAGENT_HISTORY_DEFAULT_PAGE = 20
export const SUBAGENT_HISTORY_MAX_PAGE = 50
export const SUBAGENT_HISTORY_MAX_SCAN = 5_000
const MAX_DISPLAY_CHARS = 200
const READ_CAP_BYTES = SUBAGENT_HISTORY_SEGMENT_BYTES + SUBAGENT_HISTORY_MAX_EVENT_BYTES

const STATUSES: ReadonlySet<string> = new Set(["running", "idle", "unknown"])

interface SegmentInfo {
  file: string
  count: number
  firstSeq: number
  lastSeq: number
}

interface HistoryManifest {
  version: 1
  segments: SegmentInfo[]
  nextSeq: number
}

interface HistoryState {
  version: 1
  entries: Record<string, { firstSeenAt: string; agent: string; model: string; title: string; status: SubagentStatus }>
}

function baseDataRoot(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim().length > 0
    ? env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode", "rig-tools")
}

/** Root of the durable subagent-history store for this launch environment. */
export function subagentHistoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(baseDataRoot(env), "subagent-history")
}

function segmentsDirectory(root: string): string {
  return path.join(root, "segments")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitize(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " ")).slice(0, MAX_DISPLAY_CHARS).join("").trim() || "(untitled)"
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return SUBAGENT_HISTORY_DEFAULT_PAGE
  return Math.min(SUBAGENT_HISTORY_MAX_PAGE, Math.max(1, Math.floor(limit)))
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

function clampScan(maxScan: number | undefined): number {
  if (typeof maxScan !== "number" || !Number.isFinite(maxScan)) return SUBAGENT_HISTORY_MAX_SCAN
  return Math.min(SUBAGENT_HISTORY_MAX_SCAN, Math.max(1, Math.floor(maxScan)))
}

function parseEventLine(line: string): SubagentHistoryEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const { seq, sessionID, at, agent, model, title, status, firstSeenAt } = raw
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return undefined
  if (typeof sessionID !== "string" || !sessionID) return undefined
  if (typeof at !== "string" || !at) return undefined
  if (typeof agent !== "string" || typeof model !== "string" || typeof title !== "string") return undefined
  if (typeof status !== "string" || !STATUSES.has(status)) return undefined
  if (typeof firstSeenAt !== "string" || !firstSeenAt) return undefined
  return { seq, sessionID, at, agent, model, title, status: status as SubagentStatus, firstSeenAt }
}

async function fileSize(file: string): Promise<number> {
  return (await stat(file).catch(() => undefined))?.size ?? 0
}

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

async function readBounded(file: string, cap: number): Promise<BoundedText> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return { text: "", truncated: false }
  try {
    const info = await handle.stat()
    const truncated = info.size > cap
    const start = truncated ? info.size - cap : 0
    const length = Number(info.size - start)
    if (length <= 0) return { text: "", truncated }
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return { text: buffer.toString("utf8"), truncated }
  } catch {
    return { text: "", truncated: false }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readJsonFile(file: string): Promise<unknown> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (info.size > SUBAGENT_HISTORY_SEGMENT_BYTES * 8) return undefined
    const buffer = Buffer.alloc(Number(info.size))
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, 0)
    return JSON.parse(buffer.toString("utf8")) as unknown
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function scanSegment(file: string): Promise<{ count: number; firstSeq: number; lastSeq: number } | undefined> {
  const { text, truncated } = await readBounded(file, READ_CAP_BYTES)
  let count = 0
  let firstSeq = Number.POSITIVE_INFINITY
  let lastSeq = -1
  for (const line of text.split("\n")) {
    const event = parseEventLine(line)
    if (!event) continue
    count += 1
    firstSeq = Math.min(firstSeq, event.seq)
    lastSeq = Math.max(lastSeq, event.seq)
  }
  if (count === 0 && !truncated) return undefined
  return { count, firstSeq: count > 0 ? firstSeq : 0, lastSeq }
}

async function rebuildManifest(root: string): Promise<HistoryManifest> {
  const directory = segmentsDirectory(root)
  const files = await readdir(directory).catch(() => [] as string[])
  const segments: SegmentInfo[] = []
  for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
    const scanned = await scanSegment(path.join(directory, file))
    if (scanned) segments.push({ file, ...scanned })
  }
  segments.sort((left, right) => left.firstSeq - right.firstSeq)
  const lastSeq = segments.reduce((maximum, segment) => Math.max(maximum, segment.lastSeq), 0)
  return { version: 1, segments, nextSeq: lastSeq + 1 }
}

function isManifest(value: unknown): value is HistoryManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments)) return false
  if (typeof value.nextSeq !== "number" || !Number.isInteger(value.nextSeq) || value.nextSeq < 1) return false
  return value.segments.every((segment) =>
    isRecord(segment) &&
    typeof segment.file === "string" &&
    typeof segment.count === "number" &&
    typeof segment.firstSeq === "number" &&
    typeof segment.lastSeq === "number",
  )
}

async function loadManifest(root: string): Promise<HistoryManifest> {
  const parsed = await readJsonFile(path.join(root, "manifest.json"))
  if (isManifest(parsed) && await manifestMatchesDisk(root, parsed)) return parsed
  return rebuildManifest(root)
}

/**
 * Reuse a manifest only when it still agrees with the immutable segments, so a
 * stale manifest left by a failed write cannot make the next append reuse a
 * sequence number or hide a rotated segment.
 */
async function manifestMatchesDisk(root: string, manifest: HistoryManifest): Promise<boolean> {
  const files = (await readdir(segmentsDirectory(root)).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"))
  const listed = new Set(manifest.segments.map((segment) => segment.file))
  for (const file of files) {
    if (listed.has(file)) continue
    // An unlisted empty file is a failed-append leftover, not hidden history.
    if (await fileSize(path.join(segmentsDirectory(root), file)) > 0) return false
  }
  if (manifest.segments.length === 0) return files.length === 0
  const last = manifest.segments[manifest.segments.length - 1]!
  const bounded = await readBounded(path.join(segmentsDirectory(root), last.file), READ_CAP_BYTES)
  let lastSeq = -1
  for (const line of bounded.text.split("\n")) {
    const event = parseEventLine(line)
    if (event) lastSeq = Math.max(lastSeq, event.seq)
  }
  return lastSeq < manifest.nextSeq
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, file)
}

function emptyState(): HistoryState {
  return { version: 1, entries: {} }
}

function loadState(value: unknown): HistoryState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) return emptyState()
  return value as unknown as HistoryState
}

const recordChains = new Map<string, Promise<unknown>>()

/** Record changed live observations. Returns the number of new events written. */
export function recordSubagentObservations(
  root: string,
  rows: readonly SubagentRow[],
  at: string,
): Promise<number> {
  if (rows.length === 0) return Promise.resolve(0)
  const previous = recordChains.get(root) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => performRecord(root, rows, at))
  recordChains.set(root, run.catch(() => undefined))
  return run
}

async function performRecord(root: string, rows: readonly SubagentRow[], at: string): Promise<number> {
  await mkdir(segmentsDirectory(root), { recursive: true })
  const manifest = await loadManifest(root)
  const stateFile = path.join(root, "state.json")
  const state = loadState(await readJsonFile(stateFile))

  let sequence = manifest.nextSeq
  const events: SubagentHistoryEvent[] = []
  for (const row of rows) {
    const agent = sanitize(row.agent)
    const model = sanitize(row.model)
    const title = sanitize(row.title)
    const existing = state.entries[row.sessionID]
    if (existing && existing.agent === agent && existing.model === model && existing.title === title && existing.status === row.status) {
      continue
    }
    events.push({
      seq: sequence++,
      sessionID: row.sessionID,
      at,
      agent,
      model,
      title,
      status: row.status,
      firstSeenAt: existing?.firstSeenAt ?? at,
    })
    state.entries[row.sessionID] = { firstSeenAt: existing?.firstSeenAt ?? at, agent, model, title, status: row.status }
  }
  if (events.length === 0) return 0

  const lines = events.map((event) => `${JSON.stringify(event)}\n`)
  for (const line of lines) {
    const bytes = Buffer.byteLength(line)
    if (bytes > SUBAGENT_HISTORY_MAX_EVENT_BYTES) {
      throw new Error(
        `subagent history event exceeds ${SUBAGENT_HISTORY_MAX_EVENT_BYTES} bytes (${bytes}); the observation was not recorded`,
      )
    }
  }

  const pending: Array<{ file: string; body: string }> = []
  let current = manifest.segments[manifest.segments.length - 1]
  let currentExistingBytes = current ? await fileSize(path.join(segmentsDirectory(root), current.file)) : 0
  let body: string[] = []
  let bodyBytes = 0
  const flush = () => {
    if (current && body.length > 0) pending.push({ file: current.file, body: body.join("") })
    body = []
    bodyBytes = 0
  }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    const line = lines[index]!
    const bytes = Buffer.byteLength(line)
    const segmentCount = (current?.count ?? 0) + body.length
    const segmentBytes = (current ? currentExistingBytes : 0) + bodyBytes
    if (!current || segmentCount + 1 > SUBAGENT_HISTORY_SEGMENT_EVENTS || segmentBytes + bytes > SUBAGENT_HISTORY_SEGMENT_BYTES) {
      flush()
      current = { file: `${String(event.seq).padStart(12, "0")}.jsonl`, count: 0, firstSeq: event.seq, lastSeq: event.seq }
      manifest.segments.push(current)
      currentExistingBytes = 0
    }
    body.push(line)
    bodyBytes += bytes
    current.count += 1
    current.firstSeq = Math.min(current.firstSeq, event.seq)
    current.lastSeq = Math.max(current.lastSeq, event.seq)
  }
  flush()

  manifest.nextSeq = sequence
  try {
    for (const write of pending) {
      await appendFile(path.join(segmentsDirectory(root), write.file), write.body, "utf8")
    }
    await writeJsonAtomic(path.join(root, "manifest.json"), manifest)
  } catch (error) {
    // Segment appends may already be durable while the manifest write failed.
    // Rebuild from disk so a later append cannot reuse a sequence number or
    // hide a rotated segment, then surface the failure.
    await writeJsonAtomic(path.join(root, "manifest.json"), await rebuildManifest(root)).catch(() => undefined)
    throw error
  }
  await writeJsonAtomic(stateFile, state)
  return events.length
}

function withinRange(at: string, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && at < from) return false
  if (to !== undefined && at > to) return false
  return true
}

function matchesText(row: { agent: string; model: string; title: string }, text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return true
  const needle = text.toLowerCase()
  return row.agent.toLowerCase().includes(needle) || row.model.toLowerCase().includes(needle) || row.title.toLowerCase().includes(needle)
}

interface ScanResult {
  readonly scanned: number
  readonly truncated: boolean
  readonly exhausted: boolean
  readonly nextBeforeSeq?: number
  readonly segmentsRead: number
}

async function scanEventsNewestFirst(
  root: string,
  manifest: HistoryManifest,
  visit: (event: SubagentHistoryEvent) => boolean,
  maxScan: number,
  beforeSeq?: number,
): Promise<ScanResult> {
  let scanned = 0
  let truncated = false
  let segmentsRead = 0
  for (let index = manifest.segments.length - 1; index >= 0; index -= 1) {
    const segment = manifest.segments[index]!
    // Every event in this segment is newer than the cursor, so skip the file.
    if (beforeSeq !== undefined && segment.firstSeq >= beforeSeq) continue
    segmentsRead += 1
    const bounded = await readBounded(path.join(segmentsDirectory(root), segment.file), READ_CAP_BYTES)
    if (bounded.truncated) truncated = true
    const lines = bounded.text.split("\n")
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const event = parseEventLine(lines[lineIndex]!)
      if (!event) continue
      if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
      scanned += 1
      const keepGoing = visit(event)
      if (!keepGoing) return { scanned, truncated, exhausted: false, nextBeforeSeq: event.seq + 1, segmentsRead }
      if (scanned >= maxScan) return { scanned, truncated: true, exhausted: false, nextBeforeSeq: event.seq, segmentsRead }
    }
  }
  return { scanned, truncated, exhausted: true, segmentsRead }
}

/**
 * Paged, read-only latest-state query. Rows never include session IDs or
 * prompts. It is offset-paged (a cursor would let an item's older event
 * resurface after a newer page) and reports `truncated` instead of implying a
 * bounded page is complete.
 */
export async function querySubagentHistory(root: string, query: SubagentHistoryQuery = {}): Promise<SubagentHistoryPage> {
  const manifest = await loadManifest(root)
  const limit = clampLimit(query.limit)
  const offset = clampOffset(query.offset)
  const maxScan = clampScan(query.maxScan)
  const rows: SubagentHistoryRow[] = []
  const seen = new Set<string>()
  let matched = 0

  const result = await scanEventsNewestFirst(root, manifest, (event) => {
    if (seen.has(event.sessionID)) return true
    seen.add(event.sessionID)
    if (
      (query.status === undefined || event.status === query.status) &&
      matchesText(event, query.text) &&
      withinRange(event.at, query.from, query.to)
    ) {
      if (matched < offset) {
        matched += 1
      } else if (rows.length >= limit) {
        return false
      } else {
        rows.push({
          agent: event.agent,
          model: event.model,
          title: event.title,
          status: event.status,
          firstSeenAt: event.firstSeenAt,
          lastSeenAt: event.at,
        })
        matched += 1
      }
    }
    return true
  }, maxScan)

  return {
    rows,
    offset,
    limit,
    hasMore: !result.exhausted,
    scanned: result.scanned,
    truncated: result.truncated,
    segmentsRead: result.segmentsRead,
  }
}

/**
 * Paged, read-only raw-observation query with a `beforeSeq` continuation
 * cursor. Rows never include session IDs or prompts.
 */
export async function querySubagentHistoryEvents(root: string, query: SubagentHistoryQuery = {}): Promise<SubagentHistoryEventPage> {
  const manifest = await loadManifest(root)
  const limit = clampLimit(query.limit)
  const offset = clampOffset(query.offset)
  const maxScan = clampScan(query.maxScan)
  const beforeSeq = typeof query.beforeSeq === "number" && Number.isFinite(query.beforeSeq) ? Math.floor(query.beforeSeq) : undefined
  const rows: Array<SubagentHistoryEventRow & { seq: number }> = []
  let matched = 0

  const result = await scanEventsNewestFirst(root, manifest, (event) => {
    if (query.status !== undefined && event.status !== query.status) return true
    if (!matchesText(event, query.text)) return true
    if (!withinRange(event.at, query.from, query.to)) return true
    if (matched < offset) {
      matched += 1
      return true
    }
    if (rows.length >= limit) return false
    rows.push({
      seq: event.seq,
      at: event.at,
      agent: event.agent,
      model: event.model,
      title: event.title,
      status: event.status,
      firstSeenAt: event.firstSeenAt,
    })
    matched += 1
    return true
  }, maxScan, beforeSeq)

  const publicRows: SubagentHistoryEventRow[] = rows.map((row) => ({
    at: row.at,
    agent: row.agent,
    model: row.model,
    title: row.title,
    status: row.status,
    firstSeenAt: row.firstSeenAt,
  }))
  return {
    rows: publicRows,
    offset,
    limit,
    hasMore: !result.exhausted,
    scanned: result.scanned,
    truncated: result.truncated,
    segmentsRead: result.segmentsRead,
    ...(result.nextBeforeSeq !== undefined ? { nextBeforeSeq: result.nextBeforeSeq } : {}),
  }
}

/** Bounded, secret-free text for the latest-state history page. */
export function formatSubagentHistoryPage(page: SubagentHistoryPage): string {
  const shown = page.rows.length
  const range = shown === 0 ? "no rows" : `rows ${page.offset + 1}-${page.offset + shown}`
  const more = page.hasMore ? " · more available" : ""
  const truncated = page.truncated ? " · scan truncated, refine the filters" : ""
  const header = `Subagent history: ${range}${more}${truncated}`
  if (shown === 0) return `${header}\nNo matching history.`
  const lines = page.rows.map((row) => `${row.status} · ${row.agent} · ${row.model}: ${row.title} (first seen ${row.firstSeenAt}, last ${row.lastSeenAt})`)
  return `${header}\n${lines.join("\n")}`
}

/** Bounded, secret-free text for the raw-observation page, including its cursor. */
export function formatSubagentHistoryEventsPage(page: SubagentHistoryEventPage): string {
  const shown = page.rows.length
  const range = shown === 0 ? "no rows" : `rows ${page.offset + 1}-${page.offset + shown}`
  const more = page.hasMore ? " · more available" : ""
  const truncated = page.truncated ? " · scan truncated, refine the filters" : ""
  const cursor = page.nextBeforeSeq !== undefined ? `\nnext beforeSeq: ${page.nextBeforeSeq}` : ""
  const header = `Subagent observations: ${range}${more}${truncated}`
  if (shown === 0) return `${header}\nNo matching observations.${cursor}`
  const lines = page.rows.map((row) => `${row.at} · ${row.status} · ${row.agent} · ${row.model}: ${row.title}`)
  return `${header}\n${lines.join("\n")}${cursor}`
}
