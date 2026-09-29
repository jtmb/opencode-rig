// RLE candidate synthesis: deterministic extraction, strict candidate schema
// validation, bounded model synthesis with a single fallback, fail-closed.
//
// Design rules (see docs/learn-review.md):
// - Summaries only, never transcripts; bounded input and output.
// - Trust classes T0-T4; synthesis output is never auto-active: new candidates
//   are `pending` (or `quarantined` on conflict) and require human review.
// - Explicit user corrections become immediate T1 candidates, still pending.
// - Contradictions produce questions instead of silent overwrites.
// - Provenance, validity, and conflict are required on every candidate.

import { createHash } from "node:crypto"

import { containsSensitive, redactText } from "./redact.ts"

export const TRUST_CLASSES = ["T0", "T1", "T2", "T3", "T4"] as const
export type TrustClass = (typeof TRUST_CLASSES)[number]

export const CANDIDATE_SOURCES = ["observation", "correction", "synthesis"] as const
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number]

export const CANDIDATE_STATES = ["pending", "quarantined", "approved", "rejected", "promoted"] as const
export type CandidateState = (typeof CANDIDATE_STATES)[number]

// Synthesis output is restricted to this subset; the full lifecycle lives in
// the review queue. Validation enforces the restriction at runtime.
export const NEW_CANDIDATE_STATES: readonly CandidateState[] = ["pending", "quarantined"]

export const CONFLICT_STATUSES = ["none", "suspect", "confirmed"] as const
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number]

export const PROVENANCE_ACTORS = ["user", "agent", "model"] as const
export type ProvenanceActor = (typeof PROVENANCE_ACTORS)[number]

export const MAX_SUMMARIES = 8
export const MAX_SUMMARY_CHARS = 2_000
export const MAX_CANDIDATES = 16
export const MAX_TITLE_CHARS = 160
export const MAX_BODY_CHARS = 2_000
export const MAX_QUESTIONS = 8
export const MAX_QUESTION_CHARS = 280
export const CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1_000
export const MAX_RESOURCE_CPU_LOAD = 0.85
export const MAX_RESOURCE_MEMORY_BYTES = 256 * 1024 * 1024
export const MAX_RESOURCE_QUEUE_DEPTH = 32
export const MAX_RESOURCE_PROVIDER_QUOTA = 1_000_000
export const MAX_SUMMARY_INPUTS = 64
export const MAX_MODEL_OUTPUT_BYTES = 32 * 1024
export const MAX_EXISTING_CANDIDATES = 256

const CANDIDATE_KEYS = new Set([
  "id",
  "repo",
  "origin",
  "namespace",
  "title",
  "body",
  "trust",
  "source",
  "state",
  "provenance",
  "validity",
  "conflict",
  "conflictResolution",
  "questions",
  "contradicts",
])
const REQUIRED_CANDIDATE_KEYS = [
  "id",
  "repo",
  "namespace",
  "title",
  "body",
  "trust",
  "source",
  "state",
  "provenance",
  "validity",
  "conflict",
] as const
const SAFE_NAMESPACE = /^learnings\/[a-z0-9-]{1,64}\/$/
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const UTF8_ENCODER = new TextEncoder()

export type CandidateProvenance = {
  repo: string
  actor: ProvenanceActor
  createdAt: string
  episodeID?: string
  sessionID?: string
}

export type CandidateValidity = {
  expiresAt: string
  scope: string
}

export type CandidateConflict = {
  status: ConflictStatus
  reason?: string
  with?: string[]
}

export type ConflictResolutionRecord = {
  decision: "accept" | "reject"
  reason: string
  resolvedBy: string
  resolvedAt: string
}

export type LearnCandidate = {
  id: string
  repo: string
  origin?: string
  namespace: string
  title: string
  body: string
  trust: TrustClass
  source: CandidateSource
  state: CandidateState
  provenance: CandidateProvenance
  validity: CandidateValidity
  conflict: CandidateConflict
  conflictResolution?: ConflictResolutionRecord
  questions?: string[]
  contradicts?: string[]
}

export type GenerateTextFn = (input: { prompt: string; model?: string }) => Promise<{ data: { text: string } }>

export type SynthesisResourceGate = {
  idle?: boolean
  cpu?: number
  cpuLoad?: number
  cpuPercent?: number
  ram?: number
  memoryBytes?: number
  ramBytes?: number
  quota?: number
  providerQuotaRemaining?: number
  providerQuota?: number
  queue?: number
  queueDepth?: number
}

