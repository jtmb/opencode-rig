// recorder.ts — RLE observe/record vertical slice (observation only).
//
// Explicitly enabled observation with persistent status; structured summaries
// only, never raw transcripts. Recording aggregates per-session tool events
// into bounded episode summaries (see storage-state.ts). No learning,
// synthesis, promotion, or rule optimization happens here — those are later
// slices and stay unimplemented.
//
// Mutation rule: the pause flag is the only writable field, and it changes
// only through a random, server-held, state-bound approval token. /learn
// status and /learn audit are read-only apart from retention housekeeping.

import { createHash, randomBytes } from "node:crypto"

import { redactText } from "./redact.ts"
import {
  addEpisode,
  createInitialState,
  MAX_EPISODE_EVENTS,
  MAX_ID_BYTES,
  MAX_SESSION_ID_BYTES,
  MAX_SUMMARY_BYTES,
  pruneEpisodes,
  truncateUtf8,
  utf8ByteLength,
  type EpisodeSummary,
  type LearnState,
} from "./storage-state.ts"

/** Fixed event schema accepted from session.execution/tool subscriptions. */
export type ObservedEvent = {
  kind: "tool" | "execution"
  name: string
  sessionID: string
  timestamp: number
  ok: boolean
  detail?: string
}

/** Convert only metadata-only OpenCode events; inputs, outputs, and error text
 * never cross into recorder state. */
export function toObservedEvent(input: unknown): ObservedEvent | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const event = input as Record<string, unknown>
  const data = event.data
  if (typeof event.type !== "string" || !Number.isSafeInteger(event.created) || data === null || typeof data !== "object" || Array.isArray(data)) {
    return undefined
  }
  const fields = data as Record<string, unknown>
  if (typeof fields.sessionID !== "string") return undefined
  if (event.type === "session.tool.input.started" && typeof fields.name === "string") {
    return { kind: "tool", name: fields.name, sessionID: fields.sessionID, timestamp: event.created as number, ok: true }
  }
  const executions: Record<string, { name: string; ok: boolean }> = {
    "session.execution.succeeded": { name: "succeeded", ok: true },
    "session.execution.failed": { name: "failed", ok: false },
    "session.execution.interrupted": { name: "interrupted", ok: false },
    "session.tool.failed": { name: "tool-failed", ok: false },
  }
  const execution = executions[event.type]
  return execution === undefined
    ? undefined
    : { kind: "execution", ...execution, sessionID: fields.sessionID, timestamp: event.created as number }
}

/** Maximum UTF-8 bytes accepted for a tool/execution name. */
export const MAX_EVENT_NAME_BYTES = 128

/** Maximum UTF-8 bytes accepted for an event session id. */
export const MAX_EVENT_SESSION_ID_BYTES = MAX_SESSION_ID_BYTES

/** Maximum UTF-8 bytes accepted for event detail before redaction. */
export const MAX_EVENT_DETAIL_BYTES = 1024

/** Compatibility name retained for callers; enforcement is by UTF-8 bytes. */
export const MAX_EVENT_DETAIL_CHARS = MAX_EVENT_DETAIL_BYTES

/** Maximum pending sessions retained in memory. New sessions are dropped at the cap. */
export const MAX_PENDING_SESSIONS = 64

/** Maximum accepted events represented by one pending session/episode. */
export const MAX_EVENTS_PER_SESSION = MAX_EPISODE_EVENTS

/** Maximum distinct `kind:name` values retained per pending session. */
export const MAX_EVENT_KINDS = 32

/** Maximum accounted UTF-8 bytes across all pending session inputs. */
export const MAX_PENDING_BYTES = 256 * 1024

/** Maximum command string accepted by the recorder command shim. */
export const MAX_COMMAND_BYTES = 512

/** Events idle longer than this gap are treated as a new episode (15 min). */
export const EPISODE_IDLE_GAP_MS = 15 * 60 * 1000

/** Pause preview tokens expire after this long (5 min). */
export const PAUSE_TOKEN_TTL_MS = 5 * 60 * 1000

/** Maximum outstanding pause previews; oldest entries are evicted deterministically. */
export const MAX_PAUSE_TOKENS = 64

