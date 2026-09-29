// Basic Memory namespaced promotion: strict per-repo namespaces inside one
// shared project, plus a promotion draft builder and an approved promotion
// path stub.
//
// The plugin must never write to Basic Memory directly. Promotion produces a
// draft (exact markdown plus a declarative write_note call description) and a
// state-bound approval token; the host executes the write only after explicit
// exact-diff approval. All helpers here are pure data builders.

import { createHash, randomBytes } from "node:crypto"

import { containsSensitive, redactText } from "./redact.ts"
import { makeCandidateId, type CandidateState, type LearnCandidate, type TrustClass } from "./synthesize.ts"

export const LEARN_NAMESPACE_ROOT = "learnings"
export const MAX_SLUG_CHARS = 64
export const MAX_NOTE_CHARS = 8_192
export const PROMOTION_TOKEN_TTL_MS = 60_000
export const BASIC_MEMORY_PROJECT = "computer-assistant"
export const BASIC_MEMORY_OUTPUT_FORMAT = "text" as const
const MAX_PROMOTION_TOKENS = 64
const CANDIDATE_ID = /^cand-[0-9a-f]{12}$/

export type PromotionWriteCall = {
  tool: "write_note"
  input: {
    title: string
    content: string
    directory: string
    project: string
    output_format: "text" | "json"
  }
}

export type PromotionDraft = {
  candidateID?: string
  candidateTrust?: TrustClass
  candidateState?: CandidateState
  notePath: string
  title: string
  markdown: string
  contentHash: string
  writeCall: PromotionWriteCall
  payloadHash?: string
}

export type PromotionIntent = {
  action: "promote"
  candidateID: string
  notePath: string
  contentHash: string
  payloadHash?: string
}

function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
}

const CREDENTIAL_URI = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi
const SCP_CREDENTIAL = /^[^/@\s:]+:[^/@\s]*@[^:/\s]+:/
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const MAX_GATE_IDENTITY_CHARS = 256
const MAX_DATE_MS = 8_640_000_000_000_000

function hasCredentialMaterial(value: string): boolean {
  CREDENTIAL_URI.lastIndex = 0
  return containsSensitive(value) || CREDENTIAL_URI.test(value) || SCP_CREDENTIAL.test(value)
}

function assertSafeBoundaryText(value: string, label: string): void {
  if (CONTROL_EXCEPT_WHITESPACE.test(value) || hasCredentialMaterial(value) || redactText(value) !== value) {
    throw new Error(`${label} contains secret material; refused`)
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function canonicalRemote(value: string): string | undefined {
  if (SCP_CREDENTIAL.test(value.trim())) throw new Error("remote contains credential material")
  let trimmed: string
  try {
    trimmed = redactText(value.trim()).replace(CREDENTIAL_URI, "$1[REDACTED]@")
  } catch {
    return undefined
  }
  if (!trimmed) return undefined
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const url = new URL(trimmed)
      const host = url.host.toLowerCase()
      const segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.replace(/\.git$/i, "").toLowerCase())
      if (host && segments.length > 0 && segments.every((segment) => segment !== "." && segment !== "..")) {
        return `${host}/${segments.join("/")}`
      }
    }
  } catch {
    // Fall through to the scp-like remote form or local-path fallback.
  }
  const scp = trimmed.match(/^(?:[^/@\s:]+@)?([^:/\s]+):(.+)$/)
  if (!scp) return undefined
  const host = scp[1].toLowerCase()
  const segments = scp[2]
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/\.git$/i, "").toLowerCase())
  if (!host || segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return undefined
  return `${host}/${segments.join("/")}`
}

function canonicalLocal(value: string): string {
  const slashified = value.trim().replace(/\\/g, "/")
  const absolute = slashified.startsWith("/") || /^[A-Za-z]:\//.test(slashified)
  const parts: string[] = []
  for (const part of slashified.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "parent") parts.pop()
      else parts.push("parent")
      continue
    }
    parts.push(part.replace(/\.git$/i, ""))
  }
  if (parts.length === 0) throw new Error(`repo ${JSON.stringify(value)} has no usable namespace slug or identity`)
  return `${absolute ? "absolute" : "relative"}/${parts.join("/")}`
}

