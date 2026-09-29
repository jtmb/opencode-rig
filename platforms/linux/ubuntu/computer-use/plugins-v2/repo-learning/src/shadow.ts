// Shadow evaluation harness for repo learning.
//
// Shadow mode observes a task and scores candidate artifacts without ever
// influencing the active task. Inputs are copied and frozen at the boundary;
// the evaluator has no active-session handle, callback, or write path. Every
// record therefore carries the invariant directly: isolated true and
// influencedActive false.

import { isSafeArtifactPath, type LearnedArtifact } from "./artifacts.ts"

export type ShadowTaskSnapshot = {
  readonly taskId: string
  readonly summary: string
  readonly baseHash: string
}

export type ShadowCandidate = {
  readonly artifact: LearnedArtifact
  readonly rationale: string
}

export type ShadowScore = {
  readonly usefulness: number
  readonly novelty: number
  readonly risk: number
}

export type ShadowRecord = {
  readonly id: string
  readonly taskId: string
  readonly artifactId: string
  readonly score: ShadowScore
  readonly verdict: "keep" | "drop" | "needs-human"
  readonly isolated: true
  readonly influencedActive: false
  readonly evaluatedAt: string
}

export type IsolatedWorktree = {
  readonly path: string
  readonly baseHash: string
}

export type WorktreeValidation =
  | { readonly ok: true; readonly worktree: IsolatedWorktree; readonly note: string }
  | { readonly ok: false; readonly reason: string }

const MAX_SUMMARY_LENGTH = 4 * 1024
const MAX_RATIONALE_LENGTH = 4 * 1024
const MAX_TASK_ID_LENGTH = 256
const MAX_RUN_ID_LENGTH = 256

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be 1-${maximum} characters`)
  }
  return value
}

function copyArtifact(artifact: LearnedArtifact): LearnedArtifact {
  boundedString(artifact.id, "artifact id", MAX_RUN_ID_LENGTH)
  boundedString(artifact.title, "artifact title", 512)
  boundedString(artifact.body, "artifact body", 16 * 1024)
  boundedString(artifact.createdAt, "artifact createdAt", 128)
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    body: artifact.body,
    sourceSession: artifact.sourceSession,
    createdAt: artifact.createdAt,
    baseHash: artifact.baseHash,
    status: artifact.status,
  })
}

function copyTask(task: ShadowTaskSnapshot): ShadowTaskSnapshot {
  return Object.freeze({
    taskId: boundedString(task.taskId, "taskId", MAX_TASK_ID_LENGTH),
    summary: boundedString(task.summary, "task summary", MAX_SUMMARY_LENGTH),
    baseHash: boundedString(task.baseHash, "task baseHash", 512),
  })
}

function copyCandidate(candidate: ShadowCandidate): ShadowCandidate {
  return Object.freeze({
    artifact: copyArtifact(candidate.artifact),
    rationale: boundedString(candidate.rationale, "rationale", MAX_RATIONALE_LENGTH),
  })
}

function scoreCandidate(candidate: ShadowCandidate): ShadowScore {
  const rationale = candidate.rationale.trim().toLowerCase()
  const body = candidate.artifact.body.trim().toLowerCase()
  const evidence = `${rationale}\n${body}`
  const usefulness = clamp01(
    0.3 +
      (evidence.includes("verified") || evidence.includes("reproduced") ? 0.3 : 0) +
      (evidence.includes("fixes") || evidence.includes("prevents") ? 0.2 : 0) +
      (candidate.rationale.trim().length > 80 ? 0.1 : 0),
  )
  const novelty = clamp01(
    0.4 +
      (evidence.includes("new") || evidence.includes("previously unknown") ? 0.3 : 0) -
      (evidence.includes("duplicate") || evidence.includes("already known") ? 0.3 : 0),
  )
  const risk = clamp01(
    0.1 +
      (evidence.includes("destructive") || evidence.includes("irreversible") ? 0.6 : 0) +
      (evidence.includes("permission") || evidence.includes("secret") ? 0.3 : 0),
  )
  return Object.freeze({ usefulness, novelty, risk })
}

function verdictFor(score: ShadowScore): ShadowRecord["verdict"] {
  if (score.risk >= 0.7) return "drop"
  if (score.usefulness >= 0.6 && score.novelty >= 0.4 && score.risk < 0.4) return "keep"
  return "needs-human"
}

/** Validate an isolated worktree without touching the filesystem. The stub
 * checks lexical safety and base-hash presence only; a future slice mounts
 * a real git worktree here. Never resolves against the live checkout. */
export function validateIsolatedWorktree(worktree: IsolatedWorktree): WorktreeValidation {
  if (worktree === null || typeof worktree !== "object" || !isSafeArtifactPath(worktree.path)) {
    return { ok: false, reason: `unsafe worktree path: ${worktree?.path ?? ""}` }
  }
  if (typeof worktree.baseHash !== "string" || worktree.baseHash.length === 0 || worktree.baseHash.length > 512) {
    return { ok: false, reason: "worktree baseHash is required" }
  }
  if (worktree.path === "" || worktree.path === ".") {
    return { ok: false, reason: "worktree must not be the live checkout root" }
  }
  const copy = Object.freeze({ path: worktree.path.replaceAll("\\", "/"), baseHash: worktree.baseHash })
  return {
    ok: true,
    worktree: copy,
    note: `stub: lexical checks only against base ${copy.baseHash}; no worktree mounted, live checkout untouched`,
  }
}

/** Run one shadow evaluation. Pure and synchronous: takes a copied task
 * snapshot plus copied candidate data, returns a scored record. The active
 * task is never read back and never written. */
export function runShadow(
  task: ShadowTaskSnapshot,
  candidate: ShadowCandidate,
  runId: string,
): ShadowRecord {
  const frozenTask = copyTask(task)
  const frozenCandidate = copyCandidate(candidate)
  const safeRunId = boundedString(runId, "runId", MAX_RUN_ID_LENGTH)
  const score = scoreCandidate(frozenCandidate)
  return Object.freeze({
    id: safeRunId,
    taskId: frozenTask.taskId,
    artifactId: frozenCandidate.artifact.id,
    score,
    verdict: verdictFor(score),
    isolated: true,
    influencedActive: false,
    evaluatedAt: new Date().toISOString(),
  })
}

/** Batch convenience: evaluate many copied candidates against one frozen
 * snapshot. Each record is independent; ordering never affects scores. */
export function runShadowBatch(
  task: ShadowTaskSnapshot,
  candidates: readonly ShadowCandidate[],
  runIdPrefix: string,
): ShadowRecord[] {
  const frozenTask = copyTask(task)
  const safePrefix = boundedString(runIdPrefix, "runIdPrefix", MAX_RUN_ID_LENGTH)
  return candidates.slice().map((candidate, index) => runShadow(frozenTask, candidate, `${safePrefix}-${index}`))
}
