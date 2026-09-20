// Unit tests for RLE candidate synthesis, trust gating, conflict quarantine,
// namespace isolation, promotion gating, and the review queue.

import assert from "node:assert/strict"
import test from "node:test"

import {
  assertCandidateNamespace,
  buildPromotionDraft,
  canonicalRepoIdentity,
  crossRepoPromotionPathStub,
  createPromotionGate,
  isPathInNamespace,
  notePathFor,
  repoNamespace,
  slugForRepo,
} from "../src/memory-namespace.ts"
import {
  createReviewQueue,
  learnCommandHelp,
  parseLearnCommand,
} from "../src/review-queue.ts"
import {
  CANDIDATE_TTL_MS,
  dedupeCandidates,
  detectConflicts,
  deterministicExtract,
  makeCandidateId,
  mayAutoActivate,
  synthesizeCandidates,
  trustForSource,
  validateCandidate,
  validateCandidateFor,
  validateSynthesisPayload,
  TRUST_CLASSES,
  type GenerateTextFn,
  type LearnCandidate,
} from "../src/synthesize.ts"

const REPO = "/home/user/code/my-app"
const NAMESPACE = repoNamespace(REPO)
const CREATED = "2026-09-19T10:00:00.000Z"
const EXPIRES = new Date(Date.parse(CREATED) + CANDIDATE_TTL_MS).toISOString()

function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const repo = typeof overrides.repo === "string" ? overrides.repo : REPO
  const namespace = typeof overrides.namespace === "string" ? overrides.namespace : NAMESPACE
  const title = typeof overrides.title === "string" ? overrides.title : "Use bounded shell commands"
  const body = typeof overrides.body === "string"
    ? overrides.body
    : "Run repository checks through the bounded command runner instead of raw shell."
  const provenance = overrides.provenance && typeof overrides.provenance === "object"
    ? { repo, actor: "model", createdAt: CREATED, ...(overrides.provenance as Record<string, unknown>) }
    : { repo, actor: "model", createdAt: CREATED }
  const validity = overrides.validity && typeof overrides.validity === "object"
    ? { expiresAt: EXPIRES, scope: repo, ...(overrides.validity as Record<string, unknown>) }
    : { expiresAt: EXPIRES, scope: repo }
  const { provenance: _provenance, validity: _validity, ...flatOverrides } = overrides
  return {
    repo,
    namespace,
    title,
    body,
    trust: "T0",
    source: "synthesis",
    state: "pending",
    provenance,
    validity,
    conflict: { status: "none" },
    ...flatOverrides,
    id: makeCandidateId(namespace, title, body),
  }
}

function validCandidate(overrides: Record<string, unknown> = {}): LearnCandidate {
  return validateCandidate(validRaw(overrides))
}

function approvedCandidate(): LearnCandidate {
  return { ...validCandidate(), trust: "T2", state: "approved" }
}

test("schema validation accepts a well-formed candidate", () => {
  const candidate = validateCandidate(validRaw())
  assert.equal(candidate.id, makeCandidateId(NAMESPACE, candidate.title, candidate.body))
  assert.equal(candidate.trust, "T0")
  assert.equal(candidate.state, "pending")
})

test("schema validation requires provenance, validity, and conflict", () => {
  const withoutProvenance = validRaw()
  delete withoutProvenance.provenance
  assert.throws(() => validateCandidate(withoutProvenance), /provenance/)
  const withoutValidity = validRaw()
  delete withoutValidity.validity
  assert.throws(() => validateCandidate(withoutValidity), /validity/)
  const withoutConflict = validRaw()
  delete withoutConflict.conflict
  assert.throws(() => validateCandidate(withoutConflict), /conflict/)
})

test("schema validation rejects bad trust, auto-active states, and unknown fields", () => {
  assert.throws(() => validateCandidate(validRaw({ trust: "T5" })), /trust/)
  assert.throws(() => validateCandidate(validRaw({ state: "approved" })), /never auto-active/)
  assert.throws(() => validateCandidate(validRaw({ state: "promoted" })), /never auto-active/)
  assert.throws(() => validateCandidate(validRaw({ transcript: "..." })), /unknown field/)
})