export type SynthesizeInput = {
  repo: string
  namespace: string
  summaries: readonly string[]
  existing?: readonly LearnCandidate[]
  corrections?: readonly string[]
  origin?: string
  resourceGate?: SynthesisResourceGate
  resources?: SynthesisResourceGate
  resource?: SynthesisResourceGate
  now?: () => number
}

export type SynthesizeMeta = {
  attempts: number
  extractedSummaries: number
  duplicates: number
  quarantined: number
}

export type SynthesizeResult =
  | { ok: true; candidates: LearnCandidate[]; meta: SynthesizeMeta }
  | { ok: false; error: string; candidates: LearnCandidate[] }

function fail(message: string): never {
  throw new Error(`invalid candidate: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireOwnKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`${label}.${key} is required`)
  }
}

function nonEmptyString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`)
  const text = (value as string).trim()
  if (text.length > maximum) fail(`${label} exceeds ${maximum} characters`)
  return text
}

// URI userinfo is not covered by the shared redactor's provider-token list,
// but it is still credential material. It is rejected at persistence
// boundaries and replaced before untrusted text is sent to a model.
const CREDENTIAL_URI = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi

function containsCredentialMaterial(value: string): boolean {
  CREDENTIAL_URI.lastIndex = 0
  return CREDENTIAL_URI.test(value)
}

function safeStoredString(value: unknown, label: string, maximum: number): string {
  const text = nonEmptyString(value, label, maximum)
  if (CONTROL_EXCEPT_WHITESPACE.test(text)) fail(`${label} contains control characters`)
  const redacted = redactText(text)
  if (redacted !== text || containsSensitive(text) || containsCredentialMaterial(text)) {
    fail(`${label} contains secret material`)
  }
  return text
}

function redactInputString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") fail(`${label} must be a string`)
  if (value.length > maximum) fail(`${label} exceeds ${maximum} characters`)
  let redacted = redactText(value)
  redacted = redacted.replace(CREDENTIAL_URI, "$1[REDACTED]@")
  return redacted
}

function safeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  try {
    return redactInputString(text, "error", 512).slice(0, 512)
  } catch {
    return "redacted synthesis failure"
  }
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`)
  }
  const time = Date.parse(value as string)
  if (!Number.isFinite(time)) fail(`${label} is not a real timestamp`)
  if (new Date(time).toISOString().slice(0, 19) !== (value as string).slice(0, 19)) {
    fail(`${label} is not a real timestamp`)
  }
  return value as string
}

export function validateConflictResolution(value: unknown): ConflictResolutionRecord {
  if (!isRecord(value)) fail("conflictResolution must be an object")
  const record = value as Record<string, unknown>
  requireOwnKeys(record, ["decision", "reason", "resolvedBy", "resolvedAt"], "conflictResolution")
  if (record.decision !== "accept" && record.decision !== "reject") {
    fail("conflictResolution.decision must be accept or reject")
  }
  return {
    decision: record.decision,
    reason: safeStoredString(record.reason, "conflictResolution.reason", MAX_QUESTION_CHARS),
    resolvedBy: safeStoredString(record.resolvedBy, "conflictResolution.resolvedBy", 128),
    resolvedAt: isoDate(record.resolvedAt, "conflictResolution.resolvedAt"),
  }
}

function stringList(value: unknown, label: string, maximum: number, itemMaximum: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array of at most ${maximum} strings`)
  return (value as unknown[]).map((entry) => safeStoredString(entry, `${label} entry`, itemMaximum))
}

export function normalizeTopicText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function makeCandidateId(namespace: string, title: string, body: string): string {
  return `cand-${digest(`${namespace}\n${normalizeTopicText(title)}\n${normalizeTopicText(body)}`).slice(0, 12)}`
}

// Deterministic extraction: normalize, truncate, drop empties, drop exact
// duplicates, and cap the count. No model calls, no randomness, stable order.
export function deterministicExtract(summaries: readonly string[]): string[] {
  const seen = new Set<string>()
  const extracted: string[] = []
  for (const summary of summaries.slice(0, MAX_SUMMARY_INPUTS)) {
    if (typeof summary !== "string") continue
    let redacted: string
    try {
      redacted = redactInputString(summary, "summary", 64 * 1024)
    } catch {
      // An over-cap or otherwise malformed observation is not allowed to
      // reach the model. The caller still receives explicit corrections.
      continue
    }
    const text = redacted.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS)
    if (!text || seen.has(text)) continue
    seen.add(text)
    extracted.push(text)
    if (extracted.length >= MAX_SUMMARIES) break
  }
  return extracted
}