function repoIdentity(repo: string, origin?: string): { canonical: string; readable: string } {
  if (typeof repo !== "string" || !repo.trim()) throw new Error("repo is missing or empty")
  if (repo.length > 512) throw new Error("repo exceeds 512 characters")
  const suppliedOrigin = typeof origin === "string" && origin.trim() ? origin.trim() : undefined
  if (suppliedOrigin !== undefined && suppliedOrigin.length > 512) throw new Error("origin exceeds 512 characters")
  const remote = canonicalRemote(suppliedOrigin ?? repo)
  if (remote !== undefined) {
    const readable = `remote-${remote.replace(/[^a-z0-9]+/gi, "-")}`
    return { canonical: `remote/${remote}`, readable }
  }
  // The fallback includes the canonicalized checkout path in the fingerprint,
  // so sibling checkouts with the same basename cannot collide. Only the
  // sanitized slug is exposed in the namespace; the full path is not stored.
  let safeLocal = repo
  try {
    safeLocal = redactText(repo).replace(CREDENTIAL_URI, "$1[REDACTED]@")
  } catch {
    throw new Error("repo could not be safely canonicalized")
  }
  const local = canonicalLocal(safeLocal)
  const basename = local.split("/").pop() ?? "repo"
  return { canonical: `local/${local}`, readable: `local-${basename}` }
}

export function canonicalRepoIdentity(repo: string, origin?: string): string {
  const identity = repoIdentity(repo, origin)
  if (!identity.canonical.startsWith("local/")) return identity.canonical
  return `local/${slugSegment(identity.readable)}/${digest(identity.canonical).slice(0, 16)}`
}

// Derive a strict per-repo namespace from the canonical remote owner/repo
// identity when available. A stable cryptographic fingerprint is always
// appended, including for local checkouts, so basename collisions are safe.
export function slugForRepo(repo: string, origin?: string): string {
  const identity = repoIdentity(repo, origin)
  const readable = slugSegment(identity.readable)
  const fingerprint = digest(identity.canonical).slice(0, 12)
  const readableLimit = Math.max(1, MAX_SLUG_CHARS - fingerprint.length - 1)
  const prefix = readable.slice(0, readableLimit).replace(/-+$/g, "") || "repo"
  return `${prefix}-${fingerprint}`.slice(0, MAX_SLUG_CHARS)
}

export function repoNamespace(repo: string, origin?: string): string {
  return `${LEARN_NAMESPACE_ROOT}/${slugForRepo(repo, origin)}/`
}

function checkNamespace(namespace: string): void {
  if (typeof namespace !== "string" || !namespace.startsWith(`${LEARN_NAMESPACE_ROOT}/`) || !namespace.endsWith("/") || namespace.includes("..") || namespace.includes("\\") || /[\u0000-\u001f]/.test(namespace)) {
    throw new Error(`namespace ${JSON.stringify(namespace)} is outside ${LEARN_NAMESPACE_ROOT}/`)
  }
  const slug = namespace.slice(LEARN_NAMESPACE_ROOT.length + 1, -1)
  if (!slug || slug.length > MAX_SLUG_CHARS || !/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`namespace ${JSON.stringify(namespace)} has an invalid slug`)
  }
}

function checkCandidateID(id: string): void {
  if (!CANDIDATE_ID.test(id)) throw new Error(`candidate id ${JSON.stringify(id)} is invalid`)
}

// Namespace isolation: the candidate must belong to this exact repo namespace.
export function assertCandidateNamespace(
  candidate: Pick<LearnCandidate, "namespace" | "repo" | "origin">,
  repo: string,
  origin?: string,
): void {
  assertSafeBoundaryText(candidate.repo, "candidate.repo")
  const candidateOrigin = candidate.origin ?? origin
  if (candidate.origin !== undefined && origin !== undefined && candidate.origin !== origin) {
    throw new Error(`origin isolation: candidate is for ${JSON.stringify(candidate.origin)}, expected ${JSON.stringify(origin)}`)
  }
  if (origin === undefined && candidate.origin !== undefined) {
    throw new Error(`origin isolation: candidate is for ${JSON.stringify(candidate.origin)}, expected no origin`)
  }
  if (candidateOrigin !== undefined) assertSafeBoundaryText(candidateOrigin, "candidate.origin")
  const expected = repoNamespace(repo, candidateOrigin)
  if (candidate.namespace !== expected) {
    throw new Error(`namespace isolation: candidate is in ${JSON.stringify(candidate.namespace)}, expected ${JSON.stringify(expected)}`)
  }
  if (candidate.repo !== repo) {
    throw new Error(`repo isolation: candidate is for ${JSON.stringify(candidate.repo)}, expected ${JSON.stringify(repo)}`)
  }
}

export function notePathFor(namespace: string, id: string): string {
  checkNamespace(namespace)
  checkCandidateID(id)
  return `${namespace}${id}.md`
}

export type CrossRepoPromotionPath = {
  action: "cross-repo-promote"
  candidateID: string
  sourceNamespace: string
  targetNamespace: string
  targetNotePath: string
  requiresExplicitApproval: true
  automatic: false
}

