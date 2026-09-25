import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import {
  agentPolicyIndexErrors,
  cancelDirectChild,
  createSerialWriteQueue,
  defaultProtectedPaths,
  loadMemory,
} from "../src/index.ts"
import {
  createOrchestrationPolicy,
  isCommitOrPush,
  isPolicyRepair,
  isSubagentLaunch,
  parseOrchestrationPolicyOptions,
  protectedPathInInput,
  REQUIRED_AGENT_INDEX_LINKS,
  isTaskCompletion,
  toolMayMutate,
  validateAgentPolicyIndex,
  type CapacityResult,
  type MemorySnapshot,
  type TaskKind,
} from "../src/policy.ts"

const DEFAULT_DESCRIPTION = "Run the requested child task"
const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../..")

const syntheticTodoState = async (_parentSessionID: string, description?: string) => JSON.stringify({
  items: description ? [{ content: description, status: "pending" }] : [],
  updatedAt: "2026-09-22T00:00:00.000Z",
})

const input = (overrides: Record<string, unknown> = {}) => ({
  agent: "execution/ingenium-default",
  background: true,
  model: "project/provider-model#default",
  description: DEFAULT_DESCRIPTION,
  ...overrides,
})

const event = (id: string, overrides: Record<string, unknown> = {}) => ({
  tool: "subagent",
  id,
  sessionID: String(overrides.sessionID ?? "ses_parent"),
  input: input(Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "sessionID"))),
})

const failedTool = (id: string, overrides: Record<string, unknown> = {}) => ({
  ...event(id, overrides),
  tool: String(overrides.tool ?? "read"),
  status: "error" as const,
  error: overrides.error ?? { message: "tool failed" },
  ...(overrides.expected === true ? { expected: true } : {}),
})

function configuredPolicy(
  capacityDiagnostic: (requestedAgents: number) => Promise<CapacityResult>,
  maxConcurrent = 3,
  options: Record<string, unknown> = {},
  environment?: NodeJS.ProcessEnv,
) {
  return createOrchestrationPolicy({
    maxConcurrent,
    ...options,
  }, {
    capacityDiagnostic,
    resolveAgentModel: async () => "project/provider-model#default",
    readTodoState: syntheticTodoState,
    ...(environment ? { environment } : {}),
  })
}

function policy(
  approvedCount = 3,
  maxConcurrent = 3,
  options: Record<string, unknown> = {},
  environment?: NodeJS.ProcessEnv,
) {
  return configuredPolicy(async () => ({ approvedCount }), maxConcurrent, options, environment)
}

function declaredPolicy(
  approvedCount = 3,
  kind: TaskKind = "change",
  maxConcurrent = 3,
  options: Record<string, unknown> = {},
  environment?: NodeJS.ProcessEnv,
) {
  const controller = policy(approvedCount, maxConcurrent, options, environment)
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

async function acceptChild(controller: ReturnType<typeof policy>, id = "accepted-child") {
  const childID = await launch(controller, id, "ses_parent", `ses_${id.replace(/[^A-Za-z0-9]/g, "")}`)
  controller.sessionStatus(childID, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "Independently reviewed and verified the child implementation.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
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
    capacityDiagnostic: async () => ({ approvedCount: 3 }),
    resolveAgentModel: async () => "project/provider-model#default",
    readTodoState: syntheticTodoState,
  })
}

const snapshot: MemorySnapshot = {
  project: "computer-assistant",
  bindings: ["open-rig", "opencode-rig"],
  checkedAt: "2026-09-19T12:00:00.000Z",
  digest: "abc123",
  entries: [{ title: "Decision", permalink: "decisions/decision", content: "Keep the rule." }],
}

async function realTodoPolicy(
  root: string,
  options: Record<string, unknown> = {},
  todoStatePath?: (parentSessionID: string, root: string) => string,
) {
  let capacityCalls = 0
  const controller = createOrchestrationPolicy(options, {
    capacityDiagnostic: async () => {
      capacityCalls += 1
      return { approvedCount: 3 }
    },
    resolveAgentModel: async () => "project/provider-model#default",
    todoRoot: root,
    ...(todoStatePath ? { todoStatePath } : {}),
  })
  controller.declareTask("ses_parent", { kind: "change" })
  return { controller, capacityCalls: () => capacityCalls }
}

function acceptancePolicy(projectRoot: string, readTodoState = syntheticTodoState) {
  return createOrchestrationPolicy({}, {
    capacityDiagnostic: async () => ({ approvedCount: 3 }),
    resolveAgentModel: async () => "project/provider-model#default",
    readTodoState,
    projectRoot,
  })
}

function acceptanceManifest(claims: readonly Record<string, unknown>[]) {
  return JSON.stringify({
    version: 3,
    claims,
    ui_acceptance: {
      version: 3,
      status: "pending",
      reason: "Fixture evidence remains explicit.",
      source_roots: ["src"],
      source_extensions: [".tsx"],
      source_files: [],
    },
    subagent_policy: { allowed_agents: ["general"], allowed_models: ["project/provider-model#default"], max_concurrency: 10 },
    subagent_evidence: [{
      id: "fixture-agent",
      agent: "general",
      model: "project/provider-model#default",
      background: true,
      evidence: ["proof.txt"],
    }],
  })
}

async function writeAcceptanceFixture(root: string, claims: readonly Record<string, unknown>[]) {
  await writeFile(join(root, "proof.txt"), "retained test evidence\n")
  await writeFile(join(root, "acceptance-evidence.json"), acceptanceManifest(claims))
}

async function acceptedClaimTask(
  projectRoot: string,
  requiredClaimIDs: string[],
  readTodoState = syntheticTodoState,
) {
  const controller = acceptancePolicy(projectRoot, readTodoState)
  controller.declareTask("ses_parent", { kind: "change", requiredClaimIDs })
  await acceptChild(controller, `claim-${requiredClaimIDs[0] ?? "unscoped"}`)
  return controller
}

async function writeTodoMirror(
  root: string,
  items: readonly Record<string, unknown>[],
  legacy = false,
) {
  const state = legacy ? items : { items, updatedAt: "2026-09-22T00:00:00.000Z" }
  await writeFile(join(root, "ses_parent.json"), JSON.stringify(state))
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

test("scopes the index gate to Open Rig and fails closed for regular policy files", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const external = await mkdtemp("/tmp/opencode/orchestration-external-")
  const owner = await mkdtemp("/tmp/opencode/orchestration-owner-")
  const strictOwner = await mkdtemp("/tmp/opencode/orchestration-strict-owner-")
  context.after(() => Promise.all([
    rm(external, { recursive: true, force: true }),
    rm(owner, { recursive: true, force: true }),
    rm(strictOwner, { recursive: true, force: true }),
  ]))

  await writeFile(join(external, "AGENTS.md"), "# Consumer repository\n")
  const externalPolicy = declaredPolicy(3, "change", 3, {
    enforceAgentIndex: true,
    parentImplementationOptOutEnv: "OPEN_RIG_ALLOW_PARENT_WORK",
  }, { OPEN_RIG_ALLOW_PARENT_WORK: "true" })
  const externalErrors = await agentPolicyIndexErrors(external)
  assert.deepEqual(externalErrors, [])
  externalPolicy.setIndexErrors(externalErrors)
  const externalChild = await launch(externalPolicy, "external-consumer")
  externalPolicy.sessionStatus(externalChild, "idle")
  externalPolicy.reviewFollowup("ses_parent", {
    sessionID: externalChild,
    outcome: "accepted",
    verification: "The external consumer launch was independently reviewed.",
  })
  externalPolicy.acknowledgeFollowup("ses_parent", externalChild, "accepted")
  await assert.doesNotReject(externalPolicy.before({
    tool: "patch",
    id: "external-mutation",
    sessionID: "ses_parent",
    input: { patchText: "*** Update File: consumer.ts\n+consumer change\n" },
  }))

  await mkdir(join(
    owner,
    "platforms",
    "linux",
    "ubuntu",
    "computer-use",
    "plugins-v2",
    "orchestration-policy",
    "src",
  ), { recursive: true })
  await writeFile(join(
    owner,
    "platforms",
    "linux",
    "ubuntu",
    "computer-use",
    "plugins-v2",
    "orchestration-policy",
    "src",
    "index.ts",
  ), "owner source\n")
  await writeFile(join(owner, "AGENTS.md"), "# Open Rig index\n")
  assert.match((await agentPolicyIndexErrors(owner)).join("\n"), /agent-policy\.md/)

  const validIndex = REQUIRED_AGENT_INDEX_LINKS.map((link) => `[x](${link})`).join("\n")
  const validPolicy = [
    "## Precedence and conflicts",
    "## Start and memory reconciliation",
    "## Work and progress",
    "## Safety",
    "## Source and verification",
    "## Enforcement boundary",
    "ROADMAP.md todo tool installed OpenCode question tool",
  ].join("\n")
  await mkdir(join(
    strictOwner,
    "platforms",
    "linux",
    "ubuntu",
    "computer-use",
    "plugins-v2",
    "orchestration-policy",
    "src",
  ), { recursive: true })
  await writeFile(join(
    strictOwner,
    "platforms",
    "linux",
    "ubuntu",
    "computer-use",
    "plugins-v2",
    "orchestration-policy",
    "src",
    "index.ts",
  ), "owner source\n")
  await mkdir(join(strictOwner, "docs"), { recursive: true })
  await writeFile(join(strictOwner, "AGENTS.target.md"), validIndex)
  await writeFile(join(strictOwner, "docs", "agent-policy.target.md"), validPolicy)
  await symlink(join(strictOwner, "AGENTS.target.md"), join(strictOwner, "AGENTS.md"))
  await symlink(
    join(strictOwner, "docs", "agent-policy.target.md"),
    join(strictOwner, "docs", "agent-policy.md"),
  )
  const symlinkedIndexErrors = await agentPolicyIndexErrors(strictOwner)
  assert.match(symlinkedIndexErrors.join("\n"), /AGENTS\.md must be a regular non-symlink file/)
  await rm(join(strictOwner, "AGENTS.md"))
  await writeFile(join(strictOwner, "AGENTS.md"), validIndex)
  const symlinkedPolicyErrors = await agentPolicyIndexErrors(strictOwner)
  assert.match(symlinkedPolicyErrors.join("\n"), /agent-policy\.md must be a regular non-symlink file/)

  const ownerSource = join(
    strictOwner,
    "platforms",
    "linux",
    "ubuntu",
    "computer-use",
    "plugins-v2",
    "orchestration-policy",
    "src",
    "index.ts",
  )
  const ownerTarget = join(strictOwner, "owner-source.target.ts")
  await writeFile(ownerTarget, "owner source\n")
  await rm(ownerSource)
  await symlink(ownerTarget, ownerSource)
  const symlinkedOwnerErrors = await agentPolicyIndexErrors(strictOwner)
  assert.match(symlinkedOwnerErrors.join("\n"), /orchestration-policy.+index\.ts must be a regular non-symlink file/)

  const [canonicalIndex, canonicalPolicy] = await Promise.all([
    lstat(join(REPOSITORY_ROOT, "AGENTS.md")),
    lstat(join(REPOSITORY_ROOT, "docs", "agent-policy.md")),
  ])
  assert.equal(canonicalIndex.isFile(), true)
  assert.equal(canonicalIndex.isSymbolicLink(), false)
  assert.equal(canonicalPolicy.isFile(), true)
  assert.equal(canonicalPolicy.isSymbolicLink(), false)
  assert.deepEqual(await agentPolicyIndexErrors(REPOSITORY_ROOT), [])
})

