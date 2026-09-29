import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import orchestrationPolicy, { RESTORED_CAPACITY_WAIT_TIMEOUT_MS, RESTORED_CAPACITY_WAITS } from "../src/index.ts"
import { assignTodoIds, emptyTodoIdentity } from "../../rig-todo/src/identity.ts"
import { writeTodoDispatchSnapshot } from "../../rig-todo/src/dispatch.ts"
import { todoDataRoot } from "../../rig-todo/src/state.ts"
import type { TodoItem } from "../../rig-todo/src/store.ts"

// Real plugin-entry regression for restored admission capacity. A fresh plugin
// runtime misses the idle event of an already-idle child, so a persisted active
// child must be reconciled against the authoritative session lifecycle before
// its admission slot is trusted. The fix releases capacity only for a child
// that is positively owned by its restored parent in this same project and then
// observed idle; a still-running child, a foreign-owned child, or a foreign-
// project child keeps its capacity reserved. Waits are bounded and finite, so a
// child that never becomes idle cannot block the others or release capacity.

const FOLLOWUP_KEY = "subagent-followup/pending"
const TASK_KEY = "orchestration-task/state"

const PARENT = "ses_capacityparent"
const ORPHAN = "ses_capacityorphan"
const RUNNER = "ses_capacityrunner"
const PROJECT = "capacity-restart-test"
const FOREIGN_PROJECT = "some-other-project"
const DESCRIPTION = "Launch the replacement worker"

function seedTask(childIDs: readonly string[]) {
  return [{
    parentID: PARENT,
    kind: "change",
    declaredAt: "2026-09-23T00:00:00.000Z",
    children: childIDs.map((sessionID) => ({ sessionID, status: "active" as const })),
    ledgers: {},
  }]
}

type Harness = {
  storage: Map<string, unknown>
  hooks: Map<string, (event: any) => Promise<void>>
  tools: Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>
  dataRoot: string
  waits: string[]
  waitSignals: Map<string, AbortSignal | undefined>
  getSignals: Map<string, AbortSignal | undefined>
  completedWaits: Set<string>
  readonly peakActiveWaits: number
  release: (childID: string) => void
  restore: () => Promise<void>
}

type HarnessOptions = {
  childIDs: readonly string[]
  /** Children whose authoritative wait stays pending until released. */
  running?: readonly string[]
  /** Session lookups that hang until their request signal aborts. */
  getHung?: readonly string[]
  /** Waits that resolve from the abort event instead of rejecting. */
  resolveWaitAfterAbort?: readonly string[]
  rejectFirstTaskWrite?: boolean
  /** Children whose live session reports a different owning parent. */
  ownerOverrides?: Readonly<Record<string, string>>
  /** Children whose live session reports a different project. */
  projectOverrides?: Readonly<Record<string, string>>
}