test("schema validation binds source, trust, actor, repository, scope, and canonical id", () => {
  assert.throws(
    () => validateCandidate(validRaw({ source: "correction", trust: "T0", provenance: { actor: "user" } })),
    /cannot claim trust/,
  )
  assert.throws(
    () => validateCandidate(validRaw({ provenance: { actor: "user" } })),
    /cannot claim trust/,
  )
  assert.throws(
    () => validateCandidate(validRaw({ provenance: { repo: "/elsewhere" } })),
    /candidate\.repo must match provenance\.repo/,
  )
  assert.throws(
    () => validateCandidate(validRaw({ validity: { scope: "/elsewhere" } })),
    /validity\.scope must match candidate\.repo/,
  )
  assert.throws(
    () => validateCandidate(validRaw({ trust: "T4" })),
    /model output cannot claim T4/,
  )
  const invalidID = validRaw()
  invalidID.id = "cand-0123456789ab"
  assert.throws(() => validateCandidate(invalidID), /id is not canonical/)
})

test("model payloads cannot impersonate user corrections or T4 trust", () => {
  assert.throws(
    () => validateSynthesisPayload(JSON.stringify([validRaw({ source: "correction", trust: "T4", provenance: { actor: "user" } })])),
    /T4 is reserved for explicit cross-repository promotion/,
  )
})

test("secret material is redacted or rejected at synthesis boundaries", async () => {
  const extracted = deterministicExtract(["use password=topsecretvalue only in tests"])
  assert.equal(extracted.length, 1)
  assert.ok(!extracted[0].includes("topsecretvalue"))

  const correction = await synthesizeCandidates(undefined, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: [],
    corrections: ["Do not log password=topsecretvalue in the review record."],
    now: () => Date.parse(CREATED),
  })
  assert.equal(correction.ok, true)
  assert.ok(!correction.candidates[0].body.includes("topsecretvalue"))

  assert.throws(
    () => validateSynthesisPayload(JSON.stringify([validRaw({ body: "password=topsecretvalue" })])),
    /secret material/,
  )
  const promptSecrets: string[] = []
  await synthesizeCandidates(async ({ prompt }) => {
    promptSecrets.push(prompt)
    return { data: { text: JSON.stringify([]) } }
  }, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["episode used token ghp_abcdefghij1234567890"],
  })
  assert.ok(!promptSecrets[0].includes("ghp_abcdefghij1234567890"))
  assert.throws(
    () => buildPromotionDraft(validRaw({ body: "password=topsecretvalue" }) as unknown as LearnCandidate),
    /secret material/,
  )
})

test("schema validation enforces the 90-day validity bound", () => {
  const late = new Date(Date.parse(CREATED) + CANDIDATE_TTL_MS + 1).toISOString()
  assert.throws(
    () => validateCandidate(validRaw({ validity: { expiresAt: late, scope: REPO } })),
    /90-day/,
  )
})

test("schema validation requires questions for conflicts and conflict for quarantine", () => {
  assert.throws(
    () => validateCandidate(validRaw({ conflict: { status: "suspect", reason: "maybe" } })),
    /questions are required/,
  )
  assert.throws(
    () => validateCandidate(validRaw({ state: "quarantined" })),
    /must report a conflict/,
  )
  const quarantined = validateCandidate(
    validRaw({
      state: "quarantined",
      conflict: { status: "suspect", reason: "maybe", with: ["cand-aaaaaaaaaaaa"] },
      questions: ["Which statement should be kept?"],
    }),
  )
  assert.equal(quarantined.state, "quarantined")
})

test("trust gating: corrections become T1, synthesis stays T0, nothing auto-activates", () => {
  assert.equal(trustForSource("correction"), "T1")
  assert.equal(trustForSource("observation"), "T0")
  assert.equal(trustForSource("synthesis"), "T0")
  for (const trust of TRUST_CLASSES) assert.equal(mayAutoActivate(trust), false)
})

test("deterministic extraction is bounded, stable, and duplicate-free", () => {
  const first = deterministicExtract(["  hello   world  ", "", "hello world", 42 as unknown as string])
  assert.deepEqual(first, ["hello world"])
  const many = Array.from({ length: 20 }, (_, index) => `summary ${index}`)
  assert.equal(deterministicExtract(many).length, 8)
  const long = deterministicExtract(["x".repeat(5_000)])
  assert.equal(long[0]?.length, 2_000)
})