test("validates the hard cap and ignores legacy identity options", () => {
  assert.equal(parseOrchestrationPolicyOptions({}).maxConcurrent, 10)
  assert.equal(parseOrchestrationPolicyOptions({}).delegationOnly, true)
  assert.equal(parseOrchestrationPolicyOptions({ backgroundOnly: false }).delegationOnly, true)
  assert.equal(parseOrchestrationPolicyOptions({ delegationOnly: false }).delegationOnly, true)
  assert.match(parseOrchestrationPolicyOptions({ delegationOnly: false }).configurationErrors.join(" "), /not configurable/)
  for (let maxConcurrent = 1; maxConcurrent <= 10; maxConcurrent += 1) {
    assert.equal(parseOrchestrationPolicyOptions({ maxConcurrent }).maxConcurrent, maxConcurrent)
  }
  assert.throws(() => parseOrchestrationPolicyOptions({ maxConcurrent: 11 }), /1 through 10/)
  assert.throws(() => parseOrchestrationPolicyOptions({ maxConcurrent: 0 }), /1 through 10/)
  const stale = parseOrchestrationPolicyOptions({
    maxConcurrent: 10,
    allowedAgents: [],
    allowedModels: ["not-a-model"],
  })
  assert.equal(Object.hasOwn(stale, "allowedAgents"), false)
  assert.equal(Object.hasOwn(stale, "allowedModels"), false)
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
  assert.equal(toolMayMutate("npm", { action: "test", apply: true }), true)
  assert.equal(toolMayMutate("shell", { command: "git status" }), false)
  assert.equal(toolMayMutate("shell", { command: "git add -- README.md" }), true)
  assert.equal(toolMayMutate("execute", { code: "return tools.repo_push({})" }), true)
  assert.equal(toolMayMutate("execute", { code: 'return tools["npm"]({ action: "test" })' }), true)
  assert.equal(toolMayMutate("execute", { code: "return tools.task_complete({ verification: \"done\" })" }), true)
  assert.equal(toolMayMutate("execute", { code: "return tools.todoread({})" }), false)
  const githubMutations = [
    "actions_run_trigger",
    "add_comment_to_pending_review",
    "add_issue_comment",
    "add_reply_to_pull_request_comment",
    "create_branch",
    "create_or_update_file",
    "create_pull_request",
    "create_repository",
    "delete_file",
    "fork_repository",
    "issue_write",
    "merge_pull_request",
    "pull_request_review_write",
    "push_files",
    "sub_issue_write",
    "update_pull_request",
    "update_pull_request_branch",
  ]
  for (const method of githubMutations) {
    for (const code of [
      `return tools.github.${method}({})`,
      `return tools["github"].${method}({})`,
      `return tools.github["${method}"]({})`,
      `return tools["github"]["${method}"]({})`,
    ]) {
      assert.equal(toolMayMutate("execute", { code }), true, code)
    }
  }
  for (const code of [
    "return tools.github.issue_read({})",
    'return tools["github"].get_file_contents({})',
    'return tools.github["list_issues"]({})',
    'return tools["github"]["pull_request_read"]({})',
    'return "tools.github.issue_write({})"',
  ]) {
    assert.equal(toolMayMutate("execute", { code }), false, code)
  }
  assert.equal(isTaskCompletion("task_complete", {}), true)
  assert.equal(isTaskCompletion("execute", { code: 'return tools["task_complete"]({})' }), true)
  assert.equal(isTaskCompletion("execute", { code: "return tools.repo_commit({})" }), false)
  assert.equal(protectedPathInInput({ path: `${installedPath}-v2/opencode` }, [installedPath]), installedPath)
  assert.equal(protectedPathInInput({ patchText: `*** Update File: README.md\n+Document ${installedPath}.` }, [installedPath]), undefined)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: AGENTS.md" }), true)
  assert.equal(isPolicyRepair("patch", { patchText: "*** Update File: README.md" }), false)
  assert.equal(isCommitOrPush("repo_commit", {}), true)
  assert.equal(isCommitOrPush("execute", { code: "return tools.repo_push({})" }), true)
  for (const method of [
    "create_branch",
    "create_or_update_file",
    "delete_file",
    "merge_pull_request",
    "push_files",
    "update_pull_request_branch",
  ]) {
    assert.equal(isCommitOrPush("execute", { code: `return tools.github.${method}({})` }), true, method)
  }
  assert.equal(isCommitOrPush("execute", { code: 'return tools["github"]["push_files"]({})' }), true)
  assert.equal(isCommitOrPush("execute", { code: "return tools.github.issue_write({})" }), false)
  assert.equal(isCommitOrPush("execute", { code: "return tools.todoread({})" }), false)
  assert.equal(isSubagentLaunch("subagent", {}), true)
  assert.equal(isSubagentLaunch("execute", { code: "return tools.subagent({})" }), false)
  assert.equal(isSubagentLaunch("execute", { code: "return tools.todoread({})" }), false)
})

test("requires an active task and due reconciliation for direct and Code Mode GitHub issue writes", async () => {
  const issueInput = {
    method: "create",
    owner: "openai",
    repo: "downstream-consumer",
    title: "Policy regression probe",
    body: `Review this reference: ${installedPath}`,
  }
  const code = `return tools["github"]["issue_write"](${JSON.stringify(issueInput)})`

  const undeclared = policy()
  assert.equal(toolMayMutate("github.issue_write", issueInput), true)
  await assert.rejects(undeclared.before({
    tool: "github.issue_write",
    id: "direct-issue-write-undeclared",
    sessionID: "ses_parent",
    input: issueInput,
  }), /call task_declare/)
  assert.equal(toolMayMutate("execute", { code }), true)
  await assert.rejects(undeclared.before({
    tool: "execute",
    id: "execute-issue-write-undeclared",
    sessionID: "ses_parent",
    input: { code },
  }), /call task_declare/)

  const controller = memoryPolicy()
  controller.setIndexErrors(["local policy index intentionally invalid"])
  controller.sessionCreated("ses_parent")
  controller.setMemorySnapshot("ses_parent", snapshot)
  controller.declareTask("ses_parent", { kind: "correction" })
  await assert.rejects(controller.before({
    tool: "github.issue_write",
    id: "direct-issue-write-reconciliation-due",
    sessionID: "ses_parent",
    input: issueInput,
  }), /rule reconciliation is due/)
  await assert.rejects(controller.before({
    tool: "execute",
    id: "execute-issue-write-reconciliation-due",
    sessionID: "ses_parent",
    input: { code },
  }), /rule reconciliation is due/)
  controller.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  await assert.rejects(controller.before({
    tool: "github.issue_write",
    id: "direct-issue-write-ledgers-incomplete",
    sessionID: "ses_parent",
    input: issueInput,
  }), /correction ledger acknowledgement is incomplete/)
  await assert.rejects(controller.before({
    tool: "execute",
    id: "execute-issue-write-ledgers-incomplete",
    sessionID: "ses_parent",
    input: { code },
  }), /correction ledger acknowledgement is incomplete/)
  for (const ledger of ["roadmap", "todo", "memory"] as const) {
    controller.acknowledgeCorrection("ses_parent", {
      ledger,
      status: "no_write",
      evidence: `${ledger} has no separate write for the external issue guard test.`,
    })
  }
  await assert.doesNotReject(controller.before({
    tool: "github.issue_write",
    id: "direct-issue-write-ready",
    sessionID: "ses_parent",
    input: issueInput,
  }))
  await assert.doesNotReject(controller.before({
    tool: "execute",
    id: "execute-issue-write-ready",
    sessionID: "ses_parent",
    input: { code },
  }))

  controller.setIndexErrors([])
  const mixedIssueInput = { ...issueInput, body: "No protected path is present in this mixed call." }
  for (const [id, mixedCode] of [
    ["execute-issue-write-with-local-patch", `await tools.github.issue_write(${JSON.stringify(mixedIssueInput)}); return tools.patch({ patchText: "*** Update File: local.txt" })`],
    ["execute-issue-write-with-dynamic-shell", `await tools.github.issue_write(${JSON.stringify(mixedIssueInput)}); return tools.shell({ command: dynamicCommand })`],
  ] as const) {
    assert.equal(toolMayMutate("execute", { code: mixedCode }), true)
    await assert.rejects(controller.before({
      tool: "execute",
      id,
      sessionID: "ses_parent",
      input: { code: mixedCode },
    }), /a direct background child is required/)
  }
})

test("keeps read-only probes and quoted issue-write literals outside the mutation gate", async () => {
  const controller = policy()
  const cases = [
    { tool: "github.issue_read", input: { owner: "openai", repo: "downstream-consumer" } },
    { tool: "execute", input: { code: "return tools.github.issue_read({})" } },
    { tool: "execute", input: { code: 'return "tools.github.issue_write({})"' } },
    { tool: "execute", input: { code: '// tools.github.issue_write({})\nreturn tools.github.issue_read({})' } },
  ] as const
  for (const [index, item] of cases.entries()) {
    assert.equal(toolMayMutate(item.tool, item.input), false)
    await assert.doesNotReject(controller.before({
      tool: item.tool,
      id: `read-only-github-probe-${index}`,
      sessionID: "ses_parent",
      input: item.input,
    }))
  }
})

test("denies direct local writes and dynamic Code Mode shell calls without a declared task", async () => {
  const controller = policy()
  const directWrite = {
    tool: "shell",
    id: "direct-local-write",
    sessionID: "ses_parent",
    input: { command: "touch local-marker" },
  }
  assert.equal(toolMayMutate(directWrite.tool, directWrite.input), true)
  await assert.rejects(controller.before(directWrite), /call task_declare/)

  const code = "return tools.shell({ command: dynamicCommand })"
  assert.equal(toolMayMutate("execute", { code }), true)
  await assert.rejects(controller.before({
    tool: "execute",
    id: "execute-dynamic-shell-write",
    sessionID: "ses_parent",
    input: { code },
  }), /call task_declare/)
})

test("leaves npm metadata, optional VCS status, and exact Git inspection read-only", async () => {
  const controller = policy()
  const boundedGitLog = "git --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false log --max-count=10 --oneline"
  // OpenCode v2 exposes ctx.vcs.status() to plugins; projects may surface an equivalent model tool separately.
  const cases = [
    { tool: "npm", input: { action: "scripts" } },
    { tool: "vcs.status", input: {} },
    { tool: "shell", input: { command: "git status --short" } },
    { tool: "shell", input: { command: "git diff --stat" } },
    { tool: "shell", input: { command: boundedGitLog } },
    { tool: "execute", input: { code: 'return tools.npm({ action: "scripts" })' } },
    { tool: "execute", input: { code: "return tools.vcs.status({})" } },
    { tool: "execute", input: { code: 'return tools.shell({ command: "git status --short" })' } },
    { tool: "execute", input: { code: `return tools.shell({ command: ${JSON.stringify(boundedGitLog)} })` } },
  ] as const
  for (const [index, item] of cases.entries()) {
    assert.equal(toolMayMutate(item.tool, item.input), false)
    await assert.doesNotReject(controller.before({
      tool: item.tool,
      id: `read-only-metadata-${index}`,
      sessionID: "ses_parent",
      input: item.input,
    }))
  }
  assert.equal(toolMayMutate("npm", { action: "test", apply: true }), true)
  assert.equal(toolMayMutate("shell", { command: "git status --short && touch marker" }), true)

  const rejectedGitLogs = [
    "git log",
    "git --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false log --max-count=11 --oneline",
    `${boundedGitLog} --all`,
    `${boundedGitLog}; touch marker`,
    `${boundedGitLog} $(printf HEAD)`,
  ]
  for (const [index, command] of rejectedGitLogs.entries()) {
    assert.equal(toolMayMutate("shell", { command }), true, command)
    await assert.rejects(controller.before({
      tool: "shell",
      id: `rejected-git-log-${index}`,
      sessionID: "ses_parent",
      input: { command },
    }), /call task_declare/)

    const code = `return tools.shell({ command: ${JSON.stringify(command)} })`
    assert.equal(toolMayMutate("execute", { code }), true, code)
    await assert.rejects(controller.before({
      tool: "execute",
      id: `rejected-code-mode-git-log-${index}`,
      sessionID: "ses_parent",
      input: { code },
    }), /call task_declare/)
  }
})

