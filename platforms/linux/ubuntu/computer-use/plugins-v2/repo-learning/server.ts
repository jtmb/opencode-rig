import { Plugin } from "@opencode/plugin"

import {
  addVerifiedConflictDecision,
  addReflectionObligation,
  addVerifiedReceipt,
  buildUntrustedReflectionContext,
  checkTaskCompletionReceipts,
  createReflectionState,
  createRepositoryKey,
  formatReflectionConflictDecisionResult,
  formatReflectionResult,
  formatUnverifiedReflectionResult,
  isPureGovernanceCodeModeCall,
  loadReflectionState,
  outstandingReflectionConflicts,
  outstandingObligations as outstandingReflectionObligations,
  prepareReflectionConflictDecision,
  prepareReflection,
  pruneReflectionState,
  reflectionStorageKey,
  REFLECTION_CONFLICT_TOOL_NAME,
  REFLECTION_TOOL_NAME,
  serializeReflectionState,
  isLearningOrGovernanceTool,
  type ReflectionBoundary,
  type ReflectionExecutionIdentity,
  type ReflectionState,
} from "./src/reflection.ts"
import { resolveRepoLearningOptions } from "./src/config.ts"
import { createRecorder, toObservedEvent, type ObservedEvent } from "./src/recorder.ts"
import { RepoLearning, type RepoLearningCompletionInput, type RepoLearningInput } from "./src/rpc.ts"
import { loadStoredState, serializeState, type LearnState } from "./src/storage-state.ts"

const STATE_KEY = "repo-learning/observe"
const MAX_PENDING_REFLECTION_EXECUTIONS = 128
const MAX_PENDING_CODE_MODE_STARTS = 128
const MAX_PENDING_CODE_MODE_ID_LENGTH = 128

function toolEventCallID(data: Record<string, unknown>): string | undefined {
  if (typeof data.callID === "string") return data.callID
  return typeof data.id === "string" ? data.id : undefined
}

function codeModeStartIdentity(value: unknown): { sessionID: string; toolCallID: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const event = value as Record<string, unknown>
  if (event.type !== "session.tool.input.started") return undefined
  const data = typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined
  if (data?.name !== "execute" || typeof data.sessionID !== "string") return undefined
  const toolCallID = toolEventCallID(data)
  if (
    toolCallID === undefined || data.sessionID.length > MAX_PENDING_CODE_MODE_ID_LENGTH ||
    toolCallID.length > MAX_PENDING_CODE_MODE_ID_LENGTH
  ) return undefined
  return { sessionID: data.sessionID, toolCallID }
}

export function initialPluginState(value: unknown, nowMs = Date.now()): LearnState {
  return loadStoredState(value, nowMs).state
}

type SessionProject = { projectID?: string; agent?: string; location?: { directory?: string } }

export function eventSessionID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const data = (value as Record<string, unknown>).data
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
  const sessionID = (data as Record<string, unknown>).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

export function idleSessionID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const event = value as Record<string, unknown>
  const sessionID = eventSessionID(event)
  if (!sessionID) return undefined
  if (event.type === "session.idle") return sessionID
  if (event.type !== "session.status") return undefined
  const status = (event.data as Record<string, unknown>).status
  return typeof status === "object" && status !== null && !Array.isArray(status) && (status as Record<string, unknown>).type === "idle"
    ? sessionID
    : undefined
}

export function reflectionBoundary(
  value: unknown,
): { sessionID: string; boundary: ReflectionBoundary } | undefined {
  const sessionID = eventSessionID(value)
  if (!sessionID) return undefined
  const type = (value as Record<string, unknown>).type
  if (
    type === "session.execution.succeeded" || type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  ) return { sessionID, boundary: "task-boundary" }
  const idleID = idleSessionID(value)
  return idleID === undefined ? undefined : { sessionID: idleID, boundary: "idle" }
}