// Declarative path stub only. It computes no write call and cannot upgrade a
// candidate to T4; a separate exact-diff, human-approved workflow must own
// any future cross-repository promotion.
export function crossRepoPromotionPathStub(candidateID: string, sourceRepo: string, targetRepo: string): CrossRepoPromotionPath {
  checkCandidateID(candidateID)
  assertSafeBoundaryText(sourceRepo, "source repo")
  assertSafeBoundaryText(targetRepo, "target repo")
  if (sourceRepo === targetRepo) throw new Error("cross-repo promotion requires a different target repo")
  const sourceNamespace = repoNamespace(sourceRepo)
  const targetNamespace = repoNamespace(targetRepo)
  if (sourceNamespace === targetNamespace) throw new Error("cross-repo promotion target resolves to the source namespace")
  return {
    action: "cross-repo-promote",
    candidateID,
    sourceNamespace,
    targetNamespace,
    targetNotePath: notePathFor(targetNamespace, candidateID),
    requiresExplicitApproval: true,
    automatic: false,
  }
}

// Guard a note path against traversal and cross-namespace writes.
export function isPathInNamespace(notePath: string, namespace: string): boolean {
  try {
    checkNamespace(namespace)
  } catch {
    return false
  }
  if (typeof notePath !== "string" || !notePath.startsWith(namespace) || notePath.includes("..") || notePath.includes("\\") || /[\u0000-\u001f]/.test(notePath)) return false
  const rest = notePath.slice(namespace.length)
  return /^cand-[0-9a-f]{12}\.md$/.test(rest)
}

function promotionTitle(candidate: LearnCandidate): string {
  return candidate.id
}

function assertCandidatePromotionSafe(candidate: LearnCandidate): void {
  const fields = [
    [candidate.id, "candidate.id"],
    [candidate.repo, "candidate.repo"],
    [candidate.namespace, "candidate.namespace"],
    [candidate.title, "candidate.title"],
    [candidate.body, "candidate.body"],
    [candidate.validity.scope, "candidate.validity.scope"],
    [candidate.validity.expiresAt, "candidate.validity.expiresAt"],
    [candidate.conflict.reason ?? "", "candidate.conflict.reason"],
    [candidate.provenance.repo, "candidate.provenance.repo"],
    [candidate.provenance.episodeID ?? "", "candidate.provenance.episodeID"],
    [candidate.provenance.sessionID ?? "", "candidate.provenance.sessionID"],
    ...(candidate.questions ?? []).map((question) => [question, "candidate.question"] as const),
  ] as const
  for (const [value, label] of fields) {
    if (value) assertSafeBoundaryText(value, label)
  }
}

export function buildPromotionMarkdown(candidate: LearnCandidate): string {
  assertCandidatePromotionSafe(candidate)
  const lines = [
    `# ${candidate.title}`,
    "",
    `- trust: ${candidate.trust}`,
    `- source: ${candidate.source}`,
    `- repo: ${candidate.repo}`,
    `- namespace: ${candidate.namespace}`,
    `- validity: ${candidate.validity.scope}, expires ${candidate.validity.expiresAt}`,
    `- conflict: ${candidate.conflict.status}${candidate.conflict.reason ? ` (${candidate.conflict.reason})` : ""}`,
    `- provenance: ${candidate.provenance.actor}, ${candidate.provenance.createdAt}` +
      `${candidate.provenance.episodeID ? `, episode ${candidate.provenance.episodeID}` : ""}` +
      `${candidate.provenance.sessionID ? `, session ${candidate.provenance.sessionID}` : ""}`,
    "",
    "## Learning",
    "",
    candidate.body,
    "",
  ]
  if (candidate.questions && candidate.questions.length > 0) {
    lines.push("## Open questions", "", ...candidate.questions.map((question) => `- ${question}`), "")
  }
  const markdown = lines.join("\n")
  if (markdown.length > MAX_NOTE_CHARS) {
    throw new Error(`promotion markdown exceeds ${MAX_NOTE_CHARS} characters`)
  }
  return markdown
}

type PromotionWriteInput = PromotionWriteCall["input"]

function canonicalWriteInput(title: string, markdown: string, directory: string): PromotionWriteInput {
  if (title.length === 0 || title.length > MAX_NOTE_CHARS || markdown.length > MAX_NOTE_CHARS) {
    throw new Error("promotion write payload exceeds its text bounds")
  }
  assertSafeBoundaryText(title, "promotion title")
  assertSafeBoundaryText(markdown, "promotion content")
  assertSafeBoundaryText(directory, "promotion directory")
  return {
    title,
    content: markdown,
    directory,
    project: BASIC_MEMORY_PROJECT,
    output_format: BASIC_MEMORY_OUTPUT_FORMAT,
  }
}

