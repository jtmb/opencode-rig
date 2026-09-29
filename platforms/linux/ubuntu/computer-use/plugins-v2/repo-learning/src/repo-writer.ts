import { constants } from "node:fs"
import { lstat, link, mkdir, open, readdir, unlink } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"

import { canonicalRepoIdentity, repoNamespace as memoryRepoNamespace } from "./memory-namespace.ts"
import { containsSensitive, redactText } from "./redact.ts"

export const LEARNED_INSTRUCTION_DIRECTORY = "docs/learned-instructions"
export const REPO_LEARNING_JOURNAL_DIRECTORY = ".git/repo-learning/journal"
export const MAX_INSTRUCTION_TITLE_CHARS = 160
export const MAX_INSTRUCTION_CHARS = 8_192
export const MAX_CANONICAL_INSTRUCTION_BYTES = 24 * 1024
export const MAX_JOURNAL_RECORD_BYTES = 48 * 1024

export const INSTRUCTION_JOURNAL_STATES = [
  "approved",
  "repo-written",
  "mirror-pending",
  "readback-verified",
  "quarantined",
] as const

export type InstructionJournalState = (typeof INSTRUCTION_JOURNAL_STATES)[number]
export type InstructionProgressState = Exclude<InstructionJournalState, "quarantined">

export type InstructionRepository = {
  root: string
  repo: string
  origin?: string
}

export type InstructionCandidate = {
  candidateID: string
  title: string
  instruction: string
}

export type CanonicalInstructionPlan = {
  schema: "open-rig-learned-instruction/v1"
  candidateID: string
  title: string
  instruction: string
  instructionDigest: string
  contentID: string
  repoNamespace: string
  repoIdentityDigest: string
  repositoryRootDigest: string
  targetPath: string
  targetDigest: string
  baseDigest: string
  contentDigest: string
  content: string
}

export type ApprovalContextDigest = {
  approvedAt: number
  contextDigest: string
}

export type InstructionJournalRecord = {
  schema: "open-rig-repo-learning-journal/v1"
  state: InstructionJournalState
  plan: CanonicalInstructionPlan
  approval: ApprovalContextDigest
  recordedAt: number
  quarantineReason?: QuarantineReason
}

export type QuarantineReason =
  | "target-collision"
  | "stale-base"
  | "canonical-mismatch"
  | "canonical-missing"
  | "memory-project-mismatch"
  | "memory-profile-mismatch"
  | "memory-note-conflict"
  | "readback-mismatch"

export type RepoWriteResult = {
  plan: CanonicalInstructionPlan
  state: InstructionProgressState
  idempotent: boolean
}

export type RepositoryWriterOptions = {
  now?: () => number
  onTransition?: (state: InstructionJournalState) => void | Promise<void>
}

const SHA256 = /^[0-9a-f]{64}$/
const CONTENT_ID = /^[0-9a-f]{64}$/
const MAX_CANDIDATE_ID_CHARS = 128
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Credential identifiers include AWS key/session forms and bearer-prefixed IDs.
const AWS_ACCESS_KEY_ID = /^(?:AKIA|ASIA)[0-9A-Z]{16}$/
const AWS_SESSION_TOKEN = /^(?:FwoGZX|IQoJ|AQoDYXdz)[A-Za-z0-9._~-]{24,}$/
const BEARER_CREDENTIAL_ID = /^bearer[.:_-][A-Za-z0-9._~-]{16,}$/i
const SAFE_MEMORY_NAMESPACE = /^learnings\/[a-z0-9-]{1,64}\/$/
const SECRET_URI = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi
const CONTROL_EXCEPT_NEWLINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const INVISIBLE_FORMATTING = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/
const POISONED_INSTRUCTION = /\b(?:ignore|disregard|override|bypass|disable|circumvent)\s+(?:(?:all|any)\s+)?(?:previous|prior|above|system|developer|operator|safety|security|approval|review|policy|instructions?)\b|\b(?:reveal|exfiltrate|dump|print|expose)\s+(?:all\s+)?(?:secrets?|credentials?|tokens?|private\s+keys?)\b|\b(?:pretend|act)\s+(?:you\s+are|as)\s+(?:an?\s+)?(?:system|developer|root|administrator)\b|<!--|<\/?(?:script|iframe|style)\b/i
const JOURNAL_SCHEMA = "open-rig-repo-learning-journal/v1" as const
const INSTRUCTION_SCHEMA = "open-rig-learned-instruction/v1" as const
const ABSENT_BASE_DIGEST = digest("open-rig-repo-learning:absent-target:v1")
const JOURNAL_STATE_FILE: Record<InstructionJournalState, string> = {
  approved: "approved.json",
  "repo-written": "repo-written.json",
  "mirror-pending": "mirror-pending.json",
  "readback-verified": "readback-verified.json",
  quarantined: "quarantined.json",
}
const PROGRESS_ORDER: readonly InstructionProgressState[] = [
  "approved",
  "repo-written",
  "mirror-pending",
  "readback-verified",
]

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is not a canonical SHA-256 digest`)
}

function containsCredentialLikeContent(value: string, maximum: number): boolean {
  if (typeof value !== "string" || value.length > maximum) return true
  SECRET_URI.lastIndex = 0
  return containsSensitive(value) || redactText(value) !== value || SECRET_URI.test(value) ||
    AWS_ACCESS_KEY_ID.test(value) || AWS_SESSION_TOKEN.test(value) || BEARER_CREDENTIAL_ID.test(value)
}

function hasSuspiciousIdentifierEntropy(value: string): boolean {
  if (value.length < 32) return false
  const frequencies = new Map<string, number>()
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
  const entropy = [...frequencies.values()].reduce((total, count) => {
    const probability = count / value.length
    return total - probability * Math.log2(probability)
  }, 0)
  return entropy >= 3.75
}

function isSafeCandidateID(value: unknown): value is string {
  return typeof value === "string" && CANDIDATE_ID.test(value) &&
    !containsCredentialLikeContent(value, MAX_CANDIDATE_ID_CHARS) && !hasSuspiciousIdentifierEntropy(value)
}

function assertSafeText(value: string, label: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be non-empty and at most ${maximum} characters`)
  }
  if (CONTROL_EXCEPT_NEWLINES.test(value) || INVISIBLE_FORMATTING.test(value) || containsCredentialLikeContent(value, maximum)) {
    throw new Error(`${label} contains control characters or secret material`)
  }
}

