// Optimization-rule slice: measure-only metric collection with per-rule
// caller-issued approval-token simulation.
//
// Default posture is measure-only: collectMetrics + summarize record what
// happened without changing anything. Applying an optimization requires an
// explicit, short-lived, single-use approval bound to the canonical digest of
// the complete rule (scope, limits, fallback, rollback, and action). The
// approval stores are server-held; caller-provided approval fields are only
// checked against the stored record and never treated as authority.

import { createHash, randomBytes } from "node:crypto"

export const MAX_RULES_PER_RUN = 8
export const MAX_SAMPLES_PER_METRIC = 512
export const MAX_VALUE_MAGNITUDE = 1e12
export const OPTIMIZATION_APPROVAL_TTL_MS = 60_000
export const MAX_OPTIMIZATION_APPROVALS = 64
export const MAX_METRIC_NAME_CHARS = 256
export const MAX_METRICS = 128
const MAX_DATE_MS = 8_640_000_000_000_000
const CONTROL_EXCEPT_WHITESPACE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export type MetricSample = {
  readonly name: string
  readonly value: number
  readonly at: string
}

export type MetricSummary = {
  readonly name: string
  readonly count: number
  readonly min: number
  readonly max: number
  readonly mean: number
}

/** `limits` is accepted as an alias so callers can use the plural policy
 * vocabulary; exactly one value, or two equal values, is permitted. */
export type OptimizationRule = {
  readonly id: string
  readonly scope: string
  readonly limit?: number
  readonly limits?: number
  readonly fallback: string
  readonly rollback: string
  readonly action: string
}

export type RuleApproval = {
  readonly token: string
  readonly approvalToken: string
  readonly ruleId: string
  readonly ruleDigest: string
  readonly approved: true
  readonly approvedBy: string
  readonly approvedAt: string
  readonly expiresAt: number
}

export type OptimizationOutcome =
  | { readonly ruleId: string; readonly status: "measured-only"; readonly summary: MetricSummary | undefined }
  | { readonly ruleId: string; readonly status: "applied"; readonly actions: number; readonly rollback: string }
  | { readonly ruleId: string; readonly status: "refused"; readonly reason: string }

export type OptimizationApplyInput = {
  rules: readonly OptimizationRule[]
  approvals: readonly RuleApproval[]
  metrics: MetricCollector
  metricForRule?: (ruleId: string) => string
  /** Testable clock; production callers use Date.now when omitted. */
  now?: () => number
  nowMs?: number
}

type StoredApproval = {
  readonly token: string
  readonly ruleId: string
  readonly ruleDigest: string
  readonly approvedBy: string
  readonly approvedAt: string
  readonly expiresAt: number
}

function checkedValue(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE_MAGNITUDE) {
    throw new Error(`metric value out of bounds: ${value}`)
  }
  return value
}

function checkedText(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || CONTROL_EXCEPT_WHITESPACE.test(value)) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function resolvedLimit(rule: OptimizationRule): number | undefined {
  if (rule.limit !== undefined && rule.limits !== undefined && rule.limit !== rule.limits) return undefined
  return rule.limits ?? rule.limit
}

export function validateRule(rule: OptimizationRule): { ok: boolean; reason?: string } {
  if (rule === null || typeof rule !== "object") return { ok: false, reason: "rule is required" }
  if (!rule.id) return { ok: false, reason: "rule id is required" }
  if (!rule.scope) return { ok: false, reason: `rule ${rule.id}: scope is required` }
  const limit = resolvedLimit(rule)
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return { ok: false, reason: `rule ${rule.id}: limit must be a positive number` }
  }
  if (!rule.fallback) return { ok: false, reason: `rule ${rule.id}: fallback is required` }
  if (!rule.rollback) return { ok: false, reason: `rule ${rule.id}: rollback is required` }
  if (!rule.action) return { ok: false, reason: `rule ${rule.id}: action is required` }
  try {
    checkedText(rule.id, `rule ${rule.id} id`, 256)
    checkedText(rule.scope, `rule ${rule.id} scope`)
    checkedText(rule.fallback, `rule ${rule.id} fallback`)
    checkedText(rule.rollback, `rule ${rule.id} rollback`)
    checkedText(rule.action, `rule ${rule.id} action`)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : `rule ${rule.id} has invalid text` }
  }
  return { ok: true }
}

function canonicalRule(rule: OptimizationRule): string {
  const validity = validateRule(rule)
  if (!validity.ok) throw new Error(validity.reason ?? "invalid optimization rule")
  // Keep key order explicit. `id` is bound separately by RuleApproval; the
  // digest is intentionally the complete policy payload named by the gate.
  return JSON.stringify({
    scope: rule.scope,
    limits: resolvedLimit(rule),
    fallback: rule.fallback,
    rollback: rule.rollback,
    action: rule.action,
  })
}