function payloadHash(writeCall: PromotionWriteCall): string {
  return createHash("sha256")
    .update(JSON.stringify({ tool: writeCall.tool, input: {
      title: writeCall.input.title,
      content: writeCall.input.content,
      directory: writeCall.input.directory,
      project: writeCall.input.project,
      output_format: writeCall.input.output_format,
    } }), "utf8")
    .digest("hex")
}

function validatePromotionDraft(draft: PromotionDraft): { writeInput: PromotionWriteInput; payloadHash: string } {
  if (!draft || typeof draft !== "object") throw new Error("promotion draft is missing")
  if (draft.writeCall?.tool !== "write_note") throw new Error("promotion draft has an invalid write_note call")
  if (typeof draft.notePath !== "string" || typeof draft.title !== "string" || typeof draft.markdown !== "string") {
    throw new Error("promotion draft has an invalid canonical field")
  }
  if (draft.title.length === 0 || draft.title.length > MAX_NOTE_CHARS || draft.markdown.length > MAX_NOTE_CHARS) {
    throw new Error("promotion draft exceeds its text bounds")
  }
  if (typeof draft.candidateID !== "string" || draft.candidateID !== draft.notePath.match(/(cand-[0-9a-f]{12})\.md$/)?.[1]) {
    throw new Error("promotion candidate id is not canonical")
  }
  if (draft.candidateState !== "approved" || (draft.candidateTrust !== "T2" && draft.candidateTrust !== "T3")) {
    throw new Error("promotion requires an approved T2+ candidate")
  }
  const input = draft.writeCall.input
  if (!input || typeof input !== "object") throw new Error("promotion draft is missing its write payload")
  if (input.content !== draft.markdown) throw new Error("writeCall content must exactly match markdown")
  if (input.title !== draft.title) throw new Error("writeCall title must exactly match the draft title")
  if (input.project !== BASIC_MEMORY_PROJECT || input.output_format !== BASIC_MEMORY_OUTPUT_FORMAT) {
    throw new Error("writeCall project and output format are not canonical")
  }
  if (!isPathInNamespace(draft.notePath, input.directory)) {
    throw new Error("promotion draft escapes its namespace; refused")
  }
  assertSafeBoundaryText(draft.notePath, "promotion note path")
  const expectedContentHash = createHash("sha256").update(draft.markdown, "utf8").digest("hex")
  if (draft.contentHash !== expectedContentHash) throw new Error("promotion content hash is not canonical")
  const canonicalInput = canonicalWriteInput(draft.title, draft.markdown, input.directory)
  const canonicalCall: PromotionWriteCall = { tool: "write_note", input: canonicalInput }
  const canonicalPayloadHash = payloadHash(canonicalCall)
  if (draft.payloadHash !== undefined && draft.payloadHash !== canonicalPayloadHash) {
    throw new Error("promotion write payload hash is not canonical")
  }
  return { writeInput: canonicalInput, payloadHash: canonicalPayloadHash }
}

// Build the exact promotion draft for review. Preview-safe: no I/O, no
// Basic Memory calls. The markdown shown here must byte-match the write.
export function buildPromotionDraft(candidate: LearnCandidate, now: () => number = Date.now): PromotionDraft {
  assertCandidatePromotionSafe(candidate)
  if (candidate.state !== "approved" || (candidate.trust !== "T2" && candidate.trust !== "T3")) {
    throw new Error("promotion requires an approved T2+ candidate")
  }
  assertCandidateNamespace(candidate, candidate.repo, candidate.origin)
  checkCandidateID(candidate.id)
  if (candidate.id !== makeCandidateId(candidate.namespace, candidate.title, candidate.body)) {
    throw new Error("candidate id is not canonical for promotion")
  }
  const expiresAt = Date.parse(candidate.validity.expiresAt)
  const nowMs = now()
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > MAX_DATE_MS || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    throw new Error(`candidate ${candidate.id} is expired; promotion is closed`)
  }
  const notePath = notePathFor(candidate.namespace, candidate.id)
  const title = promotionTitle(candidate)
  const markdown = buildPromotionMarkdown(candidate)
  const contentHash = createHash("sha256").update(markdown, "utf8").digest("hex")
  const input = canonicalWriteInput(title, markdown, candidate.namespace)
  const writeCall: PromotionWriteCall = { tool: "write_note", input }
  if (writeCall.input.content !== markdown) throw new Error("writeCall content must exactly match markdown")
  return {
    candidateID: candidate.id,
    candidateTrust: candidate.trust,
    candidateState: candidate.state,
    notePath,
    title,
    markdown,
    contentHash,
    writeCall,
    payloadHash: payloadHash(writeCall),
  }
}