/** Outcome of recordEvent: stored or dropped with a machine-readable reason. */
export type RecordOutcome =
  | { stored: true; sessionID: string }
  | {
      stored: false
      reason:
        | "paused"
        | "invalid-event"
        | "idle-heartbeat"
        | "over-cap-detail"
        | "over-cap-name"
        | "over-cap-session"
        | "over-cap-events"
        | "over-cap-kinds"
        | "over-cap-sessions"
        | "over-cap-pending-bytes"
    }

/** Minimal structural bus so tests can subscribe without plugin types. */
export type EventBus = {
  subscribe: (topic: "session.execution" | "session.tool", handler: (event: unknown) => void) => void
}

export type PauseIdentity = {
  sessionID: string
  agentID: string
}

export type PauseIntent = {
  action: "pause"
  paused: boolean
}

export type PausePreview = {
  dryRun: true
  intent: PauseIntent
  /** Preferred name used by the other RLE approval gates. */
  expectToken: string
  /** Compatibility alias; it contains the same opaque random token. */
  token: string
  expiresAt: number
}

export type PauseApplyInput = {
  expectToken?: string
  /** Human/host approval must be explicitly true. */
  approval?: boolean
  /** Accepted as an explicit-apply alias for the neighboring RLE gates. */
  apply?: boolean
}

export type LearnCommandContext = PauseIdentity & {
  approval?: boolean
  apply?: boolean
}

type PendingSession = {
  sessionID: string
  startedAt: number
  lastAt: number
  eventCount: number
  pendingBytes: number
  toolCalls: number
  errors: number
  kinds: Set<string>
}

type PauseToken = {
  token: string
  sessionID: string
  agentID: string
  intentDigest: string
  stateDigest: string
  desired: boolean
  expiresAt: number
}

type EventValidation =
  | { event: ObservedEvent }
  | { reason: Extract<RecordOutcome, { stored: false }>["reason"] }

const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]+$/
const SAFE_EVENT_NAME = /^[A-Za-z0-9_.:/-]+$/
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const CONTROL_REPLACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const EVENT_KEYS = ["kind", "name", "sessionID", "timestamp", "ok"]
const EVENT_KEYS_WITH_DETAIL = [...EVENT_KEYS, "detail"]

function hasExpectedEventKeys(candidate: Record<string, unknown>): boolean {
  const keys = Object.keys(candidate).sort()
  const expected = (Object.prototype.hasOwnProperty.call(candidate, "detail") ? EVENT_KEYS_WITH_DETAIL : EVENT_KEYS).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function isValidNow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function assertNow(value: number, operation: string): void {
  if (!isValidNow(value)) throw new Error(`${operation} requires a valid nowMs`)
}

function isBoundedText(value: unknown, maximumBytes: number, pattern?: RegExp): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    utf8ByteLength(value) <= maximumBytes &&
    !CONTROL_EXCEPT_WHITESPACE.test(value) &&
    (pattern === undefined || pattern.test(value))
  )
}

function isSafeEventIdentity(value: string, maximumBytes: number, pattern: RegExp): boolean {
  if (!isBoundedText(value, maximumBytes, pattern)) return false
  // Identity fields are used in pending keys and episode ids. Reject a known
  // secret rather than storing a partially redacted identity in operational state.
  return redactText(value) === value
}

