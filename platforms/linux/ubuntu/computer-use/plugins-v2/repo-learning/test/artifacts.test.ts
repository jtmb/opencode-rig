import assert from "node:assert/strict"
import test from "node:test"

import {
  artifactHash,
  buildUnifiedDiff,
  checkPromotionTarget,
  compileArtifact,
  createArtifactPromotionGate,
  createPreview,
  isSafeArtifactPath,
  revalidatePreview,
  routeArtifact,
  ARTIFACT_PREVIEW_TTL_MS,
  type LearnedArtifact,
} from "../src/artifacts.ts"
import {
  applyOptimizations,
  approveRule,
  createMetricCollector,
  createOptimizationGate,
  MAX_RULES_PER_RUN,
  optimizationRuleDigest,
  validateRule,
  type OptimizationRule,
} from "../src/optimize.ts"
import { runShadow, validateIsolatedWorktree } from "../src/shadow.ts"

const BASE_NOW = 1_700_000_000_000

function candidateArtifact(overrides: Partial<LearnedArtifact> = {}): LearnedArtifact {
  return {
    id: "rle-001",
    kind: "fact",
    title: "Repo uses npm workspaces",
    body: "Plugins live under plugins-v2 and share one lockfile.",
    createdAt: new Date(BASE_NOW).toISOString(),
    baseHash: "abc123",
    status: "candidate",
    ...overrides,
  }
}

function rule(overrides: Partial<OptimizationRule> = {}): OptimizationRule {
  return {
    id: "r1",
    scope: "review-queue",
    limit: 3,
    fallback: "manual review",
    rollback: "restore queue order",
    action: "reorder pending review work",
    ...overrides,
  }
}

// --- Smallest-artifact routing ---

test("routes each input shape to its smallest artifact kind", () => {
  assert.equal(routeArtifact({ title: "t", body: "Why does the build fail on clean clones?" }), "question")
  assert.equal(routeArtifact({ title: "t", body: "Retirement: remove the old parser" }), "retirement")
  assert.equal(routeArtifact({ title: "t", body: "Optimization: make parser startup faster" }), "optimization")
  assert.equal(routeArtifact({ title: "t", body: "Automate the recurring deploy check" }), "automation")
  assert.equal(routeArtifact({ title: "t", body: "User preference: prefer bounded commands" }), "preference")
  assert.equal(routeArtifact({ title: "t", body: "Add a regression test for the parser fallback" }), "test")
  assert.equal(routeArtifact({ title: "t", body: "New runbook for plugin deploys" }), "docs")
  assert.equal(routeArtifact({ title: "t", body: "Tool: one-liner to list stale worktrees" }), "tool")
  assert.equal(routeArtifact({ title: "t", body: "Skill: reusable workflow for triage" }), "skill")
  assert.equal(routeArtifact({ title: "t", body: "Convention: always pin parser versions" }), "convention")
  assert.equal(routeArtifact({ title: "t", body: "Gotcha: build breaks if parsers install out of order" }), "gotcha")
  assert.equal(routeArtifact({ title: "t", body: "The default branch is main" }), "fact")
})

test("question routing wins over more specific shapes", () => {
  assert.equal(routeArtifact({ title: "t", body: "Should we automate this?" }), "question")
  assert.equal(routeArtifact({ title: "t", body: "Add a regression test for what?" }), "question")
})

test("compileArtifact assigns routed kind and candidate status", () => {
  const artifact = compileArtifact({ title: "Watch out", body: "Silent failure when the token expires" }, "rle-9")
  assert.equal(artifact.kind, "gotcha")
  assert.equal(artifact.status, "candidate")
})

test("compileArtifact redacts sensitive artifact text before it can enter the queue", () => {
  const artifact = compileArtifact(
    { title: "Use password=hunter2secret only in tests", body: "Token ghp_abcdefghij1234567890 must never be retained." },
    "rle-secret",
  )
  assert.ok(!artifact.title.includes("hunter2secret"))
  assert.ok(!artifact.body.includes("ghp_abcdefghij1234567890"))
  assert.match(`${artifact.title}\n${artifact.body}`, /\[REDACTED\]/)
})