// Trust assignment by origin. T0 = untrusted model/observation extraction,
// T1 = explicit user correction (immediate candidate, review still required).
export function trustForSource(source: CandidateSource): TrustClass {
  return source === "correction" ? "T1" : "T0"
}

function validateSourceTrustActor(source: CandidateSource, trust: TrustClass, actor: ProvenanceActor): void {
  if (trust === "T4") {
    fail(source === "correction" && actor === "user"
      ? "T4 is reserved for explicit cross-repository promotion"
      : "T4 requires an explicit cross-repository approval; model output cannot claim T4")
  }
  const valid = source === "correction"
    ? actor === "user" && trust === "T1"
    : source === "observation"
      ? actor === "agent" && trust === "T0"
      : actor === "model" && trust === "T0"
  if (!valid) {
    fail(`source ${source} cannot claim trust ${trust} with actor ${actor}`)
  }
}

// Hard gate: synthesis output is never auto-active, regardless of trust.
export function mayAutoActivate(_trust: TrustClass): false {
  return false
}

function validateProvenance(value: unknown): CandidateProvenance {
  if (!isRecord(value)) fail("provenance must be an object")
  const record = value as Record<string, unknown>
  requireOwnKeys(record, ["repo", "actor", "createdAt"], "provenance")
  const actor = record.actor
  if (actor !== "user" && actor !== "agent" && actor !== "model") fail("provenance.actor must be user, agent, or model")
  return {
    repo: safeStoredString(record.repo, "provenance.repo", 512),
    actor: actor as ProvenanceActor,
    createdAt: isoDate(record.createdAt, "provenance.createdAt"),
    episodeID: record.episodeID === undefined ? undefined : safeStoredString(record.episodeID, "provenance.episodeID", 128),
    sessionID: record.sessionID === undefined ? undefined : safeStoredString(record.sessionID, "provenance.sessionID", 128),
  }
}

function validateValidity(value: unknown, createdAt: string): CandidateValidity {
  if (!isRecord(value)) fail("validity must be an object")
  const record = value as Record<string, unknown>
  requireOwnKeys(record, ["expiresAt", "scope"], "validity")
  const expiresAt = isoDate(record.expiresAt, "validity.expiresAt")
  const created = Date.parse(createdAt)
  const expires = Date.parse(expiresAt)
  if (!(expires > created)) fail("validity.expiresAt must be after provenance.createdAt")
  if (expires - created > CANDIDATE_TTL_MS) fail("validity.expiresAt exceeds the 90-day candidate bound")
  return { expiresAt, scope: safeStoredString(record.scope, "validity.scope", 256) }
}

function validateConflict(value: unknown): CandidateConflict {
  if (!isRecord(value)) fail("conflict must be an object")
  const record = value as Record<string, unknown>
  requireOwnKeys(record, ["status"], "conflict")
  const status = record.status
  if (status !== "none" && status !== "suspect" && status !== "confirmed") {
    fail("conflict.status must be none, suspect, or confirmed")
  }
  const conflict: CandidateConflict = { status: status as ConflictStatus }
  const reason = record.reason === undefined ? undefined : safeStoredString(record.reason, "conflict.reason", MAX_QUESTION_CHARS)
  if (reason !== undefined) conflict.reason = reason
  const withIds = stringList(record.with, "conflict.with", MAX_CANDIDATES, 64)
  if (withIds !== undefined) conflict.with = withIds
  if (conflict.status !== "none" && !conflict.reason) fail("conflict.reason is required unless status is none")
  return conflict
}

