// storage-state.ts — bounded operational state for repo-learning observation.
//
// State lives in ctx.storage (operational only, never learning content).
// Episodes are structured summaries with fixed schemas, UTF-8 byte/count caps,
// and 30-day retention. All parsing and mutation is fail-closed: invalid
// input throws, over-cap state is rejected at the storage boundary, and
// pruning is deterministic and oldest-first.

import { redactText } from "./redact.ts"

/** Episodes older than this are pruned (30 days in milliseconds). */
export const EPISODE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Maximum episodes retained in operational state. */
export const MAX_EPISODES = 200

/** Maximum UTF-8 bytes in an episode id or session id. */
export const MAX_ID_BYTES = 256

/** Maximum UTF-8 bytes in a session id. */
export const MAX_SESSION_ID_BYTES = 128

/** Maximum characters in a stored episode summary (legacy/API name). */
export const MAX_SUMMARY_CHARS = 2000

/** Maximum UTF-8 bytes in a stored episode summary. */
export const MAX_SUMMARY_BYTES = 2000

/** Maximum accepted event count represented by one episode. */
export const MAX_EPISODE_EVENTS = 512

/** Maximum serialized state size accepted by parseState (512 KiB). */
export const MAX_STATE_BYTES = 512 * 1024

/** Schema version for forward-compatible fail-closed parsing. */
export const LEARN_STATE_SCHEMA = 1

const UTF8_ENCODER = new TextEncoder()
const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/
const SAFE_EPISODE_ID = /^[A-Za-z0-9_.-]+$/
const EPISODE_KEYS = ["id", "sessionID", "startedAt", "endedAt", "toolCalls", "errors", "summary"]
const STATE_KEYS = ["schema", "paused", "episodes"]

export type EpisodeSummary = {
  id: string
  sessionID: string
  startedAt: number
  endedAt: number
  toolCalls: number
  errors: number
  summary: string
}

export type LearnState = {
  schema: number
  paused: boolean
  episodes: EpisodeSummary[]
}

/** Return the UTF-8 byte length, rather than the JavaScript UTF-16 length. */
export function utf8ByteLength(value: string): number {
  if (typeof value !== "string") throw new Error("utf8ByteLength requires a string")
  return UTF8_ENCODER.encode(value).byteLength
}

/** Truncate at a UTF-8 boundary without creating an invalid string. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error("truncateUtf8 requires a string")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("truncateUtf8 requires a valid maxBytes")
  if (utf8ByteLength(value) <= maxBytes) return value
  let output = ""
  let used = 0
  for (const character of value) {
    const size = utf8ByteLength(character)
    if (used + size > maxBytes) break
    output += character
    used += size
  }
  return output
}

export function createInitialState(): LearnState {
  return { schema: LEARN_STATE_SCHEMA, paused: false, episodes: [] }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isSafeInteger(value: unknown, maximum?: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (maximum === undefined || value <= maximum)
  )
}

function isSafeId(value: unknown, maximumBytes: number, pattern: RegExp): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    utf8ByteLength(value) <= maximumBytes &&
    pattern.test(value)
  )
}

function isValidEpisode(value: unknown): value is EpisodeSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const episode = value as Record<string, unknown>
  return (
    hasExactKeys(episode, EPISODE_KEYS) &&
    isSafeId(episode["id"], MAX_ID_BYTES, SAFE_EPISODE_ID) &&
    isSafeId(episode["sessionID"], MAX_SESSION_ID_BYTES, SAFE_SESSION_ID) &&
    isSafeInteger(episode["startedAt"]) &&
    isSafeInteger(episode["endedAt"]) &&
    (episode["endedAt"] as number) >= (episode["startedAt"] as number) &&
    isSafeInteger(episode["toolCalls"], MAX_EPISODE_EVENTS) &&
    isSafeInteger(episode["errors"], MAX_EPISODE_EVENTS) &&
    typeof episode["summary"] === "string" &&
    (episode["summary"] as string).length <= MAX_SUMMARY_CHARS &&
    utf8ByteLength(episode["summary"] as string) <= MAX_SUMMARY_BYTES &&
    !(episode["summary"] as string).includes("\u0000")
  )
}

function normalizeEpisode(value: unknown): EpisodeSummary {
  if (!isValidEpisode(value)) throw new Error("invalid episode")
  const episode = value as EpisodeSummary
  const summary = redactText(episode.summary)
  if (summary.length > MAX_SUMMARY_CHARS || utf8ByteLength(summary) > MAX_SUMMARY_BYTES) {
    throw new Error("invalid episode summary")
  }
  return {
    id: episode.id,
    sessionID: episode.sessionID,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    toolCalls: episode.toolCalls,
    errors: episode.errors,
    summary,
  }
}

function normalizeState(value: unknown): LearnState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid LearnState")
  }
  const state = value as Record<string, unknown>
  if (
    !hasExactKeys(state, STATE_KEYS) ||
    state["schema"] !== LEARN_STATE_SCHEMA ||
    typeof state["paused"] !== "boolean" ||
    !Array.isArray(state["episodes"]) ||
    state["episodes"].length > MAX_EPISODES
  ) {
    throw new Error("invalid LearnState")
  }
  const episodes = state["episodes"] as unknown[]
  for (let index = 0; index < episodes.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(episodes, index)) throw new Error("invalid LearnState")
  }
  return {
    schema: LEARN_STATE_SCHEMA,
    paused: state["paused"],
    episodes: episodes.map((episode) => normalizeEpisode(episode)),
  }
}

/**
 * Add one validated episode summary. The summary is redacted before storage.
 * Enforces count cap (oldest-first eviction) and throws on invalid input.
 */