type PromotionToken = {
  token: string
  sessionID: string
  agent: string
  intent: PromotionIntent
  writeInput: PromotionWriteInput
  payloadHash: string
  expiresAt: number
}

// Approved promotion path stub. Issues state-bound approval tokens for an
// exact draft hash and, on apply, returns the declarative write_note call for
// the host to execute after explicit approval. This stub never touches the
// Basic Memory MCP server itself.
export function createPromotionGate(now: () => number = Date.now) {
  const tokens = new Map<string, PromotionToken>()

  const checkedNow = (): number => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS - PROMOTION_TOKEN_TTL_MS) {
      throw new Error("promotion clock must be a valid date")
    }
    return value
  }

  const checkedIdentity = (value: string, label: string): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_GATE_IDENTITY_CHARS) {
      throw new Error(`${label} is required and bounded`)
    }
    assertSafeBoundaryText(value, label)
    return value
  }

  const prune = (nowMs: number) => {
    for (const [key, value] of tokens) if (value.expiresAt <= nowMs) tokens.delete(key)
    while (tokens.size >= MAX_PROMOTION_TOKENS) {
      const oldest = tokens.keys().next().value as string | undefined
      if (!oldest) break
      tokens.delete(oldest)
    }
  }

  const preview = (draft: PromotionDraft, sessionID: string, agent: string) => {
    const canonical = validatePromotionDraft(draft)
    const safeSessionID = checkedIdentity(sessionID, "sessionID")
    const safeAgent = checkedIdentity(agent, "agent")
    const issuedAt = checkedNow()
    prune(issuedAt)
    const intent: PromotionIntent = {
      action: "promote",
      candidateID: draft.candidateID ?? draft.notePath.match(/(cand-[0-9a-f]{12})\.md$/)?.[1] ?? draft.notePath,
      notePath: draft.notePath,
      contentHash: draft.contentHash,
      payloadHash: canonical.payloadHash,
    }
    const token = randomBytes(24).toString("base64url")
    const expiresAt = issuedAt + PROMOTION_TOKEN_TTL_MS
    const storedIntent = { ...intent }
    tokens.set(token, {
      token,
      sessionID: safeSessionID,
      agent: safeAgent,
      intent: storedIntent,
      writeInput: canonical.writeInput,
      payloadHash: canonical.payloadHash,
      expiresAt,
    })
    return { dryRun: true as const, intent: { ...storedIntent }, expectToken: token, expiresAt }
  }

  // Apply path: revalidates token binding and exact draft bytes, then hands
  // the host the write_note call. Requires explicit human approval upstream.
  const apply = (
    draft: PromotionDraft,
    input: { expectToken?: string; approval?: boolean },
    sessionID: string,
    agent: string,
  ): PromotionWriteCall => {
    if (input.approval !== true) throw new Error("promotion requires explicit approval=true")
    const safeSessionID = checkedIdentity(sessionID, "sessionID")
    const safeAgent = checkedIdentity(agent, "agent")
    const nowMs = checkedNow()
    const record = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!record || record.expiresAt <= nowMs) throw new Error("promotion approval token is missing or expired")
    if (record.sessionID !== safeSessionID || record.agent !== safeAgent) {
      throw new Error("promotion approval token does not match this session and agent")
    }
    const currentHash = createHash("sha256").update(draft.markdown, "utf8").digest("hex")
    if (currentHash !== draft.contentHash || currentHash !== record.intent.contentHash) {
      throw new Error("promotion draft changed after preview; preview again")
    }
    const canonical = validatePromotionDraft(draft)
    if (record.intent.notePath !== draft.notePath) {
      throw new Error("promotion approval token does not match this draft")
    }
    if (canonical.payloadHash !== record.payloadHash || canonical.payloadHash !== record.intent.payloadHash) {
      throw new Error("promotion write payload changed after preview; preview again")
    }
    tokens.delete(record.token)
    // Rebuild the returned call from the token-bound canonical payload. The
    // caller's mutable draft/writeCall is never returned to the host.
    return {
      tool: "write_note",
      input: {
        title: record.writeInput.title,
        content: record.writeInput.content,
        directory: record.writeInput.directory,
        project: record.writeInput.project,
        output_format: record.writeInput.output_format,
      },
    }
  }

  return { preview, apply }
}