test("dedupe drops exact duplicates and keeps near-duplicates", () => {
  const base = validCandidate()
  const duplicate = { ...base, id: "cand-ffffffffffff" }
  const near = validCandidate({ body: `${base.body} Extra sentence.` })
  const { kept, duplicates } = dedupeCandidates([base], [duplicate, near])
  assert.deepEqual(duplicates, ["cand-ffffffffffff"])
  assert.deepEqual(kept.map((candidate) => candidate.id), [near.id])
})

test("explicit contradictions quarantine the incoming candidate with questions", () => {
  const known = validCandidate({ title: "Always use raw shell" })
  const incoming = validCandidate({ contradicts: ["always use raw shell!!"], body: "Use the bounded shell runner instead." })
  const [resolved] = detectConflicts([known], [incoming])
  assert.equal(resolved?.state, "quarantined")
  assert.equal(resolved?.conflict.status, "suspect")
  assert.deepEqual(resolved?.conflict.with, [known.id])
  assert.ok((resolved?.questions?.length ?? 0) > 0)
})

test("same title with different body quarantines as a suspect conflict", () => {
  const known = validCandidate()
  const incoming = validCandidate({ body: "A completely different claim." })
  const [resolved] = detectConflicts([known], [incoming])
  assert.equal(resolved?.state, "quarantined")
  assert.ok((resolved?.questions?.length ?? 0) > 0)
})

test("incoming candidates are compared pairwise before queueing", () => {
  const first = validCandidate({ title: "Pairwise rule", body: "Use the bounded runner." })
  const second = validCandidate({ title: "Pairwise rule", body: "Use an unbounded shell." })
  const resolved = detectConflicts([], [first, second])
  assert.equal(resolved[0]?.state, "quarantined")
  assert.equal(resolved[1]?.state, "quarantined")
  assert.ok(resolved[0]?.conflict.with?.includes(second.id))
  assert.ok(resolved[1]?.conflict.with?.includes(first.id))
})

test("validateSynthesisPayload accepts arrays and {candidates} wrappers", () => {
  const single = validateSynthesisPayload(JSON.stringify([validRaw()]))
  assert.equal(single.length, 1)
  const wrapped = validateSynthesisPayload(JSON.stringify({ candidates: [validRaw()] }))
  assert.equal(wrapped.length, 1)
  assert.throws(() => validateSynthesisPayload("not json"), /not valid JSON/)
})

test("candidate ids are deterministic for identical content", () => {
  assert.equal(makeCandidateId(NAMESPACE, "t", "b"), makeCandidateId(NAMESPACE, "t", "b"))
  assert.notEqual(makeCandidateId(NAMESPACE, "t", "b"), makeCandidateId(NAMESPACE, "t", "c"))
})

test("synthesizeCandidates emits T0 synthesis plus immediate T1 corrections, never auto-active", async () => {
  const generate: GenerateTextFn = async () => ({ data: { text: JSON.stringify([validRaw()]) } })
  const result = await synthesizeCandidates(generate, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["Episode: fixed the bounded runner timeout."],
    existing: [],
    corrections: ["Always run the typecheck before claiming done."],
    now: () => Date.parse(CREATED),
  })
  assert.equal(result.ok, true)
  assert.equal(result.meta.attempts, 1)
  if (!result.ok) return
  assert.equal(result.candidates.length, 2)
  for (const candidate of result.candidates) {
    assert.ok(candidate.state === "pending" || candidate.state === "quarantined")
  }
  const correction = result.candidates.find((candidate) => candidate.source === "correction")
  assert.ok(correction)
  assert.equal(correction.trust, "T1")
  assert.equal(correction.state, "pending")
  assert.equal(correction.provenance.actor, "user")
})

test("synthesizeCandidates fails closed when the model fails twice", async () => {
  let calls = 0
  const failing: GenerateTextFn = async () => {
    calls += 1
    throw new Error("model unavailable")
  }
  const failed = await synthesizeCandidates(failing, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
  })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.candidates, [])
  assert.equal(calls, 2)
  assert.match(failed.error, /failed closed after 2 attempt/)

  const invalid: GenerateTextFn = async () => ({ data: { text: "not json" } })
  const rejected = await synthesizeCandidates(invalid, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
  })
  assert.equal(rejected.ok, false)
  assert.deepEqual(rejected.candidates, [])
})

