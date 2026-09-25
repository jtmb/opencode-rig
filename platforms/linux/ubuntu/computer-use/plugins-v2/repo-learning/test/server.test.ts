import assert from "node:assert/strict"
import test from "node:test"

import {
  setupRepoLearningServer,
  type RepoLearningServerContext,
} from "../server.ts"
import {
  createRepositoryKey,
  REFLECTION_TOOL_NAME,
  reflectionStorageKey,
} from "../src/reflection.ts"
import { toObservedEvent } from "../src/recorder.ts"
import type { RepoLearningCompletionInput, RepoLearningInput, RepoLearningOutput } from "../src/rpc.ts"

type LearnHandler = (input: RepoLearningInput) => Promise<RepoLearningOutput>
type CompletionHandler = (input: RepoLearningCompletionInput) => Promise<{
  enabled: boolean
  ready: boolean
  required: number
  receipted: number
  missingObligationIDs: string[]
  conflictObligationIDs: string[]
}>
type ReflectionTool = {
  name: string
  execute: (input: unknown, context: {
    sessionID: string
    agent: string
    messageID: string
    id: string
    progress?: () => Promise<void>
  }) => Promise<{ content?: string }>
}
type HookEvent = {
  tool: string
  sessionID: string
  agent: string
  messageID: string
  id: string
  input: unknown
  status?: "completed" | "error"
  result?: { content?: string }
}
type ContextEvent = {
  sessionID: string
  agent: string
  tools: Record<string, unknown>
  system: Array<{ type: "text"; text: string }>
}

const END = Symbol("end")

function fakeContext(options: unknown, initialStorage?: Map<string, unknown>) {
  const values = initialStorage ?? new Map<string, unknown>()
  let methods: { learn: LearnHandler; checkTaskCompletion: CompletionHandler } | undefined
  let reflectionTool: ReflectionTool | undefined
  let contextHook: ((event: ContextEvent) => Promise<void>) | undefined
  const hooks = new Map<string, (event: HookEvent) => Promise<void>>()
  let eventSubscriptions = 0
  let storageWrites = 0
  let reflectionReads = 0
  const queuedEvents: unknown[] = []
  let waitingEvent: ((event: unknown | typeof END) => void) | undefined
  let scheduledEventCount = 0
  let processedEventCount = 0
  const processedEventWaiters: Array<{ count: number; resolve: () => void }> = []

  const markEventProcessed = () => {
    processedEventCount += 1
    for (const waiter of processedEventWaiters.splice(0)) {
      if (waiter.count <= processedEventCount) waiter.resolve()
      else processedEventWaiters.push(waiter)
    }
  }

  const context = {
    options,
    location: { directory: "/repo/a", project: { id: "project-a", canonical: "/repo/a" } },
    storage: {
      get: async (key: string) => {
        if (key.startsWith("repo-learning/reflection/")) reflectionReads += 1
        return values.get(key)
      },
      set: async (key: string, value: unknown) => {
        storageWrites += 1
        values.set(key, value)
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        projectID: sessionID === "ses_other" ? "project-b" : "project-a",
        location: { directory: sessionID === "ses_other" ? "/repo/b" : "/repo/a" },
      }),
      hook: async (name: string, callback: (event: ContextEvent) => Promise<void>) => {
        assert.equal(name, "context")
        contextHook = callback
        return { dispose: async () => undefined }
      },
    },
    rpc: {
      register: async (_definition: unknown, registered: { learn: LearnHandler; checkTaskCompletion: CompletionHandler }) => {
        methods = registered
        return { dispose: async () => undefined }
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: ReflectionTool) => void }) => void) => {
        callback({ add: (tool) => { reflectionTool = tool } })
        return { dispose: async () => undefined }
      },
      hook: async (name: string, callback: (event: HookEvent) => Promise<void>) => {
        hooks.set(name, callback)
        return { dispose: async () => undefined }
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        eventSubscriptions += 1
        return (async function* () {
          const onAbort = () => waitingEvent?.(END)
          signal.addEventListener("abort", onAbort)
          try {
            while (!signal.aborted) {
              if (queuedEvents.length > 0) {
                yield queuedEvents.shift()
                markEventProcessed()
                continue
              }
              const next = await new Promise<unknown | typeof END>((resolve) => {
                waitingEvent = resolve
              })
              waitingEvent = undefined
              if (next === END) return
              yield next
              markEventProcessed()
            }
          } finally {
            signal.removeEventListener("abort", onAbort)
            waitingEvent = undefined
          }
        })()
      },
    },
  } as unknown as RepoLearningServerContext

  return {
    context,
    methods: () => {
      assert.ok(methods)
      return methods
    },
    reflectionTool: () => {
      assert.ok(reflectionTool)
      return reflectionTool
    },
    hasReflectionTool: () => reflectionTool !== undefined,
    contextHook: () => {
      assert.ok(contextHook)
      return contextHook
    },
    hasContextHook: () => contextHook !== undefined,
    hooks,
    values,
    eventSubscriptions: () => eventSubscriptions,
    storageWrites: () => storageWrites,
    reflectionReads: () => reflectionReads,
    pushEvent: (event: unknown) => {
      scheduledEventCount += 1
      if (waitingEvent) {
        const resolve = waitingEvent
        waitingEvent = undefined
        resolve(event)
      } else queuedEvents.push(event)
    },
    pushEventsAndWait: async (events: unknown[]) => {
      const count = scheduledEventCount + events.length
      for (const event of events) {
        scheduledEventCount += 1
        if (waitingEvent) {
          const resolve = waitingEvent
          waitingEvent = undefined
          resolve(event)
        } else queuedEvents.push(event)
      }
      if (processedEventCount >= count) return
      await new Promise<void>((resolve) => processedEventWaiters.push({ count, resolve }))
    },
  }
}