test("allows only fixed OpenCode identity probes and keeps installed-binary writes blocked", async () => {
  const installedBinary = join(homedir(), ".opencode", "bin", "opencode")
  const protectedPaths = defaultProtectedPaths()
  assert.ok(protectedPaths.includes(installedBinary))
  const launcher = "./platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh"
  const probes = [
    `${launcher} service status`,
    `OPENCODE_V2_BIN=${installedBinary} ${launcher} service status`,
    `${launcher} api get /api/info`,
    `OPENCODE_V2_BIN=${installedBinary} ${launcher} api get /api/info`,
    `${installedBinary} api get /api/info`,
  ]
  const controller = policy(3, 3, { protectedPaths })
  for (const [index, command] of probes.entries()) {
    const direct = { command }
    assert.equal(toolMayMutate("shell", direct, protectedPaths), false, command)
    assert.equal(protectedPathInInput(direct, protectedPaths), undefined, command)
    await assert.doesNotReject(controller.before({
      tool: "shell",
      id: `read-only-opencode-probe-${index}`,
      sessionID: "ses_parent",
      input: direct,
    }))

    const code = `return tools.shell({ command: ${JSON.stringify(command)} })`
    assert.equal(toolMayMutate("execute", { code }, protectedPaths), false, code)
    assert.equal(protectedPathInInput({ code }, protectedPaths), undefined, code)
    await assert.doesNotReject(controller.before({
      tool: "execute",
      id: `code-mode-opencode-probe-${index}`,
      sessionID: "ses_parent",
      input: { code },
    }))
  }

  const quotedLiteral = `return ${JSON.stringify(`tools.shell({ command: "${installedBinary} api get /api/info" })`)}`
  assert.equal(toolMayMutate("execute", { code: quotedLiteral }, protectedPaths), false)
  assert.equal(protectedPathInInput({ code: quotedLiteral }, protectedPaths), undefined)
  const patchBodyReference = `return tools.patch({ patchText: ${JSON.stringify(`*** Update File: README.md\n+Configured binary: ${installedBinary}`)} })`
  assert.equal(protectedPathInInput({ code: patchBodyReference }, protectedPaths), undefined)

  const rejectedCommands = [
    `${installedBinary} api post /api/info`,
    `${installedBinary} api get /api/info; touch marker`,
    `${installedBinary} api get "$(printf /api/info)"`,
    "$OPENCODE_V2_BIN api get /api/info",
    `OPENCODE_V2_BIN="${installedBinary}" ${launcher} service status`,
    `OPENCODE_V2_BIN=${installedBinary} ${launcher} service restart`,
    `python3 platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py basic-memory --opencode-bin ${installedBinary} --server http://127.0.0.1:4096 --directory /tmp/consumer`,
  ]
  for (const [index, command] of rejectedCommands.entries()) {
    assert.equal(toolMayMutate("shell", { command }, protectedPaths), true, command)
    await assert.rejects(controller.before({
      tool: "shell",
      id: `rejected-opencode-command-${index}`,
      sessionID: "ses_parent",
      input: { command },
    }), /immutable|task_declare/)

    const code = `return tools["shell"]({ command: ${JSON.stringify(command)} })`
    assert.equal(toolMayMutate("execute", { code }, protectedPaths), true, code)
    await assert.rejects(controller.before({
      tool: "execute",
      id: `rejected-code-mode-opencode-command-${index}`,
      sessionID: "ses_parent",
      input: { code },
    }), /immutable|task_declare/)
  }
  assert.equal(toolMayMutate("shell", { command: `${installedBinary} api get /api/info` }), true)

  const protectedController = policy(3, 3, { protectedPaths })
  const binaryEdit = { path: installedBinary, search: "x", replacement: "y" }
  await assert.rejects(protectedController.before({
    tool: "binary_replace",
    id: "direct-installed-binary-edit",
    sessionID: "ses_parent",
    input: binaryEdit,
  }), /immutable/)
  const patchEdit = { patchText: `*** Update File: ${installedBinary}\n+forbidden` }
  assert.equal(protectedPathInInput(patchEdit, protectedPaths), installedBinary)
  await assert.rejects(protectedController.before({
    tool: "patch",
    id: "direct-installed-binary-patch",
    sessionID: "ses_parent",
    input: patchEdit,
  }), /immutable/)
  for (const code of [
    `return tools.binary_replace({ path: ${JSON.stringify(installedBinary)}, search: "x", replacement: "y" })`,
    `return tools.patch({ patchText: ${JSON.stringify(`*** Update File: ${installedBinary}\n+forbidden`)} })`,
  ]) {
    assert.equal(toolMayMutate("execute", { code }, protectedPaths), true)
    assert.equal(protectedPathInInput({ code }, protectedPaths), installedBinary)
    await assert.rejects(protectedController.before({
      tool: "execute",
      id: `code-mode-installed-binary-edit-${code.length}`,
      sessionID: "ses_parent",
      input: { code },
    }), /immutable/)
  }
})

test("keeps parent implementation delegated before and after accepted child follow-up while allowing child edits", async () => {
  const controller = declaredPolicy()
  const parentPatch = {
    tool: "patch",
    id: "parent-patch-before-child",
    sessionID: "ses_parent",
    input: { patchText: "*** Update File: README.md\n+parent implementation" },
  }
  await assert.rejects(controller.before(parentPatch), /a direct background child is required/)

  const childID = await launch(controller, "delegated-implementation", "ses_parent", "ses_delegatedimplementation")
  await controller.before({
    tool: "patch",
    id: "child-implementation",
    sessionID: childID,
    input: { patchText: "*** Update File: README.md\n+child implementation" },
  })
  controller.sessionStatus(childID, "idle")
  await assert.rejects(controller.before({ ...parentPatch, id: "parent-patch-awaiting-followup" }), /accepted subagent_followup is required/)

  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "The child diff and focused check were independently reviewed.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  for (const [tool, input] of [
    ["patch", { patchText: "*** Update File: README.md\n+parent implementation" }],
    ["shell", { command: "npm test" }],
    ["npm", { action: "test", apply: true }],
  ] as const) {
    await assert.rejects(
      controller.before({ tool, id: `parent-${tool}`, sessionID: "ses_parent", input }),
      /parent implementation blocked: delegation-only/,
    )
  }
  assert.match(controller.instructions("ses_parent"), /Parent implementation is delegation-only/)
})

test("allows only the exact declared environment opt-out and keeps malformed settings fail-closed", async () => {
  const undeclared = declaredPolicy(3, "change", 3, {}, { OPEN_RIG_ALLOW_PARENT_WORK: "true" })
  await acceptChild(undeclared, "undeclared-override")
  await assert.rejects(
    undeclared.before({ tool: "patch", id: "undeclared-patch", sessionID: "ses_parent", input: { patchText: "*** Update File: README.md" } }),
    /delegation-only/,
  )

  const exactFalse = declaredPolicy(3, "change", 3, {
    parentImplementationOptOutEnv: "OPEN_RIG_ALLOW_PARENT_WORK",
  }, { OPEN_RIG_ALLOW_PARENT_WORK: "false" })
  await acceptChild(exactFalse, "false-override")
  await assert.rejects(
    exactFalse.before({ tool: "patch", id: "false-patch", sessionID: "ses_parent", input: { patchText: "*** Update File: README.md" } }),
    /delegation-only/,
  )

  const exactTrue = declaredPolicy(3, "change", 3, {
    parentImplementationOptOutEnv: "OPEN_RIG_ALLOW_PARENT_WORK",
  }, { OPEN_RIG_ALLOW_PARENT_WORK: "true" })
  await acceptChild(exactTrue, "true-override")
  await assert.doesNotReject(exactTrue.before({
    tool: "patch",
    id: "exact-opt-out-patch",
    sessionID: "ses_parent",
    input: { patchText: "*** Update File: README.md\n+explicit opt-out" },
  }))
  assert.equal(exactTrue.options.delegationOnly, false)

  for (const [index, value] of ["TRUE", "1", " true "] .entries()) {
    const invalid = declaredPolicy(3, "change", 3, {
      parentImplementationOptOutEnv: "OPEN_RIG_ALLOW_PARENT_WORK",
    }, { OPEN_RIG_ALLOW_PARENT_WORK: value })
    assert.equal(invalid.options.delegationOnly, true)
    assert.match(invalid.options.configurationErrors.join(" "), /must be unset or equal exactly/)
    assert.match(invalid.instructions("ses_parent"), /PARENT DELEGATION CONFIGURATION INVALID/)
    const childID = await launch(invalid, `invalid-override-${index}`, "ses_parent", `ses_invalidoverride${index}`)
    await invalid.before({
      tool: "patch",
      id: `invalid-child-patch-${index}`,
      sessionID: childID,
      input: { patchText: "*** Update File: README.md\n+child still permitted" },
    })
    await assert.rejects(
      invalid.before({ tool: "patch", id: `invalid-parent-patch-${index}`, sessionID: "ses_parent", input: { patchText: "*** Update File: README.md" } }),
      /accepted subagent_followup is required/,
    )
  }
})

test("backgroundOnly false changes only child launch mode, never parent delegation", async () => {
  const controller = declaredPolicy(3, "change", 3, { backgroundOnly: false })
  const launchEvent = event("foreground-child", { background: false })
  await controller.before(launchEvent)
  const childID = "ses_foregroundchild"
  controller.after({ ...launchEvent, status: "completed", result: { sessionID: childID } })
  await controller.before({
    tool: "patch",
    id: "foreground-child-edit",
    sessionID: childID,
    input: { patchText: "*** Update File: README.md\n+child" },
  })
  controller.sessionStatus(childID, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "Reviewed and accepted the foreground child for this isolated policy test.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  await assert.rejects(
    controller.before({ tool: "patch", id: "foreground-parent-edit", sessionID: "ses_parent", input: { patchText: "*** Update File: README.md" } }),
    /delegation-only/,
  )
})

test("Code Mode nested mutations and release-task commit tools cannot bypass parent delegation", async () => {
  const controller = declaredPolicy(3, "release")
  await acceptChild(controller, "release-child")
  const nestedMutations = [
    'return tools.patch({ patchText: "*** Update File: README.md" })',
    'return tools["shell"]({ command: "npm test" })',
    'return tools.npm({ action: "test", apply: true })',
    "return tools.repo_commit({ action: \"apply\", approval: true })",
    "return tools.repo_push({ action: \"apply\", approval: true })",
    "return tools.github.create_or_update_file({})",
    'return tools["github"].push_files({})',
    'return tools.github["create_pull_request"]({})',
    "return tools.github.merge_pull_request({})",
    "return tools.github.create_branch({})",
    "return tools.github.update_pull_request({})",
  ]
  for (const [index, code] of nestedMutations.entries()) {
    assert.equal(toolMayMutate("execute", { code }), true)
    await assert.rejects(
      controller.before({ tool: "execute", id: `nested-mutation-${index}`, sessionID: "ses_parent", input: { code } }),
      /parent implementation blocked: delegation-only/,
    )
  }
  await assert.doesNotReject(controller.before({
    tool: "execute",
    id: "nested-task-complete",
    sessionID: "ses_parent",
    input: { code: 'return tools["task_complete"]({ verification: "all children reviewed" })' },
  }))
  await assert.doesNotReject(controller.before({
    tool: "execute",
    id: "github-read-only",
    sessionID: "ses_parent",
    input: { code: "return tools.github.issue_read({})" },
  }))
})

test("explicit parent opt-out preserves child-follow-up and active-child commit/push gates", async () => {
  const controller = declaredPolicy(3, "release", 3, {
    parentImplementationOptOutEnv: "OPEN_RIG_ALLOW_PARENT_WORK",
  }, { OPEN_RIG_ALLOW_PARENT_WORK: "true" })
  const childID = await launch(controller, "release-gate-child", "ses_parent", "ses_releasegatechild")
  const githubCommitPush = [
    "return tools.github.create_branch({})",
    "return tools.github.create_or_update_file({})",
    "return tools.github.delete_file({})",
    "return tools.github.merge_pull_request({})",
    'return tools["github"]["push_files"]({})',
    "return tools.github.update_pull_request_branch({})",
  ]
  for (const tool of ["repo_commit", "repo_push"]) {
    await assert.rejects(
      controller.before({ tool, id: `active-${tool}`, sessionID: "ses_parent", input: {} }),
      /background child is active/,
    )
    await assert.rejects(
      controller.before({ tool, id: `child-${tool}`, sessionID: childID, input: {} }),
      /child agents may not commit or push/,
    )
  }
  for (const [index, code] of githubCommitPush.entries()) {
    await assert.rejects(
      controller.before({ tool: "execute", id: `active-github-${index}`, sessionID: "ses_parent", input: { code } }),
      /commit or push blocked while a background child is active/,
    )
    await assert.rejects(
      controller.before({ tool: "execute", id: `child-github-${index}`, sessionID: childID, input: { code } }),
      /child agents may not commit or push/,
    )
  }
  controller.sessionStatus(childID, "idle")
  for (const tool of ["repo_commit", "repo_push"]) {
    await assert.rejects(
      controller.before({ tool, id: `followup-${tool}`, sessionID: "ses_parent", input: {} }),
      /background agent follow-up required/,
    )
  }
  for (const [index, code] of githubCommitPush.entries()) {
    await assert.rejects(
      controller.before({ tool: "execute", id: `followup-github-${index}`, sessionID: "ses_parent", input: { code } }),
      /background agent follow-up required/,
    )
  }
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "The child is reviewed before checking separate release gates.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  for (const tool of ["repo_commit", "repo_push"]) {
    await assert.doesNotReject(controller.before({ tool, id: `ready-${tool}`, sessionID: "ses_parent", input: {} }))
  }
  for (const [index, code] of githubCommitPush.entries()) {
    await assert.rejects(
      controller.before({ tool: "execute", id: `unapproved-github-${index}`, sessionID: "ses_parent", input: { code } }),
      /separate repo_commit or repo_push approval gates/,
    )
  }
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
  await launch(controller, "allowed-after-accept", "ses_parent", "ses_secondchild")
  assert.deepEqual(controller.taskState("ses_parent")?.children.map((child) => child.sessionID), ["ses_child", "ses_secondchild"])

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

test("refreshes child provenance after concurrent task persistence and reload", () => {
  const task = declaredPolicy().taskStateRecords()[0]!
  const sibling = policy()
  sibling.declareTask("ses_sibling", { kind: "change" })
  const siblingTask = sibling.taskStateRecords()[0]!
  const history = Array.from({ length: 79 }, (_, index) => ({
    sessionID: `ses_history${index}`,
    status: "reviewed" as const,
    outcome: "accepted" as const,
  }))
  const stale = { ...task, children: history }
  const recordedChildID = "ses_persistedlate"
  const persistedDuringReload = {
    ...stale,
    children: [...history, { sessionID: recordedChildID, status: "active" as const }],
  }
  const restored = policy()
  restored.restoreTaskState([stale, siblingTask])
  restored.restoreTaskState([persistedDuringReload, siblingTask])

  assert.equal(restored.taskState("ses_parent")?.children.length, 80)
  assert.equal(restored.recoverCompletedFollowup("ses_parent", {
    id: recordedChildID,
    parentID: "ses_parent",
    outcome: "running",
  }), false)
  assert.equal(restored.recoverCompletedFollowup("ses_parent", {
    id: recordedChildID,
    parentID: "ses_parent",
    outcome: "succeeded",
  }), true)
  assert.deepEqual(restored.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: recordedChildID }])
  assert.equal(restored.recoverCompletedFollowup("ses_parent", {
    id: "ses_unrecorded",
    parentID: "ses_parent",
    outcome: "succeeded",
  }), false)
  assert.equal(restored.recoverCompletedFollowup("ses_sibling", {
    id: recordedChildID,
    parentID: "ses_sibling",
    outcome: "succeeded",
  }), false)
  assert.deepEqual(restored.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: recordedChildID }])

  const replacementTask = { ...stale, declaredAt: "2026-09-24T00:00:00.000Z", children: [] }
  const replacement = policy()
  replacement.restoreTaskState([replacementTask])
  replacement.restoreTaskState([persistedDuringReload])
  assert.deepEqual(replacement.taskState("ses_parent")?.children, [])
  assert.equal(replacement.recoverCompletedFollowup("ses_parent", {
    id: recordedChildID,
    parentID: "ses_parent",
    outcome: "succeeded",
  }), false)
  assert.deepEqual(replacement.pendingFollowupRecords(), [])
})