test("explicit corrections survive empty summaries and provider or double-invalid failures", async () => {
  let emptyCalls = 0
  const correctionOnly = await synthesizeCandidates(async () => {
    emptyCalls += 1
    return { data: { text: "[]" } }
  }, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: [],
    corrections: ["Always keep explicit corrections pending for review."],
    now: () => Date.parse(CREATED),
  })
  assert.equal(correctionOnly.ok, true)
  assert.equal(emptyCalls, 0)
  assert.equal(correctionOnly.candidates[0].trust, "T1")
  assert.equal(correctionOnly.candidates[0].state, "pending")

  const providerFailure = await synthesizeCandidates(async () => {
    throw new Error("provider unavailable")
  }, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
    corrections: ["Queue this correction even when the provider is unavailable."],
    now: () => Date.parse(CREATED),
  })
  assert.equal(providerFailure.ok, false)
  assert.equal(providerFailure.candidates.length, 1)
  assert.equal(providerFailure.candidates[0].trust, "T1")

  const doubleInvalid = await synthesizeCandidates(async () => ({ data: { text: "not json" } }), {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
    corrections: ["Queue this correction after invalid model output."],
    now: () => Date.parse(CREATED),
  })
  assert.equal(doubleInvalid.ok, false)
  assert.equal(doubleInvalid.candidates.length, 1)
  assert.equal(doubleInvalid.candidates[0].state, "pending")
})

test("resource and idle gates defer only model synthesis while retaining corrections", async () => {
  let calls = 0
  const deferred = await synthesizeCandidates(async () => {
    calls += 1
    return { data: { text: "[]" } }
  }, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
    corrections: ["The correction must queue while the host is busy."],
    resourceGate: {
      idle: false,
      cpuLoad: 0.2,
      memoryBytes: 1,
      providerQuotaRemaining: 10,
      queueDepth: 0,
    },
    now: () => Date.parse(CREATED),
  })
  assert.equal(deferred.ok, false)
  assert.equal(calls, 0)
  assert.equal(deferred.candidates.length, 1)

  const quota = await synthesizeCandidates(async () => {
    calls += 1
    return { data: { text: "[]" } }
  }, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
    corrections: ["Queue this when provider quota is exhausted."],
    resources: { idle: true, cpuLoad: 0.1, memoryBytes: 1, providerQuotaRemaining: 0, queueDepth: 0 },
    now: () => Date.parse(CREATED),
  })
  assert.equal(quota.ok, false)
  assert.equal(quota.candidates.length, 1)
  assert.equal(calls, 0)
})

test("synthesizeCandidates uses the single repair fallback before succeeding", async () => {
  let calls = 0
  const flaky: GenerateTextFn = async () => {
    calls += 1
    if (calls === 1) return { data: { text: "oops" } }
    return { data: { text: JSON.stringify([validRaw()]) } }
  }
  const result = await synthesizeCandidates(flaky, {
    repo: REPO,
    namespace: NAMESPACE,
    summaries: ["usable summary"],
  })
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
  if (result.ok) assert.equal(result.meta.attempts, 2)
})

test("namespace isolation rejects cross-repo and cross-namespace candidates", () => {
  assert.equal(repoNamespace(REPO), NAMESPACE)
  assert.match(slugForRepo("/srv/git/my-app.git"), /^local-my-app-[0-9a-f]{12}$/)
  assert.throws(() => slugForRepo("///"), /no usable namespace slug/)
  assert.throws(
    () => validateCandidateFor({ repo: REPO, namespace: NAMESPACE }, validRaw({ namespace: "learnings/other/" })),
    /namespace mismatch/,
  )
  assert.throws(
    () => validateCandidateFor({ repo: REPO, namespace: NAMESPACE }, validRaw({ repo: "/elsewhere" })),
    /repo mismatch/,
  )
  const candidate = validCandidate()
  assert.doesNotThrow(() => assertCandidateNamespace(candidate, REPO))
  assert.throws(() => assertCandidateNamespace(candidate, "/home/user/code/other"), /namespace isolation/)
  assert.equal(notePathFor(NAMESPACE, candidate.id), `${NAMESPACE}${candidate.id}.md`)
  assert.equal(isPathInNamespace(`${NAMESPACE}${candidate.id}.md`, NAMESPACE), true)
  assert.equal(isPathInNamespace("learnings/other/cand-0123456789ab.md", NAMESPACE), false)
  assert.equal(isPathInNamespace(`${NAMESPACE}../evil.md`, NAMESPACE), false)
})