export function optimizationRuleDigest(rule: OptimizationRule): string {
  return createHash("sha256").update(canonicalRule(rule), "utf8").digest("hex")
}

function nowValue(value: number | undefined, fallback: () => number): number {
  const now = value ?? fallback()
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS - OPTIMIZATION_APPROVAL_TTL_MS) {
    throw new Error("optimization clock must be a valid date")
  }
  return now
}

function tokenFor(approval: RuleApproval): string {
  if (approval === null || typeof approval !== "object") return ""
  if (typeof approval.token === "string" && approval.token.length > 0) return approval.token
  return typeof approval.approvalToken === "string" ? approval.approvalToken : ""
}

function sameApproval(stored: StoredApproval, supplied: RuleApproval): boolean {
  if (supplied === null || typeof supplied !== "object") return false
  return tokenFor(supplied) === stored.token &&
    supplied.approvalToken === stored.token &&
    supplied.token === stored.token &&
    supplied.ruleId === stored.ruleId &&
    supplied.ruleDigest === stored.ruleDigest &&
    supplied.approved === true &&
    supplied.approvedBy === stored.approvedBy &&
    supplied.approvedAt === stored.approvedAt &&
    supplied.expiresAt === stored.expiresAt
}

function createApprovalManager(now: () => number = Date.now) {
  const approvals = new Map<string, StoredApproval>()

  const prune = (nowMs: number) => {
    for (const [key, value] of approvals) if (value.expiresAt <= nowMs) approvals.delete(key)
    while (approvals.size >= MAX_OPTIMIZATION_APPROVALS) {
      const oldest = approvals.keys().next().value as string | undefined
      if (!oldest) break
      approvals.delete(oldest)
    }
  }

  const issue = (rule: OptimizationRule, approvedBy: string, issuedAtOverride?: number): RuleApproval => {
    const validity = validateRule(rule)
    if (!validity.ok) throw new Error(validity.reason ?? "invalid optimization rule")
    const reviewer = checkedText(approvedBy, "approvedBy", 256)
    const issuedAtMs = nowValue(issuedAtOverride, now)
    const expiresAt = issuedAtMs + OPTIMIZATION_APPROVAL_TTL_MS
    const token = randomBytes(32).toString("base64url")
    const record: StoredApproval = {
      token,
      ruleId: rule.id,
      ruleDigest: optimizationRuleDigest(rule),
      approvedBy: reviewer,
      approvedAt: new Date(issuedAtMs).toISOString(),
      expiresAt,
    }
    approvals.set(token, record)
    prune(issuedAtMs)
    return {
      token,
      approvalToken: token,
      ruleId: record.ruleId,
      ruleDigest: record.ruleDigest,
      approved: true,
      approvedBy: record.approvedBy,
      approvedAt: record.approvedAt,
      expiresAt,
    }
  }

  const apply = (input: OptimizationApplyInput): OptimizationOutcome[] => {
    if (input === null || typeof input !== "object" || !Array.isArray(input.rules) || !Array.isArray(input.approvals)) {
      throw new Error("optimization apply requires bounded rule and approval arrays")
    }
    // Approval expiry is authoritative to this gate's clock; caller-provided
    // timestamps cannot rewind it and extend a token's lifetime.
    const nowMs = nowValue(undefined, now)
    prune(nowMs)
    if (input.rules.length > MAX_RULES_PER_RUN) {
      return input.rules.slice(0, MAX_RULES_PER_RUN).map((rule) => ({
        ruleId: rule.id,
        status: "refused",
        reason: `run exceeds the ${MAX_RULES_PER_RUN}-rule cap; split into smaller batches`,
      }) as OptimizationOutcome)
    }

    const presentedByRule = new Map<string, { readonly supplied: RuleApproval; readonly stored: StoredApproval }>()
    const invalidByRule = new Set<string>()
    for (const supplied of input.approvals.slice(0, MAX_OPTIMIZATION_APPROVALS)) {
      const token = tokenFor(supplied)
      const stored = approvals.get(token)
      if (!stored || !sameApproval(stored, supplied)) {
        if (typeof supplied.ruleId === "string") invalidByRule.add(supplied.ruleId)
        continue
      }
      if (!presentedByRule.has(stored.ruleId)) presentedByRule.set(stored.ruleId, { supplied, stored })
    }

    const consumed = new Set<string>()
    const seenRuleIds = new Set<string>()
    return input.rules.map((rule) => {
      const validity = validateRule(rule)
      if (!validity.ok) return { ruleId: rule.id, status: "refused", reason: validity.reason ?? "invalid rule" }
      if (seenRuleIds.has(rule.id)) {
        return { ruleId: rule.id, status: "refused", reason: "duplicate rule id cannot reuse one approval" }
      }
      seenRuleIds.add(rule.id)
      const metricName = input.metricForRule?.(rule.id)
      const summary = metricName ? input.metrics.summarize(metricName) : undefined
      const approval = presentedByRule.get(rule.id)
      if (invalidByRule.has(rule.id) && !approval) {
        return { ruleId: rule.id, status: "refused", reason: "optimization approval is unknown, expired, replayed, or mutated" }
      }
      if (!approval) {
        return { ruleId: rule.id, status: "measured-only", summary }
      }
      if (consumed.has(approval.stored.token)) {
        return { ruleId: rule.id, status: "refused", reason: "optimization approval was already consumed in this run" }
      }
      if (approval.stored.expiresAt <= nowMs) {
        approvals.delete(approval.stored.token)
        return { ruleId: rule.id, status: "refused", reason: "optimization approval expired" }
      }
      let digest: string
      try {
        digest = optimizationRuleDigest(rule)
      } catch (error) {
        return { ruleId: rule.id, status: "refused", reason: error instanceof Error ? error.message : "invalid rule" }
      }
      if (approval.stored.ruleDigest !== digest) {
        return { ruleId: rule.id, status: "refused", reason: "optimization rule changed after approval" }
      }
      if (approval.stored.ruleId !== rule.id) {
        return { ruleId: rule.id, status: "refused", reason: "optimization approval rule mismatch" }
      }
      // Consume only after revalidation. A second rule or a later invocation
      // with the same approval therefore cannot replay the effect.
      approvals.delete(approval.stored.token)
      consumed.add(approval.stored.token)
      const limit = resolvedLimit(rule) ?? 0
      const actions = Math.max(0, Math.min(Math.floor(limit), MAX_RULES_PER_RUN))
      return { ruleId: rule.id, status: "applied", actions, rollback: rule.rollback }
    })
  }

  return { issue, apply }
}