test("terminal recovery does not reopen an already reviewed child", async () => {
  const controller = declaredPolicy()
  const childID = await launch(controller, "already-reviewed", "ses_parent", "ses_reviewedchild")
  controller.sessionStatus(childID, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "The child was already reviewed and accepted.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")

  assert.equal(controller.recoverCompletedFollowup("ses_parent", {
    id: childID,
    parentID: "ses_parent",
    outcome: "succeeded",
  }), false)
  assert.deepEqual(controller.pendingFollowupRecords(), [])
})

test("keeps capacity reserved until session.status observes idle and requires parent follow-up", async () => {
  const controller = declaredPolicy(3, "change", 1)
  const childID = await launch(controller, "cancel-capacity", "ses_parent", "ses_cancelcapacity")
  let releaseWait!: () => void
  let signalWait!: () => void
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  const waitStarted = new Promise<void>((resolve) => { signalWait = resolve })
  let interruptCalls = 0
  let waitCalls = 0
  let persistedTasks: ReturnType<typeof controller.taskStateRecords> = []
  let persistedFollowups: ReturnType<typeof controller.pendingFollowupRecords> = []
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "ses_parent" }),
    interrupt: async ({ sessionID, resume }: { sessionID: string; resume: false }) => {
      assert.equal(sessionID, childID)
      assert.equal(resume, false)
      interruptCalls += 1
      return { interrupted: true }
    },
    waitForLifecycle: async ({ sessionID }: { sessionID: string }) => {
      assert.equal(sessionID, childID)
      waitCalls += 1
      signalWait()
      await waitGate
      controller.sessionStatus(childID, "idle")
    },
  }
  const persistLifecycle = async () => {
    persistedTasks = controller.taskStateRecords()
    persistedFollowups = controller.pendingFollowupRecords()
  }

  await assert.doesNotReject(controller.before({
    tool: "subagent_cancel",
    id: "cancel-control-tool",
    sessionID: "ses_parent",
    input: { sessionID: childID },
  }))
  assert.equal(toolMayMutate("subagent_cancel", { sessionID: childID }), false)

  const cancellation = cancelDirectChild(controller, session, "ses_parent", childID, persistLifecycle)
  await waitStarted
  assert.equal(interruptCalls, 1)
  assert.equal(waitCalls, 1)
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
  await assert.rejects(controller.before(event("capacity-during-cancel")), /configured agent orchestration limit reached/)
  await assert.rejects(
    cancelDirectChild(controller, session, "ses_parent", childID, persistLifecycle),
    /cancellation is already in progress/,
  )
  assert.equal(interruptCalls, 1)

  releaseWait()
  assert.deepEqual(await cancellation, { outcome: "idle", interrupted: true })
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
  assert.deepEqual(persistedFollowups, [{ parentID: "ses_parent", childID }])
  assert.equal(persistedTasks[0]?.children.find((child) => child.sessionID === childID)?.status, "awaiting_followup")
  await assert.rejects(controller.before(event("followup-before-launch")), /follow-up required/)

  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "The parent reviewed the child after cancellation reached idle.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  await launch(controller, "capacity-after-cancel-review", "ses_parent", "ses_aftercancelreview")
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 2 })
})

test("observes deletion during cancellation without trusting interrupt completion", async () => {
  const controller = declaredPolicy(3, "change", 1)
  const childID = await launch(controller, "cancel-delete-race", "ses_parent", "ses_canceldeleterace")
  let getCalls = 0
  let persisted = 0
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      getCalls += 1
      return { id: sessionID, parentID: "ses_parent" }
    },
    interrupt: async () => ({ interrupted: true }),
    waitForLifecycle: async () => {
      assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
      assert.equal(controller.sessionDeleted(childID), true)
    },
  }
  assert.deepEqual(
    await cancelDirectChild(controller, session, "ses_parent", childID, async () => { persisted += 1 }),
    { outcome: "deleted", interrupted: true },
  )
  assert.equal(getCalls, 1)
  assert.equal(persisted, 1)
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
  assert.deepEqual(controller.pendingFollowupRecords(), [{ parentID: "ses_parent", childID }])
})

test("recovers an interrupted child after the bounded cancellation wait times out", async () => {
  const controller = declaredPolicy(3, "change", 1)
  const childID = await launch(controller, "cancel-wait-terminal", "ses_parent", "ses_cancelwaitterminal")
  let getCalls = 0
  let waitCalls = 0
  let persistedTasks: ReturnType<typeof controller.taskStateRecords> = []
  let persistedFollowups: ReturnType<typeof controller.pendingFollowupRecords> = []
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      getCalls += 1
      assert.equal(sessionID, childID)
      return getCalls === 1
        ? { id: sessionID, parentID: "ses_parent" }
        : { id: sessionID, parentID: "ses_parent", outcome: "interrupted" as const }
    },
    interrupt: async ({ sessionID, resume }: { sessionID: string; resume: false }) => {
      assert.equal(sessionID, childID)
      assert.equal(resume, false)
      return { interrupted: true }
    },
    waitForLifecycle: async (
      { sessionID }: { sessionID: string },
      waitSignal: AbortSignal,
    ) => {
      assert.equal(sessionID, childID)
      waitCalls += 1
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(waitSignal.reason)
        if (waitSignal.aborted) abort()
        else waitSignal.addEventListener("abort", abort, { once: true })
      })
    },
  }
  const persistLifecycle = async () => {
    persistedTasks = controller.taskStateRecords()
    persistedFollowups = controller.pendingFollowupRecords()
  }

  assert.deepEqual(
    await cancelDirectChild(controller, session, "ses_parent", childID, persistLifecycle, 20),
    { outcome: "interrupted", interrupted: true },
  )
  assert.equal(getCalls, 2)
  assert.equal(waitCalls, 1)
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
  assert.deepEqual(persistedFollowups, [{ parentID: "ses_parent", childID }])
  assert.equal(persistedTasks[0]?.children.find((child) => child.sessionID === childID)?.status, "awaiting_followup")
  assert.deepEqual(controller.pendingFollowupRecords(), [{ parentID: "ses_parent", childID }])
})

test("keeps capacity reserved when the bounded cancellation wait times out", async () => {
  const controller = declaredPolicy(3, "change", 1)
  const childID = await launch(controller, "cancel-wait-timeout", "ses_parent", "ses_cancelwaittimeout")
  let getCalls = 0
  let interruptCalls = 0
  let waitCalls = 0
  let signalWait!: () => void
  const waitStarted = new Promise<void>((resolve) => { signalWait = resolve })
  let persisted = 0
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      getCalls += 1
      assert.equal(sessionID, childID)
      return { id: sessionID, parentID: "ses_parent" }
    },
    interrupt: async ({ sessionID, resume }: { sessionID: string; resume: false }) => {
      assert.equal(sessionID, childID)
      assert.equal(resume, false)
      interruptCalls += 1
      return { interrupted: true }
    },
    waitForLifecycle: async (
      { sessionID }: { sessionID: string },
      waitSignal: AbortSignal,
    ) => {
      assert.equal(sessionID, childID)
      waitCalls += 1
      signalWait()
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(waitSignal.reason)
        if (waitSignal.aborted) abort()
        else waitSignal.addEventListener("abort", abort, { once: true })
      })
    },
  }
  const cancellation = cancelDirectChild(
    controller,
    session,
    "ses_parent",
    childID,
    async () => { persisted += 1 },
    10,
  )

  await waitStarted
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
  await assert.rejects(cancellation, (error: unknown) => error instanceof Error && error.name === "TimeoutError")
  assert.equal(getCalls, 2)
  assert.equal(interruptCalls, 1)
  assert.equal(waitCalls, 1)
  assert.equal(persisted, 0)
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
  assert.deepEqual(controller.pendingFollowupRecords(), [])
  assert.equal(controller.taskState("ses_parent")?.children.find((child) => child.sessionID === childID)?.status, "active")
  await assert.rejects(controller.before(event("capacity-after-wait-timeout")), /configured agent orchestration limit reached/)
})

test("bounds the total cancellation budget when the terminal-state recheck stalls", async () => {
  const controller = declaredPolicy(3, "change", 1)
  const childID = await launch(controller, "cancel-recheck-timeout", "ses_parent", "ses_cancelrechecktimeout")
  const waitTimeoutMs = 600
  let getCalls = 0
  let persisted = 0
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      getCalls += 1
      assert.equal(sessionID, childID)
      if (getCalls > 1) return new Promise<never>(() => undefined)
      return { id: sessionID, parentID: "ses_parent" }
    },
    interrupt: async () => ({ interrupted: true }),
    waitForLifecycle: async (
      { sessionID }: { sessionID: string },
      waitSignal: AbortSignal,
    ) => {
      assert.equal(sessionID, childID)
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(waitSignal.reason)
        if (waitSignal.aborted) abort()
        else waitSignal.addEventListener("abort", abort, { once: true })
      })
    },
  }

  const startedAt = performance.now()
  await assert.rejects(
    cancelDirectChild(controller, session, "ses_parent", childID, async () => { persisted += 1 }, waitTimeoutMs),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  )
  assert.ok(performance.now() - startedAt < waitTimeoutMs * 1.5)
  assert.equal(getCalls, 2)
  assert.equal(persisted, 0)
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
  assert.deepEqual(controller.pendingFollowupRecords(), [])
  assert.equal(controller.taskState("ses_parent")?.children.find((child) => child.sessionID === childID)?.status, "active")
  await assert.rejects(controller.before(event("capacity-after-recheck-timeout")), /configured agent orchestration limit reached/)
})

test("treats an interrupt idle no-op as stale until session.status observes idle", async () => {
  const controller = declaredPolicy(3, "change", 1)
  const childID = await launch(controller, "cancel-idle-noop", "ses_parent", "ses_cancelidlenoop")
  let releaseWait!: () => void
  let signalWait!: () => void
  const waitGate = new Promise<void>((resolve) => { releaseWait = resolve })
  const waitStarted = new Promise<void>((resolve) => { signalWait = resolve })
  let persisted = 0
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "ses_parent" }),
    interrupt: async () => ({ interrupted: false }),
    waitForLifecycle: async () => {
      signalWait()
      await waitGate
      controller.sessionStatus(childID, "idle")
    },
  }
  const cancellation = cancelDirectChild(controller, session, "ses_parent", childID, async () => { persisted += 1 })

  await waitStarted
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
  assert.deepEqual(controller.pendingFollowupRecords(), [])
  releaseWait()
  await assert.rejects(cancellation, /already idle; cancellation was denied/)
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 1 })
  assert.deepEqual(controller.pendingFollowupRecords(), [{ parentID: "ses_parent", childID }])
  assert.equal(persisted, 1)
})

test("denies cross-owner, stale, and already-terminal cancellation requests", async () => {
  const controller = declaredPolicy()
  const childID = await launch(controller, "cancel-denials", "ses_parent", "ses_canceldenials")
  let getCalls = 0
  let interruptCalls = 0
  const session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      getCalls += 1
      return { id: sessionID, parentID: "ses_parent" }
    },
    interrupt: async () => {
      interruptCalls += 1
      return { interrupted: true }
    },
    waitForLifecycle: async () => undefined,
  }

  await assert.rejects(
    cancelDirectChild(controller, session, "ses_otherparent", childID, async () => undefined),
    /not active for this parent and child/,
  )
  assert.equal(getCalls, 0)
  await assert.rejects(
    cancelDirectChild(controller, {
      ...session,
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "ses_otherparent" }),
    }, "ses_parent", childID, async () => undefined),
    /not owned by this parent/,
  )
  assert.equal(interruptCalls, 0)
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })

  controller.sessionStatus(childID, "idle")
  await assert.rejects(
    cancelDirectChild(controller, session, "ses_parent", childID, async () => undefined),
    /not active for this parent and child/,
  )
  assert.equal(interruptCalls, 0)

  const terminalController = declaredPolicy()
  const terminalChildID = await launch(terminalController, "cancel-terminal", "ses_parent", "ses_cancelterminal")
  let terminalInterruptCalls = 0
  let persisted = 0
  await assert.rejects(
    cancelDirectChild(terminalController, {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        parentID: "ses_parent",
        outcome: "succeeded" as const,
      }),
      interrupt: async () => {
        terminalInterruptCalls += 1
        return { interrupted: true }
      },
      waitForLifecycle: async () => undefined,
    }, "ses_parent", terminalChildID, async () => { persisted += 1 }),
    /already terminal \(succeeded\); cancellation was denied/,
  )
  assert.equal(terminalInterruptCalls, 0)
  assert.equal(persisted, 1)
  assert.deepEqual(terminalController.state(), { pending: 0, active: 0, known: 1 })
  assert.deepEqual(terminalController.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: terminalChildID }])
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

