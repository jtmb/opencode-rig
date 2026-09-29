import assert from "node:assert/strict"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import orchestrationPolicy from "../src/index.ts"
import { assignTodoIds, emptyTodoIdentity } from "../../rig-todo/src/identity.ts"
import {
  releaseTodoBinding,
  readTodoDispatchSnapshot,
  withTodoWriterLease,
  writeTodoDispatchSnapshot,
} from "../../rig-todo/src/dispatch.ts"
import { todoDataRoot, todoStatePath } from "../../rig-todo/src/state.ts"
import type { TodoItem } from "../../rig-todo/src/store.ts"
import { DEFAULT_ENFORCEMENTS, writeEnforcementSettings } from "../src/settings.ts"

const PARENT = "ses_todoplugin"
const DESCRIPTION = "Implement authoritative Todo binding"

function item(content: string, status: TodoItem["status"] = "pending"): TodoItem {
  return { content, status }
}

async function setup(root: string) {
  const oldData = process.env.XDG_DATA_HOME
  const oldConfig = process.env.XDG_CONFIG_HOME
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_CONFIG_HOME = join(root, "config")
  const storage = new Map<string, unknown>()
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>()
  const projectID = "todo-dispatch-test"
  const ctx = {
    options: { enforceAgentIndex: false },
    location: { project: { canonical: join(root, "project"), id: projectID } },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)) },
      remove: async (key: string) => { storage.delete(key) },
    },
    agent: { get: async () => ({ data: { model: { providerID: "fixture", id: "model" } } }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID }),
      wait: async () => undefined,
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
      prompt: async () => ({ id: "goal-prompt" }),
      interrupt: async () => ({ interrupted: false }),
      hook: async () => undefined,
    },
    tool: {
      hook: async (name: string, handler: (event: any) => Promise<void>) => { hooks.set(name, handler) },
      transform: async (register: (editor: { add: (tool: any) => void }) => void) => {
        register({ add: (tool) => { tools.set(tool.name, tool) } })
      },
    },
    permission: { hook: async () => {} },
    rpc: Object.assign(() => ({ checkTaskCompletion: async () => ({ enabled: true, ready: true, required: 0, receipted: 0, missingObligationIDs: [], conflictObligationIDs: [], unresolvedConflictIDs: [] }) }), {
      register: async () => ({ dispose: async () => undefined }),
    }),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  } as unknown as Parameters<typeof orchestrationPolicy.setup>[0]
  const cleanup = await orchestrationPolicy.setup(ctx)
  const dataRoot = todoDataRoot()
  const assigned = assignTodoIds(emptyTodoIdentity(), [item(DESCRIPTION)], PARENT)
  await writeTodoDispatchSnapshot(PARENT, {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: assigned.todos,
    identity: assigned.identity,
    bindings: [],
  }, dataRoot)
  const declare = tools.get("task_declare")
  assert.ok(declare)
  await declare.execute({ kind: "change", summary: "Exercise Todo reservation hooks" }, { sessionID: PARENT })
  const restore = async () => {
    await cleanup?.()
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = oldConfig
  }
  return { hooks, dataRoot, restore }
}

function launchEvent(id: string, description = DESCRIPTION) {
  return {
    tool: "subagent",
    id,
    sessionID: PARENT,
    input: { agent: "fixture/worker", model: "fixture/model", background: true, description },
  }
}

test("requireTodoDispatch OFF admits parent progress and unbound launches up to maxConcurrent", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-toggle-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const plugin = await setup(root)
  context.after(plugin.restore)
  const before = plugin.hooks.get("execute.before")!
  const progress = { tool: "goal_report", id: "progress", sessionID: PARENT, input: { status: "progress" } }

  // Default ON: an unbound actionable Todo blocks parent progress.
  await assert.rejects(before(progress), /Todo dispatch required/)

  // Operator turns the Todo-dispatch coupling OFF; capacity alone now gates.
  await writeEnforcementSettings(
    { ...DEFAULT_ENFORCEMENTS, requireTodoDispatch: false, parentDelegationOnly: false },
    undefined,
  )
  await before(progress)
  // A launch whose description matches no Todo is admitted, not rejected per-Todo,
  // and creates no Todo binding while the coupling is off.
  await before(launchEvent("call_unbound", "Description that matches no actionable Todo"))
  assert.deepEqual((await readTodoDispatchSnapshot(PARENT, plugin.dataRoot))?.bindings, [])
})