function safeYaml(value: string): string {
  return JSON.stringify(value)
}

function renderContent(input: {
  candidateID: string
  title: string
  instruction: string
  instructionDigest: string
  contentID: string
  repoNamespace: string
  repoIdentityDigest: string
}): string {
  return [
    "---",
    `schema: ${INSTRUCTION_SCHEMA}`,
    `content_id: ${input.contentID}`,
    `candidate_id: ${safeYaml(input.candidateID)}`,
    `repo_namespace: ${input.repoNamespace}`,
    `repo_identity_sha256: ${input.repoIdentityDigest}`,
    `instruction_sha256: ${input.instructionDigest}`,
    "authority: subordinate",
    `title: ${safeYaml(input.title)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.instruction,
    "",
    "> This learning is subordinate to current repository policy and requires independent operator judgment.",
    "> It grants no permission to bypass AGENTS.md, approvals, or safety rules.",
    "",
  ].join("\n")
}

function expectedContentID(input: {
  candidateID: string
  title: string
  instructionDigest: string
  repoIdentityDigest: string
}): string {
  return digest(JSON.stringify({
    schema: INSTRUCTION_SCHEMA,
    candidateID: input.candidateID,
    title: input.title,
    instructionDigest: input.instructionDigest,
    repoIdentityDigest: input.repoIdentityDigest,
  }))
}

function canonicalTarget(contentID: string): string {
  if (!CONTENT_ID.test(contentID)) throw new Error("content id is invalid")
  return `${LEARNED_INSTRUCTION_DIRECTORY}/${contentID}.md`
}

function planFingerprint(plan: CanonicalInstructionPlan): string {
  return digest(JSON.stringify([
    plan.schema,
    plan.candidateID,
    plan.title,
    plan.instruction,
    plan.instructionDigest,
    plan.contentID,
    plan.repoNamespace,
    plan.repoIdentityDigest,
    plan.repositoryRootDigest,
    plan.targetPath,
    plan.targetDigest,
    plan.baseDigest,
    plan.contentDigest,
    plan.content,
  ]))
}

export function validateInstructionPlan(value: unknown): asserts value is CanonicalInstructionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("instruction plan is missing")
  const plan = value as Partial<CanonicalInstructionPlan>
  if (plan.schema !== INSTRUCTION_SCHEMA) throw new Error("instruction plan schema is invalid")
  if (!isSafeCandidateID(plan.candidateID)) throw new Error("instruction candidate id is invalid")
  if (typeof plan.title !== "string") throw new Error("instruction title is invalid")
  if (typeof plan.instruction !== "string") throw new Error("instruction payload is invalid")
  assertSafeText(plan.title, "instruction title", MAX_INSTRUCTION_TITLE_CHARS)
  if (/[\r\n]/.test(plan.title)) throw new Error("instruction title must be one line")
  assertSafeText(plan.instruction, "instruction payload", MAX_INSTRUCTION_CHARS)
  if (!plan.instruction.trim() || POISONED_INSTRUCTION.test(plan.instruction)) {
    throw new Error("instruction payload is empty or contains a poisoned instruction")
  }
  assertDigest(plan.instructionDigest, "instruction digest")
  assertDigest(plan.contentID, "content id")
  assertDigest(plan.repoIdentityDigest, "repository identity digest")
  assertDigest(plan.repositoryRootDigest, "repository root digest")
  assertDigest(plan.targetDigest, "target digest")
  assertDigest(plan.baseDigest, "base digest")
  assertDigest(plan.contentDigest, "content digest")
  if (typeof plan.repoNamespace !== "string" || !SAFE_MEMORY_NAMESPACE.test(plan.repoNamespace)) {
    throw new Error("repository memory namespace is invalid")
  }
  const targetPath = canonicalTarget(plan.contentID)
  if (plan.targetPath !== targetPath || plan.targetDigest !== digest(targetPath)) {
    throw new Error("instruction target path or digest is not canonical")
  }
  const instructionDigest = digest(plan.instruction)
  if (plan.instructionDigest !== instructionDigest) throw new Error("instruction digest does not match its payload")
  const contentID = expectedContentID({
    candidateID: plan.candidateID,
    title: plan.title,
    instructionDigest,
    repoIdentityDigest: plan.repoIdentityDigest,
  })
  if (plan.contentID !== contentID) throw new Error("content id does not match the approved candidate")
  const content = renderContent({
    candidateID: plan.candidateID,
    title: plan.title,
    instruction: plan.instruction,
    instructionDigest,
    contentID,
    repoNamespace: plan.repoNamespace,
    repoIdentityDigest: plan.repoIdentityDigest,
  })
  if (plan.content !== content || plan.contentDigest !== digest(content)) {
    throw new Error("canonical instruction content or digest changed")
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CANONICAL_INSTRUCTION_BYTES) {
    throw new Error("canonical instruction exceeds its byte bound")
  }
}

export async function createInstructionPlan(
  repository: InstructionRepository,
  candidate: InstructionCandidate,
): Promise<CanonicalInstructionPlan> {
  if (!repository || typeof repository !== "object") throw new Error("instruction repository is required")
  if (typeof repository.root !== "string" || !path.isAbsolute(repository.root)) {
    throw new Error("instruction repository root must be absolute")
  }
  if (typeof repository.repo !== "string" || !repository.repo.trim()) throw new Error("repository identity is required")
  if (repository.origin !== undefined && typeof repository.origin !== "string") throw new Error("repository origin is invalid")
  if (!candidate || typeof candidate !== "object") throw new Error("instruction candidate is required")
  if (!isSafeCandidateID(candidate.candidateID)) {
    throw new Error("instruction candidate id must be an opaque safe identifier")
  }
  assertSafeText(candidate.title, "instruction title", MAX_INSTRUCTION_TITLE_CHARS)
  if (/[\r\n]/.test(candidate.title)) throw new Error("instruction title must be one line")
  assertSafeText(candidate.instruction, "instruction payload", MAX_INSTRUCTION_CHARS)
  if (!candidate.instruction.trim() || POISONED_INSTRUCTION.test(candidate.instruction)) {
    throw new Error("instruction payload is empty or contains a poisoned instruction")
  }
  await assertSafeRoot(repository.root)
  const repoIdentity = canonicalRepoIdentity(repository.repo, repository.origin)
  const repoIdentityDigest = digest(repoIdentity)
  const repoNamespace = memoryRepoNamespace(repository.repo, repository.origin)
  const instructionDigest = digest(candidate.instruction)
  const contentID = expectedContentID({
    candidateID: candidate.candidateID,
    title: candidate.title,
    instructionDigest,
    repoIdentityDigest,
  })
  const targetPath = canonicalTarget(contentID)
  const targetDigest = digest(targetPath)
  const content = renderContent({
    candidateID: candidate.candidateID,
    title: candidate.title,
    instruction: candidate.instruction,
    instructionDigest,
    contentID,
    repoNamespace,
    repoIdentityDigest,
  })
  if (Buffer.byteLength(content, "utf8") > MAX_CANONICAL_INSTRUCTION_BYTES) {
    throw new Error("canonical instruction exceeds its byte bound")
  }
  const current = await readTarget(repository.root, targetPath)
  const plan: CanonicalInstructionPlan = {
    schema: INSTRUCTION_SCHEMA,
    candidateID: candidate.candidateID,
    title: candidate.title,
    instruction: candidate.instruction,
    instructionDigest,
    contentID,
    repoNamespace,
    repoIdentityDigest,
    repositoryRootDigest: digest(path.resolve(repository.root)),
    targetPath,
    targetDigest,
    baseDigest: current ? digest(current) : ABSENT_BASE_DIGEST,
    contentDigest: digest(content),
    content,
  }
  validateInstructionPlan(plan)
  const journal = await readJournal(repository.root, plan.contentID)
  if (journal) {
    if (journal.state === "quarantined") throw new Error("instruction candidate is already quarantined")
    const stored = journal.plan
    if (stored.contentDigest !== plan.contentDigest || stored.repoIdentityDigest !== plan.repoIdentityDigest ||
      stored.repoNamespace !== plan.repoNamespace || stored.repositoryRootDigest !== plan.repositoryRootDigest ||
      stored.targetDigest !== plan.targetDigest) {
      throw new Error("existing instruction journal conflicts with the candidate identity")
    }
    return clonePlan(stored)
  }
  return plan
}

export function instructionPlanFingerprint(plan: CanonicalInstructionPlan): string {
  validateInstructionPlan(plan)
  return planFingerprint(plan)
}

export async function writeApprovedInstruction(
  repositoryRoot: string,
  plan: CanonicalInstructionPlan,
  approvalContext: { sessionID: string; agent: string },
  options: RepositoryWriterOptions = {},
): Promise<RepoWriteResult> {
  validateInstructionPlan(plan)
  assertApprovalContext(approvalContext)
  await assertPlanRoot(repositoryRoot, plan)
  const now = checkedNow(options.now ?? Date.now)
  const existing = await readJournal(repositoryRoot, plan.contentID)
  if (existing) {
    assertSamePlan(existing.plan, plan)
  } else {
    let current: Buffer | undefined
    try {
      current = await readTarget(repositoryRoot, plan.targetPath)
    } catch {
      await appendQuarantine(repositoryRoot, plan, {
        approvedAt: now,
        contextDigest: approvalContextDigest(approvalContext),
      }, "target-collision", now, options)
      throw new Error("canonical instruction target is unsafe; quarantined")
    }
    if (current && digest(current) !== plan.contentDigest) {
      await appendQuarantine(repositoryRoot, plan, {
        approvedAt: now,
        contextDigest: approvalContextDigest(approvalContext),
      }, "target-collision", now, options)
      throw new Error("canonical instruction target contains different content; quarantined")
    }
    if (!current && plan.baseDigest !== ABSENT_BASE_DIGEST) {
      await appendQuarantine(repositoryRoot, plan, {
        approvedAt: now,
        contextDigest: approvalContextDigest(approvalContext),
      }, "stale-base", now, options)
      throw new Error("canonical instruction base changed after preview; quarantined")
    }
    await appendState(repositoryRoot, {
      schema: JOURNAL_SCHEMA,
      state: "approved",
      plan: clonePlan(plan),
      approval: { approvedAt: now, contextDigest: approvalContextDigest(approvalContext) },
      recordedAt: now,
    }, options)
  }
  return recoverApprovedInstruction(repositoryRoot, plan.contentID, options)
}

export async function recoverApprovedInstruction(
  repositoryRoot: string,
  contentID: string,
  options: RepositoryWriterOptions = {},
): Promise<RepoWriteResult> {
  if (!CONTENT_ID.test(contentID)) throw new Error("content id is invalid")
  await assertSafeRoot(repositoryRoot)
  const journal = await readJournal(repositoryRoot, contentID)
  if (!journal) throw new Error("no approved repository-learning journal entry exists")
  if (journal.state === "quarantined") throw new Error("repository-learning candidate is quarantined")
  await assertPlanRoot(repositoryRoot, journal.plan)
  let current: Buffer | undefined
  try {
    current = await readTarget(repositoryRoot, journal.plan.targetPath)
  } catch {
    const now = checkedNow(options.now ?? Date.now)
    await appendQuarantine(repositoryRoot, journal.plan, journal.approval, "canonical-mismatch", now, options)
    throw new Error("canonical instruction target became unsafe; quarantined")
  }
  let idempotent = false
  if (current) {
    if (digest(current) !== journal.plan.contentDigest || !current.equals(Buffer.from(journal.plan.content, "utf8"))) {
      const now = checkedNow(options.now ?? Date.now)
      await appendQuarantine(repositoryRoot, journal.plan, journal.approval, "canonical-mismatch", now, options)
      throw new Error("canonical instruction does not match its durable journal; quarantined")
    }
    idempotent = true
  } else {
    if (journal.state !== "approved") {
      const now = checkedNow(options.now ?? Date.now)
      await appendQuarantine(repositoryRoot, journal.plan, journal.approval, "canonical-missing", now, options)
      throw new Error("durably published instruction is missing; quarantined")
    }
    if (journal.plan.baseDigest !== ABSENT_BASE_DIGEST) {
      const now = checkedNow(options.now ?? Date.now)
      await appendQuarantine(repositoryRoot, journal.plan, journal.approval, "stale-base", now, options)
      throw new Error("repository base changed after approval; quarantined")
    }
    try {
      await publishNoReplace(repositoryRoot, journal.plan.targetPath, Buffer.from(journal.plan.content, "utf8"))
    } catch {
      const now = checkedNow(options.now ?? Date.now)
      await appendQuarantine(repositoryRoot, journal.plan, journal.approval, "target-collision", now, options)
      throw new Error("canonical instruction publication collided or became unsafe; quarantined")
    }
  }

  let state = journal.state
  if (state === "approved") {
    const now = checkedNow(options.now ?? Date.now)
    const written = await appendState(repositoryRoot, { ...journal, state: "repo-written", recordedAt: now }, options)
    state = written.state as InstructionProgressState
  }
  return { plan: clonePlan(journal.plan), state: state as InstructionProgressState, idempotent }
}

export async function markInstructionMirrorPending(
  repositoryRoot: string,
  plan: CanonicalInstructionPlan,
  options: RepositoryWriterOptions = {},
): Promise<InstructionProgressState> {
  validateInstructionPlan(plan)
  await assertPlanRoot(repositoryRoot, plan)
  const journal = await readJournal(repositoryRoot, plan.contentID)
  if (!journal || journal.state === "quarantined") throw new Error("instruction is not available for mirroring")
  assertSamePlan(journal.plan, plan)
  if (journal.state === "readback-verified") return journal.state
  if (journal.state === "mirror-pending") return journal.state
  if (journal.state !== "repo-written") throw new Error("repository instruction must be durable before mirroring")
  const current = await readTarget(repositoryRoot, plan.targetPath)
  if (!current || !current.equals(Buffer.from(plan.content, "utf8"))) {
    const now = checkedNow(options.now ?? Date.now)
    await appendQuarantine(repositoryRoot, plan, journal.approval, "canonical-mismatch", now, options)
    throw new Error("repository instruction changed before mirroring; quarantined")
  }
  const now = checkedNow(options.now ?? Date.now)
  const pending = await appendState(repositoryRoot, { ...journal, state: "mirror-pending", recordedAt: now }, options)
  return pending.state as InstructionProgressState
}

export async function markInstructionReadbackVerified(
  repositoryRoot: string,
  plan: CanonicalInstructionPlan,
  options: RepositoryWriterOptions = {},
): Promise<InstructionProgressState> {
  validateInstructionPlan(plan)
  await assertPlanRoot(repositoryRoot, plan)
  const journal = await readJournal(repositoryRoot, plan.contentID)
  if (!journal || journal.state === "quarantined") throw new Error("instruction is not available for readback verification")
  assertSamePlan(journal.plan, plan)
  if (journal.state === "readback-verified") return journal.state
  if (journal.state !== "mirror-pending") throw new Error("Basic Memory mirror is not pending")
  const current = await readTarget(repositoryRoot, plan.targetPath)
  if (!current || !current.equals(Buffer.from(plan.content, "utf8"))) {
    const now = checkedNow(options.now ?? Date.now)
    await appendQuarantine(repositoryRoot, plan, journal.approval, "canonical-mismatch", now, options)
    throw new Error("repository instruction changed before mirror readback; quarantined")
  }
  const now = checkedNow(options.now ?? Date.now)
  const verified = await appendState(repositoryRoot, { ...journal, state: "readback-verified", recordedAt: now }, options)
  return verified.state as InstructionProgressState
}

export async function quarantineInstruction(
  repositoryRoot: string,
  plan: CanonicalInstructionPlan,
  reason: QuarantineReason,
  options: RepositoryWriterOptions = {},
): Promise<void> {
  validateInstructionPlan(plan)
  if (!INSTRUCTION_QUARANTINE_REASONS.has(reason)) throw new Error("quarantine reason is invalid")
  await assertPlanRoot(repositoryRoot, plan)
  const journal = await readJournal(repositoryRoot, plan.contentID)
  if (!journal) throw new Error("cannot quarantine an instruction without a durable approval journal")
  assertSamePlan(journal.plan, plan)
  if (journal.state === "quarantined") return
  const now = checkedNow(options.now ?? Date.now)
  await appendQuarantine(repositoryRoot, plan, journal.approval, reason, now, options)
}

export async function readCanonicalInstruction(
  repositoryRoot: string,
  plan: CanonicalInstructionPlan,
): Promise<Buffer | undefined> {
  validateInstructionPlan(plan)
  await assertPlanRoot(repositoryRoot, plan)
  const current = await readTarget(repositoryRoot, plan.targetPath)
  return current ? Buffer.from(current) : undefined
}

export async function readInstructionJournal(
  repositoryRoot: string,
  contentID: string,
): Promise<InstructionJournalRecord | undefined> {
  if (!CONTENT_ID.test(contentID)) throw new Error("content id is invalid")
  await assertSafeRoot(repositoryRoot)
  return readJournal(repositoryRoot, contentID)
}

const INSTRUCTION_QUARANTINE_REASONS = new Set<QuarantineReason>([
  "target-collision",
  "stale-base",
  "canonical-mismatch",
  "canonical-missing",
  "memory-project-mismatch",
  "memory-profile-mismatch",
  "memory-note-conflict",
  "readback-mismatch",
])

function assertApprovalContext(value: { sessionID: string; agent: string }): void {
  if (!value || typeof value !== "object") throw new Error("approval context is required")
  for (const [label, text] of [["session", value.sessionID], ["agent", value.agent]] as const) {
    if (typeof text !== "string" || text.length === 0 || text.length > 256 || CONTROL_EXCEPT_NEWLINES.test(text)) {
      throw new Error(`${label} approval context is invalid`)
    }
    if (containsSensitive(text) || redactText(text) !== text) throw new Error(`${label} approval context contains secret material`)
  }
}

function approvalContextDigest(context: { sessionID: string; agent: string }): string {
  return digest(`${context.sessionID}\n${context.agent}`)
}

function checkedNow(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new Error("repository-learning clock is invalid")
  }
  return value
}

function clonePlan(plan: CanonicalInstructionPlan): CanonicalInstructionPlan {
  return { ...plan }
}

function assertSamePlan(left: CanonicalInstructionPlan, right: CanonicalInstructionPlan): void {
  if (planFingerprint(left) !== planFingerprint(right)) throw new Error("instruction plan changed after approval")
}

async function assertPlanRoot(root: string, plan: CanonicalInstructionPlan): Promise<void> {
  await assertSafeRoot(root)
  if (digest(path.resolve(root)) !== plan.repositoryRootDigest) {
    throw new Error("instruction approval belongs to a different repository checkout")
  }
}

async function assertSafeRoot(root: string): Promise<void> {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("repository root must be absolute")
  const absolute = path.resolve(root)
  await assertDirectoryChain(absolute, true)
}

async function assertDirectoryChain(absolute: string, required: boolean): Promise<void> {
  const parsed = path.parse(absolute)
  let current = parsed.root
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (const component of components) {
    current = path.join(current, component)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (isErrorCode(error, "ENOENT") && !required) return
      throw new Error(`required repository path is unavailable: ${safeRelativeError(current, absolute)}`)
    }
    if (metadata.isSymbolicLink()) throw new Error(`symlinked repository ancestor refused: ${safeRelativeError(current, absolute)}`)
    if (!metadata.isDirectory()) throw new Error(`repository ancestor is not a directory: ${safeRelativeError(current, absolute)}`)
  }
}

function safeRelativeError(value: string, root: string): string {
  return value === root ? "." : path.relative(root, value).slice(0, 160)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

async function readTarget(root: string, relativePath: string): Promise<Buffer | undefined> {
  if (relativePath !== canonicalTarget(relativePath.slice(relativePath.lastIndexOf("/") + 1, -3))) {
    throw new Error("repository target path is not canonical")
  }
  await assertSafeRoot(root)
  const absolute = path.join(root, ...relativePath.split("/"))
  const parent = path.dirname(absolute)
  try {
    await assertDirectoryChain(parent, true)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("required repository path is unavailable:")) return undefined
    throw error
  }
  let metadata
  try {
    metadata = await lstat(absolute)
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined
    throw new Error("repository target could not be inspected safely")
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("repository target is not a regular non-symlink file")
  if (metadata.size > MAX_CANONICAL_INSTRUCTION_BYTES) throw new Error("repository target exceeds the canonical instruction byte bound")
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size > MAX_CANONICAL_INSTRUCTION_BYTES) {
      throw new Error("repository target changed during safe read")
    }
    const bytes = await handle.readFile()
    if (bytes.length > MAX_CANONICAL_INSTRUCTION_BYTES) throw new Error("repository target exceeds the canonical instruction byte bound")
    return bytes
  } finally {
    await handle.close()
  }
}

async function ensureDirectory(root: string, relative: string): Promise<string> {
  const parts = relative.split("/")
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) {
    throw new Error("directory path contains traversal")
  }
  await assertSafeRoot(root)
  let current = root
  for (const part of parts) {
    const parent = current
    current = path.join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
      await syncDirectory(parent)
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw new Error("repository directory could not be created safely")
    }
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("repository directory is not a regular non-symlink directory")
  }
  return current
}

async function ensureTargetDirectory(root: string): Promise<string> {
  return ensureDirectory(root, LEARNED_INSTRUCTION_DIRECTORY)
}

async function ensureJournalDirectory(root: string, contentID: string): Promise<string> {
  if (!CONTENT_ID.test(contentID)) throw new Error("content id is invalid")
  return ensureDirectory(root, `${REPO_LEARNING_JOURNAL_DIRECTORY}/${contentID}`)
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeNoReplace(directory: string, targetName: string, bytes: Buffer, mode: number): Promise<boolean> {
  if (targetName.includes("/") || targetName === "." || targetName === "..") throw new Error("publication filename is invalid")
  const temporaryName = `.${targetName}.${randomBytes(12).toString("hex")}.tmp`
  const temporaryPath = path.join(directory, temporaryName)
  const targetPath = path.join(directory, targetName)
  let created = false
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    )
    created = true
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporaryPath, targetPath)
      await syncDirectory(directory)
      return true
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error
      return false
    }
  } finally {
    if (created) {
      try {
        await unlink(temporaryPath)
        await syncDirectory(directory)
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) throw error
      }
    }
  }
}

async function publishNoReplace(root: string, relativePath: string, bytes: Buffer): Promise<boolean> {
  const directory = await ensureTargetDirectory(root)
  const targetName = path.posix.basename(relativePath)
  const published = await writeNoReplace(directory, targetName, bytes, 0o644)
  if (!published) {
    const current = await readTarget(root, relativePath)
    if (current && current.equals(bytes)) return false
    throw new Error("canonical instruction publication collided with different content")
  }
  const current = await readTarget(root, relativePath)
  if (!current || !current.equals(bytes)) throw new Error("canonical instruction publication failed readback")
  return true
}

async function readJournal(root: string, contentID: string): Promise<InstructionJournalRecord | undefined> {
  const relative = `${REPO_LEARNING_JOURNAL_DIRECTORY}/${contentID}`
  const absolute = path.join(root, ...relative.split("/"))
  try {
    await assertDirectoryChain(absolute, true)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("required repository path is unavailable:")) return undefined
    throw error
  }
  const names = await readdir(absolute)
  if (names.length > INSTRUCTION_JOURNAL_STATES.length) throw new Error("repository-learning journal exceeds its state bound")
  for (const name of names) {
    if (!Object.values(JOURNAL_STATE_FILE).includes(name)) throw new Error("repository-learning journal contains an unknown entry")
  }
  let latest: InstructionJournalRecord | undefined
  for (let index = 0; index < PROGRESS_ORDER.length; index += 1) {
    const state = PROGRESS_ORDER[index]!
    const filename = JOURNAL_STATE_FILE[state]
    if (!names.includes(filename)) {
      const laterStateExists = PROGRESS_ORDER.slice(index + 1).some((later) => names.includes(JOURNAL_STATE_FILE[later]))
      if (laterStateExists) throw new Error("repository-learning journal has a missing transition")
      break
    }
    const next = await readJournalRecord(path.join(absolute, filename), contentID)
    if (next.state !== state) throw new Error("repository-learning journal transition filename does not match its state")
    if (latest) {
      if (latest.state === "quarantined") throw new Error("repository-learning journal continues after quarantine")
      assertSamePlan(latest.plan, next.plan)
      if (latest.approval.approvedAt !== next.approval.approvedAt || latest.approval.contextDigest !== next.approval.contextDigest) {
        throw new Error("repository-learning journal approval binding changed")
      }
    } else if (state !== "approved") {
      throw new Error("repository-learning journal does not begin with approval")
    }
    latest = next
  }
  const quarantineName = JOURNAL_STATE_FILE.quarantined
  if (names.includes(quarantineName)) {
    const quarantined = await readJournalRecord(path.join(absolute, quarantineName), contentID)
    if (latest) {
      assertSamePlan(latest.plan, quarantined.plan)
      if (latest.approval.approvedAt !== quarantined.approval.approvedAt || latest.approval.contextDigest !== quarantined.approval.contextDigest) {
        throw new Error("repository-learning quarantine changed its approval binding")
      }
    } else if (quarantined.state !== "quarantined") {
      throw new Error("repository-learning quarantine record is invalid")
    }
    if (quarantined.state !== "quarantined") throw new Error("repository-learning quarantine state is invalid")
    if (latest && quarantined.recordedAt < latest.recordedAt) throw new Error("repository-learning quarantine predates its latest state")
    latest = quarantined
  }
  if (!latest) return undefined
  return latest
}

async function readJournalRecord(file: string, contentID: string): Promise<InstructionJournalRecord> {
  const metadata = await lstat(file)
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_JOURNAL_RECORD_BYTES) {
    throw new Error("repository-learning journal record is not a bounded regular file")
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size > MAX_JOURNAL_RECORD_BYTES) {
      throw new Error("repository-learning journal changed during read")
    }
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  if (bytes.length > MAX_JOURNAL_RECORD_BYTES) throw new Error("repository-learning journal exceeds its byte bound")
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown
  } catch {
    throw new Error("repository-learning journal is malformed")
  }
  if (!isRecord(parsed) || parsed.schema !== JOURNAL_SCHEMA || typeof parsed.state !== "string" ||
    !(INSTRUCTION_JOURNAL_STATES as readonly string[]).includes(parsed.state) || !isRecord(parsed.plan) ||
    !isRecord(parsed.approval) || typeof parsed.recordedAt !== "number") {
    throw new Error("repository-learning journal has an invalid schema")
  }
  const plan = parsed.plan as unknown as CanonicalInstructionPlan
  validateInstructionPlan(plan)
  if (plan.contentID !== contentID) throw new Error("repository-learning journal content id mismatch")
  const approval = parsed.approval
  if (!Number.isSafeInteger(approval.approvedAt) || (approval.approvedAt as number) < 0 ||
    typeof approval.contextDigest !== "string" || !SHA256.test(approval.contextDigest) ||
    !Number.isSafeInteger(parsed.recordedAt) || parsed.recordedAt < 0) {
    throw new Error("repository-learning journal approval metadata is invalid")
  }
  if (parsed.state === "quarantined") {
    if (typeof parsed.quarantineReason !== "string" || !INSTRUCTION_QUARANTINE_REASONS.has(parsed.quarantineReason as QuarantineReason)) {
      throw new Error("repository-learning quarantine reason is invalid")
    }
  } else if (parsed.quarantineReason !== undefined) {
    throw new Error("repository-learning progress record contains a quarantine reason")
  }
  return parsed as unknown as InstructionJournalRecord
}

async function appendState(
  root: string,
  record: InstructionJournalRecord,
  options: RepositoryWriterOptions,
): Promise<InstructionJournalRecord> {
  validateInstructionPlan(record.plan)
  const directory = await ensureJournalDirectory(root, record.plan.contentID)
  const filename = JOURNAL_STATE_FILE[record.state]
  const json = Buffer.from(`${JSON.stringify(record)}\n`, "utf8")
  if (json.length > MAX_JOURNAL_RECORD_BYTES) throw new Error("repository-learning journal entry exceeds its byte bound")
  const written = await writeNoReplace(directory, filename, json, 0o600)
  if (!written) {
    const existing = await readJournalRecord(path.join(directory, filename), record.plan.contentID)
    if (!sameJournalRecord(existing, record)) throw new Error("repository-learning journal transition conflicts with an existing record")
    return existing
  }
  const persisted = await readJournalRecord(path.join(directory, filename), record.plan.contentID)
  if (!sameJournalRecord(persisted, record)) throw new Error("repository-learning journal readback mismatch")
  await options.onTransition?.(record.state)
  return persisted
}

function sameJournalRecord(left: InstructionJournalRecord, right: InstructionJournalRecord): boolean {
  return left.state === right.state && planFingerprint(left.plan) === planFingerprint(right.plan) &&
    left.approval.approvedAt === right.approval.approvedAt &&
    left.approval.contextDigest === right.approval.contextDigest &&
    left.quarantineReason === right.quarantineReason
}

async function appendQuarantine(
  root: string,
  plan: CanonicalInstructionPlan,
  approval: ApprovalContextDigest,
  reason: QuarantineReason,
  now: number,
  options: RepositoryWriterOptions,
): Promise<void> {
  if (!INSTRUCTION_QUARANTINE_REASONS.has(reason)) throw new Error("quarantine reason is invalid")
  await appendState(root, {
    schema: JOURNAL_SCHEMA,
    state: "quarantined",
    plan: clonePlan(plan),
    approval: { ...approval },
    recordedAt: now,
    quarantineReason: reason,
  }, options)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