test("repo namespace identity separates basenames and converges alternate origin checkouts", () => {
  const first = repoNamespace("/work/one/my-app")
  const second = repoNamespace("/work/two/my-app")
  assert.notEqual(first, second)
  const origin = "https://github.com/Acme/my-app.git"
  const checkoutA = repoNamespace("/work/one/my-app", origin)
  const checkoutB = repoNamespace("/work/two/my-app", origin)
  assert.equal(checkoutA, checkoutB)
  assert.equal(repoNamespace("/work/one/my-app", "git@github.com:acme/my-app.git"), checkoutA)
  assert.throws(() => repoNamespace("user:supersecret@github.com:acme/my-app.git"), /credential material/)
  const credentialed = "https://user:supersecret@github.com/acme/my-app.git"
  assert.equal(repoNamespace("/work/one/my-app", credentialed), checkoutA)
  assert.ok(!repoNamespace(credentialed).includes("supersecret"))
  assert.ok(!canonicalRepoIdentity(credentialed).includes("supersecret"))
  assert.ok(!repoNamespace("../../my-app").includes(".."))
  assert.equal(isPathInNamespace(`${checkoutA}../cand-0123456789ab.md`, checkoutA), false)
  assert.equal(isPathInNamespace(`${checkoutA}cand-0123456789ab.md`, checkoutA), true)

  const candidate = validCandidate({ repo: "/work/two/my-app", namespace: checkoutB })
  assert.doesNotThrow(() => assertCandidateNamespace(candidate, "/work/two/my-app", origin))
})

test("promotion draft is byte-stable and the gate requires approval plus token", () => {
  const draft = buildPromotionDraft(approvedCandidate())
  assert.ok(draft.markdown.includes("provenance"))
  assert.ok(draft.markdown.includes("validity"))
  assert.ok(draft.markdown.includes("conflict"))
  assert.equal(draft.writeCall.tool, "write_note")
  assert.equal(draft.writeCall.input.directory, NAMESPACE)
  assert.equal(draft.writeCall.input.title, draft.candidateID)
  assert.equal(draft.notePath, `${NAMESPACE}${draft.writeCall.input.title}.md`)

  const gate = createPromotionGate()
  const preview = gate.preview(draft, "ses_1", "agent")
  assert.equal(preview.dryRun, true)
  assert.throws(() => gate.apply(draft, { expectToken: preview.expectToken }, "ses_1", "agent"), /explicit approval/)
  const writeCall = gate.apply(draft, { expectToken: preview.expectToken, approval: true }, "ses_1", "agent")
  assert.equal(writeCall.tool, "write_note")

  const second = gate.preview(draft, "ses_1", "agent")
  const tampered = { ...draft, markdown: `${draft.markdown}\nTampered.` }
  assert.throws(() => gate.apply(tampered, { expectToken: second.expectToken, approval: true }, "ses_1", "agent"), /changed after preview/)
})

test("promotion approval binds every canonical write payload field", () => {
  const draft = buildPromotionDraft(approvedCandidate())
  assert.equal(draft.writeCall.input.content, draft.markdown)
  assert.equal(draft.writeCall.input.project, "computer-assistant")
  assert.equal(draft.writeCall.input.output_format, "text")
  const gate = createPromotionGate()
  const tamperedInputs = [
    { title: "[T2] forged title" },
    { content: `${draft.markdown}\nforged` },
    { directory: "learnings/other/" },
    { project: "other-project" },
    { output_format: "json" as const },
  ]
  for (const changes of tamperedInputs) {
    const preview = gate.preview(draft, "ses_payload", "agent")
    const tampered = {
      ...draft,
      writeCall: {
        ...draft.writeCall,
        input: { ...draft.writeCall.input, ...changes },
      },
    }
    assert.throws(
      () => gate.apply(tampered, { expectToken: preview.expectToken, approval: true }, "ses_payload", "agent"),
      /canonical|exactly match|escapes|changed after preview/,
    )
  }
})