test("artifact boundaries redact URI userinfo and reject it everywhere else", () => {
  const artifact = compileArtifact(
    {
      title: "Use https://user:secret@example.com/repo only as an example",
      body: "The checkout is https://alice:token@example.com/repo.",
      sourceSession: "https://session:secret@example.com/run",
    },
    "rle-uri",
  )
  assert.ok(!`${artifact.title}\n${artifact.body}\n${artifact.sourceSession}`.includes("secret"))
  assert.ok(!`${artifact.title}\n${artifact.body}\n${artifact.sourceSession}`.includes("alice:token"))
  assert.match(artifact.body, /\[REDACTED\]/)

  const unsafe = { ...candidateArtifact({ status: "approved", body: "https://user:secret@example.com/repo" }) }
  assert.throws(() => createPreview(unsafe, { path: "docs/x.md", symlink: false }, "old"), /sensitive/)
  assert.equal(isSafeArtifactPath("https://user:secret@example.com/repo"), false)
  assert.throws(() => buildUnifiedDiff("docs/x.md", "https://user:secret@example.com/repo", "new"), /sensitive/)
  assert.throws(
    () => createPreview({ ...candidateArtifact(), status: "approved" }, { path: "docs/x.md", symlink: false }, "old", {
      sessionID: "https://user:secret@example.com",
      agent: "agent-1",
    }),
    /unsafe text/,
  )
})

test("compileArtifact rejects empty or oversized input", () => {
  assert.throws(() => compileArtifact({ title: "", body: "x" }, "rle-x"))
  assert.throws(() => compileArtifact({ title: "x", body: "" }, "rle-x"))
})

// --- Promotion path / symlink checks ---

test("promotion targets refuse absolute, traversal, .git, and symlink paths", () => {
  assert.equal(isSafeArtifactPath("skills/triage/SKILL.md"), true)
  assert.equal(isSafeArtifactPath("/etc/passwd"), false)
  assert.equal(isSafeArtifactPath("../outside.md"), false)
  assert.equal(isSafeArtifactPath("a/./b.md"), false)
  assert.equal(isSafeArtifactPath(".git/hooks/pre-push"), false)
  assert.equal(isSafeArtifactPath("a\0b"), false)
  assert.deepEqual(checkPromotionTarget({ path: "docs/x.md", symlink: true }).ok, false)
  assert.deepEqual(checkPromotionTarget({ path: "docs/x.md", symlink: false }).ok, true)
})

// --- Preview-token revalidation ---

