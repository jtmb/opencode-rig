import { appendFile, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import type { IdentifiedTodo } from "./identity.ts"
import { todoDataRoot } from "./state.ts"
import type { TodoPriority, TodoStatus } from "./store.ts"

/**
 * Durable, append-only Todo history.
 *
 * Every accepted transition is recorded once as an immutable JSON line in a
 * rotated segment file. History is never pruned or overwritten. Reads are
 * bounded: a page walks the newest segments only and stops at `maxScan` parsed
 * transitions, reporting truncation when it does, and a `beforeSeq` cursor lets
 * a caller continue into older transitions without an unbounded scan.
 *
 * Segment packing splits a batch by serialized UTF-8 byte size and event count,
 * so a segment file never exceeds the size its readers scan. A single event
 * larger than `ARCHIVE_MAX_EVENT_BYTES` is rejected before anything is written.
 */

export type TodoArchiveEventKind = "created" | "status_changed" | "content_changed" | "priority_changed" | "removed"
export type TodoArchiveStatus = TodoStatus | "removed"

export interface TodoArchiveEvent {
  readonly seq: number
  readonly id: string
  readonly sessionID: string
  readonly at: string
  readonly kind: TodoArchiveEventKind
  readonly content: string
  readonly status: TodoArchiveStatus
  readonly previousStatus?: TodoStatus
  readonly priority?: TodoPriority
}

export type TodoArchiveDraft = Omit<TodoArchiveEvent, "seq">

export interface ArchivedTodo {
  readonly id: string
  readonly sessionID: string
  readonly content: string
  readonly status: TodoArchiveStatus
  readonly priority?: TodoPriority
  readonly updatedAt: string
  readonly seq: number
}

export interface TodoArchiveQuery {
  readonly sessionID?: string
  readonly text?: string
  readonly status?: TodoArchiveStatus
  readonly kind?: TodoArchiveEventKind
  readonly from?: string
  readonly to?: string
  readonly offset?: number
  readonly limit?: number
  readonly maxScan?: number
  /** Only consider events with `seq < beforeSeq` (continuation cursor). */
  readonly beforeSeq?: number
}

export interface TodoArchiveEventPage {
  readonly items: readonly TodoArchiveEvent[]
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
  readonly scanned: number
  readonly truncated: boolean
  readonly segmentsRead: number
  /** Pass as `beforeSeq` to continue with the next older page. */
  readonly nextBeforeSeq?: number
}

export interface ArchivedTodoPage {
  readonly items: readonly ArchivedTodo[]
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
  readonly scanned: number
  readonly truncated: boolean
  readonly segmentsRead: number
  readonly hiddenHistory: number
}

export const ARCHIVE_SEGMENT_EVENTS = 200
export const ARCHIVE_SEGMENT_BYTES = 256 * 1024
export const ARCHIVE_MAX_EVENT_BYTES = 64 * 1024
export const ARCHIVE_DEFAULT_PAGE = 20
export const ARCHIVE_MAX_PAGE = 50
export const ARCHIVE_MAX_SCAN = 5_000

const ARCHIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled", "removed"])
const ARCHIVE_KINDS: ReadonlySet<string> = new Set(["created", "status_changed", "content_changed", "priority_changed", "removed"])
const READ_CAP_BYTES = ARCHIVE_SEGMENT_BYTES + ARCHIVE_MAX_EVENT_BYTES

interface SegmentInfo {
  file: string
  count: number
  firstSeq: number
  lastSeq: number
}

interface ArchiveManifest {
  version: 1
  segments: SegmentInfo[]
  nextSeq: number
}

/** Root directory of the durable archive for this launch environment. */
export function todoArchiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(todoDataRoot(env), "archive")
}