export function validateCandidate(value: unknown, options: { allowLifecycleStates?: boolean } = {}): LearnCandidate {
  if (!isRecord(value)) fail("candidate must be an object")
  const record = value as Record<string, unknown>
  requireOwnKeys(record, REQUIRED_CANDIDATE_KEYS, "candidate")
  for (const key of Object.keys(record)) {
    if (!CANDIDATE_KEYS.has(key)) fail(`unknown field ${JSON.stringify(key)}`)
  }
  const trust = record.trust
  if (!(TRUST_CLASSES as readonly unknown[]).includes(trust)) fail("trust must be T0, T1, T2, T3, or T4")
  const source = record.source
  if (!(CANDIDATE_SOURCES as readonly unknown[]).includes(source)) {
    fail("source must be observation, correction, or synthesis")
  }
  const state = record.state
  const allowedState = options.allowLifecycleStates
    ? state === "pending" || state === "quarantined" || state === "approved" || state === "rejected" || state === "promoted"
    : state === "pending" || state === "quarantined"
  if (!allowedState) {
    fail("synthesis output must be pending or quarantined, never auto-active")
  }
  const provenance = validateProvenance(record.provenance)
  const validity = validateValidity(record.validity, provenance.createdAt)
  const conflict = validateConflict(record.conflict)
  const questions = stringList(record.questions, "questions", MAX_QUESTIONS, MAX_QUESTION_CHARS)
  if (conflict.status !== "none" && (!questions || questions.length === 0)) {
    fail("questions are required when a conflict is reported")
  }
  if (state === "quarantined" && conflict.status === "none") {
    fail("quarantined candidates must report a conflict")
  }
  const repo = safeStoredString(record.repo, "repo", 512)
  const origin = record.origin === undefined ? undefined : safeStoredString(record.origin, "origin", 512)
  const namespace = safeStoredString(record.namespace, "namespace", 128)
  if (!SAFE_NAMESPACE.test(namespace)) fail("namespace is outside the learnings namespace")
  const title = safeStoredString(record.title, "title", MAX_TITLE_CHARS)
  const body = safeStoredString(record.body, "body", MAX_BODY_CHARS)
  const id = safeStoredString(record.id, "id", 64)
  if (state === "pending" || state === "quarantined") {
    validateSourceTrustActor(source as CandidateSource, trust as TrustClass, provenance.actor)
  } else if (state === "approved" && trust !== "T2" && trust !== "T3") {
    fail("approved candidates must have T2 or T3 trust")
  } else if (state === "promoted" && trust !== "T3") {
    fail("promoted candidates must have T3 trust")
  }
  if (provenance.repo !== repo) fail("candidate.repo must match provenance.repo")
  if (validity.scope !== repo) fail("validity.scope must match candidate.repo")
  const expectedID = makeCandidateId(namespace, title, body)
  if (id !== expectedID) fail(`id is not canonical for namespace, title, and body; expected ${expectedID}`)
  const conflictResolution = record.conflictResolution === undefined
    ? undefined
    : validateConflictResolution(record.conflictResolution)
  const candidate: LearnCandidate = {
    id,
    repo,
    ...(origin === undefined ? {} : { origin }),
    namespace,
    title,
    body,
    trust: trust as TrustClass,
    source: source as CandidateSource,
    state: state as CandidateState,
    provenance,
    validity,
    conflict,
  }
  if (conflictResolution !== undefined) candidate.conflictResolution = conflictResolution
  if (questions !== undefined) candidate.questions = questions
  const contradicts = stringList(record.contradicts, "contradicts", MAX_QUESTIONS, MAX_TITLE_CHARS)
  if (contradicts !== undefined) candidate.contradicts = contradicts
  return candidate
}

// Namespace isolation: a candidate is only usable for the exact repo and
// namespace it was synthesized for.
export function validateCandidateFor(
  input: Pick<SynthesizeInput, "repo" | "namespace" | "origin">,
  value: unknown,
  options: { allowLifecycleStates?: boolean } = {},
): LearnCandidate {
  const candidate = validateCandidate(value, options)
  if (candidate.repo !== input.repo) fail(`repo mismatch: expected ${JSON.stringify(input.repo)}`)
  if (candidate.namespace !== input.namespace) {
    fail(`namespace mismatch: expected ${JSON.stringify(input.namespace)}`)
  }
  if (candidate.validity.scope !== input.repo) fail(`scope mismatch: expected ${JSON.stringify(input.repo)}`)
  if (input.origin !== undefined && candidate.origin !== undefined && candidate.origin !== input.origin) {
    fail(`origin mismatch: expected ${JSON.stringify(input.origin)}`)
  }
  if (input.origin === undefined && candidate.origin !== undefined) {
    fail("origin mismatch: candidate supplied an origin where none was expected")
  }
  if (input.origin !== undefined && candidate.origin === undefined) candidate.origin = input.origin
  return candidate
}

