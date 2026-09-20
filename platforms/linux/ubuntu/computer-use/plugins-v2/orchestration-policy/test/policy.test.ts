import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { loadMemory } from "../src/index.ts"
import {
  createOrchestrationPolicy,
  isCommitOrPush,
  isPolicyRepair,
  isSubagentLaunch,
  parseOrchestrationPolicyOptions,
  protectedPathInInput,
  REQUIRED_AGENT_INDEX_LINKS,
  toolMayMutate,
  validateAgentPolicyIndex,
  type CapacityResult,
  type MemorySnapshot,
  type TaskKind,
} from "../src/policy.ts"

const input = (overrides: Record<string, unknown> = {}) => ({
  agent: "general",
  background: true,
  model: "openai/gpt-5.6-luna#max",
  ...overrides,
})

const event = (id: string, overrides: Record<string, unknown> = {}) => ({
  tool: "subagent",
  id,
  sessionID: String(overrides.sessionID ?? "ses_parent"),
  input: input(Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "sessionID"))),
})

function configuredPolicy(capacity: (requestedAgents: number) => Promise<CapacityResult>) {
  return createOrchestrationPolicy({
    maxConcurrent: 3,
    allowedAgents: ["explore", "general"],
    allowedModels: ["openai/gpt-5.6-luna#max", "openai/gpt-5.6-sol#xhigh"],
  }, {
    capacity,
    resolveAgentModel: async () => "openai/gpt-5.6-luna#max",
  })
}

function policy(approvedCount = 3) {
  return configuredPolicy(async () => ({ approvedCount }))
}

function declaredPolicy(approvedCount = 3, kind: TaskKind = "change") {
  const controller = policy(approvedCount)
  controller.declareTask("ses_parent", { kind })
  return controller
}

async function launch(
  controller: ReturnType<typeof policy>,
  id: string,
  parentID = "ses_parent",
  childID = `ses_child${id.replace(/[^A-Za-z0-9]/g, "")}`,
) {
  const launchEvent = event(id, { sessionID: parentID })
  await controller.before(launchEvent)
  controller.after({ ...launchEvent, status: "completed", result: { sessionID: childID } })
  return childID
}

const installedPath = ["/home/test/.local", "opt", "opencode"].join("/")

function memoryPolicy(interval = 10) {
  return createOrchestrationPolicy({
    reconciliationIntervalTurns: interval,
    memoryProject: "computer-assistant",
    memoryDirectory: "/tmp/opencode/memory",
    memoryBindings: ["open-rig", "opencode-rig"],
    protectedPaths: [installedPath],
  }, {
    capacity: async () => ({ approvedCount: 3 }),
    resolveAgentModel: async () => "openai/gpt-5.6-luna#max",
  })
}

const snapshot: MemorySnapshot = {
  project: "computer-assistant",
  bindings: ["open-rig", "opencode-rig"],
  checkedAt: "2026-09-19T12:00:00.000Z",
  digest: "abc123",
  entries: [{ title: "Decision", permalink: "decisions/decision", content: "Keep the rule." }],
}

test("loads only bounded project-tagged decisions and preferences from regular files", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const directory = await mkdtemp("/tmp/opencode/orchestration-memory-")
  context.after(() => rm(directory, { recursive: true, force: true }))
  const note = (title: string, type: string, tags: string) => `---\ntitle: ${title}\ntype: ${type}\npermalink: memory/${title.toLowerCase()}\ntags:\n- ${tags}\n---\n\nBound choice.\n`
  await Promise.all([
    writeFile(join(directory, "a.md"), note("Rule", "decision", "open-rig")),
    writeFile(join(directory, "b.md"), note("Preference", "preference", "opencode-rig")),
    writeFile(join(directory, "ignored-type.md"), note("Gotcha", "gotcha", "open-rig")),
    writeFile(join(directory, "ignored-tag.md"), note("Other", "decision", "other-project")),
  ])
  const loaded = await loadMemory("computer-assistant", ["open-rig", "opencode-rig"], directory)
  assert.deepEqual(loaded.entries.map((entry) => entry.title), ["Rule", "Preference"])
  assert.match(loaded.digest, /^[a-f0-9]{64}$/)

  await symlink(join(directory, "a.md"), join(directory, "linked.md"))
  const failed = await loadMemory("computer-assistant", ["open-rig"], directory)
  assert.equal(failed.error, "bounded Basic Memory lookup failed")
  assert.deepEqual(failed.entries, [])
})