/** Whether an untrusted value is a recorded archive status. */
export function isTodoArchiveStatus(value: unknown): value is TodoArchiveStatus {
  return typeof value === "string" && ARCHIVE_STATUSES.has(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function manifestPath(root: string): string {
  return path.join(root, "manifest.json")
}

function segmentsDirectory(root: string): string {
  return path.join(root, "segments")
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return ARCHIVE_DEFAULT_PAGE
  return Math.min(ARCHIVE_MAX_PAGE, Math.max(1, Math.floor(limit)))
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

function clampScan(maxScan: number | undefined): number {
  if (typeof maxScan !== "number" || !Number.isFinite(maxScan)) return ARCHIVE_MAX_SCAN
  return Math.min(ARCHIVE_MAX_SCAN, Math.max(1, Math.floor(maxScan)))
}

/**
 * Append-only transition diff between two identified lists. Identity comes
 * from the persisted per-item ids, never from the task text, so duplicate
 * contents stay distinct and an edited task keeps its id.
 */
export function diffTodoTransitions(
  previous: readonly IdentifiedTodo[],
  next: readonly IdentifiedTodo[],
  sessionID: string,
  at: string,
): TodoArchiveDraft[] {
  const previousById = new Map<string, IdentifiedTodo>()
  for (const item of previous) previousById.set(item.id, item)

  const drafts: TodoArchiveDraft[] = []
  const seen = new Set<string>()
  for (const item of next) {
    seen.add(item.id)
    const prior = previousById.get(item.id)
    if (!prior) {
      drafts.push({
        id: item.id,
        sessionID,
        at,
        kind: "created",
        content: item.content,
        status: item.status,
        ...(item.priority ? { priority: item.priority } : {}),
      })
      continue
    }
    const statusChanged = prior.status !== item.status
    const contentChanged = prior.content !== item.content
    const priorityChanged = (prior.priority ?? undefined) !== (item.priority ?? undefined)
    if (!statusChanged && !contentChanged && !priorityChanged) continue
    drafts.push({
      id: item.id,
      sessionID,
      at,
      kind: statusChanged ? "status_changed" : contentChanged ? "content_changed" : "priority_changed",
      content: item.content,
      status: item.status,
      ...(statusChanged ? { previousStatus: prior.status } : {}),
      ...(item.priority ? { priority: item.priority } : {}),
    })
  }
  for (const item of previous) {
    if (seen.has(item.id)) continue
    drafts.push({
      id: item.id,
      sessionID,
      at,
      kind: "removed",
      content: item.content,
      status: "removed",
      previousStatus: item.status,
      ...(item.priority ? { priority: item.priority } : {}),
    })
  }
  return drafts
}

/** Replay chronological events into the latest record for each stable id. */
export function materializeArchivedTodos(events: readonly TodoArchiveEvent[]): ArchivedTodo[] {
  const byId = new Map<string, ArchivedTodo>()
  for (const event of events) {
    byId.set(event.id, {
      id: event.id,
      sessionID: event.sessionID,
      content: event.content,
      status: event.status,
      ...(event.priority ? { priority: event.priority } : {}),
      updatedAt: event.at,
      seq: event.seq,
    })
  }
  return [...byId.values()]
}

function parseEventLine(line: string): TodoArchiveEvent | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const { seq, id, sessionID, at, kind, content, status } = raw
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return undefined
  if (typeof id !== "string" || !id) return undefined
  if (typeof sessionID !== "string" || !sessionID) return undefined
  if (typeof at !== "string" || !at) return undefined
  if (typeof kind !== "string" || !ARCHIVE_KINDS.has(kind)) return undefined
  if (typeof content !== "string" || !content) return undefined
  if (typeof status !== "string" || !ARCHIVE_STATUSES.has(status)) return undefined
  const previousStatus = typeof raw.previousStatus === "string" && ARCHIVE_STATUSES.has(raw.previousStatus) && raw.previousStatus !== "removed"
    ? (raw.previousStatus as TodoStatus)
    : undefined
  const priority = typeof raw.priority === "string" && (raw.priority === "high" || raw.priority === "medium" || raw.priority === "low")
    ? (raw.priority as TodoPriority)
    : undefined
  return {
    seq,
    id,
    sessionID,
    at,
    kind: kind as TodoArchiveEventKind,
    content,
    status: status as TodoArchiveStatus,
    ...(previousStatus ? { previousStatus } : {}),
    ...(priority ? { priority } : {}),
  }
}

async function fileSize(file: string): Promise<number> {
  return (await stat(file).catch(() => undefined))?.size ?? 0
}

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

/** Read at most `cap` bytes from the end of a file. */
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

async function scanSegment(file: string): Promise<{ count: number; firstSeq: number; lastSeq: number; truncated: boolean } | undefined> {
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
  return { count, firstSeq: count > 0 ? firstSeq : 0, lastSeq, truncated }
}

async function rebuildManifest(root: string): Promise<ArchiveManifest> {
  const directory = segmentsDirectory(root)
  const files = await readdir(directory).catch(() => [] as string[])
  const segments: SegmentInfo[] = []
  for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
    const scanned = await scanSegment(path.join(directory, file))
    if (scanned) segments.push({ file, count: scanned.count, firstSeq: scanned.firstSeq, lastSeq: scanned.lastSeq })
  }
  segments.sort((left, right) => left.firstSeq - right.firstSeq)
  const lastSeq = segments.reduce((maximum, segment) => Math.max(maximum, segment.lastSeq), 0)
  return { version: 1, segments, nextSeq: lastSeq + 1 }
}

function isManifest(value: unknown): value is ArchiveManifest {
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

async function readFileUtf8(file: string): Promise<string | undefined> {
  const handle = await open(file, "r").catch(() => undefined)
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (info.size > ARCHIVE_SEGMENT_BYTES * 8) return undefined
    const buffer = Buffer.alloc(Number(info.size))
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString("utf8")
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function loadManifest(root: string): Promise<ArchiveManifest> {
  const raw = await readFileUtf8(manifestPath(root))
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isManifest(parsed) && await manifestMatchesDisk(root, parsed)) return parsed
    } catch {
      // Corrupt manifest: rebuild from the immutable segment files below.
    }
  }
  return rebuildManifest(root)
}