async function setup(root: string, options: HarnessOptions): Promise<Harness> {
  const oldData = process.env.XDG_DATA_HOME
  const oldConfig = process.env.XDG_CONFIG_HOME
  process.env.XDG_DATA_HOME = join(root, "data")
  process.env.XDG_CONFIG_HOME = join(root, "config")

  const childIDs = options.childIDs
  const storage = new Map<string, unknown>()
  storage.set(TASK_KEY, seedTask(childIDs))
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>()
  const waits: string[] = []
  let activeWaits = 0
  let peakActiveWaits = 0
  let rejectNextTaskWrite = options.rejectFirstTaskWrite ?? false
  const running = new Set(options.running ?? [])
  const getHung = new Set(options.getHung ?? [])
  const resolveWaitAfterAbort = new Set(options.resolveWaitAfterAbort ?? [])
  const waitSignals = new Map<string, AbortSignal | undefined>()
  const getSignals = new Map<string, AbortSignal | undefined>()
  const completedWaits = new Set<string>()
  const owners = new Map(childIDs.map((childID) => [childID, options.ownerOverrides?.[childID] ?? PARENT]))
  const projects = new Map(childIDs.map((childID) => [childID, options.projectOverrides?.[childID] ?? PROJECT]))
  const gates = new Map<string, () => void>()
  const gatePromises = new Map<string, Promise<void>>()
  for (const childID of childIDs) {
    let release!: () => void
    gatePromises.set(childID, new Promise<void>((resolve) => { release = resolve }))
    gates.set(childID, release)
  }

  const ctx = {
    options: { maxConcurrent: 1, enforceAgentIndex: false },
    location: { project: { canonical: join(root, "project"), id: PROJECT } },
    storage: {
      get: async (key: string) => structuredClone(storage.get(key)),
      set: async (key: string, value: unknown) => {
        if (key === TASK_KEY && rejectNextTaskWrite) {
          rejectNextTaskWrite = false
          throw new Error("fixture task-state write rejected")
        }
        storage.set(key, structuredClone(value))
      },
      remove: async (key: string) => { storage.delete(key) },
    },
    agent: { get: async () => ({ data: { model: { providerID: "fixture", id: "model" } } }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }, requestOptions?: { signal?: AbortSignal }) => {
        const signal = requestOptions?.signal
        getSignals.set(sessionID, signal)
        if (getHung.has(sessionID)) {
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason)
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          })
        }
        return {
          id: sessionID,
          parentID: owners.get(sessionID),
          projectID: projects.get(sessionID),
        }
      },
      wait: ({ sessionID }: { sessionID: string }, waitOptions?: { signal?: AbortSignal }) => {
        const signal = waitOptions?.signal
        waits.push(sessionID)
        waitSignals.set(sessionID, signal)
        activeWaits += 1
        peakActiveWaits = Math.max(peakActiveWaits, activeWaits)
        const request = resolveWaitAfterAbort.has(sessionID)
          ? new Promise<void>((resolve) => {
            if (signal?.aborted) resolve()
            else signal?.addEventListener("abort", () => resolve(), { once: true })
          })
          : (async () => {
            if (running.has(sessionID)) {
              await Promise.race([
                gatePromises.get(sessionID),
                new Promise<never>((_resolve, reject) => {
                  if (signal?.aborted) reject(signal.reason)
                  else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
                }),
              ])
            } else {
              // Yield so simultaneous authoritative waits accumulate like real RPCs.
              await new Promise<void>((resolve) => setImmediate(resolve))
            }
          })()
        return request.finally(() => {
          activeWaits -= 1
          completedWaits.add(sessionID)
        })
      },
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
  const assigned = assignTodoIds(emptyTodoIdentity(), [{ content: DESCRIPTION, status: "pending" } as TodoItem], PARENT)
  await writeTodoDispatchSnapshot(PARENT, {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: assigned.todos,
    identity: assigned.identity,
    bindings: [],
  }, dataRoot)

  const restore = async () => {
    await cleanup?.()
    if (oldData === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = oldData
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = oldConfig
  }
  return {
    storage,
    hooks,
    tools,
    dataRoot,
    waits,
    waitSignals,
    getSignals,
    completedWaits,
    get peakActiveWaits() { return peakActiveWaits },
    release: (childID: string) => gates.get(childID)?.(),
    restore,
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return check()
}

function followupChildIDs(harness: Harness): string[] {
  const records = harness.storage.get(FOLLOWUP_KEY)
  return Array.isArray(records) ? records.map((entry) => (entry as { childID: string }).childID) : []
}

function childStatus(harness: Harness, childID: string): string | undefined {
  const tasks = harness.storage.get(TASK_KEY)
  if (!Array.isArray(tasks)) return undefined
  const task = tasks[0] as { children?: { sessionID: string; status: string }[] } | undefined
  return task?.children?.find((child) => child.sessionID === childID)?.status
}

function launchEvent(id: string) {
  return {
    tool: "subagent",
    id,
    sessionID: PARENT,
    input: { agent: "fixture/worker", model: "fixture/model", background: true, description: DESCRIPTION },
  }
}

test("releases a genuine restart orphan's admission slot and requires parent follow-up", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-orphan-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const harness = await setup(root, { childIDs: [ORPHAN] })
  context.after(harness.restore)

  const before = harness.hooks.get("execute.before")!
  const after = harness.hooks.get("execute.after")!
  const followup = harness.tools.get("subagent_followup")!
  assert.ok(followup)

  assert.equal(
    await waitFor(() => followupChildIDs(harness).includes(ORPHAN)),
    true,
    "an already-idle restored orphan must be reconciled to a follow-up obligation",
  )
  assert.equal(childStatus(harness, ORPHAN), "awaiting_followup")

  // Capacity is released, but the restored orphan still owns a follow-up
  // obligation, so the next launch is denied until the parent reviews it.
  await assert.rejects(before(launchEvent("orphan-before-followup")), /follow-up required/)

  await followup.execute(
    { sessionID: ORPHAN, outcome: "accepted", verification: "Verified the reconciled restart orphan." },
    { sessionID: PARENT },
  )
  assert.equal(followupChildIDs(harness).length, 0)

  await before(launchEvent("orphan-after-followup"))
  await after({ ...launchEvent("orphan-after-followup"), status: "error", error: { message: "test cleanup" } })
})

