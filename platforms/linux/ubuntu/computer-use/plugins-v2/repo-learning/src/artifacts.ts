// RLE artifact compiler: smallest-artifact routing + bounded unified-diff
// preview + server-held, token-gated promotion scaffolding.
//
// Scope: candidate classification and human-gated promotion scaffolding only.
// This module never commits, pushes, changes permissions, or touches the
// filesystem. Promotion is still a write-path stub, but the preview/apply
// boundary is complete enough to reject replay, expiry, theft, stale state,
// path drift, content drift, and sensitive text.

import { createHash, randomBytes } from "node:crypto"

import { containsSensitive, redactText } from "./redact.ts"

export const ARTIFACT_KINDS = [
  "fact",
  "gotcha",
  "convention",
  "preference",
  "skill",
  "test",
  "docs",
  "tool",
  "automation",
  "optimization",
  "retirement",
  "question",
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export type ArtifactStatus = "candidate" | "approved" | "rejected" | "promoted"

export type LearnedArtifact = {
  readonly id: string
  readonly kind: ArtifactKind
  readonly title: string
  readonly body: string
  readonly sourceSession?: string
  readonly createdAt: string
  readonly baseHash?: string
  readonly status: ArtifactStatus
}

export type ArtifactInput = {
  readonly title: string
  readonly body: string
  readonly sourceSession?: string
  readonly baseHash?: string
}

export const ARTIFACT_PREVIEW_TTL_MS = 60_000
export const MAX_ARTIFACT_PREVIEW_TOKENS = 64
export const MAX_BASE_CONTENT_CHARS = 64 * 1024
export const MAX_DIFF_CHARS = 96 * 1024
const MAX_ARTIFACT_ID_CHARS = 256
const MAX_DATE_MS = 8_640_000_000_000_000
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const CREDENTIAL_URI = /(\b[a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED\]@)[^\/\s:@]+(?::[^\/\s@]*)?@/gi

function containsCredentialMaterial(value: string): boolean {
  CREDENTIAL_URI.lastIndex = 0
  return CREDENTIAL_URI.test(value)
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value)
}

export type ArtifactPreviewIntent = {
  readonly action: "promote"
  readonly artifactId: string
  readonly path: string
  readonly baseHash: string
  readonly contentHash: string
}

/**
 * Public preview information. The claims are useful to a UI, but are never
 * trusted during apply: the opaque token indexes an entry in a server-held
 * store owned by createArtifactPromotionGate.
 */
export type PreviewToken = {
  readonly token: string
  readonly artifactId: string
  readonly artifactHash: string
  readonly contentHash: string
  readonly baseHash: string
  readonly path: string
  readonly intent: "promote"
  readonly sessionID: string
  readonly agent: string
  readonly issuedAt: string
  readonly expiresAt: number
}

export type PromotionTarget = {
  readonly path: string
  readonly symlink: boolean
}

export type PromotionRuntime = {
  readonly sessionID?: string
  readonly agent?: string
  readonly proposedContent?: string
}

export type PreviewOptions = PromotionRuntime & {
  readonly nowMs?: number
}

export type PromotionRequest = {
  readonly artifact: LearnedArtifact
  readonly target: PromotionTarget
  readonly token: PreviewToken
  /** The server-side caller identity. */
  readonly sessionID?: string
  readonly agent?: string
  /** Separate human approval; artifact status alone is not sufficient. */
  readonly approval?: boolean
  readonly proposedContent?: string
}

export type PromotionResult =
  | { readonly applied: false; readonly reason: string }
  | { readonly applied: true; readonly artifactId: string; readonly path: string }