test("plugin release waits for the durable Todo snapshot before another dispatch can reserve it", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-release-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const plugin = await setup(root)
  context.after(plugin.restore)
  const before = plugin.hooks.get("execute.before")!
  const after = plugin.hooks.get("execute.after")!

  await before(launchEvent("call_first"))
  assert.equal((await readTodoDispatchSnapshot(PARENT, plugin.dataRoot))?.bindings[0]?.callID, "call_first")

  let locked!: () => void
  let unlock!: () => void
  const lockReady = new Promise<void>((resolve) => { locked = resolve })
  const gate = new Promise<void>((resolve) => { unlock = resolve })
  const holder = withTodoWriterLease(PARENT, async () => {
    locked()
    await gate
  }, plugin.dataRoot)
  await lockReady

  let released = false
  const release = after({ ...launchEvent("call_first"), status: "error", error: { message: "launch failed" } })
    .then(() => { released = true })
  let dispatched = false
  let dispatchError: unknown
  const concurrent = before(launchEvent("call_second")).then(
    () => { dispatched = true },
    (error: unknown) => { dispatchError = error },
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(released, false)
  assert.equal(dispatched, false)

  unlock()
  await Promise.all([holder, release, concurrent])
  assert.equal(released, true)
  if (!dispatched) {
    assert.match(String(dispatchError), /already reserved/)
    await before(launchEvent("call_after_release"))
  }
  assert.deepEqual((await readTodoDispatchSnapshot(PARENT, plugin.dataRoot))?.bindings.map((entry) => entry.callID), [
    dispatched ? "call_second" : "call_after_release",
  ])
  const remainingCall = dispatched ? "call_second" : "call_after_release"
  await after({ ...launchEvent(remainingCall), status: "error", error: { message: "test cleanup" } })
  assert.deepEqual((await readTodoDispatchSnapshot(PARENT, plugin.dataRoot))?.bindings, [])
})

test("binds the child session to its reserved Todo after a successful launch", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-child-bind-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const plugin = await setup(root)
  context.after(plugin.restore)
  const before = plugin.hooks.get("execute.before")!
  const after = plugin.hooks.get("execute.after")!
  const callID = "call_child"
  const childSessionID = "ses_childbound"
  const progress = { tool: "goal_report", id: "progress", sessionID: PARENT, input: { status: "progress" } }
  await assert.rejects(before(progress), /Todo dispatch required/)

  await before(launchEvent(callID))
  await after({ ...launchEvent(callID), status: "completed", result: { sessionID: childSessionID } })
  await before(progress)

  const snapshot = await readTodoDispatchSnapshot(PARENT, plugin.dataRoot)
  assert.deepEqual(snapshot?.bindings, [{
    callID,
    todoID: snapshot?.items[0]?.id,
    description: DESCRIPTION,
    childSessionID,
  }])
  await releaseTodoBinding(PARENT, callID, plugin.dataRoot)
})

test("plugin retains its launch guard when durable release fails", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-todo-release-fail-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const plugin = await setup(root)
  context.after(plugin.restore)
  const before = plugin.hooks.get("execute.before")!
  const after = plugin.hooks.get("execute.after")!
  await before(launchEvent("call_failure"))

  const state = todoStatePath(PARENT)
  const backup = `${state}.backup`
  await rename(state, backup)
  await writeFile(join(plugin.dataRoot, "invalid.json"), "{}")
  await symlink(join(plugin.dataRoot, "invalid.json"), state)
  await assert.rejects(
    after({ ...launchEvent("call_failure"), status: "error", error: { message: "launch failed" } }),
    /Todo snapshot is unavailable or invalid/,
  )
  await rm(state)
  await rename(backup, state)
  assert.deepEqual((await readTodoDispatchSnapshot(PARENT, plugin.dataRoot))?.bindings.map((binding) => binding.callID), [
    "call_failure",
  ])

  await assert.rejects(
    before({ tool: "task_complete", id: "call_complete", sessionID: PARENT, input: { verification: "done" } }),
    /blocked while a direct background launch is pending or reserving/,
  )

  await after({ ...launchEvent("call_failure"), status: "error", error: { message: "retry release" } })
  assert.deepEqual((await readTodoDispatchSnapshot(PARENT, plugin.dataRoot))?.bindings, [])
})