export function validateSynthesisPayload(text: string): LearnCandidate[] {
  if (typeof text !== "string") fail("model output must be a string")
  if (text.length > MAX_MODEL_OUTPUT_BYTES || UTF8_ENCODER.encode(text).byteLength > MAX_MODEL_OUTPUT_BYTES) {
    fail(`model output exceeds ${MAX_MODEL_OUTPUT_BYTES} bytes`)
  }
  if (containsSensitive(text) || containsCredentialMaterial(text)) {
    fail("model output contains secret material")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail("model output is not valid JSON")
  }
  const list = isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "candidates") && Array.isArray((parsed as Record<string, unknown>).candidates)
    ? (parsed as { candidates: unknown[] }).candidates
    : parsed
  if (!Array.isArray(list)) fail("model output must be a JSON array or {\"candidates\": [...]}")
  if (list.length > MAX_CANDIDATES) fail(`model output exceeds ${MAX_CANDIDATES} candidates`)
  return (list as unknown[]).map((entry) => {
    const candidate = validateCandidate(entry)
    if (candidate.source !== "synthesis" || candidate.trust !== "T0" || candidate.provenance.actor !== "model") {
      fail("model output must use source synthesis, trust T0, and model provenance")
    }
    if (candidate.conflictResolution !== undefined) {
      fail("model output cannot provide a conflict-resolution record")
    }
    return candidate
  })
}

function dedupeKey(candidate: Pick<LearnCandidate, "repo" | "namespace" | "title" | "body">): string {
  return `${candidate.repo}\n${candidate.namespace}\n${normalizeTopicText(candidate.title)}\n${normalizeTopicText(candidate.body)}`
}

// Drop incoming candidates that duplicate existing or already-seen content.
export function dedupeCandidates(
  existing: readonly LearnCandidate[],
  incoming: readonly LearnCandidate[],
): { kept: LearnCandidate[]; duplicates: string[] } {
  if (existing.length > MAX_EXISTING_CANDIDATES || incoming.length > MAX_CANDIDATES) {
    throw new Error("candidate comparison exceeds its bounds")
  }
  const seen = new Set(existing.map(dedupeKey))
  const kept: LearnCandidate[] = []
  const duplicates: string[] = []
  for (const candidate of incoming) {
    const key = dedupeKey(candidate)
    if (seen.has(key)) {
      duplicates.push(candidate.id)
      continue
    }
    seen.add(key)
    kept.push(candidate)
  }
  return { kept, duplicates }
}

function contradictionQuestion(incoming: LearnCandidate, otherTitle: string): string {
  return (
    `Candidate ${JSON.stringify(incoming.title)} may contradict ` +
    `${JSON.stringify(otherTitle)}; which statement should be kept, and what evidence decides it?`
  )
}