test("review queue refuses auto-active candidates and gates accept on preview tokens", () => {
  const queue = createReviewQueue()
  assert.throws(
    () => queue.enqueue([validRaw({ state: "approved" }) as unknown as LearnCandidate]),
    /auto-active/,
  )
  const candidate = validCandidate()
  assert.deepEqual(queue.enqueue([candidate]), { added: [candidate.id], skipped: [] })
  assert.deepEqual(queue.enqueue([candidate]).skipped, [candidate.id])

  assert.throws(() => queue.accept(candidate.id, { apply: true }, "ses_1", "agent"), /missing or expired/)
  const preview = queue.accept(candidate.id, {}, "ses_1", "agent")
  assert.ok("dryRun" in preview && preview.dryRun === true)
  if (!("dryRun" in preview)) return
  assert.throws(
    () => queue.accept(candidate.id, { apply: true, expectToken: preview.expectToken }, "ses_2", "agent"),
    /does not match/,
  )
  const fresh = queue.accept(candidate.id, {}, "ses_1", "agent")
  assert.ok("dryRun" in fresh)
  if (!("dryRun" in fresh)) return
  const applied = queue.accept(candidate.id, { apply: true, expectToken: fresh.expectToken }, "ses_1", "agent")
  assert.ok(!("dryRun" in applied))
  if ("dryRun" in applied) return
  assert.equal(applied.state, "approved")
  assert.equal(applied.trust, "T2")
})

test("review queue rejects stale tokens after the target state changes", () => {
  const queue = createReviewQueue()
  const candidate = validCandidate()
  queue.enqueue([candidate])
  const preview = queue.accept(candidate.id, {}, "ses_1", "agent")
  assert.ok("dryRun" in preview)
  if (!("dryRun" in preview)) return
  queue.quarantine(candidate.id, "new evidence arrived", ["Is this still true after the refactor?"])
  assert.throws(
    () => queue.accept(candidate.id, { apply: true, expectToken: preview.expectToken }, "ses_1", "agent"),
    /changed after preview/,
  )
})

test("review preview intent is copied before it crosses the caller boundary", () => {
  const queue = createReviewQueue()
  const candidate = validCandidate()
  queue.enqueue([candidate])
  const preview = queue.accept(candidate.id, {}, "ses_copy", "agent")
  assert.ok("dryRun" in preview)
  if (!('dryRun' in preview)) return
  ;(preview.intent as { id: string }).id = "cand-000000000000"
  const accepted = queue.accept(candidate.id, { apply: true, expectToken: preview.expectToken }, "ses_copy", "agent")
  assert.ok(!("dryRun" in accepted))
})

test("review queue validates runtime shapes and blocks expired candidates", () => {
  let nowMs = Date.parse(CREATED)
  const queue = createReviewQueue(() => nowMs)
  assert.throws(() => queue.enqueue([{} as unknown as LearnCandidate]), /invalid candidate/)
  const candidate = validCandidate()
  queue.enqueue([candidate])
  nowMs = Date.parse(candidate.validity.expiresAt) + 1
  assert.throws(() => queue.accept(candidate.id, {}, "ses_expire", "agent"), /expired/)
  assert.deepEqual(queue.list(), [])
  assert.deepEqual(queue.audit(), [])
  assert.throws(() => queue.previewDraft(candidate.id), /not found/)
})

test("quarantine acceptance requires a token-bound conflict resolution record", () => {
  const queue = createReviewQueue(() => Date.parse(CREATED))
  const candidate = validCandidate({
    state: "quarantined",
    conflict: { status: "suspect", reason: "competing rule", with: [makeCandidateId(NAMESPACE, "Other", "Other body")] },
    questions: ["Which rule is supported by evidence?"] ,
  })
  queue.enqueue([candidate])
  assert.throws(() => queue.accept(candidate.id, {}, "ses_quarantine", "agent"), /conflict-resolution record/)
  const resolution = { decision: "accept" as const, reason: "Reviewed the current repository policy.", resolvedBy: "user" }
  const preview = queue.accept(candidate.id, { resolution }, "ses_quarantine", "agent")
  assert.ok("dryRun" in preview)
  if (!("dryRun" in preview)) return
  const accepted = queue.accept(
    candidate.id,
    { apply: true, expectToken: preview.expectToken },
    "ses_quarantine",
    "agent",
  )
  assert.ok(!("dryRun" in accepted))
  if ("dryRun" in accepted) return
  assert.equal(accepted.state, "approved")
  assert.equal(accepted.conflictResolution?.decision, "accept")
  assert.equal(accepted.conflict.status, "none")
})

