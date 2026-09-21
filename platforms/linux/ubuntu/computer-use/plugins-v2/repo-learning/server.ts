import { Plugin } from "@opencode/plugin"

import { createRecorder, observationNotice, toObservedEvent } from "./src/recorder.ts"
import { RepoLearning, type RepoLearningInput } from "./src/rpc.ts"
import { createInitialState, parseState, serializeState, type LearnState } from "./src/storage-state.ts"

const STATE_KEY = "repo-learning/observe"

export function initialPluginState(value: unknown, nowMs = Date.now()): LearnState {
  if (typeof value !== "string") return createInitialState()
  try {
    return parseState(value, nowMs)
  } catch {
    return createInitialState()
  }
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
 * The active surface is limited to bounded metadata observation and read-only
 * status/audit output. Synthesis, promotion, retrieval, and optimization are
 * intentionally not registered.
 */
export default Plugin.define({
  id: "opencode-rig.repo-learning",
  async setup(ctx) {
    const target = { directory: String(ctx.location.directory), projectID: String(ctx.location.project.id) }
    const recorder = createRecorder({ initialState: initialPluginState(await ctx.storage.get(STATE_KEY)) })
    let persisted = ""
    let eventStreamHealthy = true
    const persist = async () => {
      const next = serializeState(recorder.state)
      if (next === persisted) return
      await ctx.storage.set(STATE_KEY, next)
      persisted = next
    }
    await persist()

    const runLearn = async (sessionID: string, text: string): Promise<string> => {
      if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error("learn command requires a valid session ID")
      const command = text.trim()
      const confirming = /^(?:\/?learn\s+)?(?:pause|resume)\s+\S+\s*$/.test(command)
      const mutating = /^(?:\/?learn\s+)?(?:pause|resume)(?:\s|$)/.test(command)
      const session = await ctx.session.get({ sessionID })
      if (session.projectID !== target.projectID || session.location.directory !== target.directory) {
        throw new Error("learn command requires a session in this repository")
      }
      let agentID = "read-only"
      if (mutating) {
        if (typeof session.agent !== "string") {
          throw new Error("learn pause/resume requires a session in this repository with a known agent")
        }
        agentID = session.agent
      }
      const result = recorder.learnCommand(command, {
        sessionID,
        agentID,
        approval: confirming,
      })
      await persist()
      const activeNotice = result.mutated && !recorder.state.paused ? `\n${observationNotice().status}` : ""
      const streamNotice = eventStreamHealthy ? "" : "\nObservation stream unavailable; restart OpenCode."
      return `${result.text}${activeNotice}${streamNotice}`
    }

    const rpc = await ctx.rpc.register(RepoLearning, {
      learn: async (input) => {
        const { sessionID, command } = input as RepoLearningInput
        return { text: await runLearn(sessionID, command) }
      },
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (!await eventBelongsToProject(event, target, (sessionID) => ctx.session.get({ sessionID }))) continue
          const observed = toObservedEvent(event)
          if (observed !== undefined) recorder.recordEvent(observed)
          const idle = idleSessionID(event)
          if (idle && recorder.flushSession(idle) !== undefined) await persist()
        }
      } catch {
        if (!controller.signal.aborted) eventStreamHealthy = false
      }
    })()

    return async () => {
      controller.abort()
      await rpc.dispose()
      await persist()
    }
  },
})