test("validates the hard cap and bounded allowlists", () => {
  assert.equal(parseOrchestrationPolicyOptions({}).maxConcurrent, 3)
  assert.throws(() => parseOrchestrationPolicyOptions({ maxConcurrent: 4 }), /1 through 3/)
  assert.throws(() => parseOrchestrationPolicyOptions({ allowedAgents: [] }), /1-32/)
  assert.throws(() => parseOrchestrationPolicyOptions({ allowedModels: ["not-a-model"] }), /invalid/)
  assert.equal(parseOrchestrationPolicyOptions({}).reconciliationIntervalTurns, 10)
  assert.throws(() => parseOrchestrationPolicyOptions({ reconciliationIntervalTurns: 0 }), /1 through 100/)
  assert.throws(() => parseOrchestrationPolicyOptions({ reconciliationIntervalTurns: 101 }), /1 through 100/)
  assert.throws(() => parseOrchestrationPolicyOptions({ memoryProject: "bad project" }), /invalid/)
  assert.throws(() => parseOrchestrationPolicyOptions({ memoryProject: "computer-assistant" }), /configured together/)
  assert.throws(() => parseOrchestrationPolicyOptions({ memoryDirectory: "/tmp/memory" }), /configured together/)
})

test("validates the concise AGENTS index and owning policy markers", () => {
  const index = REQUIRED_AGENT_INDEX_LINKS.map((link) => `[x](${link})`).join("\n")
  const policyDocument = [
    "## Precedence and conflicts",
    "## Start and memory reconciliation",
    "## Work and progress",
    "## Safety",
    "## Source and verification",
    "## Enforcement boundary",
    "ROADMAP.md todo tool installed OpenCode question tool",
  ].join("\n")
  assert.deepEqual(validateAgentPolicyIndex(index, policyDocument), [])
  assert.match(validateAgentPolicyIndex(index.replace("(docs/memory.md)", ""), policyDocument)[0] ?? "", /docs\/memory\.md/)
  assert.match(validateAgentPolicyIndex(index, policyDocument.replace("question tool", "ask"))[0] ?? "", /question tool/)
})

test("recognizes mutation surfaces and protected installed paths", () => {
  assert.equal(toolMayMutate("read", { path: "ROADMAP.md" }), false)
  assert.equal(toolMayMutate("patch", { patchText: "x" }), true)
  assert.equal(toolMayMutate("execute", { code: "return tools.repo_push({})" }), true)
  assert.equal(toolMayMutate("execute", { code: "return tools.todoread({})" }), false)
  assert.equal(protectedPathInInput({ path: `${installedPath}-v2/opencode` }, [installedPath]), installedPath)
  assert.equal(protectedPathInInput({ patchText: `*** Update File: README.md\n+Document ${installedPath}.` }, [installedPath]), undefined)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: AGENTS.md" }), true)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: README.md" }), false)
  assert.equal(isCommitOrPush("repo_commit", {}), true)
  assert.equal(isCommitOrPush("execute", { code: "return tools.repo_push({})" }), true)
  assert.equal(isCommitOrPush("execute", { code: "return tools.todoread({})" }), false)
  assert.equal(isSubagentLaunch("subagent", {}), true)
  assert.equal(isSubagentLaunch("execute", { code: "return tools.subagent({})" }), false)
  assert.equal(isSubagentLaunch("execute", { code: "return tools.todoread({})" }), false)
})