test("keeps a still-running restored child's slot reserved until it is observed idle", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-running-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const harness = await setup(root, { childIDs: [ORPHAN, RUNNER], running: [RUNNER] })
  context.after(harness.restore)

  assert.equal(await waitFor(() => followupChildIDs(harness).includes(ORPHAN)), true)
  // The still-running child must not be released just because the orphan was.
  assert.equal(harness.waits.includes(RUNNER), true)
  assert.equal(followupChildIDs(harness).includes(RUNNER), false)
  assert.equal(childStatus(harness, RUNNER), "active")
  assert.equal(childStatus(harness, ORPHAN), "awaiting_followup")

  // Only the authoritative idle observation for the running child releases it.
  harness.release(RUNNER)
  assert.equal(await waitFor(() => followupChildIDs(harness).includes(RUNNER)), true)
  assert.equal(childStatus(harness, RUNNER), "awaiting_followup")
})

test("does not release a restored child whose reported owner does not match", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-foreign-owner-")
  context.after(() => rm(root, { recursive: true, force: true }))
  // Simulate a persisted binding whose live session is owned by another parent.
  const harness = await setup(root, { childIDs: [ORPHAN], ownerOverrides: { [ORPHAN]: "ses_someotherparent" } })
  context.after(harness.restore)

  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  assert.equal(followupChildIDs(harness).length, 0, "a foreign-owned child must keep its slot reserved")
  assert.equal(childStatus(harness, ORPHAN), "active")
})

test("does not release a restored child that belongs to another project and never over-admits", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-foreign-project-")
  context.after(() => rm(root, { recursive: true, force: true }))
  // The live session matches the persisted parent but reports another project,
  // so its idle observation cannot prove this project's slot is free.
  const harness = await setup(root, { childIDs: [ORPHAN], projectOverrides: { [ORPHAN]: FOREIGN_PROJECT } })
  context.after(harness.restore)

  const before = harness.hooks.get("execute.before")!
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  assert.equal(followupChildIDs(harness).includes(ORPHAN), false, "a foreign-project child must keep its slot reserved")
  assert.equal(childStatus(harness, ORPHAN), "active")
  // The reserved foreign-project child still counts against this project's
  // configured limit, so a new launch is rejected instead of over-admitted.
  await assert.rejects(before(launchEvent("foreign-project-before-followup")), /orchestration limit reached/)
})

test("bounds simultaneous waits for more restored children than the limit, progressing past a never-idle child", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-bounded-")
  context.after(() => rm(root, { recursive: true, force: true }))
  // maxConcurrent is 1, but seven restored active children exceed both the
  // configured limit and the simultaneous-wait bound. The first child never
  // becomes idle during the test, one child belongs to another project, and the
  // rest are genuinely idle.
  const idle = ["ses_capacityidle1", "ses_capacityidle2", "ses_capacityidle3", "ses_capacityidle4", "ses_capacityidle5"]
  const harness = await setup(root, {
    childIDs: [RUNNER, ORPHAN, ...idle],
    running: [RUNNER],
    projectOverrides: { [ORPHAN]: FOREIGN_PROJECT },
  })
  context.after(harness.restore)

  assert.equal(
    await waitFor(() => idle.every((childID) => followupChildIDs(harness).includes(childID))),
    true,
    "every genuinely idle restored child must still be reconciled despite the never-idle first child",
  )
  assert.ok(
    harness.peakActiveWaits <= RESTORED_CAPACITY_WAITS,
    `simultaneous restored-child waits must stay bounded (peak=${harness.peakActiveWaits}, bound=${RESTORED_CAPACITY_WAITS})`,
  )
  assert.equal(followupChildIDs(harness).includes(RUNNER), false, "a never-idle child must not be released")
  assert.equal(childStatus(harness, RUNNER), "active")
  assert.equal(followupChildIDs(harness).includes(ORPHAN), false, "a foreign-project child must not be released")
  assert.equal(childStatus(harness, ORPHAN), "active")

  // Once the running child is genuinely observed idle it is released normally.
  harness.release(RUNNER)
  assert.equal(await waitFor(() => followupChildIDs(harness).includes(RUNNER)), true)
  assert.equal(childStatus(harness, RUNNER), "awaiting_followup")
  // The still-reserved foreign-project child keeps capacity below the limit, so
  // the parent cannot over-admit while it remains unreconciled.
  assert.equal(childStatus(harness, ORPHAN), "active")
})