test("coalesces sanitized top-level tool errors and exempts marked negative checks", async () => {
  const controller = declaredPolicy()
  const failure = failedTool("top-level-error", {
    tool: "shell",
    error: {
      message: "Bearer super-secret-token at /home/alice/private.txt for ses_secret123; password=hunter2",
    },
  })
  assert.equal(controller.after(failure), true)
  assert.equal(controller.after({ ...failure }), false)
  const records = controller.pendingToolErrorRecords("ses_parent")
  assert.equal(records.length, 1)
  assert.match(records[0]?.id ?? "", /^terr_[a-f0-9]{64}$/)
  assert.equal(records[0]?.tool, "shell")
  assert.doesNotMatch(records[0]?.message ?? "", /super-secret-token|\/home\/alice|ses_secret123|hunter2/)
  assert.match(records[0]?.message ?? "", /redacted|path|session-id/i)

  assert.equal(controller.after(failedTool("expected-error", {
    tool: "shell",
    expected: true,
    error: { message: "Expected negative test failure" },
  })), false)
  await assert.doesNotReject(controller.before({
    ...event("ordinary-read"),
    tool: "read",
    input: { path: "README.md" },
  }))

  await assert.rejects(
    controller.before({ ...event("rejected-before"), tool: "shell", input: { command: "git add -- README.md" } }),
    /direct background child is required/,
  )
  controller.after(failedTool("rejected-before", { tool: "shell", error: { message: "policy rejection" } }))
  assert.equal(controller.pendingToolErrorRecords("ses_parent").length, 1)
})

test("restores tool-error obligations and lets read-only work continue through corrupt state", async () => {
  const source = declaredPolicy()
  const childID = await launch(source, "error-state-child", "ses_parent", "ses_errorstatechild")
  source.sessionStatus(childID, "idle")
  source.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "Reviewed the child before testing persisted error state.",
  })
  source.acknowledgeFollowup("ses_parent", childID, "accepted")
  source.after(failedTool("persisted-error", { tool: "shell", error: { message: "failure before restart" } }))

  const restarted = policy()
  restarted.restoreTaskState(source.taskStateRecords())
  restarted.restoreToolErrors(source.toolErrorStorageValue())
  assert.deepEqual(restarted.pendingToolErrorRecords("ses_parent"), source.pendingToolErrorRecords("ses_parent"))
  await assert.doesNotReject(restarted.before({
    ...event("read-after-restart"),
    tool: "read",
    input: { path: "README.md" },
  }))
  await assert.rejects(
    restarted.completeTask("ses_parent", { verification: "Must acknowledge the persisted failure first." }),
    /unresolved top-level tool-error obligations/,
  )
  const obligationID = restarted.pendingToolErrorRecords("ses_parent")[0]?.id
  assert.ok(obligationID)
  const acknowledgement = restarted.acknowledgeToolError("ses_parent", {
    obligationID,
    evidence: "Reviewed the sanitized failure and recorded the recovery.",
  })
  assert.equal(acknowledgement.remaining, 0)
  assert.equal(restarted.after(failedTool("persisted-error", { tool: "shell", error: { message: "late duplicate" } })), false)
  assert.equal(restarted.acknowledgeToolError("ses_parent", {
    obligationID,
    evidence: "The repeated acknowledgement is intentionally idempotent.",
  }).remaining, 0)
  assert.equal((await restarted.completeTask("ses_parent", { verification: "Recovered after acknowledging the tool error." })).kind, "change")

  const corrupt = policy()
  corrupt.restoreTaskState(source.taskStateRecords())
  corrupt.restoreToolErrors({ version: 1, sessions: [{ parentID: "ses_parent", obligations: "corrupt" }] })
  await assert.doesNotReject(corrupt.before({
    ...event("read-with-corruption"),
    tool: "read",
    input: { path: "README.md" },
  }))
  await assert.rejects(
    corrupt.completeTask("ses_parent", { verification: "Corrupt state still needs explicit recovery." }),
    /persisted top-level tool-error state is corrupt/,
  )
  corrupt.acknowledgeToolError("ses_parent", {
    acknowledgeCorruption: true,
    evidence: "Operator reviewed the bounded state and accepts recovery.",
  })
  assert.equal((await corrupt.completeTask("ses_parent", { verification: "Recovered and verified the task state." })).kind, "change")
})

test("rule reconciliation is idempotent when no longer due", () => {
  const withoutMemory = policy()
  const first = withoutMemory.completeReconciliation("ses_parent", {
    outcome: "conflict",
    conflicts: ["Ignored because reconciliation is not configured."],
    resolution: "Ignored.",
  })
  const second = withoutMemory.completeReconciliation("ses_parent", {
    outcome: "resolved",
    conflicts: ["A different repeated call."],
  })
  assert.deepEqual(second, { ...first, alreadyComplete: true })
  assert.equal(withoutMemory.reconciliationState("ses_parent").due, false)

  const due = memoryPolicy()
  due.setMemorySnapshot("ses_parent", snapshot)
  const completed = due.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  const repeated = due.completeReconciliation("ses_parent", {
    outcome: "conflict",
    conflicts: ["The prior audit is already complete."],
  })
  assert.deepEqual(repeated, { ...completed, alreadyComplete: true })
})

test("restores the reconciliation audit, cadence, and binding digests across a reload", () => {
  const source = memoryPolicy(5)
  source.setMemorySnapshot("ses_parent", snapshot)
  source.after({
    ...event("restore-question"),
    tool: "question",
    status: "completed",
    result: { content: "Keep the narrower rule." },
  })
  const audit = source.completeReconciliation("ses_parent", {
    outcome: "resolved",
    conflicts: ["Two durable rules disagreed."],
    resolution: "The operator selected the narrower rule.",
  })
  source.userPrompt("ses_parent")
  source.userPrompt("ses_parent")

  const stored = source.reconciliationStorageValue()
  assert.deepEqual(stored.sessions.map((entry) => entry.sessionID), ["ses_parent"])
  assert.deepEqual(stored.sessions[0]?.audit, audit)

  const restored = memoryPolicy(5)
  restored.restoreReconciliation(stored, snapshot)
  assert.deepEqual(restored.reconciliationState("ses_parent"), { turns: 2, due: false, hasSnapshot: false })

  const repeated = restored.completeReconciliation("ses_parent", {
    outcome: "conflict",
    conflicts: ["A different call after the restored audit."],
  })
  assert.equal(repeated.alreadyComplete, true)
  assert.equal(repeated.outcome, "resolved")
  assert.deepEqual(repeated.conflicts, ["Two durable rules disagreed."])
  assert.equal(repeated.resolution, "The operator selected the narrower rule.")
  assert.equal(repeated.memoryDigest, snapshot.digest)
  assert.deepEqual(repeated.memoryBindings, snapshot.bindings)
  assert.equal(repeated.noteCount, audit.noteCount)

  restored.userPrompt("ses_parent")
  restored.userPrompt("ses_parent")
  restored.userPrompt("ses_parent")
  assert.deepEqual(restored.reconciliationState("ses_parent"), { turns: 5, due: true, hasSnapshot: false })
})

test("marks reconciliation due when the restored memory digest or bindings changed", () => {
  const source = memoryPolicy(5)
  source.setMemorySnapshot("ses_parent", snapshot)
  source.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  const stored = source.reconciliationStorageValue()

  const changedDigest = memoryPolicy(5)
  changedDigest.restoreReconciliation(stored, { ...snapshot, digest: "def456" })
  assert.deepEqual(changedDigest.reconciliationState("ses_parent"), { turns: 0, due: true, hasSnapshot: false })

  const changedBindings = memoryPolicy(5)
  changedBindings.restoreReconciliation(stored, { ...snapshot, bindings: ["open-rig"] })
  assert.deepEqual(changedBindings.reconciliationState("ses_parent"), { turns: 0, due: true, hasSnapshot: false })
})

test("fails closed when restored reconciliation state is malformed or unavailable", () => {
  const source = memoryPolicy(5)
  source.setMemorySnapshot("ses_parent", snapshot)
  source.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  const stored = source.reconciliationStorageValue()

  const malformed = memoryPolicy(5)
  malformed.restoreReconciliation({
    version: 1,
    sessions: [{ sessionID: "ses_parent", turns: 0, audit: { sessionID: "ses_parent" } }],
  }, snapshot)
  assert.deepEqual(malformed.reconciliationState("ses_parent"), { turns: 0, due: true, hasSnapshot: false })

  const garbage = memoryPolicy(5)
  garbage.restoreReconciliation("not a reconciliation state", snapshot)
  assert.equal(garbage.reconciliationState("ses_parent").due, true)

  const wrongVersion = memoryPolicy(5)
  wrongVersion.restoreReconciliation({ version: 2, sessions: stored.sessions }, snapshot)
  assert.equal(wrongVersion.reconciliationState("ses_parent").due, true)

  const unavailable = memoryPolicy(5)
  unavailable.restoreReconciliation(stored, undefined)
  assert.equal(unavailable.reconciliationState("ses_parent").due, true)

  const failedLookup = memoryPolicy(5)
  failedLookup.restoreReconciliation(stored, { ...snapshot, entries: [], error: "lookup failed" })
  assert.equal(failedLookup.reconciliationState("ses_parent").due, true)
})

test("fails closed on corrupt restored reconciliation envelopes with a matching snapshot", () => {
  const source = memoryPolicy(5)
  source.setMemorySnapshot("ses_parent", snapshot)
  source.completeReconciliation("ses_parent", { outcome: "aligned", conflicts: [] })
  const stored = source.reconciliationStorageValue()
  assert.equal(stored.sessions.length, 1)

  type Entry = { sessionID?: unknown; turns?: unknown; due?: unknown; audit?: unknown }
  const restoreWith = (mutate: (entry: Entry) => void) => {
    const clone = structuredClone(stored)
    mutate(clone.sessions[0]! as Entry)
    const controller = memoryPolicy(5)
    controller.restoreReconciliation(clone, snapshot)
    return controller.reconciliationState("ses_parent")
  }

  assert.deepEqual(restoreWith(() => {}), { turns: 0, due: false, hasSnapshot: false })

  assert.equal(restoreWith((entry) => { delete entry.due }).due, true)
  assert.equal(restoreWith((entry) => { entry.due = "false" }).due, true)
  assert.equal(restoreWith((entry) => { entry.due = 1 }).due, true)
  assert.equal(restoreWith((entry) => { delete entry.turns }).due, true)
  assert.equal(restoreWith((entry) => { entry.turns = 1.5 }).due, true)
  assert.equal(restoreWith((entry) => { entry.turns = "2" }).due, true)
  assert.equal(restoreWith((entry) => { entry.turns = -1 }).due, true)
  assert.equal(restoreWith((entry) => { entry.turns = 101 }).due, true)
  assert.equal(restoreWith((entry) => { delete entry.sessionID }).due, true)
  assert.equal(restoreWith((entry) => { (entry.audit as Record<string, unknown>).outcome = "unknown" }).due, true)

  const mismatched = memoryPolicy(5)
  const mismatchState = structuredClone(stored)
  mismatchState.sessions[0]!.sessionID = "ses_other"
  mismatched.restoreReconciliation(mismatchState, snapshot)
  assert.equal(mismatched.reconciliationState("ses_parent").due, true)
  assert.equal(mismatched.reconciliationState("ses_other").due, true)
})