/**
 * A manifest is only reused when it still agrees with the immutable segments.
 * This catches a stale manifest left behind by a failed manifest write (an
 * unlisted rotated segment, or a `nextSeq` at or behind the active segment's
 * tail) so the next append cannot reuse a sequence number or hide a tail.
 */
async function manifestMatchesDisk(root: string, manifest: ArchiveManifest): Promise<boolean> {
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

async function writeManifest(root: string, manifest: ArchiveManifest): Promise<void> {
  await mkdir(root, { recursive: true })
  const target = manifestPath(root)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await rename(temporary, target)
}

const appendChains = new Map<string, Promise<unknown>>()

/** Append transition drafts under a per-root lock. Returns the number recorded. */
export function appendTodoTransitions(root: string, drafts: readonly TodoArchiveDraft[]): Promise<number> {
  if (drafts.length === 0) return Promise.resolve(0)
  const previous = appendChains.get(root) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(() => performAppend(root, drafts))
  appendChains.set(root, run.catch(() => undefined))
  return run
}

interface PendingWrite {
  readonly file: string
  readonly body: string
}

async function performAppend(root: string, drafts: readonly TodoArchiveDraft[]): Promise<number> {
  await mkdir(segmentsDirectory(root), { recursive: true })
  const manifest = await loadManifest(root)

  let sequence = manifest.nextSeq
  const events: TodoArchiveEvent[] = drafts.map((draft) => ({ seq: sequence++, ...draft }))
  const lines: string[] = events.map((event) => `${JSON.stringify(event)}\n`)
  for (let index = 0; index < lines.length; index += 1) {
    const bytes = Buffer.byteLength(lines[index]!)
    if (bytes > ARCHIVE_MAX_EVENT_BYTES) {
      throw new Error(
        `todo archive event exceeds ${ARCHIVE_MAX_EVENT_BYTES} bytes (${bytes}); shorten the task text or split it into smaller items`,
      )
    }
  }

  const pending: PendingWrite[] = []
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
    if (!current || segmentCount + 1 > ARCHIVE_SEGMENT_EVENTS || segmentBytes + bytes > ARCHIVE_SEGMENT_BYTES) {
      flush()
      current = {
        file: `${String(event.seq).padStart(12, "0")}.jsonl`,
        count: 0,
        firstSeq: event.seq,
        lastSeq: event.seq,
      }
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
    await writeManifest(root, manifest)
  } catch (error) {
    // The segment appends may already be durable while the manifest write
    // failed. Rebuild the manifest from disk so a later append cannot reuse a
    // sequence number or hide a rotated segment, then surface the failure.
    await writeManifest(root, await rebuildManifest(root)).catch(() => undefined)
    throw error
  }
  return events.length
}

interface ScanResult {
  readonly scanned: number
  readonly truncated: boolean
  /** True when the scan reached the oldest event instead of stopping early. */
  readonly exhausted: boolean
  /** Continuation cursor for the next older page, derived from the scan itself. */
  readonly nextBeforeSeq?: number
  /** Number of segment files actually read (newer segments past the cursor are skipped). */
  readonly segmentsRead: number
}

async function scanNewestFirst(
  root: string,
  manifest: ArchiveManifest,
  visit: (event: TodoArchiveEvent) => boolean,
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
      // The continuation cursor excludes newer events without spending the
      // bounded scan budget on them, so older pages stay reachable.
      if (beforeSeq !== undefined && event.seq >= beforeSeq) continue
      scanned += 1
      const keepGoing = visit(event)
      // A page-boundary stop leaves the pending event for the next page.
      if (!keepGoing) return { scanned, truncated, exhausted: false, nextBeforeSeq: event.seq + 1, segmentsRead }
      // A bounded-scan stop has already examined this event.
      if (scanned >= maxScan) return { scanned, truncated: true, exhausted: false, nextBeforeSeq: event.seq, segmentsRead }
    }
  }
  return { scanned, truncated, exhausted: true, segmentsRead }
}