export async function eventBelongsToProject(
  value: unknown,
  target: { directory: string; projectID: string },
  lookup: (sessionID: string) => Promise<SessionProject>,
): Promise<boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  const data = typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined
  const eventLocation = typeof event.location === "object" && event.location !== null && !Array.isArray(event.location)
    ? event.location as Record<string, unknown>
    : undefined
  const dataLocation = typeof data?.location === "object" && data.location !== null && !Array.isArray(data.location)
    ? data.location as Record<string, unknown>
    : undefined
  const directLocation = eventLocation?.directory ?? dataLocation?.directory
  const directProject = data?.projectID
  if (typeof directLocation === "string") {
    return directLocation === target.directory && (typeof directProject !== "string" || directProject === target.projectID)
  }
  const sessionID = eventSessionID(event)
  if (!sessionID) return false
  try {
    const session = await lookup(sessionID)
    return session.projectID === target.projectID && session.location?.directory === target.directory
  } catch {
    return false
  }
}

/**
 * Reflection produces pending proposals and execution receipts only; repository
 * writes and learning promotion stay outside this plugin surface.
 */
export type RepoLearningServerContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export async function setupRepoLearningServer(ctx: RepoLearningServerContext) {
  const configuration = resolveRepoLearningOptions(ctx.options)
  const target = { directory: String(ctx.location.directory), projectID: String(ctx.location.project.id) }
  const storedValue = await ctx.storage.get(STATE_KEY)
  const loaded = loadStoredState(storedValue)
  const diagnostics = [...configuration.diagnostics, ...loaded.diagnostics]
  for (const diagnostic of diagnostics) console.warn(`[repo-learning] ${diagnostic}`)

  const recorder = createRecorder({ initialState: loaded.state, enabled: configuration.options.enabled })
  let persisted = typeof storedValue === "string" ? storedValue : undefined
  let storageWriteQueue: Promise<unknown> = Promise.resolve()
  const enqueueStorageWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const result = storageWriteQueue.then(write)
    storageWriteQueue = result.then(() => undefined, () => undefined)
    return result
  }
  let eventStreamHealthy = true
  const persist = async () => {
    if (!configuration.options.enabled) return
    await enqueueStorageWrite(async () => {
      const next = serializeState(recorder.state)
      if (next === persisted) return
      await ctx.storage.set(STATE_KEY, next)
      persisted = next
    })
  }
  if (configuration.options.enabled) await persist()

  const canonicalDirectory = String(ctx.location.project.canonical ?? ctx.location.directory)
  const repoKey = createRepositoryKey(target.projectID, canonicalDirectory)
  const reflectionKey = reflectionStorageKey(repoKey)
  const reflectionStoredValue = configuration.options.enabled ? await ctx.storage.get(reflectionKey) : undefined
  const reflectionLoaded = configuration.options.enabled
    ? loadReflectionState(reflectionStoredValue, repoKey)
    : { state: createReflectionState(repoKey), diagnostics: [], changed: false }
  let reflectionState: ReflectionState = reflectionLoaded.state
  let persistedReflection = typeof reflectionStoredValue === "string" ? reflectionStoredValue : undefined
  let reflectionStorageHealthy = reflectionLoaded.diagnostics.length === 0
  const reflectionDiagnostics = [...reflectionLoaded.diagnostics]
  diagnostics.push(...reflectionDiagnostics)
  for (const diagnostic of reflectionDiagnostics) console.warn(`[repo-learning] ${diagnostic}`)

  if (configuration.options.enabled && reflectionLoaded.changed && reflectionStorageHealthy) {
    try {
      await enqueueStorageWrite(async () => {
        const serialized = serializeReflectionState(reflectionState)
        await ctx.storage.set(reflectionKey, serialized)
        persistedReflection = serialized
      })
    } catch {
      reflectionStorageHealthy = false
      console.warn("[repo-learning] reflection state could not be persisted; completion checks will fail closed")
    }
  }

  const persistReflectionState = async (next: ReflectionState): Promise<boolean> => {
    if (!reflectionStorageHealthy) return false
    try {
      const serialized = serializeReflectionState(next)
      if (serialized !== persistedReflection) {
        await ctx.storage.set(reflectionKey, serialized)
        persistedReflection = serialized
      }
      reflectionState = next
      return true
    } catch {
      reflectionStorageHealthy = false
      throw new Error("reflection state persistence failed")
    }
  }

  const sessionBelongsToRepository = async (sessionID: string): Promise<boolean> => {
    try {
      const session = await ctx.session.get({ sessionID })
      return session.projectID === target.projectID && session.location.directory === target.directory
    } catch {
      return false
    }
  }

  const pendingReflectionExecutions = new Map<string, {
    identity: ReflectionExecutionIdentity
    resultID: string
    kind: "receipt" | "conflict-decision"
  }>()

  const learningGovernanceToolCalls = new Map<string, Set<string>>()
  const learningGovernanceExecutions = new Set<string>()
  const pendingCodeModeStarts = new Map<string, { sessionID: string; observed: ObservedEvent }>()
  const codeModeExecutionKey = (sessionID: string, toolCallID: string): string => JSON.stringify([sessionID, toolCallID])

  const flushPendingCodeModeStarts = (sessionID: string): void => {
    for (const [key, pending] of pendingCodeModeStarts) {
      if (pending.sessionID !== sessionID) continue
      pendingCodeModeStarts.delete(key)
      recorder.recordEvent(pending.observed)
    }
  }

  const markLearningGovernanceToolCall = (sessionID: string, toolCallID?: string) => {
    learningGovernanceExecutions.add(sessionID)
    if (toolCallID === undefined) return
    const calls = learningGovernanceToolCalls.get(sessionID) ?? new Set<string>()
    calls.add(toolCallID)
    learningGovernanceToolCalls.set(sessionID, calls)
  }

  const isLearningOrGovernanceEvent = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const event = value as Record<string, unknown>
    const data = typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
      ? event.data as Record<string, unknown>
      : undefined
    if (!data) return false

    const sessionID = data.sessionID
    const toolCallID = toolEventCallID(data)
    if (event.type === "session.tool.input.started" && isLearningOrGovernanceTool(data.name)) {
      if (typeof sessionID === "string") {
        markLearningGovernanceToolCall(sessionID, toolCallID)
      }
      return true
    }

    if (typeof sessionID === "string" && toolCallID !== undefined) {
      const calls = learningGovernanceToolCalls.get(sessionID)
      if (calls?.has(toolCallID)) {
        if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
          calls.delete(toolCallID)
          if (calls.size === 0) learningGovernanceToolCalls.delete(sessionID)
        }
        return true
      }
    }

    if (
      typeof sessionID === "string" &&
      (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted") &&
      learningGovernanceExecutions.delete(sessionID)
    ) {
      learningGovernanceToolCalls.delete(sessionID)
      return true
    }
    return false
  }

  const clearLearningGovernanceEvents = (sessionID: string): void => {
    learningGovernanceExecutions.delete(sessionID)
    learningGovernanceToolCalls.delete(sessionID)
  }

  const identityFrom = (value: unknown): ReflectionExecutionIdentity | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    if (
      typeof candidate.sessionID !== "string" || typeof candidate.agent !== "string" ||
      typeof candidate.messageID !== "string" || typeof candidate.id !== "string"
    ) return undefined
    return {
      sessionID: candidate.sessionID,
      agent: candidate.agent,
      messageID: candidate.messageID,
      toolCallID: candidate.id,
    }
  }

  const executionKey = (identity: ReflectionExecutionIdentity): string =>
    JSON.stringify([identity.sessionID, identity.agent, identity.messageID, identity.toolCallID])

  const sameExecution = (left: ReflectionExecutionIdentity, right: ReflectionExecutionIdentity): boolean =>
    left.sessionID === right.sessionID && left.agent === right.agent &&
    left.messageID === right.messageID && left.toolCallID === right.toolCallID

  const runLearn = async (sessionID: string, text: string): Promise<string> => {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error("learn command requires a valid session ID")
    const command = text.trim()
    const session = await ctx.session.get({ sessionID })
    if (session.projectID !== target.projectID || session.location.directory !== target.directory) {
      throw new Error("learn command requires a session in this repository")
    }
    const result = recorder.learnCommand(command)
    await persist()
    const parts = command.replace(/^\/?learn(?:\s+|$)/, "").trim().split(/\s+/).filter(Boolean)
    const readOnlyCommand = parts.length === 0 || parts[0] === "status" || parts[0] === "audit"
    const diagnosticNotice = readOnlyCommand && diagnostics.length > 0
      ? `\nDiagnostics:\n${diagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`
      : ""
    const streamNotice = configuration.options.enabled && !eventStreamHealthy
      ? "\nObservation stream unavailable; restart OpenCode."
      : ""
    return `${result.text}${diagnosticNotice}${streamNotice}`
  }

  const checkTaskCompletion = async (sessionID: string) => {
    if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error("completion check requires a valid session ID")
    if (!await sessionBelongsToRepository(sessionID)) {
      throw new Error("completion check requires a session in this repository")
    }
    if (!configuration.options.enabled) {
      return {
        enabled: false,
        ready: true,
        required: 0,
        receipted: 0,
        missingObligationIDs: [],
        conflictObligationIDs: [],
        unresolvedConflictIDs: [],
      }
    }
    return await enqueueStorageWrite(async () => {
      try {
        await persistReflectionState(pruneReflectionState(reflectionState))
      } catch {
        reflectionStorageHealthy = false
      }
      const result = checkTaskCompletionReceipts(reflectionState, sessionID)
      return { enabled: true, ...result, ready: reflectionStorageHealthy && result.ready }
    })
  }

  const rpc = await ctx.rpc.register(RepoLearning, {
    learn: async (input) => {
      const { sessionID, command } = input as RepoLearningInput
      return { text: await runLearn(sessionID, command) }
    },
    checkTaskCompletion: async (input) => {
      const { sessionID } = input as RepoLearningCompletionInput
      return checkTaskCompletion(sessionID)
    },
  })

  const registrations: Array<{ dispose: () => Promise<void> }> = []
  if (configuration.options.enabled) {
    registrations.push(await ctx.tool.transform((editor) => {
      editor.add({
        name: REFLECTION_TOOL_NAME,
        description:
          "Reflect on one pending bounded repository-learning observation. Propose one repo-relative canonical improvement or explicitly explain why no change is justified. Proposals are not applied.",
        input: {
          type: "object",
          properties: {
            obligationID: { type: "string", minLength: 1, maxLength: 80 },
            obligationDigest: { type: "string", minLength: 64, maxLength: 64 },
            proposal: {
              type: "object",
              properties: {
                path: { type: "string", minLength: 1, maxLength: 256 },
                change: { type: "string", minLength: 1, maxLength: 1024 },
              },
              required: ["path", "change"],
              additionalProperties: false,
            },
            noChangeRationale: { type: "string", minLength: 1, maxLength: 1024 },
          },
          required: ["obligationID", "obligationDigest"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await storageWriteQueue
          const prepared = prepareReflection(reflectionState, input, identityFrom(context), Date.now())
          return { content: formatUnverifiedReflectionResult(prepared) }
        },
      })
      editor.add({
        name: REFLECTION_CONFLICT_TOOL_NAME,
        description:
          "Resolve one bounded repository-learning proposal conflict by selecting a listed proposal digest or rejecting all proposals. Decisions are attributed, immutable, and never apply changes.",
        input: {
          type: "object",
          properties: {
            conflictID: { type: "string", minLength: 1, maxLength: 80 },
            conflictDigest: { type: "string", minLength: 64, maxLength: 64 },
            selectedProposalDigest: {
              anyOf: [
                { type: "string", minLength: 64, maxLength: 64 },
                { type: "null" },
              ],
            },
            rationale: { type: "string", minLength: 1, maxLength: 1024 },
          },
          required: ["conflictID", "conflictDigest", "selectedProposalDigest", "rationale"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await storageWriteQueue
          const prepared = prepareReflectionConflictDecision(reflectionState, input, identityFrom(context), Date.now())
          return { content: formatReflectionConflictDecisionResult(prepared) }
        },
      })
    }))

    registrations.push(await ctx.session.hook("context", async (event) => {
      if (!await sessionBelongsToRepository(event.sessionID)) return
      const hasCodeMode = Object.prototype.hasOwnProperty.call(event.tools, "execute")
      const hasReflectionTool = hasCodeMode || Object.prototype.hasOwnProperty.call(event.tools, REFLECTION_TOOL_NAME)
      const hasConflictTool = hasCodeMode || Object.prototype.hasOwnProperty.call(event.tools, REFLECTION_CONFLICT_TOOL_NAME)
      if (!hasReflectionTool && !hasConflictTool) return
      let obligations: ReturnType<typeof outstandingReflectionObligations> = []
      let conflicts: ReturnType<typeof outstandingReflectionConflicts> = []
      try {
        const visible = await enqueueStorageWrite(async (): Promise<[
          ReturnType<typeof outstandingReflectionObligations>,
          ReturnType<typeof outstandingReflectionConflicts>,
        ]> => {
          if (!reflectionStorageHealthy) return [[], []]
          if (!await persistReflectionState(pruneReflectionState(reflectionState))) return [[], []]
          return [
            hasReflectionTool ? outstandingReflectionObligations(reflectionState, event.sessionID) : [],
            hasConflictTool ? outstandingReflectionConflicts(reflectionState, event.sessionID) : [],
          ]
        })
        obligations = visible[0]
        conflicts = visible[1]
      } catch {
        reflectionStorageHealthy = false
        console.warn("[repo-learning] reflection context could not be refreshed")
        return
      }
      if (obligations.length === 0 && conflicts.length === 0) return
      event.system.push({ type: "text", text: buildUntrustedReflectionContext(obligations, conflicts) })
    }))

    registrations.push(await ctx.tool.hook("execute.before", async (event) => {
      const identity = identityFrom(event)
      if (event.tool === "execute") {
        const input = typeof event.input === "object" && event.input !== null && !Array.isArray(event.input)
          ? event.input as Record<string, unknown>
          : undefined
        if (!identity || !await sessionBelongsToRepository(identity.sessionID)) return
        const key = codeModeExecutionKey(identity.sessionID, identity.toolCallID)
        const pending = pendingCodeModeStarts.get(key)
        pendingCodeModeStarts.delete(key)
        if (isPureGovernanceCodeModeCall(input?.code)) markLearningGovernanceToolCall(identity.sessionID, identity.toolCallID)
        else if (pending) recorder.recordEvent(pending.observed)
        return
      }
      if (event.tool !== REFLECTION_TOOL_NAME && event.tool !== REFLECTION_CONFLICT_TOOL_NAME) return
      if (!identity || !await sessionBelongsToRepository(identity.sessionID)) return
      await enqueueStorageWrite(async () => {
        if (!reflectionStorageHealthy) return
        if (!await persistReflectionState(pruneReflectionState(reflectionState))) return
        const key = executionKey(identity)
        if (!pendingReflectionExecutions.has(key) && pendingReflectionExecutions.size >= MAX_PENDING_REFLECTION_EXECUTIONS) return
        if (event.tool === REFLECTION_TOOL_NAME) {
          const prepared = prepareReflection(reflectionState, event.input, identity, Date.now())
          if (!prepared.accepted) return
          pendingReflectionExecutions.set(key, { identity, kind: "receipt", resultID: prepared.receipt.id })
          return
        }
        const prepared = prepareReflectionConflictDecision(reflectionState, event.input, identity, Date.now())
        if (!prepared.accepted) return
        pendingReflectionExecutions.set(key, { identity, kind: "conflict-decision", resultID: prepared.decision.id })
      })
    }))

    registrations.push(await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== REFLECTION_TOOL_NAME && event.tool !== REFLECTION_CONFLICT_TOOL_NAME) return
      const identity = identityFrom(event)
      if (!identity) return
      const key = executionKey(identity)
      const pending = pendingReflectionExecutions.get(key)
      pendingReflectionExecutions.delete(key)
      if (!pending || event.status !== "completed" || !sameExecution(pending.identity, identity)) return
      if (!await sessionBelongsToRepository(identity.sessionID)) return

      try {
        const verified = await enqueueStorageWrite(async () => {
          if (!reflectionStorageHealthy) return undefined
          if (!await persistReflectionState(pruneReflectionState(reflectionState))) return undefined
          if (pending.kind === "receipt") {
            if (event.tool !== REFLECTION_TOOL_NAME) return undefined
            const prepared = prepareReflection(reflectionState, event.input, identity, Date.now())
            if (!prepared.accepted || prepared.receipt.id !== pending.resultID) return undefined
            const next = addVerifiedReceipt(reflectionState, prepared.receipt)
            if (!next.added || !await persistReflectionState(next.state)) return undefined
            return { kind: "receipt" as const, prepared }
          }
          if (event.tool !== REFLECTION_CONFLICT_TOOL_NAME) return undefined
          const prepared = prepareReflectionConflictDecision(reflectionState, event.input, identity, Date.now())
          if (!prepared.accepted || prepared.decision.id !== pending.resultID) return undefined
          const next = addVerifiedConflictDecision(reflectionState, prepared.decision)
          if (!next.added || !await persistReflectionState(next.state)) return undefined
          return { kind: "conflict-decision" as const, prepared }
        })
        if (verified?.kind === "receipt") {
          event.result = { ...event.result, content: formatReflectionResult(verified.prepared) }
        } else if (verified?.kind === "conflict-decision") {
          event.result = { ...event.result, content: formatReflectionConflictDecisionResult(verified.prepared, true) }
        }
      } catch {
        reflectionStorageHealthy = false
        console.warn("[repo-learning] verified reflection result could not be persisted")
      }
    }))
  }

  const controller = configuration.options.enabled ? new AbortController() : undefined
  let eventStreamTask: Promise<void> | undefined
  if (controller) {
    eventStreamTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!await eventBelongsToProject(event, target, (id) => ctx.session.get({ sessionID: id }))) continue
          const boundary = reflectionBoundary(event)
          if (boundary) flushPendingCodeModeStarts(boundary.sessionID)
          if (!isLearningOrGovernanceEvent(event)) {
            const observed = toObservedEvent(event)
            if (observed !== undefined) {
              const start = codeModeStartIdentity(event)
              if (start === undefined) recorder.recordEvent(observed)
              else {
                const key = codeModeExecutionKey(start.sessionID, start.toolCallID)
                if (pendingCodeModeStarts.size < MAX_PENDING_CODE_MODE_STARTS || pendingCodeModeStarts.has(key)) {
                  pendingCodeModeStarts.set(key, { sessionID: start.sessionID, observed })
                } else {
                  // ponytail: over-cap starts are recorded; add per-session queues if real concurrency exceeds this cap.
                  recorder.recordEvent(observed)
                }
              }
            }
          }
          if (!boundary) continue
          clearLearningGovernanceEvents(boundary.sessionID)
          const episode = recorder.flushSession(boundary.sessionID)
          if (!episode) continue
          await persist()
          const rawEvent = event as { created?: unknown }
          const createdAt = typeof rawEvent.created === "number" && Number.isSafeInteger(rawEvent.created) && rawEvent.created >= 0
            ? rawEvent.created
            : Date.now()
          await enqueueStorageWrite(async () => {
            if (!reflectionStorageHealthy) return
            const added = addReflectionObligation(reflectionState, {
              episode,
              boundary: boundary.boundary,
              createdAt,
            })
            if (added.added) {
              await persistReflectionState(added.state)
              return
            }
            if (serializeReflectionState(added.state) !== persistedReflection) {
              await persistReflectionState(added.state)
            }
            if (added.reason && added.reason !== "not-meaningful" && added.reason !== "governance-only") {
              reflectionStorageHealthy = false
              console.warn(`[repo-learning] reflection obligation was not recorded (${added.reason}); completion checks will fail closed`)
            }
          })
        }
      } catch {
        if (!controller.signal.aborted) {
          eventStreamHealthy = false
          reflectionStorageHealthy = false
        }
      }
    })()
  }

  return async () => {
    controller?.abort()
    await eventStreamTask
    await rpc.dispose()
    for (const registration of registrations.reverse()) await registration.dispose()
    await persist()
    await storageWriteQueue
  }
}

export default Plugin.define({
  id: "opencode-rig.repo-learning",
  setup: setupRepoLearningServer,
})