test("blocks repository mutations when the policy index drifts or an installed path is targeted", async () => {
  const controller = declaredPolicy(3, "change", 3, { enforceAgentIndex: true })
  controller.setIndexErrors(["missing policy link"])
  await assert.rejects(
    controller.before({ ...event("index"), tool: "shell", input: { command: "git add -- README.md" } }),
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

test("keeps policy-index repair task-bound and enforces correction ledgers", async () => {
  const repair = {
    tool: "patch",
    id: "policy-index-repair",
    sessionID: "ses_parent",
    input: { patchText: "*** Update File: AGENTS.md\n+repair the policy index" },
  }
  const undeclared = policy(3, 3, { enforceAgentIndex: true })
  undeclared.setIndexErrors(["missing policy link"])
  await assert.rejects(undeclared.before(repair), /call task_declare/)

  const correction = declaredPolicy(3, "correction", 3, { enforceAgentIndex: true })
  correction.setIndexErrors(["missing policy link"])
  await assert.rejects(correction.before(repair), /correction ledger acknowledgement is incomplete/)
  for (const ledger of ["roadmap", "todo", "memory"] as const) {
    correction.acknowledgeCorrection("ses_parent", {
      ledger,
      status: "no_write",
      evidence: `${ledger} has no separate write for this bounded repair test.`,
    })
  }
  await assert.doesNotReject(correction.before(repair))
})

test("rejects foreground and empty-agent launches while allowing project identities", async () => {
  const controller = declaredPolicy()
  await assert.rejects(controller.before(event("foreground", { background: false })), /background=true/)
  await assert.rejects(controller.before(event("empty-agent", { agent: "   " })), /agent identifier must be non-empty/)
  await controller.before(event("project-agent", {
    agent: "execution/ingenium-qa",
    model: "other-provider/other-model#max",
  }))
  assert.equal(controller.state().pending, 1)
})

test("a globally loaded policy passes namespaced agents and arbitrary resolved models through", async () => {
  const resolvedAgents: string[] = []
  const controller = createOrchestrationPolicy({
    maxConcurrent: 10,
    enforceAgentIndex: false,
    allowedAgents: ["explore"],
    allowedModels: ["openai/gpt-5.6-luna#max"],
  }, {
    capacityDiagnostic: async (requestedAgents) => {
      assert.equal(requestedAgents, 10)
      return { approvedCount: 10 }
    },
    resolveAgentModel: async (agent) => {
      resolvedAgents.push(agent)
      return "ingenium/provider-model#fast"
    },
    readTodoState: syntheticTodoState,
  })
  controller.declareTask("ses_parent", { kind: "change" })

  for (const [id, agent] of [
    ["namespaced-one", "@execution/ingenium-software-engineer-fast"],
    ["namespaced-two", "execution/ingenium-docs"],
  ] as const) {
    const launchEvent = event(id, { agent, model: undefined })
    await controller.before(launchEvent)
    controller.after({
      ...launchEvent,
      status: "completed",
      result: { sessionID: id === "namespaced-one" ? "ses_namespacedone" : "ses_namespacedtwo" },
    })
  }

  assert.deepEqual(resolvedAgents, [
    "@execution/ingenium-software-engineer-fast",
    "execution/ingenium-docs",
  ])
  const injected = controller.instructions("ses_parent")
  assert.match(injected, /does not restrict agent or model identity/)
  assert.doesNotMatch(injected, /Allowed child agents|Allowed child models|explore|general|openai\/gpt/)
  assert.doesNotMatch(injected, /AGENTS\.md|ROADMAP\.md|HANDOFF\.md|computer-assistant|open-rig/)
  assert.deepEqual(controller.state(), { pending: 0, active: 2, known: 2 })
})

test("global loading does not activate Open Rig policy-repair exceptions", async () => {
  const controller = createOrchestrationPolicy({ enforceAgentIndex: false }, {
    capacityDiagnostic: async () => ({ approvedCount: 10 }),
    resolveAgentModel: async () => "project/provider-model#default",
    readTodoState: syntheticTodoState,
  })
  controller.declareTask("ses_parent", { kind: "change" })
  for (const [id, patchText] of [
    ["global-repair", "*** Update File: AGENTS.md"],
    ["global-roadmap", "*** Update File: /project/ROADMAP.md"],
  ] as const) {
    await assert.rejects(
      controller.before({ ...event(id), tool: "patch", input: { patchText } }),
      /direct background child is required/,
    )
  }
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

test("accepts an exact actionable todo and a description with em-dash detail", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  for (const [id, description, content, legacy] of [
    ["exact-todo", "Launch the exact child", "Launch the exact child", false],
    ["detailed-todo", "Launch the detailed child", "Launch the detailed child — verify the result", true],
  ] as const) {
    const root = await mkdtemp("/tmp/opencode/orchestration-todo-")
    context.after(() => rm(root, { recursive: true, force: true }))
    await writeTodoMirror(root, [{ content, status: "pending" }], legacy)
    const { controller } = await realTodoPolicy(root)
    await controller.before(event(id, { description }))
    assert.equal(controller.state().pending, 1)
  }
})

test("rejects missing and blank subagent descriptions", async () => {
  for (const description of [undefined, "", "   "]) {
    const controller = declaredPolicy()
    await assert.rejects(
      controller.before(event(`missing-description-${String(description)}`, { description })),
      /subagent description is required/,
    )
    assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
  }
})

test("fails closed on missing, malformed, symlinked, and oversized todo mirrors", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  for (const scenario of ["missing", "malformed", "symlink", "oversized"] as const) {
    const root = await mkdtemp("/tmp/opencode/orchestration-todo-")
    context.after(() => rm(root, { recursive: true, force: true }))
    if (scenario === "malformed") await writeFile(join(root, "ses_parent.json"), "{")
    if (scenario === "symlink") {
      await writeFile(join(root, "target.json"), JSON.stringify({
        items: [{ content: DEFAULT_DESCRIPTION, status: "pending" }],
        updatedAt: "2026-09-22T00:00:00.000Z",
      }))
      await symlink(join(root, "target.json"), join(root, "ses_parent.json"))
    }
    if (scenario === "oversized") await writeFile(join(root, "ses_parent.json"), "x".repeat(64 * 1024 + 1))
    const { controller, capacityCalls } = await realTodoPolicy(root)
    await assert.rejects(
      controller.before(event(`todo-${scenario}`, { description: DEFAULT_DESCRIPTION })),
      /subagent todo mirror is unavailable or invalid/,
    )
    assert.equal(capacityCalls(), 0)
    assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
  }
})

test("rejects session IDs anywhere in todo content without exposing todo text", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-")
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeTodoMirror(root, [
    { content: "Historical work ses_secret123", status: "completed" },
    { content: DEFAULT_DESCRIPTION, status: "pending" },
  ])
  const { controller, capacityCalls } = await realTodoPolicy(root)
  const result = await controller.before(event("session-id-in-todo", { description: DEFAULT_DESCRIPTION })).catch((error: unknown) => error)
  assert(result instanceof Error)
  assert.match(result.message, /subagent todo mirror is unavailable or invalid/)
  assert.doesNotMatch(result.message, /ses_secret123/)
  assert.equal(capacityCalls(), 0)
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
})

test("requires one actionable leading description match and ignores completed history", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const rejected: Array<[string, string, Record<string, unknown>[]]> = [
    ["no-match", "Launch the requested child", [{ content: "Different work", status: "pending" }]],
    ["prefix-collision", "Fix foo", [{ content: "Fix foobar — detail", status: "pending" }]],
    ["completed-only", "Launch the requested child", [{ content: "Launch the requested child", status: "completed" }]],
    ["duplicate", "Launch the requested child", [
      { content: "Launch the requested child", status: "pending" },
      { content: "Launch the requested child — duplicate", status: "in_progress" },
    ]],
  ]
  for (const [id, description, items] of rejected) {
    const root = await mkdtemp("/tmp/opencode/orchestration-todo-")
    context.after(() => rm(root, { recursive: true, force: true }))
    await writeTodoMirror(root, items)
    const { controller, capacityCalls } = await realTodoPolicy(root)
    await assert.rejects(
      controller.before(event(id, { description })),
      /subagent description must match exactly one actionable todo/,
    )
    assert.equal(capacityCalls(), 0)
    assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
  }

  const historyRoot = await mkdtemp("/tmp/opencode/orchestration-todo-")
  context.after(() => rm(historyRoot, { recursive: true, force: true }))
  await writeTodoMirror(historyRoot, [
    { content: "Launch the requested child", status: "completed" },
    { content: "Launch the requested child", status: "cancelled" },
    { content: "Launch the requested child — current details", status: "in_progress" },
  ])
  const { controller: history } = await realTodoPolicy(historyRoot)
  await history.before(event("one-actionable-history", { description: "Launch the requested child" }))
  assert.equal(history.state().pending, 1)
})

test("blocks task completion on pending or in-progress Todos and injects one bounded reminder", async () => {
  const makeController = async (todoState: string | undefined, unreadable = false) => {
    const controller = createOrchestrationPolicy({}, {
      capacityDiagnostic: async () => ({ approvedCount: 3 }),
      resolveAgentModel: async () => "project/provider-model#default",
      readTodoState: async (parentSessionID, description) => {
        if (description !== undefined) return syntheticTodoState(parentSessionID, description)
        if (unreadable) throw new Error("private underlying read error")
        return todoState
      },
    })
    controller.declareTask("ses_parent", { kind: "change" })
    await acceptChild(controller)
    return controller
  }

  for (const status of ["pending", "in_progress"] as const) {
    const todoState = JSON.stringify({
      items: [
        { content: DEFAULT_DESCRIPTION, status: "pending" },
        { content: "Finish the remaining roadmap verification", status },
      ],
      updatedAt: "2026-09-23T00:00:00.000Z",
    })
    const controller = await makeController(todoState)
    const count = await controller.todoReminderCount("ses_parent")
    assert.equal(count, 2)
    const context = controller.instructions("ses_parent", count)
    assert.equal([...context.matchAll(/ROADMAP CONTINUITY:/g)].length, 1)
    const reminder = context.split("\n").find((line) => line.startsWith("ROADMAP CONTINUITY:"))
    assert.ok(reminder)
    assert.ok(reminder.length <= 200)
    assert.match(reminder, /completion is blocked until they are verified done/)
    await assert.rejects(controller.before({
      tool: "task_complete",
      id: `todo-gated-complete-${status}`,
      sessionID: "ses_parent",
      input: { verification: "Actionable Todos remain." },
    }), /2 actionable todo item\(s\) remain/)
    await assert.rejects(controller.before({
      tool: "repo_commit",
      id: `todo-gated-commit-${status}`,
      sessionID: "ses_parent",
      input: {},
    }), /2 actionable todo item\(s\) remain/)
    await assert.rejects(
      controller.completeTask("ses_parent", { verification: "All remaining work is verified." }),
      /2 actionable todo item\(s\) remain/,
    )
  }

  for (const status of ["completed", "cancelled"] as const) {
    const todoState = JSON.stringify({
      items: [
        { content: DEFAULT_DESCRIPTION, status },
        { content: "A prior item", status },
      ],
      updatedAt: "2026-09-23T00:00:00.000Z",
    })
    const controller = await makeController(todoState)
    assert.equal(await controller.todoReminderCount("ses_parent"), undefined)
    assert.equal((await controller.completeTask("ses_parent", { verification: "All actionable work is verified." })).kind, "change")
  }

  const absent = await makeController(undefined)
  assert.equal((await absent.completeTask("ses_parent", { verification: "No Todo state exists." })).kind, "change")

  const malformed = await makeController("{")
  await assert.rejects(
    malformed.completeTask("ses_parent", { verification: "Malformed Todo state must fail closed." }),
    /Todo state is unavailable or invalid/,
  )
  const unreadable = await makeController(undefined, true)
  await assert.rejects(
    unreadable.completeTask("ses_parent", { verification: "Unreadable Todo state must fail closed." }),
    /Todo state is unavailable or invalid/,
  )
})

test("allows task completion when the on-disk Todo state file is genuinely absent", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-completion-absent-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const controller = createOrchestrationPolicy({}, {
    capacityDiagnostic: async () => ({ approvedCount: 3 }),
    resolveAgentModel: async () => "project/provider-model#default",
    todoRoot: root,
  })
  controller.restoreTaskState([{
    parentID: "ses_parent",
    kind: "change",
    declaredAt: "2026-09-23T00:00:00.000Z",
    children: [{ sessionID: "ses_completedchild", status: "reviewed", outcome: "accepted" }],
    ledgers: {},
  }])
  assert.equal((await controller.completeTask("ses_parent", { verification: "The Todo mirror is absent." })).kind, "change")
})

test("persists required acceptance claims and blocks planned claims despite zero actionable Todos", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-acceptance-planned-")
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeAcceptanceFixture(root, [
    {
      id: "mandatory-delegation-policy",
      status: "complete",
      user_visible: false,
      runtime: false,
      evidence: { automated: ["proof.txt"] },
    },
    { id: "visible-commands", status: "planned", user_visible: true, runtime: true, evidence: {} },
  ])
  const cancelledTodo = async (_parentSessionID: string, description?: string) => JSON.stringify({
    items: description
      ? [{ content: description, status: "pending" }]
      : [{ content: "Cancelled verification work", status: "cancelled" }],
    updatedAt: "2026-09-23T00:00:00.000Z",
  })
  const controller = acceptancePolicy(root, cancelledTodo)
  controller.declareTask("ses_parent", { kind: "change", requiredClaimIDs: ["visible-commands"] })
  await acceptChild(controller, "planned-claim")

  await assert.rejects(
    controller.completeTask("ses_parent", { verification: "Free text cannot satisfy the planned visible claim." }),
    /required acceptance claim visible-commands is planned/,
  )

  assert.deepEqual(controller.taskState("ses_parent")?.requiredClaimIDs, ["visible-commands"])
  const restarted = policy()
  restarted.restoreTaskState(controller.taskStateRecords())
  assert.deepEqual(restarted.taskState("ses_parent")?.requiredClaimIDs, ["visible-commands"])
})