// Conflict detection. A candidate is quarantined (never dropped, never
// auto-active) when it explicitly contradicts a known topic or restates a
// known title with different content. Every quarantine carries questions.
export function detectConflicts(
  existing: readonly LearnCandidate[],
  incoming: readonly LearnCandidate[],
): LearnCandidate[] {
  if (existing.length > MAX_EXISTING_CANDIDATES || incoming.length > MAX_CANDIDATES) {
    throw new Error("conflict comparison exceeds its bounds")
  }
  const conflictWith = new Map<string, Set<string>>()
  const questionsByID = new Map<string, string[]>()
  const addPair = (first: LearnCandidate, second: LearnCandidate): void => {
    if (first.repo !== second.repo || first.namespace !== second.namespace) return
    if (!conflictWith.has(first.id)) conflictWith.set(first.id, new Set())
    if (!conflictWith.has(second.id)) conflictWith.set(second.id, new Set())
    conflictWith.get(first.id)?.add(second.id)
    conflictWith.get(second.id)?.add(first.id)
    const firstQuestions = questionsByID.get(first.id) ?? []
    firstQuestions.push(contradictionQuestion(first, second.title))
    questionsByID.set(first.id, firstQuestions)
    const secondQuestions = questionsByID.get(second.id) ?? []
    secondQuestions.push(contradictionQuestion(second, first.title))
    questionsByID.set(second.id, secondQuestions)
  }

  const allKnown = [...existing, ...incoming]
  for (let index = 0; index < incoming.length; index += 1) {
    const candidate = incoming[index]
    if (!candidate) continue
    for (const other of existing) {
      if (normalizeTopicText(candidate.title) === normalizeTopicText(other.title) &&
        normalizeTopicText(candidate.body) !== normalizeTopicText(other.body)) {
        addPair(candidate, other)
      }
      if ((candidate.contradicts ?? []).some((topic) => normalizeTopicText(topic) === normalizeTopicText(other.title))) {
        addPair(candidate, other)
      }
    }
    for (let otherIndex = index + 1; otherIndex < incoming.length; otherIndex += 1) {
      const other = incoming[otherIndex]
      if (!other || candidate.repo !== other.repo || candidate.namespace !== other.namespace) continue
      if (normalizeTopicText(candidate.title) === normalizeTopicText(other.title) &&
        normalizeTopicText(candidate.body) !== normalizeTopicText(other.body)) {
        addPair(candidate, other)
      }
      if ((candidate.contradicts ?? []).some((topic) => normalizeTopicText(topic) === normalizeTopicText(other.title)) ||
        (other.contradicts ?? []).some((topic) => normalizeTopicText(topic) === normalizeTopicText(candidate.title))) {
        addPair(candidate, other)
      }
    }
  }
  // Keep this lookup explicit: it makes a candidate's contradiction topics
  // compare against the complete incoming set, not only persisted state.
  for (const candidate of incoming) {
    for (const other of allKnown) {
      if (candidate.id === other.id || candidate.repo !== other.repo || candidate.namespace !== other.namespace) continue
      if ((candidate.contradicts ?? []).some((topic) => normalizeTopicText(topic) === normalizeTopicText(other.title))) {
        addPair(candidate, other)
      }
    }
  }

  return incoming.map((candidate) => {
    const conflictsWith = [...(conflictWith.get(candidate.id) ?? [])].slice(0, MAX_CANDIDATES)
    if (conflictsWith.length === 0) return candidate
    const questions = [...(candidate.questions ?? []), ...(questionsByID.get(candidate.id) ?? [])]
    return {
      ...candidate,
      state: "quarantined" as const,
      conflict: {
        status: candidate.conflict.status === "confirmed" ? "confirmed" as const : "suspect" as const,
        reason: candidate.conflict.reason ?? `possible contradiction with ${conflictsWith.length} known candidate(s)`,
        with: [...(candidate.conflict.with ?? []), ...conflictsWith].slice(0, MAX_CANDIDATES),
      },
      questions: questions.slice(0, MAX_QUESTIONS),
    }
  })
}

export function buildSynthesisPrompt(extracted: readonly string[], repo: string, namespace: string, origin?: string): string {
  const lines = extracted.slice(0, MAX_SUMMARIES).map((summary, index) => `--- episode ${index + 1} ---\n${summary}`).join("\n")
  return [
    `Extract durable repository learnings for ${repo} (namespace ${namespace}) from these episode summaries.`,
    "Return ONLY strict JSON: an array of candidates, each with id, repo, namespace, title (<=160 chars),",
    "body (<=2000 chars, summary only, no transcripts), trust (T0), source (synthesis), state (pending),",
    "id must be the canonical cand-<12 hex> digest of namespace, normalized title, and normalized body; no T4 or conflictResolution.",
    "provenance {repo, actor: model, createdAt (ISO-8601 UTC)}, validity {expiresAt (<=90 days after createdAt), scope},",
    "conflict {status: none|suspect|confirmed, reason when not none, with ids when known},",
    "optional questions (required when conflict is not none), and optional contradicts (topic titles).",
    `Use repo ${JSON.stringify(repo)} and namespace ${JSON.stringify(namespace)} exactly.`,
    ...(origin === undefined ? [] : [`Use canonical origin ${JSON.stringify(origin)} exactly when an origin field is emitted.`]),
    "At most 16 candidates. No markdown, no commentary.",
    lines,
  ].join("\n")
}

function buildRepairPrompt(error: string): string {
  return (
    `The previous output was rejected (${error}). ` +
    "Return ONLY the corrected strict JSON array with the same field rules. No markdown, no commentary."
  )
}

function correctionCandidate(
  correction: string,
  input: Pick<SynthesizeInput, "repo" | "namespace" | "origin">,
  now: () => number,
): LearnCandidate | undefined {
  let redacted: string
  try {
    redacted = redactInputString(correction, "correction", 64 * 1024)
  } catch {
    return undefined
  }
  const body = redacted.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS)
  if (!body) return undefined
  const firstLine = body.split(/(?<=[.?!\n])\s/)[0] ?? body
  const title = firstLine.slice(0, MAX_TITLE_CHARS)
  const createdAtMs = now()
  const createdAt = new Date(createdAtMs).toISOString()
  const candidate: LearnCandidate = {
    id: makeCandidateId(input.namespace, title, body),
    repo: input.repo,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    namespace: input.namespace,
    title,
    body,
    trust: "T1",
    source: "correction",
    state: "pending",
    provenance: { repo: input.repo, actor: "user", createdAt },
    validity: { expiresAt: new Date(createdAtMs + CANDIDATE_TTL_MS).toISOString(), scope: input.repo },
    conflict: { status: "none" },
  }
  return validateCandidate(candidate)
}