test("requires and persists parent follow-up after a background child becomes idle", async () => {
  const controller = declaredPolicy()
  const launchEvent = event("launch")
  await controller.before(launchEvent)
  controller.sessionCreated("ses_child", "ses_parent")
  controller.after({ ...launchEvent, status: "completed", result: JSON.stringify({ sessionID: "ses_child" }) })
  assert.throws(
    () => controller.reviewFollowup("ses_parent", {
      sessionID: "ses_child",
      outcome: "accepted",
      verification: "The child is still active.",
    }),
    /not due for this parent and child/,
  )
  assert.equal(controller.sessionStatus("ses_child", "idle"), true)
  assert.deepEqual(controller.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: "ses_child" }])
  assert.match(controller.instructions("ses_parent"), /BACKGROUND AGENT FOLLOW-UP REQUIRED/)
  await assert.rejects(controller.before(event("blocked")), /follow-up required/)
  await assert.rejects(
    controller.before({ ...event("commit"), tool: "repo_commit", input: {} }),
    /follow-up required/,
  )
  assert.throws(
    () => controller.reviewFollowup("ses_child", {
      sessionID: "ses_child",
      outcome: "accepted",
      verification: "Self review is forbidden.",
    }),
    /not due for this parent and child/,
  )
  const audit = controller.reviewFollowup("ses_parent", {
    sessionID: "ses_child",
    outcome: "accepted",
    verification: "Reviewed the diff and reran the focused package check.",
  })
  assert.equal(audit.childID, "ses_child")
  assert.deepEqual(controller.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: "ses_child" }])
  assert.equal(controller.acknowledgeFollowup("ses_parent", "ses_child", "accepted"), true)
  assert.deepEqual(controller.pendingFollowupRecords(), [])
  await assert.rejects(controller.before(event("blocked-after-accept")), /already has an accepted background child/)

  controller.sessionStatus("ses_child", "busy")
  controller.sessionStatus("ses_child", "idle")
  const restored = policy()
  restored.restoreFollowups(controller.pendingFollowupRecords())
  assert.deepEqual(restored.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: "ses_child" }])

  const deleted = declaredPolicy()
  await launch(deleted, "deleted", "ses_parent", "ses_deleted")
  assert.equal(deleted.sessionDeleted("ses_deleted"), true)
  assert.deepEqual(deleted.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: "ses_deleted" }])

  const recovered = declaredPolicy()
  await launch(recovered, "historical", "ses_parent", "ses_historical")
  assert.equal(recovered.recoverCompletedFollowup("ses_parent", {
    id: "ses_historical",
    parentID: "ses_parent",
    outcome: "succeeded",
  }), true)
  assert.equal(recovered.recoverCompletedFollowup("ses_other", {
    id: "ses_active",
    parentID: "ses_other",
  }), false)
  assert.deepEqual(recovered.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: "ses_historical" }])
})

test("requires a session-start reconciliation and repeats at the configured turn boundary", async () => {
  const controller = memoryPolicy(3)
  controller.sessionCreated("ses_parent")
  assert.deepEqual(controller.reconciliationState("ses_parent"), { turns: 0, due: true, hasSnapshot: false })
  await assert.rejects(
    controller.before({ ...event("blocked"), tool: "patch", input: { patchText: "*** Update File: README.md" } }),
    /reconciliation is due/,
  )
  controller.setMemorySnapshot("ses_parent", snapshot)
  assert.match(controller.instructions("ses_parent"), /Automatic read-only lookup found 1 bound note/)
  const audit = controller.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  assert.equal(audit.memoryDigest, "abc123")
  assert.deepEqual(controller.reconciliationState("ses_parent"), { turns: 0, due: false, hasSnapshot: false })
  controller.userPrompt("ses_parent")
  controller.userPrompt("ses_parent")
  assert.equal(controller.reconciliationState("ses_parent").due, false)
  controller.userPrompt("ses_parent")
  assert.deepEqual(controller.reconciliationState("ses_parent"), { turns: 3, due: true, hasSnapshot: false })
})

test("requires the question tool before completing an unresolved conflict", () => {
  const controller = memoryPolicy()
  controller.setMemorySnapshot("ses_parent", snapshot)
  assert.throws(
    () => controller.completeReconciliation("ses_parent", {
      outcome: "conflict",
      conflicts: ["Two durable rules disagree."],
      resolution: "Keep the narrower rule.",
    }),
    /question tool/,
  )
  controller.after({
    ...event("question"),
    tool: "question",
    status: "completed",
    result: { content: "Keep the narrower rule." },
  })
  assert.equal(controller.completeReconciliation("ses_parent", {
    outcome: "resolved",
    conflicts: ["Two durable rules disagreed."],
    resolution: "The operator selected the narrower rule.",
  }).outcome, "resolved")
})