const MAX_TITLE_LENGTH = 160
const MAX_BODY_LENGTH = 8 * 1024
function normalizeText(value: string): string {
  return value.trim().toLowerCase()
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

/** Route free-form learning text to the smallest matching artifact kind.
 * Order matters: question beats everything, then the most specific shape
 * wins; plain statements fall through to fact. */
export function routeArtifact(input: { title: string; body: string }): ArtifactKind {
  const text = normalizeText(`${input.title}\n${input.body}`)
  if (/[?]\s*$/.test(text) || text.startsWith("how ") || text.startsWith("why ") || text.includes("open question")) {
    return "question"
  }
  if (containsAny(text, ["retirement", "retire ", "retire:", "deprecate", "sunset", "remove permanently"])) {
    return "retirement"
  }
  if (containsAny(text, ["optimization", "optimize ", "optimize:", "performance tuning", "make faster"])) {
    return "optimization"
  }
  if (containsAny(text, ["automation", "automate ", "automate:", "scheduled task", "recurring task", "cron job", "timer job"])) {
    return "automation"
  }
  if (containsAny(text, ["preference", "user prefers", "user preference", "personal preference", "prefer "])) {
    return "preference"
  }
  if (containsAny(text, ["regression test", "unit test", "test case", "failing test", "add a test"])) {
    return "test"
  }
  if (containsAny(text, ["runbook", "how-to", "documentation", "readme", "changelog entry"])) {
    return "docs"
  }
  if (containsAny(text, ["cli flag", "command:", "tool:", "script:", "one-liner", "run this command"])) {
    return "tool"
  }
  if (containsAny(text, ["reusable workflow", "skill:", "sop:", "playbook", "checklist:"])) {
    return "skill"
  }
  if (containsAny(text, ["always ", "never ", "convention:", "style rule"])) {
    return "convention"
  }
  if (containsAny(text, ["gotcha", "pitfall", "fails when", "breaks if", "watch out", "silent failure"])) {
    return "gotcha"
  }
  return "fact"
}

function redactedText(value: string): string {
  const redacted = redactText(value)
  CREDENTIAL_URI.lastIndex = 0
  return redacted.replace(CREDENTIAL_URI, "$1[REDACTED]@")
}

function requireString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  if (value.length === 0 || value.length > maximum) throw new Error(`${label} must be 1-${maximum} characters`)
  if (CONTROL_EXCEPT_WHITESPACE.test(value)) throw new Error(`${label} contains control characters`)
  return value
}

function checkedArtifactMetadata(artifact: LearnedArtifact): void {
  const textFields: Array<[string, string, number]> = [
    [artifact.id, "artifact id", MAX_ARTIFACT_ID_CHARS],
    [artifact.title, "artifact title", MAX_TITLE_LENGTH],
    [artifact.body, "artifact body", MAX_BODY_LENGTH],
    ...(artifact.sourceSession === undefined ? [] : [[artifact.sourceSession, "artifact sourceSession", 256] as [string, string, number]]),
    [artifact.createdAt, "artifact createdAt", 128],
    ...(artifact.baseHash === undefined ? [] : [[artifact.baseHash, "artifact baseHash", 512] as [string, string, number]]),
  ]
  for (const [value, label, maximum] of textFields) {
    requireString(value, label, maximum)
    if (containsSensitive(value) || containsCredentialMaterial(value) || redactedText(value) !== value) {
      throw new Error("artifact contains sensitive text")
    }
  }
  if (!isArtifactKind(artifact.kind)) throw new Error("artifact kind is invalid")
  if (!Number.isFinite(Date.parse(artifact.createdAt))) throw new Error("artifact createdAt is invalid")
  if (artifact.status !== "candidate" && artifact.status !== "approved" && artifact.status !== "rejected" && artifact.status !== "promoted") {
    throw new Error("artifact status is invalid")
  }
}

export function compileArtifact(input: ArtifactInput, id: string): LearnedArtifact {
  requireString(id, "artifact id", MAX_ARTIFACT_ID_CHARS)
  const title = redactedText(requireString(input.title, "artifact title", MAX_TITLE_LENGTH).trim())
  const body = redactedText(requireString(input.body, "artifact body", MAX_BODY_LENGTH).trim())
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new Error(`artifact title must be 1-${MAX_TITLE_LENGTH} characters`)
  }
  if (!body || body.length > MAX_BODY_LENGTH) {
    throw new Error(`artifact body must be 1-${MAX_BODY_LENGTH} characters`)
  }
  const sourceSession = input.sourceSession === undefined
    ? undefined
    : redactedText(requireString(input.sourceSession, "artifact sourceSession", 256).trim())
  if (input.baseHash !== undefined) requireString(input.baseHash, "artifact baseHash", 512)
  const artifact: LearnedArtifact = {
    id,
    kind: routeArtifact({ title, body }),
    title,
    body,
    sourceSession,
    createdAt: new Date().toISOString(),
    baseHash: input.baseHash,
    status: "candidate",
  }
  checkedArtifactMetadata(artifact)
  return artifact
}