function resourceGateReason(gate: SynthesisResourceGate | undefined): string | undefined {
  if (gate === undefined) return undefined
  if (!isRecord(gate)) return "resource gate input is not an object"
  if (gate.idle !== true) return "model synthesis is deferred until the host is idle"
  const cpuLoad = gate.cpuLoad ?? gate.cpu ?? (gate.cpuPercent === undefined ? undefined : gate.cpuPercent / 100)
  const memoryBytes = gate.memoryBytes ?? gate.ramBytes ?? gate.ram
  const providerQuota = gate.providerQuotaRemaining ?? gate.providerQuota ?? gate.quota
  const queueDepth = gate.queueDepth ?? gate.queue
  if (cpuLoad === undefined || memoryBytes === undefined || providerQuota === undefined || queueDepth === undefined) {
    return "resource gate requires idle, CPU, RAM, provider quota, and queue depth inputs"
  }
  if (!Number.isFinite(cpuLoad) || cpuLoad < 0 || cpuLoad > 1) return "resource CPU input is out of bounds"
  if (!Number.isFinite(memoryBytes) || memoryBytes < 0 || memoryBytes > MAX_RESOURCE_MEMORY_BYTES) {
    return "resource RAM input is out of bounds"
  }
  if (!Number.isInteger(providerQuota) || providerQuota < 0 || providerQuota > MAX_RESOURCE_PROVIDER_QUOTA) {
    return "resource provider quota input is out of bounds"
  }
  if (!Number.isInteger(queueDepth) || queueDepth < 0 || queueDepth > MAX_RESOURCE_QUEUE_DEPTH * 4) {
    return "resource queue input is out of bounds"
  }
  if (cpuLoad > MAX_RESOURCE_CPU_LOAD) return "model synthesis is deferred while CPU load is high"
  if (memoryBytes > MAX_RESOURCE_MEMORY_BYTES) return "model synthesis is deferred while RAM pressure is high"
  if (providerQuota < 1) return "model synthesis is deferred because provider quota is exhausted"
  if (queueDepth > MAX_RESOURCE_QUEUE_DEPTH) return "model synthesis is deferred because the synthesis queue is full"
  return undefined
}

function makeMeta(attempts: number, extractedSummaries: number, duplicates: number, candidates: readonly LearnCandidate[]): SynthesizeMeta {
  return {
    attempts,
    extractedSummaries,
    duplicates,
    quarantined: candidates.filter((candidate) => candidate.state === "quarantined").length,
  }
}

function resolveIncoming(
  existing: readonly LearnCandidate[],
  incoming: readonly LearnCandidate[],
): { candidates: LearnCandidate[]; duplicates: number } {
  const { kept, duplicates } = dedupeCandidates(existing, incoming)
  return { candidates: detectConflicts(existing, kept).slice(0, MAX_CANDIDATES), duplicates: duplicates.length }
}