test("fails closed on memory lookup errors without creating an unresolvable deadlock", () => {
  const controller = memoryPolicy()
  controller.setMemorySnapshot("ses_parent", { ...snapshot, entries: [], error: "lookup failed" })
  assert.throws(
    () => controller.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] }),
    /reported as a conflict/,
  )
  controller.after({
    ...event("question"),
    tool: "question",
    status: "completed",
    result: { content: "Proceed with repository policy only." },
  })
  const audit = controller.completeReconciliation("ses_parent", {
    outcome: "conflict",
    conflicts: ["Project memory could not be read."],
    resolution: "The operator explicitly allowed repository-policy-only work for this interval.",
  })
  assert.equal(audit.lookupError, "lookup failed")
})

test("blocks repository mutations when the policy index drifts or an installed path is targeted", async () => {
  const controller = policy()
  controller.setIndexErrors(["missing policy link"])
  await assert.rejects(
    controller.before({ ...event("index"), tool: "shell", input: { command: "git status" } }),
    /policy index is invalid/,
  )
  await controller.before({
    ...event("repair"),
    tool: "patch",
    input: { patchText: "*** Update File: AGENTS.md" },
  })
  controller.setIndexErrors([])
  const protectedController = memoryPolicy()
  protectedController.setMemorySnapshot("ses_parent", snapshot)
  protectedController.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  await assert.rejects(
    protectedController.before({ ...event("binary"), tool: "binary_replace", input: { path: `${installedPath}-v2/opencode` } }),
    /immutable/,
  )
})

test("rejects foreground, disallowed-agent, and disallowed-model launches", async () => {
  const controller = declaredPolicy()
  await assert.rejects(controller.before(event("foreground", { background: false })), /background=true/)
  await assert.rejects(controller.before(event("agent", { agent: "other" })), /allows only/)
  await assert.rejects(controller.before(event("model", { model: "openai/other#max" })), /does not allow model/)
})

test("uses the configured agent model when no override is supplied", async () => {
  const controller = declaredPolicy()
  await controller.before(event("one", { model: undefined }))
  assert.equal(controller.state().pending, 1)
})

test("uses the configured agent model for the tool's unresolved placeholder", async () => {
  const controller = declaredPolicy()
  await controller.before(event("one", { model: "<unresolved>" }))
  assert.equal(controller.state().pending, 1)
})

test("enforces live concurrency and releases children only when idle", async () => {
  const controller = policy(2)
  controller.declareTask("ses_parent", { kind: "change" })
  controller.declareTask("ses_parent2", { kind: "change" })
  controller.declareTask("ses_parent3", { kind: "change" })
  await launch(controller, "one", "ses_parent", "ses_child1")
  await launch(controller, "two", "ses_parent2", "ses_child2")
  assert.deepEqual(controller.state(), { pending: 0, active: 2, known: 2 })
  await assert.rejects(controller.before(event("three", { sessionID: "ses_parent3" })), /capacity unavailable or reached/)
  controller.sessionStatus("ses_child1", "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: "ses_child1",
    outcome: "accepted",
    verification: "Reviewed and independently verified child one.",
  })
  controller.acknowledgeFollowup("ses_parent", "ses_child1", "accepted")
  await controller.before(event("three", { sessionID: "ses_parent3" }))
})

test("recovered terminal follow-up releases stale active capacity", async () => {
  const controller = policy(1)
  controller.declareTask("ses_parent", { kind: "change" })
  controller.declareTask("ses_parent2", { kind: "change" })
  await launch(controller, "one", "ses_parent", "ses_child1")
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
  assert.equal(controller.recoverCompletedFollowup("ses_parent", {
    id: "ses_child1",
    parentID: "ses_parent",
    outcome: "succeeded",
  }), true)
  controller.reviewFollowup("ses_parent", {
    sessionID: "ses_child1",
    outcome: "accepted",
    verification: "Reviewed and independently verified the recovered child.",
  })
  controller.acknowledgeFollowup("ses_parent", "ses_child1", "accepted")
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
  await controller.before(event("two", { sessionID: "ses_parent2" }))
})