const defaultApprovalManager = createApprovalManager()

/** Measure-only collector. Bounded per metric; never triggers side effects. */
export function createMetricCollector() {
  const samples = new Map<string, number[]>()
  return {
    record(name: string, value: number): MetricSample {
      const safeName = checkedText(name, "metric name", MAX_METRIC_NAME_CHARS)
      const checked = checkedValue(value)
      const bucket = samples.get(safeName) ?? []
      if (!samples.has(safeName) && samples.size >= MAX_METRICS) {
        throw new Error(`metric collector exceeds the ${MAX_METRICS}-metric cap`)
      }
      if (bucket.length >= MAX_SAMPLES_PER_METRIC) {
        throw new Error(`metric ${safeName} exceeds the ${MAX_SAMPLES_PER_METRIC}-sample cap`)
      }
      bucket.push(checked)
      samples.set(safeName, bucket)
      return { name: safeName, value: checked, at: new Date().toISOString() }
    },
    summarize(name: string): MetricSummary | undefined {
      const safeName = checkedText(name, "metric name", MAX_METRIC_NAME_CHARS)
      const bucket = samples.get(safeName)
      if (!bucket || bucket.length === 0) return undefined
      let min = bucket[0]
      let max = bucket[0]
      let total = 0
      for (const value of bucket) {
        if (value < min) min = value
        if (value > max) max = value
        total += value
      }
      return { name: safeName, count: bucket.length, min, max, mean: total / bucket.length }
    },
    summarizeAll(): MetricSummary[] {
      const out: MetricSummary[] = []
      for (const name of samples.keys()) {
        const summary = this.summarize(name)
        if (summary) out.push(summary)
      }
      return out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    },
  }
}

export type MetricCollector = ReturnType<typeof createMetricCollector>

/** Issue a token for one complete rule. The caller label is not identity proof;
 * this disconnected simulator has no effect backend. */
export function approveRule(rule: OptimizationRule, approvedBy: string, nowMs?: number): RuleApproval {
  return defaultApprovalManager.issue(rule, approvedBy, nowMs)
}

/**
 * Create an isolated approval store for a server/plugin instance. The
 * standalone approveRule/applyOptimizations helpers use a module-local store
 * for small integrations; a host server should prefer this factory.
 */
export function createOptimizationGate(now: () => number = Date.now) {
  const manager = createApprovalManager(now)
  return {
    approve: (rule: OptimizationRule, approvedBy: string) => manager.issue(rule, approvedBy),
    apply: (input: OptimizationApplyInput) => manager.apply(input),
  }
}

/** Apply optimizations. Unapproved rules stay measured-only; an applied rule
 * has passed approval identity, expiry, and full-rule digest revalidation. */
export function applyOptimizations(input: OptimizationApplyInput): OptimizationOutcome[] {
  return defaultApprovalManager.apply(input)
}