function correctionCandidates(input: SynthesizeInput, now: () => number): LearnCandidate[] {
  if (!Array.isArray(input.corrections)) return []
  const candidates: LearnCandidate[] = []
  for (const correction of input.corrections.slice(0, MAX_CANDIDATES)) {
    if (typeof correction !== "string") continue
    const candidate = correctionCandidate(correction, input, now)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}

function scopedExistingCandidates(
  input: SynthesizeInput,
  repo: string,
  namespace: string,
  origin: string | undefined,
): LearnCandidate[] {
  if (input.existing === undefined) return []
  if (!Array.isArray(input.existing)) throw new Error("existing candidates must be an array")
  if (input.existing.length > MAX_EXISTING_CANDIDATES) {
    throw new Error(`existing candidates exceed ${MAX_EXISTING_CANDIDATES}`)
  }
  return input.existing.map((candidate) =>
    validateCandidateFor(
      { repo, namespace, origin },
      candidate,
      { allowLifecycleStates: true },
    ),
  )
}

function correctionOnlyResult(
  input: SynthesizeInput,
  corrections: readonly LearnCandidate[],
  attempts: number,
  extractedSummaries: number,
  error?: string,
): SynthesizeResult {
  const resolved = resolveIncoming(input.existing ?? [], corrections)
  if (error !== undefined) {
    return {
      ok: false,
      error,
      candidates: resolved.candidates,
    }
  }
  return {
    ok: true,
    candidates: resolved.candidates,
    meta: makeMeta(attempts, extractedSummaries, resolved.duplicates, resolved.candidates),
  }
}

// Bounded synthesis: one model attempt plus a single repair fallback, then
// fail closed. Explicit corrections are materialized before any model call,
// so they survive empty inputs, provider errors, and invalid model output.
export async function synthesizeCandidates(
  generateText: GenerateTextFn | undefined,
  input: SynthesizeInput,
): Promise<SynthesizeResult> {
  const now = input.now ?? Date.now
  let safeRepo: string
  let safeNamespace: string
  let safeOrigin: string | undefined
  try {
    safeRepo = safeStoredString(input.repo, "repo", 512)
    safeNamespace = safeStoredString(input.namespace, "namespace", 128)
    if (!SAFE_NAMESPACE.test(safeNamespace)) fail("namespace is outside the learnings namespace")
    if (input.origin !== undefined) safeOrigin = safeStoredString(input.origin, "origin", 512)
  } catch (error) {
    return { ok: false, error: `synthesis input rejected: ${safeError(error)}`, candidates: [] }
  }
  const scopedInput = { ...input, repo: safeRepo, namespace: safeNamespace, origin: safeOrigin }
  const corrections = correctionCandidates(scopedInput, now)
  let existing: LearnCandidate[]
  try {
    existing = scopedExistingCandidates(scopedInput, safeRepo, safeNamespace, safeOrigin)
  } catch (error) {
    return correctionOnlyResult(
      { ...scopedInput, existing: [] },
      corrections,
      0,
      0,
      `synthesis input rejected: ${safeError(error)}`,
    )
  }
  const extracted = Array.isArray(input.summaries) ? deterministicExtract(input.summaries) : []
  const gateError = resourceGateReason(input.resourceGate ?? input.resources ?? input.resource)
  if (gateError !== undefined) {
    return correctionOnlyResult({ ...scopedInput, existing }, corrections, 0, extracted.length, gateError)
  }
  if (extracted.length === 0) {
    if (corrections.length > 0) return correctionOnlyResult({ ...scopedInput, existing }, corrections, 0, 0)
    return { ok: false, error: "no usable episode summaries after deterministic extraction", candidates: [] }
  }
  if (generateText === undefined) {
    return correctionOnlyResult({ ...scopedInput, existing }, corrections, 0, extracted.length, "synthesis provider is unavailable")
  }
  const prompt = buildSynthesisPrompt(extracted, safeRepo, safeNamespace, safeOrigin)
  let payload: LearnCandidate[] | undefined
  let attempts = 0
  let lastError = "unknown synthesis failure"
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts = attempt + 1
    try {
      const response = await generateText({ prompt: attempt === 0 ? prompt : `${prompt}\n${buildRepairPrompt(lastError)}` })
      const text = response?.data?.text
      if (typeof text !== "string" || !text.trim()) throw new Error("empty model response")
      payload = response.data.text.length > 32_768
        ? validateSynthesisPayload(response.data.text.slice(0, 32_768))
        : validateSynthesisPayload(response.data.text)
      break
    } catch (error) {
      lastError = safeError(error)
      payload = undefined
    }
  }
  if (!payload) {
    return correctionOnlyResult(
      input,
      corrections,
      attempts,
      extracted.length,
      `synthesis failed closed after ${attempts} attempt(s): ${lastError}`,
    )
  }
  try {
    const scoped = payload.map((candidate) => validateCandidateFor({ repo: safeRepo, namespace: safeNamespace, origin: safeOrigin }, candidate))
    const resolved = resolveIncoming(existing, [...corrections, ...scoped])
    return {
      ok: true,
      candidates: resolved.candidates,
      meta: makeMeta(attempts, extracted.length, resolved.duplicates, resolved.candidates),
    }
  } catch (error) {
    const message = safeError(error)
    return correctionOnlyResult(
      { ...scopedInput, existing },
      corrections,
      attempts,
      extracted.length,
      `synthesis failed closed during validation: ${message}`,
    )
  }
}