test("a deadline covering four hung session lookups still reaches idle restored children", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-hung-get-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const hung = ["ses_capacitygethung1", "ses_capacitygethung2", "ses_capacitygethung3", "ses_capacitygethung4"]
  const idle = ["ses_capacitygetidle1", "ses_capacitygetidle2", "ses_capacitygetidle3"]
  const harness = await setup(root, { childIDs: [...hung, ...idle], getHung: hung })
  context.after(harness.restore)

  assert.equal(await waitFor(() => harness.getSignals.size === hung.length), true)
  assert.deepEqual([...harness.getSignals.keys()], hung)

  context.mock.timers.tick(RESTORED_CAPACITY_WAIT_TIMEOUT_MS)
  assert.equal(await waitFor(() => idle.every((childID) => followupChildIDs(harness).includes(childID))), true)
  assert.ok(hung.every((childID) => harness.getSignals.get(childID) instanceof AbortSignal))
  assert.ok(harness.peakActiveWaits <= RESTORED_CAPACITY_WAITS)
  assert.ok(hung.every((childID) => childStatus(harness, childID) === "active"))
  assert.ok(hung.every((childID) => !followupChildIDs(harness).includes(childID)))
})

test("an idle wait resolving after its deadline cannot release the restored child's slot", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-late-wait-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const harness = await setup(root, { childIDs: [ORPHAN], resolveWaitAfterAbort: [ORPHAN] })
  context.after(harness.restore)

  assert.equal(await waitFor(() => harness.waitSignals.has(ORPHAN)), true)
  const signal = harness.waitSignals.get(ORPHAN)
  assert.ok(signal)
  context.mock.timers.tick(RESTORED_CAPACITY_WAIT_TIMEOUT_MS)
  assert.equal(signal.aborted, true)
  assert.equal(await waitFor(() => harness.completedWaits.has(ORPHAN)), true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(followupChildIDs(harness).includes(ORPHAN), false)
  assert.equal(childStatus(harness, ORPHAN), "active")
  await assert.rejects(harness.hooks.get("execute.before")!(launchEvent("late-wait-no-overadmit")), /orchestration limit reached/)
})

test("a rejected lifecycle write is reported and keeps restored capacity reserved", async (context) => {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/orchestration-restart-write-failure-")
  context.after(() => rm(root, { recursive: true, force: true }))
  const errors: unknown[][] = []
  const unhandled: unknown[] = []
  const originalError = console.error
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  console.error = (...args: unknown[]) => errors.push(args)
  process.on("unhandledRejection", onUnhandled)
  context.after(() => {
    console.error = originalError
    process.off("unhandledRejection", onUnhandled)
  })
  const harness = await setup(root, { childIDs: [ORPHAN], rejectFirstTaskWrite: true })
  context.after(harness.restore)

  assert.equal(await waitFor(() => errors.some((args) => args[0] === "restored child capacity reconciliation failed")), true)
  assert.equal(childStatus(harness, ORPHAN), "active")
  assert.equal(followupChildIDs(harness).includes(ORPHAN), false)
  await assert.rejects(harness.hooks.get("execute.before")!(launchEvent("write-failure-no-overadmit")), /orchestration limit reached/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})