test("late tool results cannot reactivate an idle child or count session IDs in text", async () => {
  const controller = policy(1)
  controller.declareTask("ses_parent", { kind: "change" })
  controller.declareTask("ses_parent2", { kind: "change" })
  const launchEvent = event("one")
  await controller.before(launchEvent)
  controller.sessionCreated("ses_child1", "ses_parent")
  controller.after({ ...launchEvent, status: "completed", result: { sessionID: "ses_child1" } })
  controller.sessionStatus("ses_child1", "idle")
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
  controller.after({ ...event("one"), status: "completed", result: { sessionID: "ses_child1", content: "untrusted ses_fake" } })
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
  controller.reviewFollowup("ses_parent", {
    sessionID: "ses_child1",
    outcome: "accepted",
    verification: "Reviewed and independently verified the idle child.",
  })
  controller.acknowledgeFollowup("ses_parent", "ses_child1", "accepted")
  const second = event("two", { sessionID: "ses_parent2" })
  await controller.before(second)
  controller.after({ ...second, status: "completed", result: { content: "untrusted result" } })
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
})

test("fails closed when capacity is invalid, unavailable, or zero", async () => {
  const cases: Array<[string, (requestedAgents: number) => Promise<CapacityResult>]> = [
    ["invalid", async () => ({ approvedCount: "not-a-number" })],
    ["error", async () => { throw new Error("capacity probe failed") }],
    ["zero", async () => ({ approvedCount: 0 })],
  ]
  for (const [name, capacity] of cases) {
    const controller = configuredPolicy(capacity)
    controller.declareTask("ses_parent", { kind: "change" })
    await assert.rejects(controller.before(event(`capacity-${name}`)), /capacity unavailable or reached/)
    assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
  }
})

test("requires task declaration and reports waiting, ready, and completed states", async () => {
  const controller = policy()
  await assert.rejects(
    controller.before({ ...event("undeclared"), tool: "patch", input: { patchText: "*** Update File: README.md" } }),
    /call task_declare/,
  )
  assert.equal(controller.taskState("ses_parent"), undefined)
  assert.throws(() => controller.declareTask("invalid", { kind: "change" }), /sessionID is invalid/)
  assert.throws(() => controller.declareTask("ses_parent", { kind: "invalid" } as never), /task kind is invalid/)

  const declared = controller.declareTask("ses_parent", { kind: "review", summary: "  Review the policy  " })
  assert.equal(declared.summary, "Review the policy")
  assert.equal(declared.childCompleted, false)
  assert.match(controller.instructions("ses_parent"), /TASK STATE: review; waiting/)
  assert.throws(() => controller.declareTask("ses_parent", { kind: "change" }), /already active/)

  const childID = await launch(controller, "status", "ses_parent", "ses_statuschild")
  assert.throws(() => controller.declareTask(childID, { kind: "change" }), /child agents cannot declare/)
  controller.sessionStatus(childID, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "Reviewed the child result.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  assert.match(controller.instructions("ses_parent"), /TASK STATE: review; ready/)
  await controller.before({ ...event("unlocked"), tool: "patch", input: { patchText: "*** Update File: README.md" } })

  const completed = controller.completeTask("ses_parent", { verification: "The reviewed policy change is complete." })
  assert.equal(completed.kind, "review")
  assert.equal(controller.taskState("ses_parent")?.completedAt !== undefined, true)
  await assert.rejects(
    controller.before({ ...event("after-complete"), tool: "patch", input: { patchText: "*** Update File: README.md" } }),
    /call task_declare/,
  )
})

test("binds session.created only to a pending launch and accepts one serialized result ID", async () => {
  const arbitrary = declaredPolicy()
  arbitrary.sessionCreated("ses_arbitrary", "ses_parent")
  assert.deepEqual(arbitrary.state(), { pending: 0, active: 0, known: 0 })

  const controller = declaredPolicy()
  const launchEvent = event("created")
  await controller.before(launchEvent)
  controller.sessionCreated("ses_arbitrary", "ses_otherparent")
  assert.deepEqual(controller.state(), { pending: 1, active: 0, known: 0 })
  controller.sessionCreated("ses_createdchild", "ses_parent")
  assert.deepEqual(controller.state(), { pending: 1, active: 1, known: 1 })
  controller.after({ ...launchEvent, status: "completed", result: JSON.stringify({ data: { sessionID: "ses_createdchild" } }) })
  assert.equal(controller.taskState("ses_parent")?.childID, "ses_createdchild")
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })

  const serialized = declaredPolicy()
  const serializedEvent = event("serialized")
  await serialized.before(serializedEvent)
  serialized.after({ ...serializedEvent, status: "completed", result: JSON.stringify({ sessionID: "ses_serializedchild" }) })
  assert.equal(serialized.taskState("ses_parent")?.childID, "ses_serializedchild")
  assert.deepEqual(serialized.state(), { pending: 0, active: 1, known: 1 })

  const ambiguous = declaredPolicy()
  const ambiguousEvent = event("ambiguous")
  await ambiguous.before(ambiguousEvent)
  ambiguous.after({
    ...ambiguousEvent,
    status: "completed",
    result: "ses_first ses_second",
  })
  assert.deepEqual(ambiguous.state(), { pending: 0, active: 0, known: 0 })
})