function withinRange(at: string, from: string | undefined, to: string | undefined): boolean {
  if (from !== undefined && at < from) return false
  if (to !== undefined && at > to) return false
  return true
}

function matchesContent(content: string, text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return true
  return content.toLowerCase().includes(text.toLowerCase())
}

/** Paged, read-only query over raw append-only transitions. */
export async function queryTodoEvents(root: string, query: TodoArchiveQuery = {}): Promise<TodoArchiveEventPage> {
  const manifest = await loadManifest(root)
  const limit = clampLimit(query.limit)
  const offset = clampOffset(query.offset)
  const maxScan = clampScan(query.maxScan)
  const beforeSeq = typeof query.beforeSeq === "number" && Number.isFinite(query.beforeSeq) ? Math.floor(query.beforeSeq) : undefined
  const items: TodoArchiveEvent[] = []
  let matched = 0

  const result = await scanNewestFirst(root, manifest, (event) => {
    if (query.sessionID !== undefined && event.sessionID !== query.sessionID) return true
    if (query.kind !== undefined && event.kind !== query.kind) return true
    if (query.status !== undefined && event.status !== query.status) return true
    if (!matchesContent(event.content, query.text)) return true
    if (!withinRange(event.at, query.from, query.to)) return true
    if (matched < offset) {
      matched += 1
      return true
    }
    if (items.length >= limit) return false
    items.push(event)
    matched += 1
    return true
  }, maxScan, beforeSeq)

  return {
    items,
    offset,
    limit,
    hasMore: !result.exhausted,
    scanned: result.scanned,
    truncated: result.truncated,
    segmentsRead: result.segmentsRead,
    ...(result.nextBeforeSeq !== undefined ? { nextBeforeSeq: result.nextBeforeSeq } : {}),
  }
}

