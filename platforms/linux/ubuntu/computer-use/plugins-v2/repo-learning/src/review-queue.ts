// RLE review queue: human-in-the-loop states plus `/learn` command stubs.
//
// States: pending -> approved | rejected; pending <-> quarantined;
// approved -> promoted. Synthesis may only create pending or quarantined.
// Trust gate: only approved (T2+) candidates may be marked promoted, and only
// through the namespaced promotion path. Nothing here auto-activates.
//
// Mutating `/learn accept|reject` calls use state-bound preview tokens in the
// same shape as the rig-tools preview/apply tools: preview returns a
// short-lived token bound to session, agent, intent, and queue state; apply
// revalidates all four before mutating.

import { createHash, randomBytes } from "node:crypto"

import { buildPromotionDraft, type PromotionDraft } from "./memory-namespace.ts"
import {
  validateCandidate,
  validateConflictResolution,
  type CandidateState,
  type ConflictResolutionRecord,
  type LearnCandidate,
  type TrustClass,
} from "./synthesize.ts"
import { containsSensitive, redactText } from "./redact.ts"

export const REVIEW_STATES = ["pending", "quarantined", "approved", "rejected", "promoted"] as const
export type ReviewState = CandidateState

export const LEARN_SUBCOMMANDS = ["review", "why", "preview", "accept", "reject", "audit", "retrieve", "cross-repo"] as const
export type LearnSubcommand = (typeof LEARN_SUBCOMMANDS)[number]

export const REVIEW_TOKEN_TTL_MS = 60_000
const MAX_REVIEW_TOKENS = 64
const MAX_REVIEW_LIST = 32
export const MAX_REVIEW_CANDIDATES = 256
const MAX_GATE_IDENTITY_CHARS = 256
const MAX_DATE_MS = 8_640_000_000_000_000
const CREDENTIAL_URI = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi

export type ReviewIntent =
  | { action: "accept"; id: string; resolution?: ConflictResolutionRecord }
  | { action: "reject"; id: string; reason: string }
  | { action: "resolve"; id: string; resolution: ConflictResolutionRecord }

export type LearnCommand =
  | { sub: LearnSubcommand; target?: string }
  | { error: string }

type ReviewToken = {
  token: string
  sessionID: string
  agent: string
  intent: ReviewIntent
  targetDigest: string
  expiresAt: number
}

export type ReviewAuditEntry = {
  id: string
  repo: string
  namespace: string
  trust: TrustClass
  state: ReviewState
  expiresAt: string
  conflict: "none" | "suspect" | "confirmed"
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
}

function clean(value: string, maximum: number): string {
  if (typeof value !== "string") throw new Error("review text must be a string")
  return redactText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim())
    .replace(CREDENTIAL_URI, "$1[REDACTED]@")
    .slice(0, maximum)
}

export type ConflictResolutionInput = {
  decision: "accept" | "reject"
  reason: string
  resolvedBy: string
  resolvedAt?: string
}

function normalizeResolution(value: ConflictResolutionInput, now: () => number): ConflictResolutionRecord {
  if (value === null || typeof value !== "object") throw new Error("conflict resolution is required")
  const resolvedAt = value.resolvedAt ?? new Date(now()).toISOString()
  return validateConflictResolution({
    decision: value.decision,
    reason: clean(value.reason, 280),
    resolvedBy: clean(value.resolvedBy, 128),
    resolvedAt,
  })
}