let eventSequence = 0

function toolEvent(
  type: string,
  created: number,
  sessionID = "ses_active",
  name?: string,
  toolCallID = `call_${created}`,
) {
  const sequence = ++eventSequence
  const data: Record<string, unknown> = { sessionID }
  if (type.startsWith("session.tool.")) {
    data.id = toolCallID
    data.assistantMessageID = `msg_${toolCallID}`
  }
  if (name !== undefined) data.name = name
  if (type === "session.tool.called") {
    data.input = {}
    data.executed = true
  } else if (type === "session.tool.success") {
    data.content = [{ type: "text", text: "completed" }]
    data.executed = true
  } else if (type === "session.tool.failed") {
    data.error = { type: "Error", message: "Expected test failure" }
    data.executed = true
  } else if (type === "session.execution.failed") {
    data.error = { type: "Error", message: "Expected test failure" }
  } else if (type === "session.execution.interrupted") {
    data.reason = "user"
  }
  const ephemeral = type === "session.idle" || type === "session.status" ||
    type === "session.tool.input.delta" || type === "session.tool.progress"
  return {
    id: `evt_${sequence}`,
    type,
    created,
    location: { directory: "/repo/a" },
    ...(ephemeral ? {} : { durable: { aggregateID: sessionID, seq: sequence, version: type === "session.tool.success" || type === "session.tool.failed" ? 2 : 1 } }),
    data,
  }
}

function learnValue(values: Map<string, unknown>): { episodes: unknown[] } | undefined {
  const value = values.get("repo-learning/observe")
  return typeof value === "string" ? JSON.parse(value) as { episodes: unknown[] } : undefined
}