function validateObservedEvent(input: unknown): EventValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { reason: "invalid-event" }
  const candidate = input as Record<string, unknown>
  try {
    if (!hasExpectedEventKeys(candidate)) return { reason: "invalid-event" }
    const kind = candidate["kind"]
    const name = candidate["name"]
    const sessionID = candidate["sessionID"]
    const timestamp = candidate["timestamp"]
    const ok = candidate["ok"]
    const detail = candidate["detail"]
    if (kind !== "tool" && kind !== "execution") return { reason: "invalid-event" }
    if (typeof name !== "string" || !isSafeEventIdentity(name, MAX_EVENT_NAME_BYTES, SAFE_EVENT_NAME)) {
      if (typeof name === "string" && utf8ByteLength(name) > MAX_EVENT_NAME_BYTES) {
        return { reason: "over-cap-name" }
      }
      return { reason: "invalid-event" }
    }
    if (typeof sessionID !== "string" || !isSafeEventIdentity(sessionID, MAX_EVENT_SESSION_ID_BYTES, SAFE_SESSION_ID)) {
      if (typeof sessionID === "string" && utf8ByteLength(sessionID) > MAX_EVENT_SESSION_ID_BYTES) {
        return { reason: "over-cap-session" }
      }
      return { reason: "invalid-event" }
    }
    if (!isValidNow(timestamp)) return { reason: "invalid-event" }
    if (typeof ok !== "boolean") return { reason: "invalid-event" }
    if (detail !== undefined && typeof detail !== "string") return { reason: "invalid-event" }
    if (typeof detail === "string") {
      if (utf8ByteLength(detail) > MAX_EVENT_DETAIL_BYTES) return { reason: "over-cap-detail" }
      if (detail.includes("\u0000")) return { reason: "invalid-event" }
    }
    return {
      event: {
        kind,
        name,
        sessionID,
        timestamp,
        ok,
        ...(detail === undefined ? {} : { detail }),
      },
    }
  } catch {
    // Getters/proxies and malformed host payloads must not cross the recorder boundary.
    return { reason: "invalid-event" }
  }
}

function cleanDetail(value: string): string {
  return value.replace(CONTROL_REPLACE, " ")
}

/**
 * Build the structured summary for one event. Detail is redacted and capped;
 * raw transcripts are never preserved by the recorder. Throws on invalid input
 * (fail-closed).
 */
export function toStructuredSummary(event: ObservedEvent): string {
  const validated = validateObservedEvent(event)
  if (!("event" in validated)) {
    if (validated.reason === "over-cap-detail") throw new Error(`event detail exceeds ${MAX_EVENT_DETAIL_BYTES} UTF-8 bytes`)
    if (validated.reason === "over-cap-name") throw new Error(`event name exceeds ${MAX_EVENT_NAME_BYTES} UTF-8 bytes`)
    if (validated.reason === "over-cap-session") throw new Error(`event sessionID exceeds ${MAX_EVENT_SESSION_ID_BYTES} UTF-8 bytes`)
    throw new Error("toStructuredSummary rejected an invalid event")
  }
  const detail = validated.event.detail === undefined ? "" : cleanDetail(validated.event.detail)
  const redacted = redactText(detail)
  const text = `${validated.event.kind}:${validated.event.name} ok=${validated.event.ok ? "yes" : "no"}${redacted.length > 0 ? ` detail=${redacted}` : ""}`
  return truncateUtf8(text, MAX_SUMMARY_BYTES)
}

/**
 * Idle/resource-aware gate: heartbeats (execution events with no detail)
 * arriving after a long idle gap are dropped instead of recorded, so idle
 * sessions cost nothing. Returns true when the event should be skipped.
 */
export function isIdleHeartbeat(event: ObservedEvent, lastAt: number | undefined, nowMs: number): boolean {
  if (event.kind !== "execution" || event.name !== "heartbeat" || (event.detail ?? "").length > 0) return false
  if (lastAt === undefined) return false
  return nowMs - lastAt >= EPISODE_IDLE_GAP_MS
}

/** Status text used when observation is explicitly active. */
export function observationNotice(): { toast: string; status: string } {
  return {
    toast: "Repo learning observation is on: structured summaries only, no raw transcripts. Run /learn status for details, /learn pause to stop.",
    status: "learn-observe: recording structured summaries (30d retention)",
  }
}

export type Recorder = {
  readonly state: LearnState
  recordEvent: (event: unknown, nowMs?: number) => RecordOutcome
  flushSession: (sessionID: string, nowMs?: number) => EpisodeSummary | undefined
  previewPauseChange: (
    paused: boolean,
    sessionIDOrIdentity: string | PauseIdentity,
    agentIDOrNow?: string | number,
    nowMs?: number,
  ) => PausePreview
  applyPauseChange: (
    input: PauseApplyInput | string,
    sessionIDOrIdentity: string | (PauseIdentity & PauseApplyInput),
    agentIDOrNow?: string | number,
    approvalOrNow?: boolean | number,
    nowMs?: number,
  ) => LearnState
  learnCommand: (
    argv: string,
    nowMsOrContext?: number | LearnCommandContext,
    context?: LearnCommandContext,
  ) => { text: string; mutated: boolean }
  attach: (bus: EventBus) => void
}