/** Paged, read-only query over the latest recorded state of each Todo item. */
export async function queryArchivedTodos(root: string, query: TodoArchiveQuery = {}): Promise<ArchivedTodoPage> {
  const manifest = await loadManifest(root)
  const limit = clampLimit(query.limit)
  const offset = clampOffset(query.offset)
  const maxScan = clampScan(query.maxScan)
  const items: ArchivedTodo[] = []
  const seen = new Set<string>()
  let matched = 0
  let hiddenHistory = 0

  // The materialized view is deduped by item, so a sequence cursor would let an
  // item's older event resurface after its newer page; it is offset-paged and
  // reports `truncated` truthfully instead.
  const result = await scanNewestFirst(root, manifest, (event) => {
    if (seen.has(event.id)) return true
    seen.add(event.id)
    if (query.sessionID !== undefined && event.sessionID !== query.sessionID) return true
    if (query.status !== undefined && event.status !== query.status) return true
    if (!matchesContent(event.content, query.text)) return true
    if (!withinRange(event.at, query.from, query.to)) return true
    if (event.status === "completed" || event.status === "cancelled" || event.status === "removed") hiddenHistory += 1
    if (matched < offset) {
      matched += 1
      return true
    }
    if (items.length >= limit) return false
    items.push({
      id: event.id,
      sessionID: event.sessionID,
      content: event.content,
      status: event.status,
      ...(event.priority ? { priority: event.priority } : {}),
      updatedAt: event.at,
      seq: event.seq,
    })
    matched += 1
    return true
  }, maxScan)

  return {
    items,
    offset,
    limit,
    hasMore: !result.exhausted,
    scanned: result.scanned,
    truncated: result.truncated,
    segmentsRead: result.segmentsRead,
    hiddenHistory,
  }
}

function archivePageHeader(
  page: { readonly items: readonly unknown[]; readonly offset: number; readonly hasMore: boolean; readonly truncated: boolean },
  label: string,
): string {
  const shown = page.items.length
  const range = shown === 0 ? "no rows" : `rows ${page.offset + 1}-${page.offset + shown}`
  const more = page.hasMore ? " · more available" : ""
  const truncated = page.truncated ? " · scan truncated, refine the filters" : ""
  return `${label}: ${range}${more}${truncated}`
}

function statusMarker(status: TodoArchiveStatus): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[~]"
  if (status === "cancelled" || status === "removed") return "[-]"
  return "[ ]"
}

/** Bounded, secret-free text for the archived-todo page. */
export function formatArchivedTodoPage(page: ArchivedTodoPage): string {
  const header = archivePageHeader(page, "Archived todos")
  const note = page.truncated ? "\nBounded scan: older items exist beyond the scanned window; refine the filters." : ""
  if (page.items.length === 0) return `${header}\nNo matching archived todos.${note}`
  const lines = page.items.map((todo) =>
    `${statusMarker(todo.status)} ${todo.content} (${todo.status}) · ${todo.updatedAt}`,
  )
  return `${header}\n${lines.join("\n")}${note}`
}

/** Bounded text for the raw transition-event page, including its cursor. */
export function formatTodoEventPage(page: TodoArchiveEventPage): string {
  const header = archivePageHeader(page, "Todo transitions")
  const cursor = page.nextBeforeSeq !== undefined ? `\nnext beforeSeq: ${page.nextBeforeSeq}` : ""
  if (page.items.length === 0) return `${header}\nNo matching transitions.${cursor}`
  const lines = page.items.map((event) => {
    const transition = event.previousStatus ? `${event.previousStatus} -> ${event.status}` : event.status
    return `${event.seq} · ${event.at} · ${event.kind}: ${event.content} (${transition})`
  })
  return `${header}\n${lines.join("\n")}${cursor}`
}