test("allows non-correction worker mutation and gates correction workers on ledgers", async () => {
  const normal = declaredPolicy()
  const normalChild = await launch(normal, "normal-worker", "ses_parent", "ses_normalworker")
  await normal.before({
    tool: "patch",
    id: "normal-worker-mutation",
    sessionID: normalChild,
    input: { patchText: "*** Update File: README.md" },
  })

  const correction = declaredPolicy(3, "correction")
  const correctionChild = await launch(correction, "correction-worker", "ses_parent", "ses_correctionworker")
  const workerMutation = {
    tool: "patch",
    id: "correction-worker-mutation",
    sessionID: correctionChild,
    input: { patchText: "*** Update File: README.md" },
  }
  await assert.rejects(correction.before(workerMutation), /correction ledger acknowledgement is incomplete/)
  for (const ledger of ["roadmap", "todo", "memory"] as const) {
    correction.acknowledgeCorrection("ses_parent", { ledger, status: "no_write", evidence: `${ledger} needs no write.` })
  }
  await correction.before(workerMutation)
})

test("denies nested delegation and child commit or push tools", async () => {
  const controller = declaredPolicy()
  const childID = await launch(controller, "worker-boundaries", "ses_parent", "ses_boundaryworker")
  await assert.rejects(controller.before(event("nested", { sessionID: childID })), /nested agents/)
  for (const tool of ["repo_commit", "repo_push"]) {
    await assert.rejects(
      controller.before({ tool, id: `child-${tool}`, sessionID: childID, input: {} }),
      /may not commit or push/,
    )
  }
})