export type RecorderOptions = {
  initialState?: LearnState
  now?: () => number
  /** Host persistence hook; retention cleanup is written through this hook. */
  persistState?: (state: LearnState) => void
}

function copyState(value: LearnState): LearnState {
  return {
    schema: value.schema,
    paused: value.paused,
    episodes: value.episodes.map((episode) => ({ ...episode })),
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot digest a non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`
  }
  throw new Error("cannot digest an unsupported value")
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex")
}

function validateIdentity(identity: PauseIdentity): PauseIdentity {
  if (
    identity === null ||
    typeof identity !== "object" ||
    !isBoundedText(identity.sessionID, MAX_SESSION_ID_BYTES) ||
    !isBoundedText(identity.agentID, MAX_ID_BYTES) ||
    redactText(identity.sessionID) !== identity.sessionID ||
    redactText(identity.agentID) !== identity.agentID
  ) {
    throw new Error("pause approval requires bounded sessionID and agentID")
  }
  return { sessionID: identity.sessionID, agentID: identity.agentID }
}

function stateDigest(state: LearnState, pending: ReadonlyMap<string, PendingSession>): string {
  return digest({
    schema: state.schema,
    paused: state.paused,
    episodes: state.episodes.map((episode) => ({
      id: episode.id,
      sessionID: episode.sessionID,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      toolCalls: episode.toolCalls,
      errors: episode.errors,
      summary: episode.summary,
    })),
    pending: [...pending.values()]
      .sort((left, right) => left.sessionID.localeCompare(right.sessionID))
      .map((session) => ({
        sessionID: session.sessionID,
        startedAt: session.startedAt,
        lastAt: session.lastAt,
        eventCount: session.eventCount,
        pendingBytes: session.pendingBytes,
        toolCalls: session.toolCalls,
        errors: session.errors,
        kinds: [...session.kinds].sort(),
      })),
  })
}

function parsePreviewCaller(
  sessionIDOrIdentity: string | PauseIdentity,
  agentIDOrNow: string | number | undefined,
  nowMsArgument: number | undefined,
  defaultNow: () => number,
): { identity: PauseIdentity; nowMs: number } {
  if (typeof sessionIDOrIdentity === "string") {
    if (typeof agentIDOrNow !== "string") throw new Error("pause preview requires sessionID and agentID")
    const identity = validateIdentity({ sessionID: sessionIDOrIdentity, agentID: agentIDOrNow })
    const nowMs = nowMsArgument ?? defaultNow()
    assertNow(nowMs, "previewPauseChange")
    return { identity, nowMs }
  }
  if (agentIDOrNow !== undefined && typeof agentIDOrNow !== "number") {
    throw new Error("pause preview received an invalid nowMs")
  }
  const identity = validateIdentity(sessionIDOrIdentity)
  const nowMs = agentIDOrNow ?? defaultNow()
  assertNow(nowMs, "previewPauseChange")
  return { identity, nowMs }
}

function pendingEventBytes(event: ObservedEvent): number {
  const serialized = JSON.stringify({
    kind: event.kind,
    name: event.name,
    sessionID: event.sessionID,
    timestamp: event.timestamp,
    ok: event.ok,
    detail: event.detail ?? "",
  })
  return utf8ByteLength(serialized)
}

/**
 * Create an observation-only recorder. State transitions are pure except the
 * pause flag, which requires a state-bound preview token and explicit
 * approval. No learning runs.
 */
export function createRecorder(options: RecorderOptions = {}): Recorder {
  const now = options.now ?? (() => Date.now())
  let state: LearnState
  if (options.initialState === undefined) {
    state = createInitialState()
  } else {
    // Loading is a retention boundary: expired episodes never become visible,
    // and the cleaned state is sent back to the host persistence layer.
    state = pruneEpisodes(options.initialState, now())
    options.persistState?.(copyState(state))
  }

  const pending = new Map<string, PendingSession>()
  const tokens = new Map<string, PauseToken>()
  let pendingBytes = 0

  function commit(next: LearnState): void {
    state = next
    options.persistState?.(copyState(state))
  }

  function pruneForRead(nowMs: number): LearnState {
    assertNow(nowMs, "retention pruning")
    const next = pruneEpisodes(state, nowMs)
    if (next.episodes.length !== state.episodes.length) commit(next)
    return state
  }

  function recordEvent(event: unknown, nowMs: number = now()): RecordOutcome {
    if (state.paused) return { stored: false, reason: "paused" }
    assertNow(nowMs, "recordEvent")
    const validation = validateObservedEvent(event)
    if (!("event" in validation)) return { stored: false, reason: validation.reason }
    const observed = validation.event
    const session = pending.get(observed.sessionID)
    if (isIdleHeartbeat(observed, session?.lastAt, nowMs)) {
      return { stored: false, reason: "idle-heartbeat" }
    }
    // Validate/redact through the summary builder so malformed input fails closed.
    try {
      toStructuredSummary(observed)
    } catch {
      return { stored: false, reason: "invalid-event" }
    }
    const eventBytes = pendingEventBytes(observed)
    const kind = `${observed.kind}:${observed.name}`

    if (session === undefined) {
      if (pending.size >= MAX_PENDING_SESSIONS) return { stored: false, reason: "over-cap-sessions" }
      if (pendingBytes + eventBytes > MAX_PENDING_BYTES) return { stored: false, reason: "over-cap-pending-bytes" }
      pending.set(observed.sessionID, {
        sessionID: observed.sessionID,
        startedAt: observed.timestamp,
        lastAt: observed.timestamp,
        eventCount: 1,
        pendingBytes: eventBytes,
        toolCalls: observed.kind === "tool" ? 1 : 0,
        errors: observed.ok ? 0 : 1,
        kinds: new Set([kind]),
      })
      pendingBytes += eventBytes
      return { stored: true, sessionID: observed.sessionID }
    }

    if (session.eventCount >= MAX_EVENTS_PER_SESSION) return { stored: false, reason: "over-cap-events" }
    if (!session.kinds.has(kind) && session.kinds.size >= MAX_EVENT_KINDS) {
      return { stored: false, reason: "over-cap-kinds" }
    }
    if (pendingBytes + eventBytes > MAX_PENDING_BYTES) return { stored: false, reason: "over-cap-pending-bytes" }

    session.eventCount += 1
    session.pendingBytes += eventBytes
    session.lastAt = Math.max(session.lastAt, observed.timestamp)
    if (observed.kind === "tool") session.toolCalls += 1
    if (!observed.ok) session.errors += 1
    session.kinds.add(kind)
    pendingBytes += eventBytes
    return { stored: true, sessionID: observed.sessionID }
  }

  function flushSession(sessionID: string, nowMs: number = now()): EpisodeSummary | undefined {
    assertNow(nowMs, "flushSession")
    const session = pending.get(sessionID)
    if (session === undefined) return undefined
    pending.delete(sessionID)
    pendingBytes = Math.max(0, pendingBytes - session.pendingBytes)
    if (state.paused) return undefined
    const tools = [...session.kinds].join(",")
    const summary = truncateUtf8(
      redactText(`session ${session.sessionID}: ${session.toolCalls} tool calls, ${session.errors} errors, kinds=[${tools}]`),
      MAX_SUMMARY_BYTES,
    )
    const episode: EpisodeSummary = {
      id: `${session.sessionID}-${session.startedAt}`,
      sessionID: session.sessionID,
      startedAt: session.startedAt,
      endedAt: Math.max(session.lastAt, nowMs),
      toolCalls: session.toolCalls,
      errors: session.errors,
      summary,
    }
    commit(pruneEpisodes(addEpisode(state, episode), nowMs))
    return { ...episode }
  }

  function pruneTokens(nowMs: number): void {
    for (const [key, value] of tokens) if (value.expiresAt <= nowMs) tokens.delete(key)
    while (tokens.size >= MAX_PAUSE_TOKENS) {
      const oldest = tokens.keys().next().value as string | undefined
      if (oldest === undefined) break
      tokens.delete(oldest)
    }
  }

  function previewPauseChange(
    paused: boolean,
    sessionIDOrIdentity: string | PauseIdentity,
    agentIDOrNow?: string | number,
    nowMsArgument?: number,
  ): PausePreview {
    if (typeof paused !== "boolean") throw new Error("previewPauseChange requires a boolean")
    const caller = parsePreviewCaller(sessionIDOrIdentity, agentIDOrNow, nowMsArgument, now)
    pruneForRead(caller.nowMs)
    pruneTokens(caller.nowMs)
    const intent: PauseIntent = { action: "pause", paused }
    const token = randomBytes(32).toString("base64url")
    const expiresAt = caller.nowMs + PAUSE_TOKEN_TTL_MS
    if (!Number.isSafeInteger(expiresAt)) throw new Error("previewPauseChange could not create a valid expiry")
    tokens.set(token, {
      token,
      sessionID: caller.identity.sessionID,
      agentID: caller.identity.agentID,
      intentDigest: digest(intent),
      stateDigest: stateDigest(state, pending),
      desired: paused,
      expiresAt,
    })
    return { dryRun: true, intent, expectToken: token, token, expiresAt }
  }

  function parseApplyArgs(
    input: PauseApplyInput | string,
    sessionIDOrIdentity: string | (PauseIdentity & PauseApplyInput),
    agentIDOrNow: string | number | undefined,
    approvalOrNow: boolean | number | undefined,
    nowMsArgument: number | undefined,
  ): { token: string; identity: PauseIdentity; approved: boolean; nowMs: number } {
    if (typeof input === "string") {
      if (typeof sessionIDOrIdentity === "string") {
        if (typeof agentIDOrNow !== "string") throw new Error("pause apply requires sessionID and agentID")
        const approved = approvalOrNow === true
        const nowMs = typeof approvalOrNow === "number" ? approvalOrNow : nowMsArgument ?? now()
        return {
          token: input,
          identity: validateIdentity({ sessionID: sessionIDOrIdentity, agentID: agentIDOrNow }),
          approved,
          nowMs,
        }
      }
      const identity = validateIdentity(sessionIDOrIdentity)
      const approved = sessionIDOrIdentity.approval === true || sessionIDOrIdentity.apply === true
      const nowMs = typeof agentIDOrNow === "number" ? agentIDOrNow : now()
      return { token: input, identity, approved, nowMs }
    }

    const token = input.expectToken
    if (typeof token !== "string" || token.length === 0) throw new Error("applyPauseChange requires expectToken")
    const approved = input.approval === true || input.apply === true
    if (typeof sessionIDOrIdentity !== "string") {
      const identity = validateIdentity(sessionIDOrIdentity)
      const nowMs = typeof agentIDOrNow === "number" ? agentIDOrNow : now()
      return { token, identity, approved, nowMs }
    }
    if (typeof agentIDOrNow !== "string") throw new Error("pause apply requires sessionID and agentID")
    const identity = validateIdentity({ sessionID: sessionIDOrIdentity, agentID: agentIDOrNow })
    const nowMs = typeof approvalOrNow === "number" ? approvalOrNow : nowMsArgument ?? now()
    return { token, identity, approved, nowMs }
  }

  function applyPauseChange(
    input: PauseApplyInput | string,
    sessionIDOrIdentity: string | (PauseIdentity & PauseApplyInput),
    agentIDOrNow?: string | number,
    approvalOrNow?: boolean | number,
    nowMsArgument?: number,
  ): LearnState {
    const request = parseApplyArgs(input, sessionIDOrIdentity, agentIDOrNow, approvalOrNow, nowMsArgument)
    if (!request.approved) throw new Error("applyPauseChange requires explicit approval=true")
    assertNow(request.nowMs, "applyPauseChange")
    const pendingToken = tokens.get(request.token)
    if (pendingToken === undefined) throw new Error("applyPauseChange rejected an unknown token")
    if (request.nowMs >= pendingToken.expiresAt) {
      tokens.delete(request.token)
      throw new Error("applyPauseChange rejected an expired token")
    }
    // Consume before checking the binding. A theft attempt burns the token and
    // cannot be retried by either the thief or the legitimate caller.
    tokens.delete(request.token)
    if (pendingToken.sessionID !== request.identity.sessionID || pendingToken.agentID !== request.identity.agentID) {
      throw new Error("applyPauseChange rejected a token bound to another session and agent")
    }
    const intent: PauseIntent = { action: "pause", paused: pendingToken.desired }
    if (pendingToken.intentDigest !== digest(intent)) {
      throw new Error("applyPauseChange rejected a token with a mismatched intent")
    }
    pruneForRead(request.nowMs)
    if (pendingToken.stateDigest !== stateDigest(state, pending)) {
      throw new Error("applyPauseChange rejected a stale token: state changed since preview")
    }
    if (pendingToken.desired) {
      pending.clear()
      pendingBytes = 0
    }
    commit({ schema: state.schema, paused: pendingToken.desired, episodes: state.episodes.map((episode) => ({ ...episode })) })
    return copyState(state)
  }

  function resolveCommandArgs(
    nowMsOrContext: number | LearnCommandContext | undefined,
    context: LearnCommandContext | undefined,
  ): { nowMs: number; caller: LearnCommandContext | undefined } {
    if (typeof nowMsOrContext === "number" || nowMsOrContext === undefined) {
      return { nowMs: nowMsOrContext ?? now(), caller: context }
    }
    return { nowMs: context === undefined ? now() : now(), caller: nowMsOrContext }
  }

  function learnCommand(
    argv: string,
    nowMsOrContext?: number | LearnCommandContext,
    context?: LearnCommandContext,
  ): { text: string; mutated: boolean } {
    if (typeof argv !== "string" || utf8ByteLength(argv) > MAX_COMMAND_BYTES) {
      throw new Error(`learn command exceeds ${MAX_COMMAND_BYTES} UTF-8 bytes`)
    }
    const command = resolveCommandArgs(nowMsOrContext, context)
    assertNow(command.nowMs, "learnCommand")
    const parts = argv.trim().split(/\s+/).filter(Boolean)
    if (parts[0] === "/learn" || parts[0] === "learn") parts.shift()
    const sub = parts[0] ?? "status"
    if (sub === "status") {
      const retained = pruneForRead(command.nowMs).episodes.length
      return {
        text: `learn status: ${state.paused ? "paused" : "observing"}, ${retained} episodes retained (30d), structured summaries only`,
        mutated: false,
      }
    }
    if (sub === "audit") {
      const current = pruneForRead(command.nowMs)
      const lines = current.episodes.slice(-10).map(
        (episode) => `- ${episode.id}: ${episode.toolCalls} tools, ${episode.errors} errors, ${truncateUtf8(redactText(episode.summary), 120)}`,
      )
      return {
        text: lines.length > 0 ? `learn audit (latest ${lines.length}):\n${lines.join("\n")}` : "learn audit: no episodes retained",
        mutated: false,
      }
    }
    if (sub === "pause" || sub === "resume") {
      if (command.caller === undefined) throw new Error(`/learn ${sub} requires sessionID and agentID context`)
      const caller = validateIdentity(command.caller)
      const paused = sub === "pause"
      if (parts.length === 1) {
        const preview = previewPauseChange(paused, caller, command.nowMs)
        return {
          text: `learn ${sub} preview: re-run as \`/learn ${sub} ${preview.expectToken}\` to confirm (expires ${new Date(preview.expiresAt).toISOString()})`,
          mutated: false,
        }
      }
      if (parts.length !== 2) throw new Error(`usage: /learn ${sub} [expectToken]`)
      const next = applyPauseChange(
        { expectToken: parts[1], approval: command.caller.approval === true || command.caller.apply === true },
        caller.sessionID,
        caller.agentID,
        command.nowMs,
      )
      return { text: `learn ${sub}: ${next.paused ? "observation paused" : "observation resumed"}`, mutated: true }
    }
    throw new Error(`unknown /learn subcommand: ${sub} (expected status|audit|pause|resume)`)
  }

  function attach(bus: EventBus): void {
    bus.subscribe("session.execution", (event: unknown) => {
      recordEvent(event)
    })
    bus.subscribe("session.tool", (event: unknown) => {
      recordEvent(event)
    })
  }

  return {
    get state() {
      // A state read is also a retention boundary; return a copy so callers
      // cannot mutate the pause flag or episode array behind the approval gate.
      pruneForRead(now())
      return copyState(state)
    },
    recordEvent,
    flushSession,
    previewPauseChange,
    applyPauseChange,
    learnCommand,
    attach,
  }
}
