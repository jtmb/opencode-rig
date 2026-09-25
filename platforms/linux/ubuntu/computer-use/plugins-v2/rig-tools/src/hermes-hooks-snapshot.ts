import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

export const HERMES_HOOK_NAMES = [
  "on_session_start",
  "on_session_end",
  "on_session_finalize",
  "on_session_reset",
  "pre_llm_call",
  "post_llm_call",
  "pre_api_request",
  "post_api_request",
  "api_request_error",
  "pre_auxiliary_call",
  "post_auxiliary_call",
  "pre_tool_call",
  "post_tool_call",
  "subagent_start",
  "subagent_stop",
] as const

export const HERMES_HOOK_EVENT_LIMIT = 128
export const HERMES_HOOK_SNAPSHOT_MAX_BYTES = 128 * 1024

const HOOK_NAME_SET: ReadonlySet<string> = new Set(HERMES_HOOK_NAMES)
const STATUS_VALUES = ["started", "ok", "error", "blocked", "cancelled", "completed", "interrupted", "unknown"] as const
const STATUS_SET: ReadonlySet<string> = new Set(STATUS_VALUES)
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,63}$/
const SAFE_REFERENCE = /^[a-f0-9]{12}$/

export type HermesHookName = (typeof HERMES_HOOK_NAMES)[number]
export type HermesHookStatus = (typeof STATUS_VALUES)[number]
export type HermesSnapshotState = "ready" | "empty" | "unavailable" | "invalid"

export type HermesHookEvent = {
  at: string
  hook: HermesHookName
  status: HermesHookStatus
  durationMs?: number
  model?: string
  provider?: string
  tool?: string
  auxTask?: string
  surface?: string
  sessionRef?: string
  turnRef?: string
  requestRef?: string
  toolRef?: string
}

export type HermesHookSnapshot = {
  schemaVersion: 1
  state: HermesSnapshotState
  updatedAt: string
  events: HermesHookEvent[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function optionalLabel(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_LABEL.test(value) ? value : undefined
}

function optionalReference(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_REFERENCE.test(value) ? value : undefined
}

function optionalDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3_600_000
    ? value
    : undefined
}

export function emptyHermesHookSnapshot(state: HermesSnapshotState = "empty"): HermesHookSnapshot {
  return { schemaVersion: 1, state, updatedAt: "", events: [] }
}

export function parseHermesHookSnapshot(value: unknown): HermesHookSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.events)) {
    return emptyHermesHookSnapshot("invalid")
  }

  const events: HermesHookEvent[] = []
  for (const candidate of value.events.slice(-HERMES_HOOK_EVENT_LIMIT)) {
    if (!isRecord(candidate) || typeof candidate.hook !== "string" || !HOOK_NAME_SET.has(candidate.hook) || !isTimestamp(candidate.at)) continue
    if (typeof candidate.status !== "string" || !STATUS_SET.has(candidate.status)) continue

    const event: HermesHookEvent = {
      at: candidate.at,
      hook: candidate.hook as HermesHookName,
      status: candidate.status as HermesHookStatus,
    }
    const durationMs = optionalDuration(candidate.durationMs)
    if (durationMs !== undefined) event.durationMs = durationMs
    for (const field of ["model", "provider", "tool", "auxTask", "surface"] as const) {
      const label = optionalLabel(candidate[field])
      if (label !== undefined) event[field] = label
    }
    for (const field of ["sessionRef", "turnRef", "requestRef", "toolRef"] as const) {
      const reference = optionalReference(candidate[field])
      if (reference !== undefined) event[field] = reference
    }
    events.push(event)
  }

  const updatedAt = isTimestamp(value.updatedAt) ? value.updatedAt : events.at(-1)?.at ?? ""
  return {
    schemaVersion: 1,
    state: events.length ? "ready" : "empty",
    updatedAt,
    events,
  }
}

export function hermesHookSnapshotPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | undefined {
  const configured = env.OPEN_RIG_HERMES_TELEMETRY_FILE?.trim()
  if (configured) return isAbsolute(configured) ? resolve(configured) : undefined

  const hermesHome = env.HERMES_HOME?.trim()
  if (hermesHome && !isAbsolute(hermesHome)) return undefined
  const root = hermesHome ? resolve(hermesHome) : resolve(home, ".hermes")
  return join(root, "logs", "open-rig-hooks.snapshot.json")
}

export function limitHermesHookSnapshot(snapshot: HermesHookSnapshot, requestedLimit?: number): HermesHookSnapshot {
  const limit = typeof requestedLimit === "number" && Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(HERMES_HOOK_EVENT_LIMIT, requestedLimit))
    : HERMES_HOOK_EVENT_LIMIT
  const events = snapshot.events.slice(-limit)
  return { ...snapshot, state: events.length ? "ready" : snapshot.state === "ready" ? "empty" : snapshot.state, events }
}

export async function readHermesHookSnapshot(path: string | undefined): Promise<HermesHookSnapshot> {
  if (!path || !isAbsolute(path)) return emptyHermesHookSnapshot("unavailable")

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = await handle.stat()
    if (!metadata.isFile()) return emptyHermesHookSnapshot("invalid")
    if (metadata.size > HERMES_HOOK_SNAPSHOT_MAX_BYTES) return emptyHermesHookSnapshot("invalid")

    const buffer = Buffer.alloc(HERMES_HOOK_SNAPSHOT_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > HERMES_HOOK_SNAPSHOT_MAX_BYTES) return emptyHermesHookSnapshot("invalid")

    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.subarray(0, length).toString("utf8"))
    } catch {
      return emptyHermesHookSnapshot("invalid")
    }
    return parseHermesHookSnapshot(parsed)
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyHermesHookSnapshot()
    return emptyHermesHookSnapshot("unavailable")
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