test("rejects malformed required claim IDs at declaration and restore", async () => {
  for (const requiredClaimIDs of [[], ["../claim"], ["same-claim", "same-claim"], Array(33).fill("valid-claim")]) {
    assert.throws(
      () => policy().declareTask("ses_parent", { kind: "change", requiredClaimIDs }),
      /requiredClaimIDs/,
    )
  }

  const restored = policy()
  restored.restoreTaskState([{
    parentID: "ses_parent",
    kind: "change",
    requiredClaimIDs: ["unsafe/claim"],
    declaredAt: "2026-09-23T00:00:00.000Z",
    children: [],
    ledgers: {},
  }])
  assert.equal(restored.taskState("ses_parent"), undefined)
  await assert.rejects(
    restored.completeTask("ses_parent", { verification: "Corrupt persisted claim state must not complete." }),
    /call task_declare/,
  )
})

test("allows complete claims with safe regular-file evidence references and rejects unknown IDs", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-acceptance-complete-")
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeAcceptanceFixture(root, [{
    id: "mandatory-delegation-policy",
    status: "complete",
    user_visible: false,
    runtime: false,
    evidence: { automated: ["proof.txt"] },
  }])
  const accepted = await acceptedClaimTask(root, ["mandatory-delegation-policy"])
  assert.equal(
    (await accepted.completeTask("ses_parent", { verification: "The required claim has a safe regular-file evidence reference." })).kind,
    "change",
  )

  const unknown = await acceptedClaimTask(root, ["not-in-the-canonical-manifest"])
  await assert.rejects(
    unknown.completeTask("ses_parent", { verification: "Free text cannot establish a manifest claim." }),
    /unknown required acceptance claim/,
  )
})

test("fails closed on missing, malformed, symlinked, and oversized canonical acceptance manifests", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-acceptance-manifest-")
  const outside = `${root}-outside.json`
  const outsideEvidence = `${root}-outside-proof.txt`
  const rootAlias = `${root}-alias`
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { force: true }),
    rm(outsideEvidence, { force: true }),
    rm(rootAlias, { force: true }),
  ]))
  await writeFile(join(root, "proof.txt"), "retained test evidence\n")
  const manifestPath = join(root, "acceptance-evidence.json")
  const valid = acceptanceManifest([{
    id: "required-check",
    status: "complete",
    user_visible: false,
    runtime: false,
    evidence: { automated: ["proof.txt"] },
  }])
  const controller = await acceptedClaimTask(root, ["required-check"])
  const complete = () => controller.completeTask("ses_parent", {
    verification: "Manifest shape and evidence-reference checks must pass independently of this text.",
  })

  await assert.rejects(complete(), /canonical acceptance-evidence\.json is unavailable or invalid/)
  await writeFile(manifestPath, "{")
  await assert.rejects(complete(), /canonical acceptance-evidence\.json is unavailable or invalid/)
  await writeFile(manifestPath, valid.replace('"status":"complete"', '"status":"planned","status":"complete"'))
  await assert.rejects(complete(), /canonical acceptance-evidence\.json is unavailable or invalid/)
  await writeFile(manifestPath, " ".repeat(1024 * 1024 + 1))
  await assert.rejects(complete(), /canonical acceptance-evidence\.json is unavailable or invalid/)
  await writeFile(outside, valid)
  await rm(manifestPath)
  await symlink(outside, manifestPath)
  await assert.rejects(complete(), /canonical acceptance-evidence\.json is unavailable or invalid/)

  await rm(manifestPath)
  await writeFile(manifestPath, acceptanceManifest([{
    id: "required-check",
    status: "complete",
    user_visible: false,
    runtime: false,
    evidence: { automated: ["linked-proof.txt"] },
  }]))
  await writeFile(outsideEvidence, "outside evidence\n")
  await symlink(outsideEvidence, join(root, "linked-proof.txt"))
  await assert.rejects(complete(), /required acceptance claim required-check has invalid evidence/)

  await symlink(root, rootAlias)
  const linkedRoot = await acceptedClaimTask(rootAlias, ["required-check"])
  await assert.rejects(
    linkedRoot.completeTask("ses_parent", { verification: "A symlinked project root is not canonical." }),
    /canonical acceptance-evidence\.json is unavailable or invalid/,
  )
})

test("rejects invalid evidence paths and preserves task completion for unscoped work", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-acceptance-path-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const manifestPath = join(root, "acceptance-evidence.json")
  const traversal = acceptanceManifest([{
    id: "required-check",
    status: "complete",
    user_visible: false,
    runtime: false,
    evidence: { automated: ["../ROADMAP.md"] },
  }])
  await writeFile(manifestPath, traversal)
  const required = await acceptedClaimTask(root, ["required-check"])
  await assert.rejects(
    required.completeTask("ses_parent", { verification: "Traversal outside the project root must be rejected." }),
    /canonical acceptance-evidence\.json is unavailable or invalid/,
  )

  const unscoped = declaredPolicy()
  await acceptChild(unscoped, "unscoped-completion")
  assert.equal((await unscoped.completeTask("ses_parent", { verification: "No claim IDs were required." })).kind, "change")
})

test("does not leak capacity or pending state after todo rejection", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-")
  context.after(() => rm(root, { recursive: true, force: true }))
  await writeTodoMirror(root, [{ content: "Other work", status: "pending" }])
  const { controller, capacityCalls } = await realTodoPolicy(root)
  await assert.rejects(controller.before(event("rejected-before-capacity")), /exactly one actionable todo/)
  assert.equal(capacityCalls(), 0)
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })

  await writeTodoMirror(root, [{ content: DEFAULT_DESCRIPTION, status: "pending" }])
  await controller.before(event("valid-after-rejection"))
  assert.equal(capacityCalls(), 1)
  assert.deepEqual(controller.state(), { pending: 1, active: 0, known: 0 })
})

test("rejects hostile parent IDs and escaping todo paths before capacity reservation", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const hostile = await realTodoPolicy(root)
  await assert.rejects(
    hostile.controller.before(event("hostile-parent", { sessionID: "ses_parent/../../escape" })),
    /parent sessionID is invalid/,
  )
  assert.equal(hostile.capacityCalls(), 0)
  assert.deepEqual(hostile.controller.state(), { pending: 0, active: 0, known: 0 })

  await writeTodoMirror(root, [{ content: DEFAULT_DESCRIPTION, status: "pending" }])
  const escaping = await realTodoPolicy(root, {}, () => join(root, "..", "escaped-todo.json"))
  await assert.rejects(
    escaping.controller.before(event("escaping-path")),
    /subagent todo mirror is unavailable or invalid/,
  )
  assert.equal(escaping.capacityCalls(), 0)
  assert.deepEqual(escaping.controller.state(), { pending: 0, active: 0, known: 0 })
})

test("enforces configured concurrency and releases children only when idle", async () => {
  const controller = policy(2, 2)
  controller.declareTask("ses_parent", { kind: "change" })
  controller.declareTask("ses_parent2", { kind: "change" })
  controller.declareTask("ses_parent3", { kind: "change" })
  await launch(controller, "one", "ses_parent", "ses_child1")
  await launch(controller, "two", "ses_parent2", "ses_child2")
  assert.deepEqual(controller.state(), { pending: 0, active: 2, known: 2 })
  await assert.rejects(controller.before(event("three", { sessionID: "ses_parent3" })), /configured agent orchestration limit reached/)
  controller.sessionStatus("ses_child1", "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: "ses_child1",
    outcome: "accepted",
    verification: "Reviewed and independently verified child one.",
  })
  controller.acknowledgeFollowup("ses_parent", "ses_child1", "accepted")
  await controller.before(event("three", { sessionID: "ses_parent3" }))
})

test("allows three concurrent children and repeated asynchronous batches in one task", async () => {
  const controller = declaredPolicy(3)
  const first = await launch(controller, "batch-one", "ses_parent", "ses_batchone")
  const second = await launch(controller, "batch-two", "ses_parent", "ses_batchtwo")
  const third = await launch(controller, "batch-three", "ses_parent", "ses_batchthree")
  assert.deepEqual(controller.state(), { pending: 0, active: 3, known: 3 })
  await assert.rejects(controller.before(event("batch-over-capacity")), /configured agent orchestration limit reached \(3\/3\)/)

  controller.sessionStatus(first, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: first,
    outcome: "accepted",
    verification: "Independently verified the first asynchronous child.",
  })
  controller.acknowledgeFollowup("ses_parent", first, "accepted")
  const fourth = await launch(controller, "batch-four", "ses_parent", "ses_batchfour")
  assert.deepEqual(controller.state(), { pending: 0, active: 3, known: 4 })
  assert.equal(controller.taskState("ses_parent")?.children.length, 4)
  await assert.rejects(
    controller.completeTask("ses_parent", { verification: "Too early." }),
    /every background child must complete/,
  )

  for (const childID of [second, third, fourth]) {
    controller.sessionStatus(childID, "idle")
    controller.reviewFollowup("ses_parent", {
      sessionID: childID,
      outcome: "accepted",
      verification: `Independently verified ${childID}.`,
    })
    controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  }
  assert.equal((await controller.completeTask("ses_parent", { verification: "All asynchronous children were reviewed." })).children.length, 4)
})

test("honors a project-configured ten-child ceiling", async () => {
  const controller = declaredPolicy(10, "change", 10)
  for (let index = 1; index <= 10; index += 1) {
    await launch(controller, `ten-${index}`, "ses_parent", `ses_ten${index}`)
  }
  assert.deepEqual(controller.state(), { pending: 0, active: 10, known: 10 })
  await assert.rejects(
    controller.before(event("ten-over-capacity")),
    /configured agent orchestration limit reached \(10\/10\)/,
  )
})

test("reserves configured launch slots while resolving concurrent children", async () => {
  let started = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const controller = createOrchestrationPolicy({ maxConcurrent: 3 }, {
    capacityDiagnostic: async () => ({ approvedCount: 1 }),
    resolveAgentModel: async () => {
      started += 1
      await gate
      return "project/provider-model#default"
    },
    readTodoState: syntheticTodoState,
  })
  controller.declareTask("ses_parent", { kind: "change" })
  const launches = ["concurrent-one", "concurrent-two", "concurrent-three"].map((id) =>
    controller.before(event(id, { model: undefined })))
  while (started < 3) await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 0 })
  release()
  await Promise.all(launches)
  for (const [id, childID] of [["concurrent-one", "ses_concurrentone"], ["concurrent-two", "ses_concurrenttwo"], ["concurrent-three", "ses_concurrentthree"]] as const) {
    controller.after({ ...event(id), status: "completed", result: { sessionID: childID } })
  }
  assert.deepEqual(controller.state(), { pending: 0, active: 3, known: 3 })
  const restored = policy()
  restored.restoreTaskState(controller.taskStateRecords())
  assert.deepEqual(restored.state(), { pending: 0, active: 3, known: 3 })
})