export function addEpisode(state: LearnState, episode: EpisodeSummary): LearnState {
  const current = normalizeState(state)
  const stored = normalizeEpisode(episode)
  const episodes = [...current.episodes, stored]
  while (episodes.length > MAX_EPISODES) episodes.shift()
  return { schema: LEARN_STATE_SCHEMA, paused: current.paused, episodes }
}

/**
 * Drop episodes older than EPISODE_RETENTION_MS relative to `nowMs`.
 * Returns a new state; never mutates. Throws on invalid time.
 */
export function pruneEpisodes(state: LearnState, nowMs: number): LearnState {
  if (!isSafeInteger(nowMs)) throw new Error("pruneEpisodes requires a valid nowMs")
  const current = normalizeState(state)
  const cutoff = nowMs - EPISODE_RETENTION_MS
  return {
    schema: LEARN_STATE_SCHEMA,
    paused: current.paused,
    episodes: current.episodes.filter((episode) => episode.endedAt >= cutoff),
  }
}

/** Serialize state for ctx.storage. Throws when the UTF-8 payload exceeds the byte cap. */
export function serializeState(state: LearnState): string {
  let raw: string
  try {
    raw = JSON.stringify(state)
  } catch {
    throw new Error("serializeState rejected an unserializable state")
  }
  if (typeof raw !== "string") throw new Error("serializeState rejected an invalid state")
  if (utf8ByteLength(raw) > MAX_STATE_BYTES) throw new Error(`LearnState exceeds ${MAX_STATE_BYTES} bytes`)
  const normalized = normalizeState(state)
  const text = JSON.stringify(normalized)
  if (utf8ByteLength(text) > MAX_STATE_BYTES) throw new Error(`LearnState exceeds ${MAX_STATE_BYTES} bytes`)
  return text
}

/**
 * Parse stored state. Fail-closed: any schema, count, or nested bound
 * violation throws. Supplying `nowMs` makes parsing a retention boundary too.
 */
export function parseState(text: string, nowMs?: number): LearnState {
  if (typeof text !== "string" || text.length === 0 || utf8ByteLength(text) > MAX_STATE_BYTES) {
    throw new Error("parseState rejected invalid state payload")
  }
  if (nowMs !== undefined && (!Number.isSafeInteger(nowMs) || nowMs < 0)) {
    throw new Error("parseState requires a valid nowMs")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error("parseState rejected malformed JSON")
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("parseState rejected a non-object state")
  }
  const state = parsed as Record<string, unknown>
  if (state["schema"] !== LEARN_STATE_SCHEMA) throw new Error("parseState rejected an unknown schema version")
  if (typeof state["paused"] !== "boolean") throw new Error("parseState rejected an invalid paused flag")
  if (!Array.isArray(state["episodes"]) || state["episodes"].length > MAX_EPISODES || !state["episodes"].every(isValidEpisode)) {
    throw new Error("parseState rejected invalid episodes")
  }
  try {
    const normalized = normalizeState(state)
    return nowMs === undefined ? normalized : pruneEpisodes(normalized, nowMs)
  } catch {
    throw new Error("parseState rejected invalid state bounds")
  }
}

/** Load state and apply retention before the caller uses or persists it. */
export function loadState(text: string, nowMs: number): LearnState {
  return parseState(text, nowMs)
}