function isExpired(candidate: LearnCandidate, nowMs: number): boolean {
  const expiresAt = Date.parse(candidate.validity.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs
}

function cloneCandidate(candidate: LearnCandidate): LearnCandidate {
  return {
    ...candidate,
    provenance: { ...candidate.provenance },
    validity: { ...candidate.validity },
    conflict: { ...candidate.conflict, with: candidate.conflict.with ? [...candidate.conflict.with] : undefined },
    conflictResolution: candidate.conflictResolution ? { ...candidate.conflictResolution } : undefined,
    questions: candidate.questions ? [...candidate.questions] : undefined,
    contradicts: candidate.contradicts ? [...candidate.contradicts] : undefined,
  }
}

function cloneIntent(intent: ReviewIntent): ReviewIntent {
  if (intent.action === "reject") return { action: "reject", id: intent.id, reason: intent.reason }
  if (intent.action === "resolve") return { action: "resolve", id: intent.id, resolution: { ...intent.resolution } }
  return {
    action: "accept",
    id: intent.id,
    ...(intent.resolution === undefined ? {} : { resolution: { ...intent.resolution } }),
  }
}

export function learnCommandHelp(): string {
  return [
    "# /learn — repository learning review",
    "",
    "- `/learn review [state]` — list candidates (default: pending).",
    "- `/learn why <id>` — show provenance, validity, conflict, and trust for one candidate.",
    "- `/learn preview <id>` — show the exact promotion draft and a short-lived approval token.",
    "- `/learn accept <id>` — preview acceptance; repeat with the token to approve.",
    "- `/learn reject <id> [reason]` — preview rejection; repeat with the token to reject.",
    "- `/learn audit [state]` — bounded read-only review audit.",
    "- `/learn retrieve <id>` — bounded read-only candidate retrieval.",
    "- `/learn cross-repo <id> <target-repo>` — explicit path stub; never automatic.",
    "",
    "Acceptance only marks a local draft approved. Promotion to Basic Memory",
    "needs a separate explicit approval through the namespaced promotion path.",
  ].join("\n")
}

export function parseLearnCommand(text: string): LearnCommand {
  const parts = clean(text ?? "", 512).replace(/^\s*\/?learn\b/i, "").trim().split(/\s+/).filter(Boolean)
  if (containsSensitive(text ?? "")) return { error: "learn command contains secret material" }
  const sub = parts[0]?.toLowerCase() as LearnSubcommand | undefined
  if (!sub || !(LEARN_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return { error: `unknown /learn subcommand; expected one of ${LEARN_SUBCOMMANDS.join("|")}` }
  }
  if (sub === "review") {
    const state = parts[1]?.toLowerCase()
    if (state !== undefined && !(REVIEW_STATES as readonly string[]).includes(state)) {
      return { error: `unknown review state ${JSON.stringify(parts[1])}; expected one of ${REVIEW_STATES.join("|")}` }
    }
    return state ? { sub, target: state } : { sub }
  }
  if (sub === "audit") {
    const state = parts[1]?.toLowerCase()
    if (state !== undefined && !(REVIEW_STATES as readonly string[]).includes(state)) {
      return { error: `unknown review state ${JSON.stringify(parts[1])}; expected one of ${REVIEW_STATES.join("|")}` }
    }
    return state ? { sub, target: state } : { sub }
  }
  if (sub === "why" || sub === "preview" || sub === "accept" || sub === "retrieve") {
    if (!parts[1]) return { error: `usage: /learn ${sub} <id>` }
    return { sub, target: parts[1] }
  }
  if (sub === "cross-repo") {
    if (!parts[1] || !parts[2]) return { error: "usage: /learn cross-repo <id> <target-repo>" }
    return { sub, target: [parts[1], ...parts.slice(2)].join(" ").slice(0, 320) }
  }
  if (!parts[1]) return { error: "usage: /learn reject <id> [reason]" }
  return { sub, target: [parts[1], ...parts.slice(2)].join(" ").slice(0, 320) }
}

function escalateOnAccept(trust: TrustClass): TrustClass {
  if (trust === "T0" || trust === "T1") return "T2"
  return trust
}

export function createReviewQueue(now: () => number = Date.now) {
  const candidates = new Map<string, LearnCandidate>()
  const tokens = new Map<string, ReviewToken>()

  const checkedNow = (): number => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS - REVIEW_TOKEN_TTL_MS) {
      throw new Error("review clock must be a valid date")
    }
    return value
  }

  const checkedIdentity = (value: string, label: string): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_GATE_IDENTITY_CHARS) {
      throw new Error(`${label} is required and bounded`)
    }
    if (containsSensitive(value) || redactText(value) !== value) throw new Error(`${label} contains secret material`)
    return value
  }

  const prune = (nowMs: number) => {
    for (const [key, value] of tokens) if (value.expiresAt <= nowMs) tokens.delete(key)
    while (tokens.size >= MAX_REVIEW_TOKENS) {
      const oldest = tokens.keys().next().value as string | undefined
      if (!oldest) break
      tokens.delete(oldest)
    }
  }

  const get = (id: string): LearnCandidate => {
    const candidate = candidates.get(id)
    if (!candidate) throw new Error(`review candidate not found: ${id}`)
    if (isExpired(candidate, checkedNow())) {
      candidates.delete(id)
      throw new Error(`candidate ${candidate.id} is expired; review and promotion are closed`)
    }
    return candidate
  }

  const pruneCandidates = () => {
    const nowMs = checkedNow()
    for (const [id, candidate] of candidates) if (isExpired(candidate, nowMs)) candidates.delete(id)
  }

  const assertLive = (candidate: LearnCandidate): void => {
    if (isExpired(candidate, checkedNow())) throw new Error(`candidate ${candidate.id} is expired; review and promotion are closed`)
  }

  const enqueue = (incoming: readonly LearnCandidate[]): { added: string[]; skipped: string[] } => {
    if (!Array.isArray(incoming)) throw new Error("review enqueue requires an array of candidates")
    pruneCandidates()
    const added: string[] = []
    const skipped: string[] = []
    for (const rawCandidate of incoming.slice(0, MAX_REVIEW_CANDIDATES)) {
      if (rawCandidate !== null && typeof rawCandidate === "object" &&
        "state" in rawCandidate && rawCandidate.state !== "pending" && rawCandidate.state !== "quarantined") {
        throw new Error(`refusing to enqueue auto-active candidate ${String((rawCandidate as { id?: unknown }).id)} (state ${String(rawCandidate.state)})`)
      }
      const candidate = validateCandidate(rawCandidate)
      if (candidate.state !== "pending" && candidate.state !== "quarantined") {
        throw new Error(`refusing to enqueue auto-active candidate ${candidate.id} (state ${candidate.state})`)
      }
      assertLive(candidate)
      if (candidates.has(candidate.id)) {
        skipped.push(candidate.id)
        continue
      }
      if (candidates.size >= MAX_REVIEW_CANDIDATES) {
        skipped.push(candidate.id)
        continue
      }
      candidates.set(candidate.id, candidate)
      added.push(candidate.id)
    }
    return { added, skipped }
  }

  const list = (state?: ReviewState): LearnCandidate[] => {
    pruneCandidates()
    const all = [...candidates.values()]
    const filtered = state ? all.filter((candidate) => (candidate.state as ReviewState) === state) : all
    return filtered.slice(0, MAX_REVIEW_LIST).map(cloneCandidate)
  }

  const retrieve = (id: string): LearnCandidate => cloneCandidate(get(id))

  const audit = (limit = MAX_REVIEW_LIST, state?: ReviewState): ReviewAuditEntry[] => {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("audit limit must be a positive integer")
    return list(state).slice(0, Math.min(limit, MAX_REVIEW_LIST)).map((candidate) => ({
      id: candidate.id,
      repo: candidate.repo,
      namespace: candidate.namespace,
      trust: candidate.trust,
      state: candidate.state,
      expiresAt: candidate.validity.expiresAt,
      conflict: candidate.conflict.status,
    }))
  }

  const formatList = (state?: ReviewState): string => {
    const entries = list(state)
    const lines = [`# Learn review${state ? ` — ${state}` : ""} (${entries.length})`, ""]
    for (const candidate of entries) {
      lines.push(`- \`${candidate.id}\` [${candidate.trust}/${candidate.state}] ${candidate.title}`)
    }
    if (entries.length === 0) lines.push("No candidates in this state.")
    return lines.join("\n")
  }

  const why = (id: string): string => {
    const candidate = get(id)
    const lines = [
      `# Why: ${candidate.title}`,
      "",
      `- id: \`${candidate.id}\``,
      `- trust: ${candidate.trust} (T0 untrusted extraction, T1 explicit correction, T2 accepted, T3 promoted, T4 cross-repo)`,
      `- source: ${candidate.source}; state: ${candidate.state}`,
      `- provenance: ${candidate.provenance.actor} at ${candidate.provenance.createdAt}` +
        `${candidate.provenance.episodeID ? `, episode ${candidate.provenance.episodeID}` : ""}` +
        `${candidate.provenance.sessionID ? `, session ${candidate.provenance.sessionID}` : ""}`,
      `- validity: ${candidate.validity.scope}, expires ${candidate.validity.expiresAt}`,
      `- conflict: ${candidate.conflict.status}${candidate.conflict.reason ? ` — ${candidate.conflict.reason}` : ""}` +
        `${candidate.conflict.with?.length ? ` (with ${candidate.conflict.with.join(", ")})` : ""}`,
      `- namespace: ${candidate.namespace}`,
      "",
      candidate.body,
    ]
    if (candidate.questions?.length) {
      lines.push("", "## Open questions", "", ...candidate.questions.map((question) => `- ${question}`))
    }
    return lines.join("\n").slice(0, 8_192)
  }

  const previewDraft = (id: string): PromotionDraft => {
    const candidate = get(id)
    assertLive(candidate)
    return buildPromotionDraft(candidate, now)
  }

  const previewIntent = (
    intent: ReviewIntent,
    sessionID: string,
    agent: string,
  ): { dryRun: true; intent: ReviewIntent; expectToken: string; expiresAt: number } => {
    const candidate = get(intent.id)
    assertLive(candidate)
    if (intent.action === "accept" && candidate.state !== "pending" && candidate.state !== "quarantined") {
      throw new Error(`candidate ${intent.id} is ${candidate.state}; only pending or quarantined can be accepted`)
    }
    if (intent.action === "accept" && candidate.state === "quarantined" &&
      (!intent.resolution || intent.resolution.decision !== "accept")) {
      throw new Error(`candidate ${intent.id} is quarantined; explicit conflict-resolution record is required`)
    }
    if (intent.action === "reject" && (candidate.state === "rejected" || candidate.state === "promoted")) {
      throw new Error(`candidate ${intent.id} is ${candidate.state}; rejection is closed`)
    }
    if (intent.action === "resolve" && candidate.state !== "quarantined") {
      throw new Error(`candidate ${intent.id} is ${candidate.state}; only quarantined candidates need conflict resolution`)
    }
    const safeSessionID = checkedIdentity(sessionID, "sessionID")
    const safeAgent = checkedIdentity(agent, "agent")
    const nowMs = checkedNow()
    prune(nowMs)
    const token = randomBytes(24).toString("base64url")
    const storedIntent = cloneIntent(intent)
    const record: ReviewToken = {
      token,
      sessionID: safeSessionID,
      agent: safeAgent,
      intent: storedIntent,
      targetDigest: digest(candidate),
      expiresAt: nowMs + REVIEW_TOKEN_TTL_MS,
    }
    tokens.set(token, record)
    return { dryRun: true, intent: cloneIntent(record.intent), expectToken: token, expiresAt: record.expiresAt }
  }

  const consumeToken = (
    intent: ReviewIntent,
    input: { apply?: boolean; expectToken?: string },
    sessionID: string,
    agent: string,
  ): LearnCandidate => {
    if (!input.apply) throw new Error("mutation requires a preview token; call again with apply=true and expectToken")
    const record = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!record || record.expiresAt <= checkedNow()) throw new Error("learn preview token is missing or expired")
    if (record.sessionID !== sessionID || record.agent !== agent || digest(record.intent) !== digest(intent)) {
      throw new Error("learn preview token does not match this session, agent, and intent")
    }
    const current = get(intent.id)
    assertLive(current)
    if (digest(current) !== record.targetDigest) {
      throw new Error("learn target state changed after preview; preview again")
    }
    tokens.delete(record.token)
    return current
  }

  const accept = (
    id: string,
    input: { apply?: boolean; expectToken?: string; resolution?: ConflictResolutionInput },
    sessionID: string,
    agent: string,
  ): LearnCandidate | { dryRun: true; intent: ReviewIntent; expectToken: string; expiresAt: number } => {
    const before = get(id)
    let resolution: ConflictResolutionRecord | undefined
    const tokenIntent = input.expectToken ? tokens.get(input.expectToken)?.intent : undefined
    const tokenResolution = tokenIntent?.action === "accept" ? tokenIntent.resolution : undefined
    if (input.apply && input.expectToken) {
      const tokenRecord = tokens.get(input.expectToken)
      if (tokenRecord && digest(before) !== tokenRecord.targetDigest) {
        throw new Error("learn target state changed after preview; preview again")
      }
    }
    if (tokenResolution && input.apply && input.resolution) {
      const supplied = normalizeResolution(input.resolution, checkedNow)
      if (supplied.decision !== tokenResolution.decision || supplied.reason !== tokenResolution.reason || supplied.resolvedBy !== tokenResolution.resolvedBy) {
        throw new Error("learn preview token does not match the conflict-resolution record")
      }
    }
    const suppliedResolution = input.resolution ? normalizeResolution(input.resolution, checkedNow) : undefined
    if (before.state === "quarantined") {
      resolution = tokenResolution && input.apply
        ? tokenResolution
        : suppliedResolution ?? (before.conflictResolution?.decision === "accept" ? before.conflictResolution : undefined)
      if (!resolution || resolution.decision !== "accept") {
        throw new Error(`candidate ${id} is quarantined; explicit conflict-resolution record is required`)
      }
    } else if (suppliedResolution !== undefined) {
      resolution = tokenResolution && input.apply ? tokenResolution : suppliedResolution
    } else {
      resolution = tokenResolution
    }
    const intent: ReviewIntent = resolution === undefined ? { action: "accept", id } : { action: "accept", id, resolution }
    if (!input.apply) return previewIntent(intent, sessionID, agent)
    const current = consumeToken(intent, input, sessionID, agent)
    if (current.state !== "pending" && current.state !== "quarantined") {
      throw new Error(`candidate ${id} is ${current.state}; only pending or quarantined can be accepted`)
    }
    // Accepting a quarantined candidate requires its questions to be resolved
    // by a fresh preview cycle; the state-digest check above enforces that the
    // reviewer saw the quarantined content.
    const updated: LearnCandidate = {
      ...current,
      state: "approved",
      trust: escalateOnAccept(current.trust),
      conflict: current.state === "quarantined"
        ? { status: "none" as const }
        : current.conflict,
      questions: current.state === "quarantined" ? undefined : current.questions,
    }
    if (resolution !== undefined) updated.conflictResolution = resolution
    candidates.set(id, updated)
    return updated
  }

  const resolveConflict = (
    id: string,
    resolutionInput: ConflictResolutionInput | undefined,
    input: { apply?: boolean; expectToken?: string },
    sessionID: string,
    agent: string,
  ): LearnCandidate | { dryRun: true; intent: ReviewIntent; expectToken: string; expiresAt: number } => {
    const tokenIntent = input.expectToken ? tokens.get(input.expectToken)?.intent : undefined
    const tokenResolution = tokenIntent?.action === "resolve" ? tokenIntent.resolution : undefined
    if (tokenResolution && input.apply && resolutionInput) {
      const supplied = normalizeResolution(resolutionInput, checkedNow)
      if (supplied.decision !== tokenResolution.decision || supplied.reason !== tokenResolution.reason || supplied.resolvedBy !== tokenResolution.resolvedBy) {
        throw new Error("learn preview token does not match the conflict-resolution record")
      }
    }
    const resolution = tokenResolution && input.apply
      ? tokenResolution
      : normalizeResolution(resolutionInput as ConflictResolutionInput, checkedNow)
    const intent: ReviewIntent = { action: "resolve", id, resolution }
    if (!input.apply) return previewIntent(intent, sessionID, agent)
    const current = consumeToken(intent, input, sessionID, agent)
    if (current.state !== "quarantined") {
      throw new Error(`candidate ${id} is ${current.state}; only quarantined candidates need resolution`)
    }
    const updated: LearnCandidate = resolution.decision === "accept"
      ? {
          ...current,
          state: "pending",
          conflict: { status: "none" },
          questions: undefined,
          conflictResolution: resolution,
        }
      : {
          ...current,
          state: "rejected",
          conflictResolution: resolution,
        }
    candidates.set(id, updated)
    return updated
  }

  const reject = (
    id: string,
    reason: string,
    input: { apply?: boolean; expectToken?: string },
    sessionID: string,
    agent: string,
  ): LearnCandidate | { dryRun: true; intent: ReviewIntent; expectToken: string; expiresAt: number } => {
    const intent: ReviewIntent = { action: "reject", id, reason: clean(reason || "rejected in review", 280) }
    if (!input.apply) return previewIntent(intent, sessionID, agent)
    const current = consumeToken(intent, input, sessionID, agent)
    if (current.state === "rejected" || current.state === "promoted") {
      throw new Error(`candidate ${id} is ${current.state}; rejection is closed`)
    }
    const updated: LearnCandidate = { ...current, state: "rejected" }
    candidates.set(id, updated)
    return updated
  }

  const quarantine = (id: string, reason: string, questions: readonly string[] = []): LearnCandidate => {
    const current = get(id)
    assertLive(current)
    if (current.state === "promoted" || current.state === "rejected") {
      throw new Error(`candidate ${id} is ${current.state}; quarantine is closed`)
    }
    const updated: LearnCandidate = {
      ...current,
      state: "quarantined",
      conflict: {
        status: "suspect",
        reason: clean(reason || "quarantined in review", 280),
        with: current.conflict.with,
      },
      conflictResolution: undefined,
      questions: [...(current.questions ?? []), ...questions.map((question) => clean(question, 280))]
        .filter(Boolean)
        .slice(0, 8),
    }
    candidates.set(id, updated)
    return updated
  }

  return {
    enqueue,
    list,
    retrieve,
    audit,
    formatList,
    why,
    previewDraft,
    accept,
    resolveConflict,
    resolve: resolveConflict,
    reject,
    quarantine,
  }
}

export type ReviewQueue = ReturnType<typeof createReviewQueue>