test("explicit conflict resolution API is preview-token bound and read-only retrieval is bounded", () => {
  const queue = createReviewQueue(() => Date.parse(CREATED))
  const candidate = validCandidate({
    state: "quarantined",
    conflict: { status: "suspect", reason: "needs review" },
    questions: ["Is this still true?"] ,
  })
  queue.enqueue([candidate])
  const resolution = { decision: "accept" as const, reason: "Checked the evidence.", resolvedBy: "user" }
  const preview = queue.resolveConflict(candidate.id, resolution, {}, "ses_resolve", "agent")
  assert.ok("dryRun" in preview)
  if (!("dryRun" in preview)) return
  assert.throws(
    () => queue.resolveConflict(candidate.id, resolution, { apply: true, expectToken: preview.expectToken }, "ses_other", "agent"),
    /does not match/,
  )
  const resolved = queue.resolveConflict(candidate.id, undefined, { apply: true, expectToken: preview.expectToken }, "ses_resolve", "agent")
  assert.ok(!("dryRun" in resolved))
  if ("dryRun" in resolved) return
  assert.equal(resolved.state, "pending")
  assert.equal(resolved.conflict.status, "none")
  const retrieved = queue.retrieve(candidate.id)
  retrieved.title = "mutated outside queue"
  assert.doesNotThrow(() => queue.retrieve(candidate.id))
  assert.equal(queue.audit(1)[0]?.id, candidate.id)
})

test("review queue cannot mark promotion before a trusted write integration exists", () => {
  const queue = createReviewQueue()
  assert.equal(Object.hasOwn(queue, "markPromoted"), false)
})

test("review queue reject flow and quarantine explanations", () => {
  const queue = createReviewQueue()
  const candidate = validCandidate()
  queue.enqueue([candidate])
  const preview = queue.reject(candidate.id, "not durable", {}, "ses_1", "agent")
  assert.ok("dryRun" in preview)
  if (!("dryRun" in preview)) return
  const rejected = queue.reject(candidate.id, "not durable", { apply: true, expectToken: preview.expectToken }, "ses_1", "agent")
  assert.ok(!("dryRun" in rejected))
  if ("dryRun" in rejected) return
  assert.equal(rejected.state, "rejected")

  const second = validCandidate({ title: "Another review item", body: "This needs a second look." })
  queue.enqueue([second])
  const quarantined = queue.quarantine(second.id, "needs a second look", ["What evidence supports this?"])
  assert.equal(quarantined.state, "quarantined")
  assert.match(queue.why(second.id), /provenance/)
  assert.match(queue.why(second.id), /What evidence supports this\?/)
  assert.match(queue.formatList("quarantined"), new RegExp(second.id))
})

test("learn command parsing covers review, why, preview, accept, and reject", () => {
  assert.deepEqual(parseLearnCommand("/learn review"), { sub: "review" })
  assert.deepEqual(parseLearnCommand("/learn review quarantined"), { sub: "review", target: "quarantined" })
  assert.deepEqual(parseLearnCommand("learn why cand-0123456789ab"), { sub: "why", target: "cand-0123456789ab" })
  assert.deepEqual(parseLearnCommand("/learn preview cand-0123456789ab"), { sub: "preview", target: "cand-0123456789ab" })
  assert.deepEqual(parseLearnCommand("/learn accept"), { error: "usage: /learn accept <id>" })
  assert.deepEqual(parseLearnCommand("/learn reject cand-1 stale wording"), {
    sub: "reject",
    target: "cand-1 stale wording",
  })
  assert.ok("error" in parseLearnCommand("/learn promote"))
  assert.match(learnCommandHelp(), /\/learn accept/)
})

test("bounded audit and explicit cross-repo path stubs never auto-promote", () => {
  assert.deepEqual(parseLearnCommand("/learn audit"), { sub: "audit" })
  assert.deepEqual(parseLearnCommand("/learn retrieve cand-0123456789ab"), {
    sub: "retrieve",
    target: "cand-0123456789ab",
  })
  assert.deepEqual(parseLearnCommand("/learn cross-repo cand-0123456789ab /tmp/other"), {
    sub: "cross-repo",
    target: "cand-0123456789ab /tmp/other",
  })
  const path = crossRepoPromotionPathStub("cand-0123456789ab", REPO, "/tmp/other")
  assert.equal(path.requiresExplicitApproval, true)
  assert.equal(path.automatic, false)
  assert.notEqual(path.sourceNamespace, path.targetNamespace)
  assert.throws(() => crossRepoPromotionPathStub("cand-0123456789ab", REPO, "https://user:secret@example.com/other"), /secret material/)
})