/** Lexical path guard for promotion targets. Mirrors the file-manager
 * containment rules at the lexical level: no absolute paths, no traversal
 * components, no .git segments, no NUL bytes. Symlink targets are refused
 * separately via the target.symlink flag. */
export function isSafeArtifactPath(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false
  if (value.includes("\0") || CONTROL_EXCEPT_WHITESPACE.test(value) || containsSensitive(value) || containsCredentialMaterial(value)) return false
  const slashValue = value.replaceAll("\\", "/")
  if (slashValue.startsWith("/") || /^[A-Za-z]:/.test(value)) return false
  const parts = slashValue.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return false
  if (parts.some((part) => part === ".git")) return false
  return true
}

function canonicalPath(value: string): string {
  if (!isSafeArtifactPath(value)) throw new Error(`unsafe promotion path: ${value}`)
  return value.replaceAll("\\", "/")
}

export function checkPromotionTarget(target: PromotionTarget): { ok: boolean; reason?: string } {
  if (target === null || typeof target !== "object") {
    return { ok: false, reason: "promotion target is required" }
  }
  if (!isSafeArtifactPath(target.path)) {
    return { ok: false, reason: `unsafe promotion path: ${target.path}` }
  }
  if (typeof target.symlink !== "boolean") {
    return { ok: false, reason: "promotion target symlink flag is required" }
  }
  if (target.symlink) {
    return { ok: false, reason: "symlink promotion targets are refused" }
  }
  return { ok: true }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function canonicalArtifactRecord(artifact: LearnedArtifact): string {
  return JSON.stringify({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    body: artifact.body,
    sourceSession: artifact.sourceSession ?? null,
    createdAt: artifact.createdAt,
    baseHash: artifact.baseHash ?? null,
    status: artifact.status,
  })
}

export function artifactHash(artifact: LearnedArtifact): string {
  checkedArtifactMetadata(artifact)
  return sha256(canonicalArtifactRecord(artifact))
}

/** The proposed file bytes for this compiler-only promotion scaffold. */
export function artifactContent(artifact: LearnedArtifact): string {
  return artifact.body
}

function assertSafeArtifactText(artifact: LearnedArtifact): void {
  const title = redactedText(artifact.title)
  const body = redactedText(artifact.body)
  const sourceSession = artifact.sourceSession === undefined ? undefined : redactedText(artifact.sourceSession)
  const allText = `${artifact.title}\n${artifact.body}\n${artifact.sourceSession ?? ""}`
  if (
    title !== artifact.title ||
    body !== artifact.body ||
    sourceSession !== artifact.sourceSession ||
    containsSensitive(allText) ||
    containsCredentialMaterial(allText)
  ) {
    throw new Error("artifact contains sensitive text; compile it through compileArtifact before promotion")
  }
}

function checkedContent(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  if (value.length > MAX_BASE_CONTENT_CHARS) {
    throw new Error(`${label} exceeds ${MAX_BASE_CONTENT_CHARS} characters`)
  }
  const redacted = redactedText(value)
  if (redacted !== value || containsSensitive(value) || containsCredentialMaterial(value)) {
    throw new Error(`${label} contains sensitive text`)
  }
  return value
}

function contentHash(value: string): string {
  return sha256(value)
}

function splitLines(value: string): string[] {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
}

type DiffOperation = { readonly type: "equal" | "delete" | "insert"; readonly line: string }

function fallbackOperations(base: readonly string[], proposed: readonly string[]): DiffOperation[] {
  return [
    ...base.map((line) => ({ type: "delete" as const, line })),
    ...proposed.map((line) => ({ type: "insert" as const, line })),
  ]
}

/** Bounded LCS-based line diff. Large inputs use a full delete/add hunk but
 * still represent both sides, rather than silently treating the change as
 * additions-only. */
function diffOperations(base: readonly string[], proposed: readonly string[]): DiffOperation[] {
  const cells = base.length * proposed.length
  if (cells > 262_144 || base.length > 512 || proposed.length > 512) {
    return fallbackOperations(base, proposed)
  }
  const width = proposed.length + 1
  const table = new Uint16Array((base.length + 1) * width)
  for (let row = base.length - 1; row >= 0; row -= 1) {
    for (let column = proposed.length - 1; column >= 0; column -= 1) {
      const index = row * width + column
      table[index] = base[row] === proposed[column]
        ? (table[(row + 1) * width + column + 1] ?? 0) + 1
        : Math.max(table[(row + 1) * width + column] ?? 0, table[row * width + column + 1] ?? 0)
    }
  }
  const operations: DiffOperation[] = []
  let row = 0
  let column = 0
  while (row < base.length && column < proposed.length) {
    if (base[row] === proposed[column]) {
      operations.push({ type: "equal", line: base[row] })
      row += 1
      column += 1
    } else if ((table[(row + 1) * width + column] ?? 0) >= (table[row * width + column + 1] ?? 0)) {
      operations.push({ type: "delete", line: base[row] })
      row += 1
    } else {
      operations.push({ type: "insert", line: proposed[column] })
      column += 1
    }
  }
  while (row < base.length) {
    operations.push({ type: "delete", line: base[row] })
    row += 1
  }
  while (column < proposed.length) {
    operations.push({ type: "insert", line: proposed[column] })
    column += 1
  }
  return operations
}

export function buildUnifiedDiff(path: string, baseContent: string, proposedContent: string): string {
  const safePath = canonicalPath(path)
  const base = checkedContent(baseContent, "baseContent")
  const proposed = checkedContent(proposedContent, "proposedContent")
  const baseLines = splitLines(base)
  const proposedLines = splitLines(proposed)
  const operations = diffOperations(baseLines, proposedLines)
  const lines = [
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
    `@@ -1,${baseLines.length} +1,${proposedLines.length} @@`,
    ...operations.map((operation) => `${operation.type === "equal" ? " " : operation.type === "delete" ? "-" : "+"}${operation.line}`),
  ]
  const diff = lines.join("\n")
  if (diff.length > MAX_DIFF_CHARS) throw new Error(`promotion diff exceeds ${MAX_DIFF_CHARS} characters`)
  return diff
}

function canonicalIntent(intent: ArtifactPreviewIntent): string {
  return JSON.stringify({
    action: intent.action,
    artifactId: intent.artifactId,
    path: intent.path,
    baseHash: intent.baseHash,
    contentHash: intent.contentHash,
  })
}

type StoredPreview = {
  readonly token: string
  readonly sessionID: string
  readonly agent: string
  readonly intent: ArtifactPreviewIntent
  readonly intentHash: string
  readonly artifactHash: string
  readonly symlink: boolean
  readonly expiresAt: number
  readonly publicToken: PreviewToken
}

function validIdentity(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} is required`)
  }
  if (CONTROL_EXCEPT_WHITESPACE.test(value) || containsSensitive(value) || containsCredentialMaterial(value) || redactedText(value) !== value) {
    throw new Error(`${label} contains unsafe text`)
  }
  return value
}

function nowFor(value: number | undefined): number {
  const now = value ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS - ARTIFACT_PREVIEW_TTL_MS) {
    throw new Error("preview time must be a valid date")
  }
  return now
}

function publicTokenMatches(stored: StoredPreview, supplied: PreviewToken): boolean {
  return supplied.token === stored.token &&
    supplied.artifactId === stored.intent.artifactId &&
    supplied.artifactHash === stored.artifactHash &&
    supplied.contentHash === stored.intent.contentHash &&
    supplied.baseHash === stored.intent.baseHash &&
    supplied.path === stored.intent.path &&
    supplied.intent === stored.intent.action &&
    supplied.sessionID === stored.sessionID &&
    supplied.agent === stored.agent &&
    supplied.issuedAt === stored.publicToken.issuedAt &&
    supplied.expiresAt === stored.expiresAt
}

function currentBaseHash(currentBase: string | { readonly content: string; readonly hash?: string }): string {
  if (typeof currentBase === "string") return contentHash(checkedContent(currentBase, "current base content"))
  if (currentBase === null || typeof currentBase !== "object") throw new Error("current base content is required")
  const content = checkedContent(currentBase.content, "current base content")
  const computed = contentHash(content)
  if (currentBase.hash !== undefined && currentBase.hash !== computed) {
    throw new Error("current base hash does not match current base content")
  }
  return computed
}

export type ArtifactPromotionGate = ReturnType<typeof createArtifactPromotionGate>

/**
 * Create a server-held preview/apply gate. Only the opaque random token is
 * intended to cross the server boundary; this map is authoritative for
 * identity, canonical intent, hashes, expiry, and single-use consumption.
 */
export function createArtifactPromotionGate(now: () => number = Date.now) {
  const tokens = new Map<string, StoredPreview>()

  const prune = (nowMs: number) => {
    for (const [key, value] of tokens) if (value.expiresAt <= nowMs) tokens.delete(key)
    while (tokens.size >= MAX_ARTIFACT_PREVIEW_TOKENS) {
      const oldest = tokens.keys().next().value as string | undefined
      if (!oldest) break
      tokens.delete(oldest)
    }
  }

  const preview = (
    artifact: LearnedArtifact,
    target: PromotionTarget,
    baseContent: string,
    options: PreviewOptions = {},
  ): { readonly diff: string; readonly token: PreviewToken } => {
    assertSafeArtifactText(artifact)
    const targetCheck = checkPromotionTarget(target)
    if (!targetCheck.ok) throw new Error(targetCheck.reason)
    const path = canonicalPath(target.path)
    const base = checkedContent(baseContent, "baseContent")
    const proposed = checkedContent(options.proposedContent ?? artifactContent(artifact), "proposedContent")
    const sessionID = validIdentity(options.sessionID, "sessionID")
    const agent = validIdentity(options.agent, "agent")
    const issuedAtMs = nowFor(options.nowMs ?? now())
    const expiresAt = issuedAtMs + ARTIFACT_PREVIEW_TTL_MS
    const intent: ArtifactPreviewIntent = {
      action: "promote",
      artifactId: artifact.id,
      path,
      baseHash: contentHash(base),
      contentHash: contentHash(proposed),
    }
    const token = randomBytes(32).toString("base64url")
    const artifactDigest = artifactHash(artifact)
    const intentHash = sha256(canonicalIntent(intent))
    const publicToken: PreviewToken = {
      token,
      artifactId: artifact.id,
      artifactHash: artifactDigest,
      contentHash: intent.contentHash,
      baseHash: intent.baseHash,
      path,
      intent: intent.action,
      sessionID,
      agent,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt,
    }
    const storedPublicToken = Object.freeze({ ...publicToken })
    prune(issuedAtMs)
    const diff = buildUnifiedDiff(path, base, proposed)
    tokens.set(token, {
      token,
      sessionID,
      agent,
      intent,
      intentHash,
      artifactHash: artifactDigest,
      symlink: target.symlink,
      expiresAt,
      publicToken: storedPublicToken,
    })
    return { diff, token: { ...storedPublicToken } }
  }

  const revalidate = (
    token: PreviewToken,
    artifact: LearnedArtifact,
    target: PromotionTarget,
    currentBase: string | { readonly content: string; readonly hash?: string },
    runtime: PromotionRuntime = {},
  ): { valid: boolean; reason?: string } => {
    if (token === null || typeof token !== "object") {
      return { valid: false, reason: "preview token is missing, expired, or already used" }
    }
    const nowMs = nowFor(now())
    prune(nowMs)
    const stored = tokens.get(token.token)
    if (!stored) return { valid: false, reason: "preview token is missing, expired, or already used" }
    if (stored.expiresAt <= nowMs) return { valid: false, reason: "preview token is expired" }
    if (!publicTokenMatches(stored, token)) return { valid: false, reason: "preview token claims were changed" }
    if (runtime.sessionID === undefined) {
      return { valid: false, reason: "preview token session identity is required" }
    }
    if (runtime.agent === undefined) {
      return { valid: false, reason: "preview token agent identity is required" }
    }
    if (runtime.sessionID !== stored.sessionID) {
      return { valid: false, reason: "preview token session mismatch" }
    }
    if (runtime.agent !== stored.agent) {
      return { valid: false, reason: "preview token agent mismatch" }
    }
    try {
      assertSafeArtifactText(artifact)
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "artifact text is unsafe" }
    }
    if (stored.intent.artifactId !== artifact.id) {
      return { valid: false, reason: "token artifact mismatch" }
    }
    if (stored.artifactHash !== artifactHash(artifact)) {
      return { valid: false, reason: "artifact changed since preview" }
    }
    let targetPath: string
    try {
      targetPath = canonicalPath(target.path)
    } catch {
      return { valid: false, reason: `unsafe promotion path: ${target.path}` }
    }
    const targetCheck = checkPromotionTarget(target)
    if (!targetCheck.ok) return { valid: false, reason: targetCheck.reason }
    if (stored.intent.path !== targetPath) {
      return { valid: false, reason: "destination path changed since preview" }
    }
    if (stored.symlink !== target.symlink) {
      return { valid: false, reason: "destination symlink state changed since preview" }
    }
    try {
      const currentHash = currentBaseHash(currentBase)
      if (stored.intent.baseHash !== currentHash) {
        return { valid: false, reason: `base moved since preview (${stored.intent.baseHash} -> ${currentHash})` }
      }
      const proposed = checkedContent(runtime.proposedContent ?? artifactContent(artifact), "proposedContent")
      if (stored.intent.contentHash !== contentHash(proposed)) {
        return { valid: false, reason: "proposed content changed since preview" }
      }
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "preview content revalidation failed" }
    }
    if (stored.intentHash !== sha256(canonicalIntent(stored.intent))) {
      return { valid: false, reason: "server preview intent is invalid" }
    }
    return { valid: true }
  }

  const apply = (
    request: PromotionRequest,
    currentBase: string | { readonly content: string; readonly hash?: string },
  ): PromotionResult => {
    if (request.approval !== true) {
      return { applied: false, reason: "promotion requires explicit approval=true" }
    }
    if (request.artifact.status !== "approved") {
      return { applied: false, reason: `artifact ${request.artifact.id} is not approved (status: ${request.artifact.status})` }
    }
    if (request.sessionID === undefined || request.agent === undefined) {
      return { applied: false, reason: "promotion requires the issuing sessionID and agent" }
    }
    const validation = revalidate(request.token, request.artifact, request.target, currentBase, {
      sessionID: request.sessionID,
      agent: request.agent,
      proposedContent: request.proposedContent,
    })
    if (!validation.valid) return { applied: false, reason: validation.reason ?? "preview revalidation failed" }
    // Consume only after all approval, identity, intent, path, base, and
    // content checks pass. The stub has no write effect, but replay is still
    // refused at this boundary.
    tokens.delete(request.token.token)
    return {
      applied: false,
      reason:
        `promotion stub: no writes performed (artifact ${request.artifact.id} -> ${request.target.path}); ` +
        "re-run behind an approved write path. Commit/push are never performed by this module.",
    }
  }

  return { preview, revalidate, apply }
}

const defaultPromotionGate = createArtifactPromotionGate()

/** Build a preview using the module's server-held compatibility gate. */
export function createPreview(
  artifact: LearnedArtifact,
  target: PromotionTarget,
  baseContent: string,
  options: PreviewOptions = {},
): { readonly diff: string; readonly token: PreviewToken } {
  return defaultPromotionGate.preview(artifact, target, baseContent, options)
}

/** Revalidate without consuming a token. Apply is the single-use operation. */
export function revalidatePreview(
  token: PreviewToken,
  artifact: LearnedArtifact,
  target: PromotionTarget,
  currentBase: string | { readonly content: string; readonly hash?: string },
  runtime: PromotionRuntime = {},
): { valid: boolean; reason?: string } {
  return defaultPromotionGate.revalidate(token, artifact, target, currentBase, runtime)
}

/** Promotion applier stub. It performs no filesystem writes. */
export function applyPromotion(
  request: PromotionRequest,
  currentBase: string | { readonly content: string; readonly hash?: string },
): PromotionResult {
  return defaultPromotionGate.apply(request, currentBase)
}
