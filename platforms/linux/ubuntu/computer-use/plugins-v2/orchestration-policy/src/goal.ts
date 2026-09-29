import { randomUUID } from "node:crypto"

const SESSION_ID = /^ses_[A-Za-z0-9]+$/
const MAX_OBJECTIVE = 2_000
const MAX_CRITERIA = 16
const MAX_CRITERION = 500
const MAX_PLAN = 8_000
const MAX_EVIDENCE = 2_000
const MAX_BLOCKED_RETRIES = 3
const BLOCKED_RETRY_EXHAUSTED = "Automatic recovery stopped after repeated transient failures; run /goal resume to retry."
export const GOAL_STORAGE_PREFIX = "goal/session/"
const GOAL_KEY = GOAL_STORAGE_PREFIX
const GOAL_PROMPT_MARKER = /^<open-rig-goal-prompt token=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>\n/

export type GoalHandoffMode = "manual" | "auto"
export type GoalStatus = "awaiting-plan" | "awaiting-build" | "active" | "paused" | "blocked" | "complete" | "cleared" | "corrupt"

export type GoalRecord = {
  version: 1
  sessionID: string
  revision: number
  handoff: GoalHandoffMode
  status: GoalStatus
  originalObjective?: string
  acceptanceCriteria: string[]
  plan?: string
  source?: "manual" | "plan"
  planReady: boolean
  planExecutionID?: string
  planSucceeded: boolean
  firstBuildPromptSent: boolean
  pendingAction?: { kind: "start" | "resume" | "progress"; executionID?: string; eligible?: boolean }
  queuedPrompt?: { token: string; inboxID?: string; kind: "start" | "resume" | "plan" | "continue"; consumed?: boolean }
  evidence?: string
  completionEvidence?: string[]
  blockedReason?: string
  blockedRetry?: { kind: "start" | "resume" | "plan" | "continue"; attempts: number }
  pausedStatus?: Exclude<GoalStatus, "paused" | "corrupt" | "complete" | "cleared">
}

export type PlanReadyInput = { objective: string; acceptanceCriteria: readonly string[]; plan: string }
export type GoalReportInput = {
  status: "progress" | "blocked" | "complete"
  evidence: string
  acceptanceEvidence?: readonly string[]
}

type GoalSession = {
  id: string
  projectID: string
  parentID?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  outcome?: "succeeded" | "failed" | "interrupted"
}

type GoalStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

type GoalDependencies = {
  storage: GoalStorage
  onStateChange?: (sessionID: string) => Promise<void> | void
  getSession(sessionID: string): Promise<GoalSession>
  waitForIdle(sessionID: string, signal?: AbortSignal): Promise<void>
  buildAgentAvailable(): Promise<boolean>
  switchAgent(sessionID: string, agent: string): Promise<void>
  switchModel(sessionID: string, model: NonNullable<GoalSession["model"]>): Promise<void>
  prompt(sessionID: string, text: string, delivery?: "steer" | "queue"): Promise<{ id: string }>
  taskIncomplete(sessionID: string): Promise<boolean>
  requireDispatch?: (sessionID: string) => Promise<void>
}