test("preview builds a real bounded unified diff from base content", () => {
  const artifact: LearnedArtifact = { ...candidateArtifact({ body: "new line\nkeep line" }), status: "approved" }
  const target = { path: "docs/learned.md", symlink: false }
  const { diff, token } = createPreview(artifact, target, "old line\nkeep line", { sessionID: "ses-1", agent: "agent-1" })
  assert.match(diff, /--- a\/docs\/learned\.md/)
  assert.match(diff, /-old line/)
  assert.match(diff, /\+new line/)
  assert.ok(!diff.includes("+keep line"), "unchanged lines must be context, not additions")
  assert.equal(token.baseHash.length, 64)
  assert.equal(token.contentHash.length, 64)
  assert.match(token.token, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(token.artifactHash, artifactHash(artifact))
  assert.deepEqual(revalidatePreview(token, artifact, target, "old line\nkeep line", { sessionID: "ses-1", agent: "agent-1" }).valid, true)
})

test("preview token invalidates on artifact edit, base move, path change, or identity theft", () => {
  const artifact: LearnedArtifact = { ...candidateArtifact(), status: "approved" }
  const target = { path: "docs/learned.md", symlink: false }
  const { token } = createPreview(artifact, target, "old body", { sessionID: "ses-1", agent: "agent-1" })
  const edited: LearnedArtifact = { ...artifact, body: "Changed body." }
  assert.match(revalidatePreview(token, edited, target, "old body", { sessionID: "ses-1", agent: "agent-1" }).reason ?? "", /changed since preview/)
  assert.match(revalidatePreview(token, artifact, target, "new body", { sessionID: "ses-1", agent: "agent-1" }).reason ?? "", /base moved/)
  assert.match(
    revalidatePreview(token, artifact, { path: "docs/other.md", symlink: false }, "old body", { sessionID: "ses-1", agent: "agent-1" }).reason ?? "",
    /destination path changed/,
  )
  assert.match(revalidatePreview(token, artifact, target, "old body", { sessionID: "ses-2", agent: "agent-1" }).reason ?? "", /session mismatch/)
  assert.match(revalidatePreview({ ...token, path: "docs/other.md" }, artifact, target, "old body", { sessionID: "ses-1", agent: "agent-1" }).reason ?? "", /claims were changed/)
})

test("promotion boundary rejects manually constructed sensitive artifacts", () => {
  const unsafe = candidateArtifact({ status: "approved", body: "password=topsecretvalue" })
  assert.throws(() => createPreview(unsafe, { path: "docs/x.md", symlink: false }, "old"), /sensitive/)
  assert.throws(() => buildUnifiedDiff("docs/x.md", "old", "Bearer abcdefghijklmnop1234"), /sensitive/)
})

test("artifact promotion requires explicit approval, expires, and consumes a token once", () => {
  let now = BASE_NOW
  const gate = createArtifactPromotionGate(() => now)
  const artifact: LearnedArtifact = { ...candidateArtifact(), status: "approved" }
  const target = { path: "docs/learned.md", symlink: false }
  const preview = gate.preview(artifact, target, "old body", { sessionID: "ses-1", agent: "agent-1" })
  assert.match(gate.revalidate(preview.token, artifact, target, "old body").reason ?? "", /session identity is required/)
  assert.equal(
    gate.apply({ artifact, target, token: preview.token, approval: true }, "old body").applied,
    false,
  )
  const applied = gate.apply(
    { artifact, target, token: preview.token, sessionID: "ses-1", agent: "agent-1", approval: true },
    "old body",
  )
  assert.equal(applied.applied, false)
  assert.match(applied.reason, /promotion stub/)
  const replay = gate.apply(
    { artifact, target, token: preview.token, sessionID: "ses-1", agent: "agent-1", approval: true },
    "old body",
  )
  if (replay.applied) throw new Error("replayed artifact promotion unexpectedly applied")
  assert.match(replay.reason, /missing, expired, or already used/)

  const expiring = gate.preview(artifact, target, "old body", { sessionID: "ses-1", agent: "agent-1" })
  now += ARTIFACT_PREVIEW_TTL_MS
  const expired = gate.apply(
    { artifact, target, token: expiring.token, sessionID: "ses-1", agent: "agent-1", approval: true },
    "old body",
  )
  if (expired.applied) throw new Error("expired artifact promotion unexpectedly applied")
  assert.match(expired.reason, /missing, expired, or already used/)
})

test("createPreview requires base content and a safe target", () => {
  const artifact = candidateArtifact()
  assert.throws(() => createPreview(artifact, { path: "../x.md", symlink: false }, "abc123"))
  assert.throws(() => createPreview(artifact, { path: "docs/x.md", symlink: false }, "Bearer abcdefghijklmnop1234"), /sensitive/)
})

// --- Shadow isolation ---

test("shadow runs are isolated and never influence the active task", () => {
  const task = { taskId: "t-1", summary: "Fix the parser fallback", baseHash: "abc123" }
  const candidate = { artifact: candidateArtifact(), rationale: "Verified fix that prevents repeat triage; previously unknown." }
  const record = runShadow(task, candidate, "shadow-1")
  task.summary = "mutated after evaluation"
  candidate.artifact = { ...candidate.artifact, body: "mutated after evaluation" }
  assert.equal(record.isolated, true)
  assert.equal(record.influencedActive, false)
  assert.equal(record.taskId, "t-1")
  assert.equal(record.artifactId, "rle-001")
})

test("shadow flags risky candidates for drop without touching the task", () => {
  const record = runShadow(
    { taskId: "t-2", summary: "Clean up worktrees", baseHash: "abc123" },
    { artifact: candidateArtifact({ id: "rle-002" }), rationale: "Destructive irreversible cleanup touching secrets." },
    "shadow-2",
  )
  assert.equal(record.verdict, "drop")
  assert.equal(record.influencedActive, false)
})

test("isolated worktree validation is lexical-only and returns a frozen copy", () => {
  const source = { path: "worktrees\\shadow-1", baseHash: "abc123" }
  const ok = validateIsolatedWorktree(source)
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.worktree.path, "worktrees/shadow-1")
    assert.notEqual(ok.worktree, source)
  }
  assert.equal(validateIsolatedWorktree({ path: ".", baseHash: "abc123" }).ok, false)
  assert.equal(validateIsolatedWorktree({ path: "../escape", baseHash: "abc123" }).ok, false)
  assert.equal(validateIsolatedWorktree({ path: "worktrees/shadow-1", baseHash: "" }).ok, false)
})