test("unrecognized tool-event aliases and raw tool-call inputs are not observed", () => {
  assert.equal(toObservedEvent({
    type: "session.tool.succeeded",
    created: Date.now(),
    data: { sessionID: "ses_active" },
  }), undefined)
  assert.equal(toObservedEvent({
    id: "evt_called",
    type: "session.tool.called",
    created: Date.now(),
    durable: { aggregateID: "ses_active", seq: 1, version: 1 },
    location: { directory: "/repo/a" },
    data: {
      sessionID: "ses_active",
      assistantMessageID: "msg_1",
      id: "call_1",
      input: { privateArgument: "not a transcript" },
      executed: true,
    },
  }), undefined)
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail("server event processing did not reach the expected state")
}

function reflectionValue(values: Map<string, unknown>): { schema: number; repoKey: string; obligations: Array<Record<string, unknown>>; receipts: Array<Record<string, unknown>> } | undefined {
  const key = reflectionStorageKey(createRepositoryKey("project-a", "/repo/a"))
  const value = values.get(key)
  return typeof value === "string" ? JSON.parse(value) as ReturnType<typeof reflectionValue> : undefined
}

async function recordOneEpisode(fixture: ReturnType<typeof fakeContext>, created: number): Promise<void> {
  await fixture.pushEventsAndWait([
    toolEvent("session.tool.input.started", created, "ses_active", "repo_read"),
    toolEvent("session.execution.succeeded", created + 1),
    toolEvent("session.idle", created + 2),
  ])
  await waitUntil(() => (reflectionValue(fixture.values)?.obligations.length ?? 0) > 0)
}

test("disabled server keeps status and audit available without observation, reflection, or storage writes", async () => {
  const now = Date.now()
  const stored = JSON.stringify({
    schema: 1,
    paused: true,
    episodes: [{
      id: "ep-legacy",
      sessionID: "ses_saved",
      startedAt: now - 1_000,
      endedAt: now,
      toolCalls: 1,
      errors: 0,
      summary: "safe summary",
    }],
  })
  const initial = new Map<string, unknown>([["repo-learning/observe", stored]])
  const fixture = fakeContext({ enabled: false }, initial)
  const cleanup = await setupRepoLearningServer(fixture.context)

  const status = await fixture.methods().learn({ sessionID: "ses_active", command: "/learn status" })
  assert.ok(status.text.includes("disabled by configuration"))
  assert.ok(status.text.includes("paused=true flag was ignored"))
  const audit = await fixture.methods().learn({ sessionID: "ses_active", command: "/learn audit" })
  assert.ok(audit.text.includes("ep-legacy"))
  const completion = await fixture.methods().checkTaskCompletion({ sessionID: "ses_active" })
  assert.equal(completion.enabled, false)
  assert.equal(completion.ready, true)
  assert.equal(fixture.hasReflectionTool(), false)
  assert.equal(fixture.hasContextHook(), false)
  assert.equal(fixture.eventSubscriptions(), 0)
  assert.equal(fixture.reflectionReads(), 0)
  assert.equal(fixture.hooks.size, 0)
  assert.equal(fixture.storageWrites(), 0)

  await cleanup?.()
  assert.equal(fixture.storageWrites(), 0)
})

test("server rejects pause/resume RPC input instead of preserving a hidden control", async () => {
  const fixture = fakeContext({ enabled: false })
  const cleanup = await setupRepoLearningServer(fixture.context)
  await assert.rejects(
    () => fixture.methods().learn({ sessionID: "ses_active", command: "/learn pause" }),
    /expected status\|audit/,
  )
  await assert.rejects(
    () => fixture.methods().learn({ sessionID: "ses_active", command: "/learn resume token" }),
    /expected status\|audit/,
  )
  assert.equal(fixture.eventSubscriptions(), 0)
  assert.equal(fixture.reflectionReads(), 0)
  assert.equal(fixture.storageWrites(), 0)
  await cleanup?.()
})

test("model-visible reflection injects untrusted evidence and only a paired real tool execution writes a receipt", async () => {
  const fixture = fakeContext({ enabled: true })
  const cleanup = await setupRepoLearningServer(fixture.context)
  assert.equal(fixture.eventSubscriptions(), 1)
  assert.equal(fixture.reflectionTool().name, REFLECTION_TOOL_NAME)
  assert.ok(fixture.hooks.has("execute.before"))
  assert.ok(fixture.hooks.has("execute.after"))

  const now = Date.now()
  await recordOneEpisode(fixture, now)
  const obligation = reflectionValue(fixture.values)!.obligations[0]!
  const system: ContextEvent["system"] = []
  await fixture.contextHook()({
    sessionID: "ses_active",
    agent: "build",
    tools: { [REFLECTION_TOOL_NAME]: {} },
    system,
  })
  assert.equal(system.length, 1)
  assert.ok(system[0]?.text.includes("untrusted observation metadata"))
  assert.ok(system[0]?.text.includes(obligation["id"] as string))

  const identity = { sessionID: "ses_active", agent: "build", messageID: "msg_real", id: "call_real" }
  const input = {
    obligationID: obligation["id"],
    obligationDigest: obligation["digest"],
    noChangeRationale: "The observed behavior is already covered by current repository guidance.",
  }
  const tool = fixture.reflectionTool()
  const context = { ...identity, progress: async () => undefined }
  const preliminary = await tool.execute(input, context)
  assert.equal(JSON.parse(preliminary.content ?? "{}").executionVerified, false)

  const after = fixture.hooks.get("execute.after")!
  const unpaired: HookEvent = { tool: REFLECTION_TOOL_NAME, ...identity, input, status: "completed", result: preliminary }
  await after(unpaired)
  assert.equal(reflectionValue(fixture.values)!.receipts.length, 0)
  const pendingCompletion = await fixture.methods().checkTaskCompletion({ sessionID: identity.sessionID })
  assert.equal(pendingCompletion.ready, false)
  assert.deepEqual(pendingCompletion.missingObligationIDs, [obligation["id"]])

  const before = fixture.hooks.get("execute.before")!
  await before({ tool: REFLECTION_TOOL_NAME, ...identity, input })
  const result = await tool.execute(input, context)
  const completed: HookEvent = { tool: REFLECTION_TOOL_NAME, ...identity, input, status: "completed", result }
  await after(completed)
  const visible = JSON.parse(completed.result?.content ?? "{}") as {
    executionVerified: boolean
    applied: boolean
    receipt: Record<string, unknown> | null
  }
  assert.equal(visible.executionVerified, true)
  assert.equal(visible.applied, false)
  assert.equal(visible.receipt?.sessionID, identity.sessionID)
  assert.equal(visible.receipt?.agent, identity.agent)
  assert.equal(visible.receipt?.messageID, identity.messageID)
  assert.equal(visible.receipt?.toolCallID, identity.id)

  const stored = reflectionValue(fixture.values)!
  assert.equal(stored.receipts.length, 1)
  assert.ok(!JSON.stringify(stored).includes("already covered by current repository guidance"))
  const completion = await fixture.methods().checkTaskCompletion({ sessionID: identity.sessionID })
  assert.equal(completion.ready, true)
  assert.equal(completion.required, 1)
  assert.equal(completion.receipted, 1)

  const afterReceiptSystem: ContextEvent["system"] = []
  await fixture.contextHook()({
    sessionID: identity.sessionID,
    agent: "build",
    tools: { [REFLECTION_TOOL_NAME]: {} },
    system: afterReceiptSystem,
  })
  assert.equal(afterReceiptSystem.length, 0)

  await fixture.pushEventsAndWait([
    toolEvent("session.tool.input.started", now + 10, "ses_active", REFLECTION_TOOL_NAME, identity.id),
    toolEvent("session.tool.called", now + 11, "ses_active", undefined, identity.id),
    toolEvent("session.tool.success", now + 12, "ses_active", undefined, identity.id),
    toolEvent("session.execution.succeeded", now + 13),
    toolEvent("session.idle", now + 14),
  ])
  assert.equal(learnValue(fixture.values)?.episodes.length, 1)
  assert.equal(reflectionValue(fixture.values)?.obligations.length, 1)
  assert.equal((await fixture.methods().checkTaskCompletion({ sessionID: identity.sessionID })).ready, true)

  await recordOneEpisode(fixture, now + 20)
  const independentObligations = reflectionValue(fixture.values)!.obligations
  assert.equal(independentObligations.length, 2)
  assert.ok(String(independentObligations[1]?.["observed"]).includes("tool:repo_read"))
  assert.ok(!String(independentObligations[1]?.["observed"]).includes(REFLECTION_TOOL_NAME))

  const secondIdentity = { ...identity, messageID: "msg_real_2", id: "call_real_2" }
  const secondInput = {
    obligationID: independentObligations[1]?.["id"],
    obligationDigest: independentObligations[1]?.["digest"],
    noChangeRationale: "The independent observation is already covered by current repository guidance.",
  }
  await before({ tool: REFLECTION_TOOL_NAME, ...secondIdentity, input: secondInput })
  const secondResult = await tool.execute(secondInput, { ...secondIdentity, progress: async () => undefined })
  const secondCompleted: HookEvent = {
    tool: REFLECTION_TOOL_NAME,
    ...secondIdentity,
    input: secondInput,
    status: "completed",
    result: secondResult,
  }
  await after(secondCompleted)
  const secondCompletion = await fixture.methods().checkTaskCompletion({ sessionID: identity.sessionID })
  assert.equal(secondCompletion.ready, true)
  assert.equal(secondCompletion.required, 2)
  assert.equal(secondCompletion.receipted, 2)

  await cleanup?.()
})

test("passive V2 tool events and direct executor/RPC calls do not manufacture receipts", async () => {
  const fixture = fakeContext({ enabled: true })
  const cleanup = await setupRepoLearningServer(fixture.context)
  const now = Date.now()
  const callID = "call_unreceipted"
  await fixture.pushEventsAndWait([
    toolEvent("session.tool.input.started", now, "ses_active", REFLECTION_TOOL_NAME, callID),
    toolEvent("session.tool.called", now + 1, "ses_active", undefined, callID),
    toolEvent("session.idle", now + 2),
  ])
  assert.equal(reflectionValue(fixture.values), undefined)
  assert.deepEqual(learnValue(fixture.values)?.episodes, [])

  const completion = await fixture.methods().checkTaskCompletion({ sessionID: "ses_active" })
  assert.equal(completion.required, 0)
  assert.equal(completion.ready, true)
  await cleanup?.()
})

test("failed learning-tool events and their anonymous execution error are excluded before recording", async () => {
  const fixture = fakeContext({ enabled: true })
  const cleanup = await setupRepoLearningServer(fixture.context)
  const now = Date.now()
  const callID = "call_failed_reflection"
  await fixture.pushEventsAndWait([
    toolEvent("session.tool.input.started", now, "ses_active", REFLECTION_TOOL_NAME, callID),
    toolEvent("session.tool.called", now + 1, "ses_active", undefined, callID),
    toolEvent("session.tool.failed", now + 2, "ses_active", undefined, callID),
    toolEvent("session.execution.failed", now + 3),
    toolEvent("session.idle", now + 4),
  ])

  assert.deepEqual(learnValue(fixture.values)?.episodes, [])
  assert.equal(reflectionValue(fixture.values)?.obligations.length ?? 0, 0)
  const completion = await fixture.methods().checkTaskCompletion({ sessionID: "ses_active" })
  assert.equal(completion.ready, true)
  assert.equal(completion.required, 0)
  await cleanup?.()
})

test("unrelated V2 tool failures still create reflection obligations", async () => {
  const fixture = fakeContext({ enabled: true })
  const cleanup = await setupRepoLearningServer(fixture.context)
  const now = Date.now()
  const callID = "call_failed_repo_read"

  await fixture.pushEventsAndWait([
    toolEvent("session.tool.input.started", now, "ses_active", "repo_read", callID),
    toolEvent("session.tool.called", now + 1, "ses_active", undefined, callID),
    toolEvent("session.tool.failed", now + 2, "ses_active", undefined, callID),
    toolEvent("session.execution.failed", now + 3),
    toolEvent("session.idle", now + 4),
  ])
  await waitUntil(() => (reflectionValue(fixture.values)?.obligations.length ?? 0) === 1)

  const obligation = reflectionValue(fixture.values)!.obligations[0]!
  assert.match(String(obligation["observed"]), /tool:repo_read/)
  assert.match(String(obligation["observed"]), /execution:tool-failed/)
  assert.match(String(obligation["observed"]), /execution:failed/)
  assert.equal(obligation["errors"], 2)
  assert.equal((await fixture.methods().checkTaskCompletion({ sessionID: "ses_active" })).ready, false)
  await cleanup?.()
})

test("restarting and replaying an idle episode preserves one deduplicated obligation", async () => {
  const shared = new Map<string, unknown>()
  const created = Date.now()
  const first = fakeContext({ enabled: true }, shared)
  const cleanupFirst = await setupRepoLearningServer(first.context)
  await recordOneEpisode(first, created)
  assert.equal(reflectionValue(shared)?.obligations.length, 1)
  await cleanupFirst?.()

  const second = fakeContext({ enabled: true }, shared)
  const cleanupSecond = await setupRepoLearningServer(second.context)
  await recordOneEpisode(second, created)
  assert.equal(reflectionValue(shared)?.obligations.length, 1)
  await cleanupSecond?.()
})

test("malformed reflection input and cross-repository sessions cannot create receipts", async () => {
  const fixture = fakeContext({ enabled: true })
  const cleanup = await setupRepoLearningServer(fixture.context)
  const now = Date.now()
  await recordOneEpisode(fixture, now)
  const obligation = reflectionValue(fixture.values)!.obligations[0]!
  const identity = { sessionID: "ses_active", agent: "build", messageID: "msg_bad", id: "call_bad" }
  const invalid = {
    obligationID: obligation["id"],
    obligationDigest: obligation["digest"],
    proposal: { path: "../README.md", change: "escape repository" },
  }
  await fixture.hooks.get("execute.before")!({ tool: REFLECTION_TOOL_NAME, ...identity, input: invalid })
  const result = await fixture.reflectionTool().execute(invalid, { ...identity, progress: async () => undefined })
  await fixture.hooks.get("execute.after")!({
    tool: REFLECTION_TOOL_NAME,
    ...identity,
    input: invalid,
    status: "completed",
    result,
  })
  assert.equal(reflectionValue(fixture.values)!.receipts.length, 0)

  const foreign = { ...identity, sessionID: "ses_other", messageID: "msg_foreign", id: "call_foreign" }
  await fixture.hooks.get("execute.before")!({ tool: REFLECTION_TOOL_NAME, ...foreign, input: {
    obligationID: obligation["id"],
    obligationDigest: obligation["digest"],
    noChangeRationale: "No repository change is justified.",
  } })
  assert.equal(reflectionValue(fixture.values)!.receipts.length, 0)
  await cleanup?.()
})