test("accepted follow-up unlocks parent mutation but prevents another child", async () => {
  const controller = declaredPolicy()
  const childID = await launch(controller, "accepted", "ses_parent", "ses_acceptedchild")
  controller.sessionStatus(childID, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "Independently verified the accepted child result.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  await controller.before({ ...event("parent-mutation"), tool: "patch", input: { patchText: "*** Update File: README.md" } })
  await assert.rejects(controller.before(event("replacement")), /already has an accepted background child/)
})

test("changes_required and failed follow-ups permit one replacement child", async () => {
  for (const outcome of ["changes_required", "failed"] as const) {
    const controller = declaredPolicy()
    const oldChild = await launch(controller, `old-${outcome}`, "ses_parent", `ses_old${outcome.replace("_", "")}`)
    controller.sessionStatus(oldChild, "idle")
    controller.reviewFollowup("ses_parent", {
      sessionID: oldChild,
      outcome,
      verification: `The ${outcome} result needs replacement work.`,
    })
    controller.acknowledgeFollowup("ses_parent", oldChild, outcome)
    assert.equal(controller.taskState("ses_parent")?.followupOutcome, outcome)

    const replacement = await launch(controller, `replacement-${outcome}`, "ses_parent", `ses_new${outcome.replace("_", "")}`)
    assert.equal(controller.taskState("ses_parent")?.childID, replacement)
    assert.equal(controller.taskState("ses_parent")?.childCompleted, false)
    assert.equal(controller.taskState("ses_parent")?.followupOutcome, undefined)
  }
})

test("restores task records and pending follow-ups without trusting malformed state", async () => {
  const source = declaredPolicy()
  const childID = await launch(source, "restore-task", "ses_parent", "ses_restorechild")
  source.sessionStatus(childID, "idle")
  const records = source.taskStateRecords()
  const restored = policy()
  restored.restoreTaskState(records)
  restored.restoreFollowups(source.pendingFollowupRecords())
  assert.deepEqual(restored.taskStateRecords(), records)
  assert.deepEqual(restored.pendingFollowupRecords(), [{ parentID: "ses_parent", childID }])
  assert.deepEqual(restored.state(), { pending: 0, active: 0, known: 1 })

  restored.restoreTaskState([
    { parentID: "not-a-session", kind: "change", childCompleted: false, ledgers: {} },
    { parentID: "ses_other", kind: "not-a-kind", childCompleted: false, ledgers: {} },
  ])
  assert.equal(restored.taskState("ses_other"), undefined)
})

test("tracks correction ledgers and requires reconciliation for a memory update", () => {
  const controller = declaredPolicy(3, "correction")
  controller.acknowledgeCorrection("ses_parent", { ledger: "roadmap", status: "updated", evidence: "ROADMAP.md was updated." })
  controller.acknowledgeCorrection("ses_parent", { ledger: "todo", status: "no_write", evidence: "The active todo needed no write." })
  assert.throws(
    () => controller.acknowledgeCorrection("ses_parent", { ledger: "memory", status: "updated", evidence: "Memory was updated." }),
    /configured project-bound Basic Memory/,
  )
  controller.acknowledgeCorrection("ses_parent", { ledger: "memory", status: "no_write", evidence: "Memory needed no write." })
  assert.deepEqual(Object.keys(controller.taskState("ses_parent")?.ledgers ?? {}).sort(), ["memory", "roadmap", "todo"])

  const memory = memoryPolicy()
  memory.declareTask("ses_parent", { kind: "correction" })
  assert.throws(
    () => memory.acknowledgeCorrection("ses_parent", { ledger: "memory", status: "updated", evidence: "Memory was updated." }),
    /rule_reconciliation first/,
  )
  memory.setMemorySnapshot("ses_parent", snapshot)
  memory.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  memory.acknowledgeCorrection("ses_parent", { ledger: "memory", status: "updated", evidence: "Memory was updated after reconciliation." })
  assert.equal(memory.taskState("ses_parent")?.ledgers.memory?.status, "updated")
})

test("allows absolute ROADMAP bootstrap while the policy index is invalid", async () => {
  const controller = declaredPolicy()
  controller.setIndexErrors(["missing policy link"])
  await controller.before({
    ...event("roadmap-bootstrap"),
    tool: "patch",
    input: { patchText: "*** Update File: /home/james/repos/opencode-rig/ROADMAP.md" },
  })
  await assert.rejects(
    controller.before({
      ...event("ordinary-indexed-mutation"),
      tool: "patch",
      input: { patchText: "*** Update File: /home/james/repos/opencode-rig/README.md" },
    }),
    /policy index is invalid/,
  )
})

test("keeps policy repair narrow and rejects traversal targets", () => {
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: /repo/AGENTS.md" }), true)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: /repo/docs/agent-policy.md" }), true)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: /repo/plugins-v2/orchestration-policy/src/policy.ts" }), true)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: ../AGENTS.md" }), false)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: /repo/src/../AGENTS.md" }), false)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: AGENTS.md\n*** Update File: README.md" }), false)
})

test("rejects execute-wrapped subagent launches", async () => {
  const controller = declaredPolicy()
  await assert.rejects(
    controller.before({
      ...event("wrapped"),
      tool: "execute",
      input: { code: 'return tools["subagent"]({ agent: "general", background: true })' },
    }),
    /direct subagent tool/,
  )
})