test("recovered terminal follow-up releases stale active capacity", async () => {
  const controller = policy(1, 1)
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
  const controller = policy(1, 1)
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

test("admits ten configured children regardless of low or unavailable capacity diagnostics", async () => {
  const cases: Array<[string, (requestedAgents: number) => Promise<CapacityResult>]> = [
    ["five", async () => ({ approvedCount: 5 })],
    ["invalid", async () => ({ approvedCount: "not-a-number" })],
    ["unavailable", async () => { throw new Error("capacity probe failed") }],
  ]
  for (const [name, diagnostic] of cases) {
    let diagnosticCalls = 0
    const controller = configuredPolicy(async (requestedAgents) => {
      diagnosticCalls += 1
      assert.equal(requestedAgents, 10)
      return diagnostic(requestedAgents)
    }, 10)
    controller.declareTask("ses_parent", { kind: "change" })
    for (let index = 1; index <= 10; index += 1) {
      await launch(controller, `${name}-${index}`, "ses_parent", `ses_${name}${index}`)
    }
    assert.deepEqual(controller.state(), { pending: 0, active: 10, known: 10 })
    assert.equal(diagnosticCalls, 10)
    await assert.rejects(
      controller.before(event(`${name}-eleven`)),
      /configured agent orchestration limit reached \(10\/10\)/,
    )
    assert.equal(diagnosticCalls, 10)
  }
})

test("capacity diagnostics do not delay direct launch admission", async () => {
  let started!: () => void
  let release!: (result: CapacityResult) => void
  const diagnosticStarted = new Promise<void>((resolve) => { started = resolve })
  const diagnostic = new Promise<CapacityResult>((resolve) => { release = resolve })
  const controller = configuredPolicy(() => {
    started()
    return diagnostic
  }, 10)
  controller.declareTask("ses_parent", { kind: "change" })

  const launchResult = controller.before(event("nonblocking-diagnostic"))
  await diagnosticStarted
  const pendingState = controller.state()
  release({ approvedCount: 0 })
  await launchResult

  assert.deepEqual(pendingState, { pending: 1, active: 0, known: 0 })
  assert.deepEqual(controller.state(), { pending: 1, active: 0, known: 0 })
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
  assert.deepEqual(declared.children, [])
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
  await assert.rejects(
    controller.before({ ...event("unlocked"), tool: "patch", input: { patchText: "*** Update File: README.md" } }),
    /parent implementation blocked: delegation-only/,
  )

  const completed = await controller.completeTask("ses_parent", { verification: "The reviewed policy change is complete." })
  assert.equal(completed.kind, "review")
  assert.equal(controller.taskState("ses_parent")?.completedAt !== undefined, true)
  await assert.rejects(
    controller.before({ ...event("after-complete"), tool: "patch", input: { patchText: "*** Update File: README.md" } }),
    /call task_declare/,
  )
})

test("blocks parent completion and commit while a direct launch is reserving or pending", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const controller = createOrchestrationPolicy({ maxConcurrent: 3 }, {
    capacityDiagnostic: async () => {
      await gate
      return { approvedCount: 3 }
    },
      resolveAgentModel: async () => "project/provider-model#default",
    readTodoState: syntheticTodoState,
  })
  controller.declareTask("ses_parent", { kind: "change" })
  const launch = controller.before(event("in-flight"))
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assert.rejects(
    controller.before({ ...event("parent-commit"), tool: "repo_commit", input: {} }),
    /pending or reserving/,
  )
  await assert.rejects(
    controller.completeTask("ses_parent", { verification: "Too early." }),
    /pending or reserving/,
  )
  release()
  await launch
  await assert.rejects(
    controller.before({ ...event("parent-push"), tool: "repo_push", input: {} }),
    /pending or reserving/,
  )
  controller.after({ ...event("in-flight"), status: "completed", result: { sessionID: "ses_inflight" } })
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
  assert.deepEqual(controller.taskState("ses_parent")?.children, [{ sessionID: "ses_createdchild", status: "active" }])
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })

  const serialized = declaredPolicy()
  const serializedEvent = event("serialized")
  await serialized.before(serializedEvent)
  serialized.after({ ...serializedEvent, status: "completed", result: JSON.stringify({ sessionID: "ses_serializedchild" }) })
  assert.deepEqual(serialized.taskState("ses_parent")?.children, [{ sessionID: "ses_serializedchild", status: "active" }])
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

test("does not self-bind a runtime session or bind a second result child", async () => {
  const self = declaredPolicy()
  const selfLaunch = event("self")
  await self.before(selfLaunch)
  assert.equal(self.sessionCreated("ses_parent", "ses_parent"), false)
  self.after({ ...selfLaunch, status: "completed", result: { sessionID: "ses_parent" } })
  assert.deepEqual(self.state(), { pending: 0, active: 0, known: 0 })

  const controller = declaredPolicy()
  const launchEvent = event("paired")
  await controller.before(launchEvent)
  assert.equal(controller.sessionCreated("ses_created", "ses_parent"), true)
  controller.after({ ...launchEvent, status: "completed", result: { sessionID: "ses_different" } })
  assert.deepEqual(controller.taskState("ses_parent")?.children, [{ sessionID: "ses_created", status: "active" }])
  assert.deepEqual(controller.state(), { pending: 0, active: 1, known: 1 })
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

test("accepted follow-up keeps parent delegation active and permits another background child", async () => {
  const controller = declaredPolicy()
  const childID = await launch(controller, "accepted", "ses_parent", "ses_acceptedchild")
  controller.sessionStatus(childID, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: childID,
    outcome: "accepted",
    verification: "Independently verified the accepted child result.",
  })
  controller.acknowledgeFollowup("ses_parent", childID, "accepted")
  await assert.rejects(
    controller.before({ ...event("parent-mutation"), tool: "patch", input: { patchText: "*** Update File: README.md" } }),
    /parent implementation blocked: delegation-only/,
  )
  const next = await launch(controller, "next", "ses_parent", "ses_nextchild")
  assert.equal(next, "ses_nextchild")
  assert.equal(controller.taskState("ses_parent")?.children.length, 2)
})

test("changes_required and failed follow-ups permit replacement children", async () => {
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
    assert.equal(controller.taskState("ses_parent")?.children[0]?.outcome, outcome)

    const replacement = await launch(controller, `replacement-${outcome}`, "ses_parent", `ses_new${outcome.replace("_", "")}`)
    assert.deepEqual(controller.taskState("ses_parent")?.children, [
      { sessionID: oldChild, status: "reviewed", outcome },
      { sessionID: replacement, status: "active" },
    ])
  }
})

test("recognizes read-only Git inspection and leaves failed-child replacement to follow-up", async () => {
  assert.equal(toolMayMutate("shell", { command: "git status" }), false)
  assert.equal(toolMayMutate("shell", { command: "git add -- README.md" }), true)
  assert.equal(toolMayMutate("execute", { code: "return tools.shell({ command: \"git status\" })" }), false)
  assert.equal(toolMayMutate("execute", { code: "return tools.shell({ command: \"git add -- README.md\" })" }), true)

  const controller = declaredPolicy()
  const failedChild = await launch(controller, "shell-failed-child", "ses_parent", "ses_shellfailed")
  assert.equal(controller.after(failedTool("child-shell-error", {
    sessionID: failedChild,
    tool: "shell",
    error: { message: "child shell failed" },
  })), false)
  assert.deepEqual(controller.pendingToolErrorRecords("ses_parent"), [])
  controller.sessionStatus(failedChild, "idle")
  controller.reviewFollowup("ses_parent", {
    sessionID: failedChild,
    outcome: "failed",
    verification: "The child shell operation failed; replacement work is required.",
  })
  controller.acknowledgeFollowup("ses_parent", failedChild, "failed")
  const replacement = await launch(controller, "shell-replacement", "ses_parent", "ses_shellreplacement")
  assert.equal(replacement, "ses_shellreplacement")
})

test("a later nonaccepted review keeps completion and commits blocked until replacement acceptance", async () => {
  const controller = declaredPolicy()
  const accepted = await launch(controller, "mixed-accepted", "ses_parent", "ses_mixedaccepted")
  controller.sessionStatus(accepted, "idle")
  controller.reviewFollowup("ses_parent", { sessionID: accepted, outcome: "accepted", verification: "Accepted first review." })
  controller.acknowledgeFollowup("ses_parent", accepted, "accepted")
  const changes = await launch(controller, "mixed-changes", "ses_parent", "ses_mixedchanges")
  controller.sessionStatus(changes, "idle")
  controller.reviewFollowup("ses_parent", { sessionID: changes, outcome: "changes_required", verification: "Requested corrections." })
  controller.acknowledgeFollowup("ses_parent", changes, "changes_required")
  await assert.rejects(
    controller.before({ ...event("mixed-commit"), tool: "repo_commit", input: {} }),
    /later changes-required or failed child/,
  )
  await assert.rejects(
    controller.completeTask("ses_parent", { verification: "Still needs replacement." }),
    /later changes-required or failed child/,
  )
})

test("task status exposes bounded task, child, and ledger state without ownership fields", () => {
  const controller = policy()
  controller.restoreTaskState([{
    parentID: "ses_parent",
    kind: "change",
    summary: "A bounded task summary",
    declaredAt: "2026-09-23T00:00:00.000Z",
    children: [{
      sessionID: "ses_child",
      status: "active",
      ownership: { version: 1, worktreeRoot: "/old/worktree", writeScopes: ["src"] },
    }],
    ledgers: {},
    ownership: { version: 1, worktreeRoot: "/old/worktree", writeScopes: ["src"] },
  }])
  const status = controller.taskState("ses_parent")
  assert.ok(status)
  assert.deepEqual(Object.keys(status).sort(), ["children", "declaredAt", "kind", "ledgers", "parentID", "summary"])
  assert.deepEqual(Object.keys(status.children[0]!).sort(), ["sessionID", "status"])
  assert.doesNotMatch(JSON.stringify(status), /ownership|readScopes|writeScopes/)
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
    { parentID: "not-a-session", kind: "change", children: [], ledgers: {} },
    { parentID: "ses_other", kind: "not-a-kind", children: [], ledgers: {} },
  ])
  assert.equal(restored.taskState("ses_other"), undefined)

  const migrated = policy()
  migrated.restoreTaskState([{
    parentID: "ses_legacy",
    kind: "change",
    declaredAt: "2026-09-21T00:00:00.000Z",
    childID: "ses_legacychild",
    childCompleted: true,
    followupOutcome: "accepted",
    ledgers: {},
  }])
  assert.deepEqual(migrated.taskState("ses_legacy")?.children, [{
    sessionID: "ses_legacychild",
    status: "reviewed",
    outcome: "accepted",
  }])

  const malformed = policy()
  malformed.restoreTaskState([{
    parentID: "ses_malformed",
    kind: "change",
    children: [
      { sessionID: "ses_validchild", status: "reviewed", outcome: "accepted" },
      { sessionID: "not-a-session", status: "active" },
    ],
    ledgers: {},
  }])
  assert.equal(malformed.taskState("ses_malformed"), undefined)

  const contradictoryLegacy = policy()
  contradictoryLegacy.restoreTaskState([{
    parentID: "ses_contradictory",
    kind: "change",
    childID: "ses_contradictorychild",
    childCompleted: false,
    followupOutcome: "accepted",
    ledgers: {},
  }])
  assert.equal(contradictoryLegacy.taskState("ses_contradictory"), undefined)
})

test("serializes storage writes and continues after a failed write", async () => {
  const queue = createSerialWriteQueue()
  const order: string[] = []
  let active = 0
  let maximum = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = queue(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    order.push("first-start")
    await gate
    order.push("first-end")
    active -= 1
  })
  const second = queue(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    order.push("second")
    active -= 1
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ["first-start"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ["first-start", "first-end", "second"])
  assert.equal(maximum, 1)
  await assert.rejects(queue(async () => { throw new Error("storage failed") }), /storage failed/)
  await queue(async () => { order.push("after-failure") })
  assert.equal(order.at(-1), "after-failure")
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
  const controller = declaredPolicy(3, "change", 3, { enforceAgentIndex: true })
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
      input: { code: 'return tools["subagent"]({ agent: "execution/ingenium-default", background: true })' },
    }),
    /direct subagent tool/,
  )
})

test("restores 98 reviewed children through storage and repairs inconsistent child state", async () => {
  const source = declaredPolicy(10, "change", 10)
  for (let index = 0; index < 98; index += 1) await acceptChild(source, `history-${index}`)

  const values = new Map<string, unknown>()
  const storageStub = {
    async set(key: string, value: unknown) {
      values.set(key, JSON.parse(JSON.stringify(value)) as unknown)
    },
    async get(key: string) {
      const value = values.get(key)
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown
    },
  }
  await storageStub.set("orchestration-task/state", source.taskStateRecords())
  await storageStub.set("subagent-followup/pending", source.pendingFollowupRecords())
  const saved = await storageStub.get("orchestration-task/state") as ReturnType<typeof source.taskStateRecords>
  assert.equal(saved[0]?.children.length, 98)
  assert.ok(saved[0]?.children.every((child) => child.status === "reviewed" && child.outcome === "accepted"))
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 16 * 1024)

  const validRestart = policy()
  validRestart.restoreFollowups(await storageStub.get("subagent-followup/pending"))
  validRestart.restoreTaskState(saved)
  assert.equal(validRestart.taskState("ses_parent")?.children.length, 98)

  for (const inconsistency of ["reviewed-without-outcome", "awaiting-with-outcome"] as const) {
    const corrupted = structuredClone(saved)
    const child = corrupted[0]!.children[97]!
    if (inconsistency === "reviewed-without-outcome") delete child.outcome
    else child.status = "awaiting_followup"
    await storageStub.set("orchestration-task/state", corrupted)

    const restarted = policy()
    restarted.restoreFollowups(await storageStub.get("subagent-followup/pending"))
    restarted.restoreTaskState(await storageStub.get("orchestration-task/state"))
    assert.equal(restarted.taskState("ses_parent")?.children.length, 98)
    assert.deepEqual(restarted.taskState("ses_parent")?.children[97], {
      sessionID: "ses_history97",
      status: "awaiting_followup",
    })
    assert.deepEqual(restarted.pendingFollowupRecords(), [{ parentID: "ses_parent", childID: "ses_history97" }])
    await assert.rejects(restarted.before(event(`blocked-${inconsistency}`)), /follow-up required/)
  }
})

test("keeps fail-closed behavior for unknown child lifecycle statuses", () => {
  const restored = policy()
  restored.restoreTaskState([{
    parentID: "ses_parent",
    kind: "change",
    declaredAt: "2026-09-25T00:00:00.000Z",
    children: [{ sessionID: "ses_hostile", status: "unknown" }],
    ledgers: {},
  }])
  assert.equal(restored.taskState("ses_parent"), undefined)
})

test("blocks a launch before the bounded task-child history can overflow", async () => {
  const controller = policy()
  controller.restoreTaskState([{
    parentID: "ses_parent",
    kind: "change",
    declaredAt: "2026-09-25T00:00:00.000Z",
    children: Array.from({ length: 256 }, (_, index) => ({
      sessionID: `ses_limit${index}`,
      status: "reviewed",
      outcome: "accepted",
    })),
    ledgers: {},
  }])
  await assert.rejects(controller.before(event("over-history-limit")), /task child history limit reached/)
  assert.deepEqual(controller.state(), { pending: 0, active: 0, known: 256 })
})