type Runtime = {
  status?: "busy" | "idle"
  statusRevision: number
  outcome?: "running" | "succeeded" | "failed" | "interrupted"
  executionID?: string
  lastIdleEventID?: string
  inbox: Map<string, { user: boolean; queued: boolean }>
  cancelled: Set<string>
  handled: Set<string>
  inFlight: boolean
  waitingExecutionID?: string
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string up to ${maximum} characters`)
  }
  return value.trim()
}

function initial(sessionID: string): GoalRecord {
  return {
    version: 1,
    sessionID,
    revision: 0,
    handoff: "manual",
    status: "cleared",
    acceptanceCriteria: [],
    planReady: false,
    planSucceeded: false,
    firstBuildPromptSent: false,
  }
}

function clone(record: GoalRecord): GoalRecord {
  return {
    ...record,
    acceptanceCriteria: [...record.acceptanceCriteria],
    ...(record.completionEvidence ? { completionEvidence: [...record.completionEvidence] } : {}),
    ...(record.pendingAction ? { pendingAction: { ...record.pendingAction } } : {}),
    ...(record.blockedRetry ? { blockedRetry: { ...record.blockedRetry } } : {}),
    ...(record.queuedPrompt ? { queuedPrompt: { ...record.queuedPrompt } } : {}),
  }
}

function reset(draft: GoalRecord, sessionID: string, handoff: GoalHandoffMode) {
  const revision = draft.revision
  for (const key of [
    "originalObjective", "plan", "source", "planExecutionID", "pendingAction", "queuedPrompt", "evidence",
    "completionEvidence", "blockedReason", "blockedRetry", "pausedStatus",
  ] as const) delete draft[key]
  Object.assign(draft, initial(sessionID), { revision, handoff })
}

function restored(value: unknown, sessionID: string): GoalRecord {
  const entry = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
  const statuses: readonly string[] = ["awaiting-plan", "awaiting-build", "active", "paused", "blocked", "complete", "cleared"]
  if (
    entry?.version !== 1 || entry.sessionID !== sessionID || !Number.isSafeInteger(entry.revision) ||
    (entry.revision as number) < 0 || (entry.handoff !== "manual" && entry.handoff !== "auto") ||
    typeof entry.status !== "string" || !statuses.includes(entry.status) || !Array.isArray(entry.acceptanceCriteria) ||
    entry.acceptanceCriteria.length > MAX_CRITERIA ||
    entry.acceptanceCriteria.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_CRITERION) ||
    typeof entry.planReady !== "boolean" || typeof entry.planSucceeded !== "boolean" ||
    typeof entry.firstBuildPromptSent !== "boolean" ||
    (entry.planExecutionID !== undefined && (typeof entry.planExecutionID !== "string" || !entry.planExecutionID || entry.planExecutionID.length > 128)) ||
    (entry.originalObjective !== undefined && (typeof entry.originalObjective !== "string" || !entry.originalObjective.trim() || entry.originalObjective.length > MAX_OBJECTIVE)) ||
    (entry.plan !== undefined && (typeof entry.plan !== "string" || !entry.plan.trim() || entry.plan.length > MAX_PLAN)) ||
    (entry.source !== undefined && entry.source !== "manual" && entry.source !== "plan") ||
    (entry.evidence !== undefined && (typeof entry.evidence !== "string" || !entry.evidence.trim() || entry.evidence.length > MAX_EVIDENCE)) ||
    (entry.blockedReason !== undefined && (typeof entry.blockedReason !== "string" || !entry.blockedReason.trim() || entry.blockedReason.length > 300)) ||
    (entry.completionEvidence !== undefined && (!Array.isArray(entry.completionEvidence) || entry.completionEvidence.length > MAX_CRITERIA ||
      entry.completionEvidence.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_EVIDENCE)))
  ) return { ...initial(sessionID), status: "corrupt" }

  const pending = entry.pendingAction as Record<string, unknown> | undefined
  if (entry.pendingAction !== undefined && (!pending || typeof pending !== "object" || Array.isArray(pending) ||
    (pending.kind !== "start" && pending.kind !== "resume" && pending.kind !== "progress") ||
    Object.keys(pending).some((key) => key !== "kind" && key !== "executionID" && key !== "eligible") ||
    (pending.executionID !== undefined && (typeof pending.executionID !== "string" || !pending.executionID || pending.executionID.length > 128)) ||
    (pending.eligible !== undefined && typeof pending.eligible !== "boolean") ||
    (pending.kind === "progress" && (typeof pending.executionID !== "string" || typeof pending.eligible !== "boolean")) ||
    (pending.kind !== "progress" && (pending.executionID !== undefined || pending.eligible !== undefined)))) {
    return { ...initial(sessionID), status: "corrupt" }
  }

  const queued = entry.queuedPrompt as Record<string, unknown> | undefined
  if (entry.queuedPrompt !== undefined && (!queued || typeof queued !== "object" || Array.isArray(queued) ||
    typeof queued.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(queued.token) ||
    Object.keys(queued).some((key) => key !== "token" && key !== "inboxID" && key !== "kind" && key !== "consumed") ||
    (queued.consumed !== undefined && typeof queued.consumed !== "boolean") ||
    (queued.inboxID !== undefined && (typeof queued.inboxID !== "string" || !queued.inboxID.startsWith("msg_") || queued.inboxID.length > 128)))) {
    return { ...initial(sessionID), status: "corrupt" }
  }
  if (queued && (typeof queued.token !== "string" || !/^[0-9a-f-]{36}$/.test(queued.token) ||
    (queued.inboxID !== undefined && (typeof queued.inboxID !== "string" || !queued.inboxID || queued.inboxID.length > 128)) ||
    !(["start", "resume", "plan", "continue"] as unknown[]).includes(queued.kind))) return { ...initial(sessionID), status: "corrupt" }

  const blockedRetry = entry.blockedRetry as Record<string, unknown> | undefined
  if (entry.blockedRetry !== undefined && (!blockedRetry || typeof blockedRetry !== "object" || Array.isArray(blockedRetry) ||
    (blockedRetry.kind !== "start" && blockedRetry.kind !== "resume" && blockedRetry.kind !== "plan" && blockedRetry.kind !== "continue") ||
    !Number.isSafeInteger(blockedRetry.attempts) || (blockedRetry.attempts as number) < 1 ||
    (blockedRetry.attempts as number) >= MAX_BLOCKED_RETRIES ||
    Object.keys(blockedRetry).some((key) => key !== "kind" && key !== "attempts"))) {
    return { ...initial(sessionID), status: "corrupt" }
  }

  const pausedStatus = entry.pausedStatus
  if (
    (entry.planReady && (entry.source !== "plan" || !entry.originalObjective || !entry.plan || !entry.planExecutionID ||
      !Array.isArray(entry.acceptanceCriteria) || entry.acceptanceCriteria.length === 0)) ||
    (entry.status !== "cleared" && !entry.originalObjective) ||
    (!entry.planReady && (entry.plan !== undefined || entry.planExecutionID !== undefined || entry.acceptanceCriteria.length > 0)) ||
    (entry.planSucceeded && !entry.planReady) ||
    (pending !== undefined && entry.status !== "active") ||
    (queued !== undefined && entry.status !== "active") ||
    (entry.status === "paused" && pausedStatus === undefined) ||
    (entry.status !== "paused" && pausedStatus !== undefined) ||
    (entry.status === "complete" && (!Array.isArray(entry.completionEvidence) || entry.completionEvidence.length === 0)) ||
    (entry.status !== "complete" && entry.completionEvidence !== undefined) ||
    (entry.firstBuildPromptSent && !entry.originalObjective)
  ) return { ...initial(sessionID), status: "corrupt" }
  if (pausedStatus !== undefined && !(["awaiting-plan", "awaiting-build", "active", "blocked"] as unknown[]).includes(pausedStatus)) {
    return { ...initial(sessionID), status: "corrupt" }
  }

  return {
    version: 1,
    sessionID,
    revision: entry.revision as number,
    handoff: entry.handoff,
    status: entry.status as GoalStatus,
    ...(typeof entry.originalObjective === "string" ? { originalObjective: entry.originalObjective } : {}),
    acceptanceCriteria: [...entry.acceptanceCriteria as string[]],
    ...(typeof entry.plan === "string" ? { plan: entry.plan } : {}),
    ...(entry.source === "manual" || entry.source === "plan" ? { source: entry.source } : {}),
    planReady: entry.planReady,
    ...(typeof entry.planExecutionID === "string" ? { planExecutionID: entry.planExecutionID } : {}),
    planSucceeded: entry.planSucceeded,
    firstBuildPromptSent: entry.firstBuildPromptSent,
    ...(pending ? { pendingAction: { ...pending } as GoalRecord["pendingAction"] } : {}),
    ...(queued ? { queuedPrompt: { ...queued } as GoalRecord["queuedPrompt"] } : {}),
    ...(typeof entry.evidence === "string" ? { evidence: entry.evidence } : {}),
    ...(Array.isArray(entry.completionEvidence) ? { completionEvidence: [...entry.completionEvidence as string[]] } : {}),
    ...(typeof entry.blockedReason === "string" ? { blockedReason: entry.blockedReason.slice(0, 300) } : {}),
    ...(blockedRetry ? { blockedRetry: { ...blockedRetry } as GoalRecord["blockedRetry"] } : {}),
    ...(typeof pausedStatus === "string" ? { pausedStatus: pausedStatus as GoalRecord["pausedStatus"] } : {}),
  }
}

function createStorage(storage: GoalStorage, onStateChange?: GoalDependencies["onStateChange"]) {
  const cache = new Map<string, GoalRecord>()
  const lanes = new Map<string, Promise<void>>()

  function serial<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
    const previous = lanes.get(sessionID) ?? Promise.resolve()
    const current = previous.then(action, action)
    const tail = current.then(() => undefined, () => undefined)
    lanes.set(sessionID, tail)
    void tail.then(() => {
      if (lanes.get(sessionID) === tail) lanes.delete(sessionID)
    })
    return current
  }

  const read = (sessionID: string) => serial(sessionID, async () => {
    const known = cache.get(sessionID)
    if (known) return clone(known)
    const value = await storage.get(`${GOAL_KEY}${sessionID}`)
    const next = value === undefined ? initial(sessionID) : restored(value, sessionID)
    cache.set(sessionID, next)
    return clone(next)
  })

  const mutate = (sessionID: string, change: (draft: GoalRecord) => boolean) => serial(sessionID, async () => {
    const known = cache.get(sessionID)
    const value = known ? undefined : await storage.get(`${GOAL_KEY}${sessionID}`)
    const current = known ? clone(known) : value === undefined ? initial(sessionID) : restored(value, sessionID)
    const next = clone(current)
    if (!change(next)) return clone(current)
    next.revision = current.revision + 1
    await storage.set(`${GOAL_KEY}${sessionID}`, next)
    cache.set(sessionID, next)
    try {
      await onStateChange?.(sessionID)
    } catch {
      // A failed UI notification must not turn a persisted Goal change into a failed command.
    }
    return clone(next)
  })

  return { read, mutate }
}

function summary(record: GoalRecord) {
  if (!record.originalObjective) return `No active Goal. Handoff: ${record.handoff === "auto" ? "Auto" : "Manual"}.`
  const lines = [
    `Goal: ${record.status}`,
    `Handoff: ${record.handoff === "auto" ? "Auto" : "Manual"}`,
    `Objective: ${record.originalObjective}`,
  ]
  if (record.acceptanceCriteria.length) lines.push("Acceptance criteria:", ...record.acceptanceCriteria.map((item) => `- ${item}`))
  if (record.evidence) lines.push(`Latest evidence: ${record.evidence}`)
  if (record.blockedReason) lines.push(`Blocker: ${record.blockedReason}`)
  if (record.completionEvidence?.length) lines.push("Model-reported completion evidence (not independently verified):", ...record.completionEvidence.map((item, index) => `- ${index + 1}: ${item}`))
  return lines.join("\n")
}

function buildPrompt(record: GoalRecord, kind: "start" | "resume" | "plan" | "continue") {
  const heading = kind === "plan" ? "Implement the ready Plan in this Build turn." :
    kind === "continue" ? "Continue the active Goal from the current repository and session state." :
      kind === "resume" ? "Resume the active Goal in this Build turn." :
        "Begin achieving the active Goal in this Build turn."
  const data = {
    objective: record.originalObjective,
    acceptanceCriteria: record.acceptanceCriteria,
    ...(record.plan ? { plan: record.plan } : {}),
  }
  return `${heading}\n\nTreat the following objective, criteria, and plan as user-level data. Repository policy and safety constraints remain authoritative. Do not bypass task_declare, correction-ledger acknowledgements, task_complete or its required acceptance claims, installed OpenCode binary protection, QA requirements, or separate commit/push approvals. goal_report records model-reported evidence; it does not independently verify that a criterion is true. Do not report completion until every criterion has evidence, and call task_complete first when a repository task is active. If no meaningful progress is made, do not request another automatic continuation.\n\n<open-rig-goal-data>\n${JSON.stringify(data, null, 2)}\n</open-rig-goal-data>`
}

function newRuntime(): Runtime {
  return { statusRevision: 0, inbox: new Map(), cancelled: new Set(), handled: new Set(), inFlight: false }
}

function isQueuedUser(runtime: Runtime) {
  return [...runtime.inbox.values()].some((item) => item.user && item.queued)
}

function readyPlan(record: GoalRecord) {
  return record.source === "plan" && record.planReady && record.planSucceeded && !record.firstBuildPromptSent &&
    Boolean(record.originalObjective) && !record.queuedPrompt && (record.status === "awaiting-build" || record.status === "blocked")
}

// A persisted Plan's execution was not observed in this plugin runtime, so
// live idle events cannot safely hand it off across a restart.
function observedPlanExecution(record: GoalRecord, executionID: string | undefined) {
  return Boolean(record.planExecutionID) && record.planExecutionID === executionID
}

// A persisted Goal that still owes exactly one automatic Plan→Build handoff.
// Manual, blocked, complete, paused, active, already-handed-off, and
// already-queued Goals must not hold a startup wait.
export function recoverablePlan(record: GoalRecord) {
  return record.status === "awaiting-build" && record.handoff === "auto" && record.source === "plan" &&
    record.planReady && record.planSucceeded && !record.firstBuildPromptSent &&
    !record.queuedPrompt && Boolean(record.originalObjective) && Boolean(record.planExecutionID)
}

// Validate a raw persisted storage value before opening any wait for it, so a
// malformed or foreign record can never qualify for startup recovery.
export function recoverableStoredGoal(value: unknown, sessionID: string) {
  return recoverablePlan(restored(value, sessionID))
}

export function assertPlanParent(session: Pick<GoalSession, "agent" | "parentID">) {
  if (session.agent !== "plan" || session.parentID) throw new Error("plan_ready is available only to a top-level Plan session")
}

export function createGoalManager(dependencies: GoalDependencies) {
  const storage = createStorage(dependencies.storage, dependencies.onStateChange)
  const runtimes = new Map<string, Runtime>()
  const locks = new Map<string, Promise<void>>()

  const runtime = (sessionID: string) => {
    let current = runtimes.get(sessionID)
    if (!current) {
      current = newRuntime()
      runtimes.set(sessionID, current)
    }
    return current
  }

  async function refreshIdleSession(sessionID: string) {
    const current = runtime(sessionID)
    const session = await dependencies.getSession(sessionID)
    if (!SESSION_ID.test(sessionID) || session.id !== sessionID) return undefined
    if (current.status !== "idle" || isQueuedUser(current)) return undefined
    return session
  }

  async function confirmIdle(sessionID: string, signal?: AbortSignal) {
    const current = runtime(sessionID)
    const statusRevision = current.statusRevision
    await dependencies.waitForIdle(sessionID, signal)
    if (current.statusRevision === statusRevision) {
      current.status = "idle"
      current.statusRevision++
      current.lastIdleEventID = `wait:${current.executionID ?? statusRevision}`
    }
    return current.status === "idle" && !isQueuedUser(current)
  }

  async function locked<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
    const previous = locks.get(sessionID) ?? Promise.resolve()
    const current = previous.then(action, action)
    const tail = current.then(() => undefined, () => undefined)
    locks.set(sessionID, tail)
    void tail.then(() => {
      if (locks.get(sessionID) === tail) locks.delete(sessionID)
    })
    return current
  }

  async function queuePrompt(sessionID: string, kind: "start" | "resume" | "plan" | "continue", record: GoalRecord, delivery: "steer" | "queue" = "steer") {
    const target = runtime(sessionID)
    const ready = await refreshIdleSession(sessionID)
    if (!ready || ready.agent !== "build") return ""
    const token = randomUUID()
    const markedPrompt = `<open-rig-goal-prompt token=${token}>\n${buildPrompt(record, kind)}`
    const queued = await storage.mutate(sessionID, (draft) => {
      if ((draft.status !== "active" && draft.status !== "awaiting-build") || draft.queuedPrompt) return false
      draft.status = "active"
      draft.queuedPrompt = { token, kind }
      draft.blockedRetry = undefined
      return true
    })
    if (queued.queuedPrompt?.token !== token) return ""
    try {
      const latest = await refreshIdleSession(sessionID)
      if (!latest || latest.agent !== "build") {
        await storage.mutate(sessionID, (draft) => {
          if (draft.queuedPrompt?.token !== token) return false
          draft.queuedPrompt = undefined
          draft.status = record.status
          draft.pendingAction = record.pendingAction ? { ...record.pendingAction } : undefined
          draft.firstBuildPromptSent = record.firstBuildPromptSent
          return true
        })
        return ""
      }
      const inbox = await dependencies.prompt(sessionID, markedPrompt, delivery)
      let saved = false
      await storage.mutate(sessionID, (draft) => {
        if (draft.queuedPrompt?.token !== token) return false
        saved = true
        draft.pendingAction = undefined
        draft.firstBuildPromptSent = true
        if (target.cancelled.has(inbox.id)) {
          draft.queuedPrompt = undefined
          if (draft.status === "active") {
            draft.status = "blocked"
            draft.blockedReason = "The queued Goal prompt was cancelled; run /goal resume to retry."
            draft.blockedRetry = undefined
          }
        } else if (draft.queuedPrompt.consumed) draft.queuedPrompt = undefined
        else draft.queuedPrompt.inboxID = inbox.id
        return true
      })
      if (!saved) return ""
      if (target.cancelled.has(inbox.id)) {
        await storage.mutate(sessionID, (draft) => {
          if ((draft.status !== "active" && draft.status !== "awaiting-build") ||
            (draft.queuedPrompt && draft.queuedPrompt.token !== token)) return false
          draft.queuedPrompt = undefined
          draft.pendingAction = undefined
          draft.status = "blocked"
          draft.blockedReason = "The queued Goal prompt was cancelled; run /goal resume to retry."
          draft.blockedRetry = undefined
          return true
        })
        return ""
      }
      return inbox.id
    } catch {
      await storage.mutate(sessionID, (draft) => {
        if (draft.queuedPrompt?.token !== token) return false
        draft.queuedPrompt = undefined
        draft.status = "blocked"
        draft.blockedReason = "OpenCode could not queue the Goal prompt; run /goal resume to retry."
        draft.pendingAction = undefined
        draft.blockedRetry = undefined
        if (kind === "plan") draft.firstBuildPromptSent = false
        return true
      })
      return ""
    }
  }

  async function switchToBuild(sessionID: string, session: GoalSession) {
    if (session.agent === "build") return session
    assertPlanParent(session)
    if (!(await dependencies.buildAgentAvailable())) throw new Error("Build agent is not configured")
    const selectedModel = session.model
    await dependencies.switchAgent(sessionID, "build")
    if (selectedModel) {
      try {
        await dependencies.switchModel(sessionID, selectedModel)
      } catch {
        // Keep Build's configured model when the prior Plan selection is no longer valid.
      }
    }
    const current = await dependencies.getSession(sessionID)
    if (current.agent !== "build") throw new Error("session agent did not switch to Build")
    return current
  }

  async function startPlanBuild(sessionID: string, signal?: AbortSignal) {
    const before = await storage.read(sessionID)
    if (!readyPlan(before)) throw new Error("there is no successful ready Plan awaiting Build")
    const current = runtime(sessionID)
    if (current.inFlight || isQueuedUser(current)) throw new Error("Build cannot start while the session has queued user input")
    const session = await dependencies.getSession(sessionID)
    if (session.agent !== "plan" && session.agent !== "build") throw new Error("the server session must be Plan or Build to start this handoff")
    if (session.agent === "plan") assertPlanParent(session)

    if (!(await confirmIdle(sessionID, signal))) throw new Error("Build cannot start while the session has queued user input")

    return locked(sessionID, async () => {
      let goal = await storage.read(sessionID)
      if (!readyPlan(goal)) throw new Error("the ready Plan changed before Build could start")
      const latest = await dependencies.getSession(sessionID)
      if (current.status !== "idle" || isQueuedUser(current)) {
        throw new Error("Build cannot start while the session has queued user input")
      }
      if (latest.agent !== "build") await switchToBuild(sessionID, latest)
      const switched = await dependencies.getSession(sessionID)
      if (switched.agent !== "build") throw new Error("session agent did not switch to Build")
      if (current.status !== "idle" || isQueuedUser(current)) {
        throw new Error("Build cannot start while the session has queued user input")
      }
      if (goal.status === "blocked") {
        goal = await storage.mutate(sessionID, (draft) => {
          if (!readyPlan(draft) || draft.status !== "blocked") return false
          draft.status = "awaiting-build"
          draft.blockedReason = undefined
          draft.blockedRetry = undefined
          return true
        })
      }
      const inboxID = await queuePrompt(sessionID, "plan", goal)
      if (!inboxID) throw new Error("Build handoff could not be queued; run /goal build again when the session is idle")
      return { text: `${summary(await storage.read(sessionID))}\nBuild handoff queued.` }
    })
  }

  async function driveIdle(sessionID: string, delivery: "steer" | "queue" = "steer") {
    return locked(sessionID, async () => {
      const currentRuntime = runtime(sessionID)
      if (currentRuntime.inFlight) return ""
      let session = await refreshIdleSession(sessionID)
      if (!session) return ""
      let goal = await storage.read(sessionID)

      let kind: "start" | "resume" | "plan" | "continue" | undefined
      let switchAgentToBuild = false
      if (goal.status === "awaiting-build" && goal.planReady && goal.planSucceeded && goal.handoff === "auto" &&
        observedPlanExecution(goal, currentRuntime.executionID) && session.agent === "plan") {
        kind = "plan"
        switchAgentToBuild = true
      } else if (goal.status === "awaiting-build" && session.agent === "build" && goal.source === "plan" &&
        goal.planReady && goal.planSucceeded && goal.handoff === "auto" &&
        observedPlanExecution(goal, currentRuntime.executionID)) {
        kind = "plan"
      } else if (goal.status === "awaiting-build" && session.agent === "build" && goal.source === "manual") {
        kind = "start"
      } else if (goal.status === "active" && session.agent === "build" && goal.source === "plan" &&
        goal.planReady && goal.planSucceeded && goal.handoff === "auto" && !goal.firstBuildPromptSent &&
        observedPlanExecution(goal, currentRuntime.executionID)) {
        kind = "plan"
      } else if (goal.status === "active" && session.agent === "build" &&
        (goal.pendingAction?.kind === "start" || goal.pendingAction?.kind === "resume")) {
        kind = goal.pendingAction.kind
      } else if (goal.status === "active" && session.agent === "build" && goal.pendingAction?.kind === "progress" &&
        goal.pendingAction.eligible === true) {
        kind = "continue"
      } else if (goal.status === "blocked" && goal.handoff === "auto" && session.agent === "build" &&
        goal.blockedRetry !== undefined && goal.blockedRetry.attempts < MAX_BLOCKED_RETRIES) {
        kind = goal.blockedRetry.kind
      }
      if (!kind || goal.queuedPrompt) return ""
      const retryKind = kind
      if (kind === "continue") {
        try {
          await dependencies.requireDispatch?.(sessionID)
        } catch (error) {
          await storage.mutate(sessionID, (draft) => {
            draft.status = "blocked"
            draft.pendingAction = undefined
            const attempts = (draft.blockedRetry?.attempts ?? 0) + 1
            if (attempts >= MAX_BLOCKED_RETRIES) {
              draft.blockedRetry = undefined
              draft.blockedReason = BLOCKED_RETRY_EXHAUSTED
            } else {
              draft.blockedRetry = { kind: "continue", attempts }
              draft.blockedReason = (error instanceof Error ? error.message : "Todo dispatch preflight failed").slice(0, 300)
            }
            return true
          })
          return ""
        }
      }

      const actionKey = `${currentRuntime.executionID ?? currentRuntime.lastIdleEventID ?? "idle"}:${goal.revision}:${kind}`
      if (currentRuntime.handled.has(actionKey)) return ""
      currentRuntime.handled.add(actionKey)
      if (currentRuntime.handled.size > 128) currentRuntime.handled.delete(currentRuntime.handled.values().next().value!)
      currentRuntime.inFlight = true
      try {
        if (switchAgentToBuild) {
          assertPlanParent(session)
          session = await refreshIdleSession(sessionID)
          if (!session || session.agent !== "plan") return ""
          goal = await storage.read(sessionID)
          if (goal.status !== "awaiting-build" || !goal.planReady || !goal.planSucceeded || goal.handoff !== "auto") return ""
          session = await switchToBuild(sessionID, session)
          if (!session || session.agent !== "build") throw new Error("session agent did not switch to Build")
          if (currentRuntime.status !== "idle" || isQueuedUser(currentRuntime)) return ""
          goal = await storage.read(sessionID)
        }
        if (goal.status === "blocked") {
          const resumed = await storage.mutate(sessionID, (draft) => {
            if (draft.status !== "blocked" || !draft.blockedRetry || draft.blockedRetry.attempts >= MAX_BLOCKED_RETRIES) return false
            draft.status = "active"
            draft.blockedReason = undefined
            return true
          })
          if (resumed.status !== "active") return ""
          goal = resumed
        }
        if (session.agent !== "build" || (goal.status !== "active" && goal.status !== "awaiting-build")) return ""
        const inboxID = await queuePrompt(sessionID, kind, goal, delivery)
        return inboxID ? (kind === "plan" ? "Build handoff queued." : kind === "continue" ? "Goal continuation queued." : "Goal prompt queued.") : ""
      } catch {
        await storage.mutate(sessionID, (draft) => {
          if (draft.status === "paused" || draft.status === "cleared" || draft.status === "complete") return false
          draft.status = "blocked"
          draft.pendingAction = undefined
          const attempts = (draft.blockedRetry?.attempts ?? 0) + 1
          if (session?.agent !== "build" || attempts >= MAX_BLOCKED_RETRIES) {
            draft.blockedRetry = undefined
            draft.blockedReason = session?.agent === "build"
              ? BLOCKED_RETRY_EXHAUSTED
              : "The Plan→Build handoff failed; run /goal resume to retry."
          } else {
            draft.blockedRetry = { kind: retryKind, attempts }
            draft.blockedReason = "The Plan→Build handoff failed; run /goal resume to retry."
          }
          return true
        })
        return ""
      } finally {
        currentRuntime.inFlight = false
      }
    })
  }

  return {
    get(sessionID: string) {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      return storage.read(sessionID)
    },
    async command(sessionID: string, command: string, signal?: AbortSignal): Promise<{ text: string; cancelInboxID?: string }> {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      const value = command.trim()
      if (!value) return { text: summary(await storage.read(sessionID)) }
      if (value === "build") return startPlanBuild(sessionID, signal)
      if (value === "pause") {
        const result = await locked(sessionID, async () => {
          let cancelInboxID: string | undefined
          const next = await storage.mutate(sessionID, (draft) => {
            if (!draft.originalObjective || draft.status === "cleared" || draft.status === "complete" || draft.status === "paused") return false
            cancelInboxID = draft.queuedPrompt?.inboxID
            draft.pausedStatus = draft.status === "blocked" ? "blocked" : draft.status as GoalRecord["pausedStatus"]
            draft.status = "paused"
            draft.pendingAction = undefined
            draft.queuedPrompt = undefined
            return true
          })
          return { next, cancelInboxID }
        })
        return { text: summary(result.next), ...(result.cancelInboxID ? { cancelInboxID: result.cancelInboxID } : {}) }
      }
      if (value === "clear") {
        const result = await locked(sessionID, async () => {
          let cancelInboxID: string | undefined
          const next = await storage.mutate(sessionID, (draft) => {
            if (!draft.originalObjective && draft.status === "cleared") return false
            cancelInboxID = draft.queuedPrompt?.inboxID
            const handoff = draft.handoff
            reset(draft, sessionID, handoff)
            return true
          })
          return { next, cancelInboxID }
        })
        return { text: summary(result.next), ...(result.cancelInboxID ? { cancelInboxID: result.cancelInboxID } : {}) }
      }
      if (value === "resume") {
        const next = await locked(sessionID, async () => {
          const session = await dependencies.getSession(sessionID)
          return storage.mutate(sessionID, (draft) => {
            if ((draft.status !== "paused" && draft.status !== "blocked") || !draft.originalObjective) {
              throw new Error("no paused or blocked Goal to resume")
            }
            draft.status = session.agent === "build" ? "active" : "awaiting-build"
            draft.pausedStatus = undefined
            draft.blockedReason = undefined
            draft.blockedRetry = undefined
            draft.pendingAction = session.agent === "build" ? { kind: "resume" } : undefined
            return true
          })
        })
        if ((await dependencies.getSession(sessionID)).agent === "build") await confirmIdle(sessionID, signal)
        const queued = await driveIdle(sessionID)
        return { text: `${summary(next)}${queued ? `\n${queued}` : ""}` }
      }

      const objective = text(value, "Goal objective", MAX_OBJECTIVE)
      const session = await dependencies.getSession(sessionID)
      const next = await locked(sessionID, () => storage.mutate(sessionID, (draft) => {
        if (draft.originalObjective && draft.status !== "cleared" && draft.status !== "corrupt") {
          throw new Error("a Goal already exists; use /goal clear before starting another objective")
        }
        const handoff = draft.handoff
        reset(draft, sessionID, handoff)
        Object.assign(draft, {
          status: session.agent === "build" ? "active" : "awaiting-build",
          originalObjective: objective,
          source: "manual",
          pendingAction: session.agent === "build" ? { kind: "start" } : undefined,
        })
        return true
      }))
      if (session.agent === "build") await confirmIdle(sessionID, signal)
      const queued = await driveIdle(sessionID)
      return { text: `${summary(next)}${queued ? `\n${queued}` : ""}` }
    },
    async toggleHandoff(sessionID: string, signal?: AbortSignal) {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      const next = await locked(sessionID, () => storage.mutate(sessionID, (draft) => {
        draft.handoff = draft.handoff === "auto" ? "manual" : "auto"
        return true
      }))
      if (next.handoff === "auto") {
        const goal = await storage.read(sessionID)
        if (goal.status === "awaiting-build" && goal.planReady && goal.planSucceeded) await confirmIdle(sessionID, signal)
      }
      return next.handoff
    },
    async planReady(sessionID: string, input: PlanReadyInput) {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      const objective = text(input.objective, "Plan objective", MAX_OBJECTIVE)
      const plan = text(input.plan, "Plan", MAX_PLAN)
      if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.length > MAX_CRITERIA) {
        throw new Error(`Plan acceptanceCriteria must contain 1..${MAX_CRITERIA} concrete criteria`)
      }
      const criteria = input.acceptanceCriteria.map((item) => text(item, "Acceptance criterion", MAX_CRITERION))
      if (new Set(criteria).size !== criteria.length) throw new Error("Plan acceptance criteria must be distinct")
      return locked(sessionID, async () => {
        const currentRuntime = runtime(sessionID)
        if (!currentRuntime.executionID || currentRuntime.status !== "busy" || currentRuntime.outcome !== "running") {
          throw new Error("plan_ready requires the active Plan turn")
        }
        return storage.mutate(sessionID, (draft) => {
          if (draft.originalObjective && draft.status !== "cleared" && draft.status !== "awaiting-build") {
            throw new Error("an active Goal already exists; clear it before replacing the Plan")
          }
          if (draft.originalObjective && draft.originalObjective !== objective) {
            throw new Error("plan_ready must retain the Goal's original objective")
          }
          const handoff = draft.handoff
          const originalObjective = draft.originalObjective ?? objective
          reset(draft, sessionID, handoff)
          Object.assign(draft, {
            status: "awaiting-build",
            originalObjective,
            acceptanceCriteria: criteria,
            plan,
            source: "plan",
            planReady: true,
            planExecutionID: currentRuntime.executionID,
            planSucceeded: false,
          })
          return true
        })
      })
    },
    async report(sessionID: string, input: GoalReportInput) {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      if (!input || typeof input !== "object" ||
        (input.status !== "progress" && input.status !== "blocked" && input.status !== "complete")) {
        throw new Error("goal_report status must be progress, blocked, or complete")
      }
      const evidence = text(input.evidence, "Goal evidence", MAX_EVIDENCE)
      return locked(sessionID, async () => {
        const currentRuntime = runtime(sessionID)
        if (!currentRuntime.executionID || currentRuntime.status !== "busy" || currentRuntime.outcome !== "running") {
          throw new Error("goal_report requires an active Build turn")
        }
        const current = await storage.read(sessionID)
        if (current.status !== "active" || !current.originalObjective) throw new Error("there is no active Goal to report")
        if (input.status === "progress") await dependencies.requireDispatch?.(sessionID)
        if (input.status === "complete") {
          if (current.acceptanceCriteria.length) {
            if (!Array.isArray(input.acceptanceEvidence) || input.acceptanceEvidence.length !== current.acceptanceCriteria.length) {
              throw new Error("goal completion requires evidence for every acceptance criterion")
            }
            input.acceptanceEvidence.forEach((item) => text(item, "Acceptance evidence", MAX_EVIDENCE))
          }
          if (await dependencies.taskIncomplete(sessionID)) {
            throw new Error("goal completion blocked: call task_complete after its existing gates and required claims pass")
          }
        }
        const completionEvidence = input.status === "complete"
          ? current.acceptanceCriteria.length
            ? input.acceptanceEvidence!.map((item) => text(item, "Acceptance evidence", MAX_EVIDENCE))
            : [evidence]
          : undefined
        return storage.mutate(sessionID, (draft) => {
          if (draft.status !== "active" || !draft.originalObjective) throw new Error("there is no active Goal to report")
          draft.evidence = evidence
          if (input.status === "progress") {
            draft.pendingAction = { kind: "progress", executionID: currentRuntime.executionID, eligible: false }
            return true
          }
          draft.pendingAction = undefined
          if (input.status === "blocked") {
            draft.status = "blocked"
            draft.blockedReason = evidence.slice(0, 300)
            draft.blockedRetry = undefined
            return true
          }
          draft.status = "complete"
          draft.completionEvidence = completionEvidence
          draft.blockedReason = undefined
          return true
        })
      })
    },
    async driveIdle(sessionID: string, delivery: "steer" | "queue" = "steer") {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      return driveIdle(sessionID, delivery)
    },
    async recoverIdle(sessionID: string, signal?: AbortSignal) {
      if (!SESSION_ID.test(sessionID)) throw new Error("Goal sessionID is invalid")
      // Only a persisted Auto Plan that still owes its one Build handoff may
      // hold a startup wait; Manual, blocked, complete, paused, active, and
      // already-queued records are skipped before any wait is opened.
      if (!recoverablePlan(await storage.read(sessionID))) return ""
      // Validate the session identity and project before opening a wait on a
      // persisted ID; a stale or foreign-project Goal must not hold a wait.
      await dependencies.getSession(sessionID)
      // A fresh plugin runtime has no observed status, so an already-idle
      // session emits no future idle event. The awaited server wait resolves
      // only when the session agent loop is idle; a status/execution event seen
      // while waiting bumps statusRevision and wins, so this never infers idle
      // from persisted outcome/time.idle fields and never drives a session that
      // is still running.
      if (!(await confirmIdle(sessionID, signal))) return ""
      if (!recoverablePlan(await storage.read(sessionID))) return ""
      // The plugin cannot inspect inbox items queued before subscription. A
      // switch to Build could deliver an older user item under the wrong agent.
      // A live idle event cannot bypass this block: automatic Plan handoff
      // requires an execution observed by this runtime (above).
      await storage.mutate(sessionID, (draft) => {
        if (!recoverablePlan(draft)) return false
        draft.status = "blocked"
        draft.blockedReason =
          "Auto restart recovery cannot prove the session inbox has no queued user input; run /goal build when the session is idle."
        draft.blockedRetry = undefined
        return true
      })
      return ""
    },
    async observeStatus(sessionID: string, status: "busy" | "idle" | "retry", eventID: string) {
      const current = runtime(sessionID)
      current.status = status === "idle" ? "idle" : "busy"
      current.statusRevision++
      if (status === "idle") current.lastIdleEventID = eventID
      return status === "idle" ? driveIdle(sessionID) : ""
    },
    async observeExecution(sessionID: string, outcome: "started" | "succeeded" | "failed" | "interrupted", eventID: string) {
      const currentRuntime = runtime(sessionID)
      if (outcome === "started") {
        currentRuntime.status = "busy"
        currentRuntime.statusRevision++
        currentRuntime.executionID = eventID
        currentRuntime.outcome = "running"
        await storage.mutate(sessionID, (draft) => {
          let changed = false
          if (draft.status === "awaiting-build" && draft.planReady && draft.planExecutionID !== eventID) {
            draft.status = "awaiting-plan"
            draft.planReady = false
            draft.planSucceeded = false
            draft.planExecutionID = undefined
            draft.plan = undefined
            draft.acceptanceCriteria = []
            changed = true
          }
          if (draft.pendingAction?.kind === "progress" && draft.pendingAction.executionID !== eventID) {
            draft.pendingAction = undefined
            changed = true
          }
          return changed
        })
        return
      }

      currentRuntime.outcome = outcome
      if (outcome === "succeeded") {
        await storage.mutate(sessionID, (draft) => {
          let changed = false
          if (draft.planReady && draft.planExecutionID === currentRuntime.executionID && !draft.planSucceeded) {
            draft.planSucceeded = true
            changed = true
          }
          if (draft.pendingAction?.kind === "progress" && draft.pendingAction.executionID === currentRuntime.executionID && !draft.pendingAction.eligible) {
            draft.pendingAction.eligible = true
            changed = true
          }
          return changed
        })
        if (currentRuntime.status === "idle") {
          await driveIdle(sessionID)
          return undefined
        }
        const goal = await storage.read(sessionID)
        if (goal.handoff === "auto" && goal.status === "awaiting-build" && goal.planReady && goal.planSucceeded &&
          goal.planExecutionID === currentRuntime.executionID && currentRuntime.executionID &&
          currentRuntime.waitingExecutionID !== currentRuntime.executionID) {
          currentRuntime.waitingExecutionID = currentRuntime.executionID
          return currentRuntime.executionID
        }
        return undefined
      } else {
        await storage.mutate(sessionID, (draft) => {
          let changed = false
          if (draft.pendingAction?.kind === "progress" && draft.pendingAction.executionID === currentRuntime.executionID) {
            draft.pendingAction = undefined
            changed = true
          }
          if (draft.planReady && draft.planExecutionID === currentRuntime.executionID && draft.planSucceeded) {
            draft.planSucceeded = false
            changed = true
          }
          return changed
        })
        return undefined
      }
    },
    async observeWaitedIdle(sessionID: string, executionID: string) {
      const current = runtime(sessionID)
      if (current.waitingExecutionID !== executionID || current.executionID !== executionID || current.outcome !== "succeeded") return ""
      current.waitingExecutionID = undefined
      current.status = "idle"
      current.statusRevision++
      current.lastIdleEventID = `wait:${executionID}`
      return driveIdle(sessionID)
    },
    async observeWaitFailure(sessionID: string, executionID: string) {
      const current = runtime(sessionID)
      if (current.waitingExecutionID !== executionID) return
      current.waitingExecutionID = undefined
      if (current.executionID !== executionID || current.outcome !== "succeeded" || current.status === "idle") return
      await locked(sessionID, async () => {
        const goal = await storage.read(sessionID)
        if (goal.status !== "awaiting-build" || goal.handoff !== "auto" || goal.planExecutionID !== executionID ||
          !goal.planReady || !goal.planSucceeded || goal.firstBuildPromptSent) return
        await storage.mutate(sessionID, (draft) => {
          if (draft.status !== "awaiting-build" || draft.handoff !== "auto" || draft.planExecutionID !== executionID ||
            !draft.planReady || !draft.planSucceeded || draft.firstBuildPromptSent) return false
          draft.status = "blocked"
          draft.blockedReason = "OpenCode could not confirm that the Plan session became idle; run /goal build when idle."
          draft.blockedRetry = undefined
          return true
        })
      })
    },
    async observeInbox(sessionID: string, inboxID: string, item: { type: string; delivery: string }) {
      const current = runtime(sessionID)
      current.inbox.set(inboxID, { user: item.type === "user", queued: item.delivery === "queue" })
    },
    updateInboxDelivery(sessionID: string, inboxID: string, delivery: string) {
      const current = runtime(sessionID)
      const item = current.inbox.get(inboxID)
      if (item) item.queued = delivery === "queue"
    },
    async finishInbox(sessionID: string, inboxID: string, cancelled = false) {
      const current = runtime(sessionID)
      current.inbox.delete(inboxID)
      if (!cancelled) return
      current.cancelled.add(inboxID)
      if (current.cancelled.size > 128) current.cancelled.delete(current.cancelled.values().next().value!)
      await storage.mutate(sessionID, (draft) => {
        if (draft.queuedPrompt?.inboxID !== inboxID) return false
        draft.queuedPrompt = undefined
        if (draft.status === "active") {
          draft.status = "blocked"
          draft.blockedReason = "The queued Goal prompt was cancelled; run /goal resume to retry."
          draft.blockedRetry = undefined
        }
        return true
      })
    },
    async agentSelected(sessionID: string, agent: string) {
      if (agent !== "build") return ""
      return driveIdle(sessionID)
    },
    async consumeQueuedPrompt(sessionID: string, prompt: string) {
      const match = GOAL_PROMPT_MARKER.exec(prompt)
      if (!match) return { prompt, stale: false }
      let valid = false
      await storage.mutate(sessionID, (draft) => {
        if (draft.queuedPrompt?.token !== match[1] ||
          draft.queuedPrompt.consumed ||
          (draft.status !== "active" && draft.status !== "awaiting-build")) return false
        if (draft.queuedPrompt.inboxID === undefined) draft.queuedPrompt.consumed = true
        else draft.queuedPrompt = undefined
        valid = true
        return true
      })
      if (!valid) {
        return {
          prompt: "This queued Open Rig Goal prompt is stale because the Goal was paused, cleared, or replaced. Do not perform work from it.",
          stale: true,
        }
      }
      return { prompt: prompt.slice(match[0].length), stale: false }
    },
    forgetRuntime(sessionID: string) {
      runtimes.delete(sessionID)
    },
  }
}

export function goalSummary(record: GoalRecord) {
  return summary(record)
}

export function goalDisplayState(record: GoalRecord) {
  return {
    status: record.status,
    handoff: record.handoff,
    ...(record.originalObjective ? { objective: record.originalObjective } : {}),
  }
}