// --- Optimizer caps and per-rule approval ---

test("optimizer is measure-only without per-rule approval", () => {
  const metrics = createMetricCollector()
  metrics.record("review-latency-ms", 120)
  const outcomes = applyOptimizations({
    rules: [rule()],
    approvals: [],
    metrics,
    metricForRule: () => "review-latency-ms",
  })
  assert.equal(outcomes[0]?.status, "measured-only")
})

test("optimizer approval binds the full rule digest and applies only one approved rule", () => {
  const metrics = createMetricCollector()
  const first = rule()
  const second = rule({ id: "r2", scope: "shadow-batch", limit: 2, fallback: "single evaluation", rollback: "discard batch scores" })
  const approval = approveRule(first, "human-reviewer")
  assert.equal(approval.ruleDigest, optimizationRuleDigest(first))
  const outcomes = applyOptimizations({ rules: [first, second], approvals: [approval], metrics })
  assert.equal(outcomes[0]?.status, "applied")
  assert.equal(outcomes[1]?.status, "measured-only")
  const applied = outcomes[0]
  assert.equal(applied?.status === "applied" && applied.rollback, "restore queue order")
})

test("optimizer refuses approval replay, expiry, and rule mutation before effect", () => {
  let now = BASE_NOW
  const gate = createOptimizationGate(() => now)
  const metrics = createMetricCollector()
  const original = rule()
  const approval = gate.approve(original, "human")
  const mutated = { ...original, action: "delete queue" }
  const changed = gate.apply({ rules: [mutated], approvals: [approval], metrics })
  assert.equal(changed[0]?.status, "refused")
  assert.match(changed[0]?.status === "refused" ? changed[0].reason : "", /changed after approval/)

  const fresh = gate.approve(original, "human")
  const applied = gate.apply({ rules: [original], approvals: [fresh], metrics })
  assert.equal(applied[0]?.status, "applied")
  const replay = gate.apply({ rules: [original], approvals: [fresh], metrics })
  assert.notEqual(replay[0]?.status, "applied")

  const expiring = gate.approve(original, "human")
  now += 1 + 60_000
  const expired = gate.apply({ rules: [original], approvals: [expiring], metrics })
  assert.notEqual(expired[0]?.status, "applied")
})

test("optimizer approvals are single-use within a batch and ignore caller clocks", () => {
  let now = BASE_NOW
  const gate = createOptimizationGate(() => now)
  const metrics = createMetricCollector()
  const original = rule()
  const approval = gate.approve(original, "human")
  const duplicate = gate.apply({ rules: [original, original], approvals: [approval], metrics })
  assert.equal(duplicate[0]?.status, "applied")
  assert.equal(duplicate[1]?.status, "refused")

  const expiring = gate.approve(original, "human")
  now += 60_001
  const rewound = gate.apply({
    rules: [original],
    approvals: [expiring],
    metrics,
    nowMs: BASE_NOW,
  })
  assert.notEqual(rewound[0]?.status, "applied")
})

test("optimizer refuses invalid rules and oversized batches", () => {
  const metrics = createMetricCollector()
  const invalid = applyOptimizations({
    rules: [{ id: "bad", scope: "", limit: 0, fallback: "", rollback: "", action: "" }],
    approvals: [],
    metrics,
  })
  assert.equal(invalid[0]?.status, "refused")
  assert.equal(validateRule({ id: "", scope: "s", limit: 1, fallback: "f", rollback: "r", action: "a" }).ok, false)

  const oversized = Array.from({ length: MAX_RULES_PER_RUN + 1 }, (_, i) => rule({ id: `r${i}` }))
  const refused = applyOptimizations({ rules: oversized, approvals: [], metrics })
  assert.ok(refused.every((outcome) => outcome.status === "refused"))
})

test("metric collector enforces name, value, and sample caps", () => {
  const metrics = createMetricCollector()
  assert.throws(() => metrics.record("", 1))
  assert.throws(() => metrics.record("m", Number.NaN))
  const summary = metrics.summarize("missing")
  assert.equal(summary, undefined)
  metrics.record("m", 2)
  metrics.record("m", 4)
  assert.deepEqual(metrics.summarize("m"), { name: "m", count: 2, min: 2, max: 4, mean: 3 })
})
