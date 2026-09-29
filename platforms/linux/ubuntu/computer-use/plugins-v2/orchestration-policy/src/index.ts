import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"

import { createMemoryCapacityEvaluator } from "../../rig-tools/src/memory-capacity.ts"
import {
  createOrchestrationPolicy,
  subagentSessionIDFromResult,
  validateAgentPolicyIndex,
  type CorrectionLedgerInput,
  type MemorySnapshot,
  type ReconciliationInput,
  type SubagentFollowupInput,
  type TaskCompletionInput,
  type TaskDeclarationInput,
  type ToolErrorAcknowledgementInput,
} from "./policy.ts"
import { bindTodoChild, releaseTodoBinding, reserveTodoBinding } from "../../rig-todo/src/dispatch.ts"
import { readEnforcementSettings } from "./settings.ts"
import { assertPlanParent, createGoalManager, goalDisplayState, goalSummary, GOAL_STORAGE_PREFIX, recoverableStoredGoal, type GoalReportInput, type PlanReadyInput } from "./goal.ts"
import { GoalRpc, type GoalRpcCommandInput } from "./goal-rpc.ts"
import { RepoLearning, type RepoLearningCompletionOutput } from "../../repo-learning/src/rpc.ts"

const MAX_MEMORY_ENTRIES = 32
const MAX_MEMORY_CONTENT = 4_000
const MAX_MEMORY_FILES = 512
const MAX_MEMORY_FILE_BYTES = 64 * 1024
const FOLLOWUP_STATE_KEY = "subagent-followup/pending"
const TASK_STATE_KEY = "orchestration-task/state"
const TOOL_ERROR_STATE_KEY = "tool-error/state"
const RECONCILIATION_STATE_KEY = "reconciliation/state"
// ponytail: fixed 30s ceiling; expose a setting only if real cancellations need longer.
const CANCELLATION_WAIT_TIMEOUT_MS = 30_000
export const RESTORED_CAPACITY_WAITS = 4
export const RESTORED_CAPACITY_WAIT_TIMEOUT_MS = 30_000

const awaitWithSignal = <T>(request: Promise<T>, signal: AbortSignal): Promise<T> => {
  let abort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  return Promise.race([request, aborted]).finally(() => {
    if (abort) signal.removeEventListener("abort", abort)
  })
}

const OWNER_SOURCE = join(
  "platforms",
  "linux",
  "ubuntu",
  "computer-use",
  "plugins-v2",
  "orchestration-policy",
  "src",
  "index.ts",
)

async function regularText(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} must be a regular non-symlink file`)
  return readFile(path, "utf8")
}

export async function agentPolicyIndexErrors(root: string) {
  try {
    const ownerSource = join(root, OWNER_SOURCE)
    let source
    try {
      source = await lstat(ownerSource)
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code === "ENOENT" || code === "ENOTDIR") return []
      throw error
    }
    if (!source.isFile() || source.isSymbolicLink()) {
      throw new Error(`${ownerSource} must be a regular non-symlink file`)
    }
    const [index, policy] = await Promise.all([
      regularText(join(root, "AGENTS.md")),
      regularText(join(root, "docs", "agent-policy.md")),
    ])
    return validateAgentPolicyIndex(index, policy)
  } catch (error) {
    return [error instanceof Error ? error.message : "could not read the agent policy index"]
  }
}

function frontmatterValue(frontmatter: string, name: string) {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"))
  return match?.[1]?.replace(/^['"]|['"]$/g, "").trim()
}

function frontmatterTags(frontmatter: string) {
  const lines = frontmatter.split("\n")
  const index = lines.findIndex((line) => line.startsWith("tags:"))
  if (index < 0) return []
  const inline = lines[index]!.slice("tags:".length).trim()
  if (inline) {
    return inline.replace(/^\[|\]$/g, "").split(",").map((tag) => tag.replace(/^\s*['"]|['"]\s*$/g, "").trim())
  }
  const tags: string[] = []
  for (const line of lines.slice(index + 1)) {
    const match = line.match(/^\s*-\s+(.+?)\s*$/)
    if (!match) break
    tags.push(match[1]!.replace(/^['"]|['"]$/g, "").trim())
  }
  return tags
}

function memoryEntry(text: string, bindings: ReadonlySet<string>) {
  const normalized = text.replaceAll("\r\n", "\n")
  if (!normalized.startsWith("---\n")) return undefined
  const end = normalized.indexOf("\n---\n", 4)
  if (end < 0) return undefined
  const frontmatter = normalized.slice(4, end)
  const type = frontmatterValue(frontmatter, "type")
  if (type !== "decision" && type !== "preference") return undefined
  if (!frontmatterTags(frontmatter).some((tag) => bindings.has(tag))) return undefined
  const title = frontmatterValue(frontmatter, "title")
  const permalink = frontmatterValue(frontmatter, "permalink")
  const content = normalized.slice(end + 5).trim().slice(0, MAX_MEMORY_CONTENT)
  if (!title || !permalink || !content) throw new Error("bound memory note is missing title, permalink, or content")
  return { title: title.slice(0, 200), permalink: permalink.slice(0, 300), content }
}

async function memoryFiles(directory: string) {
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("memoryDirectory must be a non-symlink directory")
  const pending = [directory]
  const files: string[] = []
  let visited = 0
  while (pending.length) {
    const current = pending.shift()!
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_MEMORY_FILES) throw new Error(`memoryDirectory exceeds ${MAX_MEMORY_FILES} entries`)
      const path = join(current, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error(`memoryDirectory contains a symlink: ${relative(directory, path)}`)
      if (info.isDirectory()) pending.push(path)
      else if (info.isFile() && entry.name.endsWith(".md")) {
        if (info.size > MAX_MEMORY_FILE_BYTES) throw new Error(`memory note exceeds ${MAX_MEMORY_FILE_BYTES} bytes`)
        files.push(path)
      }
    }
  }
  return files.sort()
}

export async function loadMemory(
  project: string,
  bindings: readonly string[],
  directory: string,
): Promise<MemorySnapshot> {
  const checkedAt = new Date().toISOString()
  try {
    const bindingSet = new Set(bindings)
    const seen = new Set<string>()
    const entries: { title: string; permalink: string; content: string }[] = []
    for (const path of await memoryFiles(directory)) {
      const entry = memoryEntry(await readFile(path, "utf8"), bindingSet)
      if (!entry) continue
      if (seen.has(entry.permalink)) throw new Error(`duplicate memory permalink: ${entry.permalink}`)
      if (entries.length >= MAX_MEMORY_ENTRIES) throw new Error(`more than ${MAX_MEMORY_ENTRIES} bound memory notes`)
      seen.add(entry.permalink)
      entries.push(entry)
    }
    const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex")
    return { project, bindings: [...bindings], checkedAt, digest, entries }
  } catch {
    return {
      project,
      bindings: [...bindings],
      checkedAt,
      digest: createHash("sha256").update("lookup-failed").digest("hex"),
      entries: [],
      error: "bounded Basic Memory lookup failed",
    }
  }
}

function modelReference(model: { providerID: string; id: string; variant?: string } | undefined) {
  if (!model) return undefined
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

type TerminalOutcome = "succeeded" | "failed" | "interrupted"
type ChildCancellationOutcome = TerminalOutcome | "idle" | "deleted"

type CancellationSession = {
  get(input: { sessionID: string }): Promise<{
    id: string
    parentID?: string
    outcome?: TerminalOutcome
  }>
  interrupt(input: { sessionID: string; resume: false }): Promise<{ interrupted: boolean }>
  waitForLifecycle(input: { sessionID: string }, signal: AbortSignal): Promise<void>
}

export async function cancelDirectChild(
  policy: ReturnType<typeof createOrchestrationPolicy>,
  session: CancellationSession,
  parentID: string,
  childID: string,
  persistLifecycle: () => Promise<void>,
  waitTimeoutMs = CANCELLATION_WAIT_TIMEOUT_MS,
): Promise<{ outcome: ChildCancellationOutcome; interrupted: boolean }> {
  policy.beginChildCancellation(parentID, childID)
  try {
    const requireOwner = (child: Awaited<ReturnType<CancellationSession["get"]>>) => {
      if (child.id !== childID || child.parentID !== parentID) {
        throw new Error("background child session is not owned by this parent")
      }
    }
    const ensureFollowup = async (outcome: ChildCancellationOutcome, interrupted: boolean) => {
      if (!policy.hasPendingFollowup(parentID, childID) && !policy.hasChildFollowupState(parentID, childID)) {
        throw new Error("terminal background child did not produce the required parent follow-up state")
      }
      await persistLifecycle()
      return { outcome, interrupted }
    }
    const recordTerminal = async (child: Awaited<ReturnType<CancellationSession["get"]>>) => {
      if (child.outcome !== "succeeded" && child.outcome !== "failed" && child.outcome !== "interrupted") {
        return undefined
      }
      if (!policy.recoverCompletedFollowup(parentID, child) &&
        !policy.hasPendingFollowup(parentID, childID) && !policy.hasChildFollowupState(parentID, childID)) {
        throw new Error("terminal background child did not produce the required parent follow-up state")
      }
      await persistLifecycle()
      return child.outcome
    }

    let initial
    try {
      initial = await session.get({ sessionID: childID })
    } catch (error) {
      if (policy.isDeletedChild(parentID, childID)) {
        await persistLifecycle()
        throw new Error("background child was deleted before cancellation could be requested")
      }
      throw error
    }
    requireOwner(initial)
    const initialOutcome = await recordTerminal(initial)
    if (initialOutcome) {
      throw new Error(`background child is already terminal (${initialOutcome}); cancellation was denied and parent follow-up is required`)
    }
    if (policy.isDeletedChild(parentID, childID)) {
      await ensureFollowup("deleted", false)
      throw new Error("background child was deleted before cancellation could be requested")
    }
    if (policy.hasPendingFollowup(parentID, childID) || policy.hasChildFollowupState(parentID, childID)) {
      await ensureFollowup("idle", false)
      throw new Error("background child is already idle; cancellation was denied and parent follow-up is required")
    }

    const interruption = await session.interrupt({ sessionID: childID, resume: false })
    const recheckTimeoutMs = Math.min(waitTimeoutMs, Math.max(1, Math.floor(waitTimeoutMs / 6)))
    const lifecycleTimeoutMs = waitTimeoutMs - recheckTimeoutMs

    let waitFailed = false
    let waitError: unknown
    try {
      await session.waitForLifecycle({ sessionID: childID }, AbortSignal.timeout(lifecycleTimeoutMs))
    } catch (error) {
      waitFailed = true
      waitError = error
    }
    if (policy.isDeletedChild(parentID, childID)) {
      const result = await ensureFollowup("deleted", interruption.interrupted)
      if (!interruption.interrupted) {
        throw new Error("background child was already inactive; cancellation was denied and parent follow-up is required")
      }
      return result
    }
    if (policy.hasPendingFollowup(parentID, childID) || policy.hasChildFollowupState(parentID, childID)) {
      const result = await ensureFollowup("idle", interruption.interrupted)
      if (!interruption.interrupted) {
        throw new Error("background child was already idle; cancellation was denied and parent follow-up is required")
      }
      return result
    }
    let current
    let recheckTimeout: ReturnType<typeof setTimeout> | undefined
    try {
      const lookup = session.get({ sessionID: childID })
      current = waitFailed
        ? await Promise.race([
            lookup,
            new Promise<never>((_resolve, reject) => {
              recheckTimeout = setTimeout(() => reject(waitError), recheckTimeoutMs)
            }),
          ])
        : await lookup
    } catch (error) {
      if (policy.isDeletedChild(parentID, childID)) {
        const result = await ensureFollowup("deleted", interruption.interrupted)
        if (!interruption.interrupted) {
          throw new Error("background child was already inactive; cancellation was denied and parent follow-up is required")
        }
        return result
      }
      if (policy.hasPendingFollowup(parentID, childID) || policy.hasChildFollowupState(parentID, childID)) {
        const result = await ensureFollowup("idle", interruption.interrupted)
        if (!interruption.interrupted) {
          throw new Error("background child was already idle; cancellation was denied and parent follow-up is required")
        }
        return result
      }
      throw waitFailed ? waitError : error
    } finally {
      if (recheckTimeout) clearTimeout(recheckTimeout)
    }
    requireOwner(current)
    const outcome = await recordTerminal(current)
    if (outcome) {
      if (!interruption.interrupted) {
        throw new Error(`background child was already terminal (${outcome}); cancellation was denied and parent follow-up is required`)
      }
      return { outcome, interrupted: true }
    }
    if (policy.isDeletedChild(parentID, childID)) {
      const result = await ensureFollowup("deleted", interruption.interrupted)
      if (!interruption.interrupted) {
        throw new Error("background child was already inactive; cancellation was denied and parent follow-up is required")
      }
      return result
    }
    if (policy.hasPendingFollowup(parentID, childID) || policy.hasChildFollowupState(parentID, childID)) {
      const result = await ensureFollowup("idle", interruption.interrupted)
      if (!interruption.interrupted) {
        throw new Error("background child was already idle; cancellation was denied and parent follow-up is required")
      }
      return result
    }

    if (waitFailed) throw waitError
    throw new Error("background child cancellation wait completed without observed idle, deletion, or terminal outcome")
  } finally {
    policy.finishChildCancellation(parentID, childID)
  }
}

export function createSerialWriteQueue() {
  let tail: Promise<void> = Promise.resolve()
  return <T>(write: () => Promise<T>): Promise<T> => {
    const next = tail.then(write, write)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
}

export function defaultProtectedPaths() {
  return [
    join(homedir(), ".local", "opt", "opencode"),
    join(homedir(), ".local", "lib", "opencode"),
    "/opt/opencode",
    "/usr/local/lib/node_modules/opencode",
    "/usr/lib/node_modules/opencode",
    join(homedir(), ".opencode", "bin", "opencode"),
  ]
}

export default Plugin.define({
  id: "opencode-rig.orchestration-policy",
  async setup(ctx) {
    const rawOptions = { ...((ctx.options ?? {}) as Record<string, unknown>) }
    rawOptions.protectedPaths ??= defaultProtectedPaths()
    const root = ctx.location.project.canonical
    const repoLearningRpc = ctx.rpc(RepoLearning)
    let goalManager!: ReturnType<typeof createGoalManager>
    const autoBuildQuestion = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      if (!session || session.id !== sessionID || session.projectID !== ctx.location.project.id || session.agent !== "build") return false
      try {
        const goal = await goalManager.get(sessionID)
        return goal.handoff === "auto" || goal.status === "corrupt"
      } catch {
        return true
      }
    }
    const policy = createOrchestrationPolicy(rawOptions, {
      capacityDiagnostic: createMemoryCapacityEvaluator(rawOptions),
      resolveAgentModel: async (agentID) => modelReference((await ctx.agent.get({ agentID })).data.model),
      projectRoot: root,
      autoBuildQuestion,
      repoLearningPreflight: async (sessionID) =>
        await repoLearningRpc.checkTaskCompletion({ sessionID }) as RepoLearningCompletionOutput,
    })
    const initialSettings = await readEnforcementSettings(root)
    policy.setEnforcementSettings(initialSettings)
    if (policy.options.configurationErrors.length) {
      console.error(`orchestration policy configuration verification failed: ${policy.options.configurationErrors.join("; ")}`)
    }
    policy.restoreFollowups(await ctx.storage.get(FOLLOWUP_STATE_KEY))
    policy.restoreTaskState(await ctx.storage.get(TASK_STATE_KEY))
    try {
      policy.restoreToolErrors(await ctx.storage.get(TOOL_ERROR_STATE_KEY))
    } catch {
      policy.markToolErrorStateCorrupt()
    }
    const reconciliationSnapshot = initialSettings.enforcements.memoryReconciliation && policy.options.memoryProject && policy.options.memoryDirectory
      ? await loadMemory(policy.options.memoryProject, policy.options.memoryBindings, policy.options.memoryDirectory)
      : undefined
    policy.restoreReconciliation(await ctx.storage.get(RECONCILIATION_STATE_KEY), reconciliationSnapshot)
    const memoryLoads = new Map<string, Promise<MemorySnapshot>>()
    const refreshEnforcements = async () => policy.setEnforcementSettings(await readEnforcementSettings(root))
    const enqueueWrite = createSerialWriteQueue()
    const persistFollowups = () =>
      enqueueWrite(() => ctx.storage.set(FOLLOWUP_STATE_KEY, policy.pendingFollowupRecords()))
    const persistTasks = () =>
      enqueueWrite(() => ctx.storage.set(TASK_STATE_KEY, policy.taskStateRecords()))
    const persistLifecycle = () => enqueueWrite(async () => {
      const tasks = policy.taskStateRecords()
      const followups = policy.pendingFollowupRecords()
      // If task persistence fails, retaining an extra follow-up is safer than freeing capacity.
      await ctx.storage.set(FOLLOWUP_STATE_KEY, followups)
      await ctx.storage.set(TASK_STATE_KEY, tasks)
    })
    const persistToolErrors = () => enqueueWrite(() => ctx.storage.set(TOOL_ERROR_STATE_KEY, policy.toolErrorStorageValue()))
    const persistReconciliation = () =>
      enqueueWrite(() => ctx.storage.set(RECONCILIATION_STATE_KEY, policy.reconciliationStorageValue()))
    const reconcileRestoredChild = async (parentID: string, childID: string, signal: AbortSignal) => {
      const deadline = new AbortController()
      const forwardAbort = () => deadline.abort(signal.reason)
      if (signal.aborted) deadline.abort(signal.reason)
      else signal.addEventListener("abort", forwardAbort, { once: true })
      const timer = setTimeout(
        () => deadline.abort(new Error("restored child reconciliation deadline exceeded")),
        RESTORED_CAPACITY_WAIT_TIMEOUT_MS,
      )
      try {
        if (deadline.signal.aborted) return
        let session
        try {
          session = await awaitWithSignal(
            ctx.session.get({ sessionID: childID }, { signal: deadline.signal }),
            deadline.signal,
          )
        } catch (error) {
          if (deadline.signal.aborted) return
          throw error
        }
        if (deadline.signal.aborted || session.id !== childID || session.parentID !== parentID ||
          session.projectID !== ctx.location.project.id) return

        try {
          await awaitWithSignal(
            ctx.session.wait({ sessionID: childID }, { signal: deadline.signal }),
            deadline.signal,
          )
        } catch (error) {
          if (deadline.signal.aborted) return
          throw error
        }
        if (deadline.signal.aborted || signal.aborted) return
        if (policy.sessionStatus(childID, "idle")) {
          try {
            await persistLifecycle()
          } catch (error) {
            policy.sessionStatus(childID, "busy")
            try {
              await persistLifecycle()
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "restored child lifecycle persistence and rollback failed")
            }
            throw error
          }
        }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener("abort", forwardAbort)
      }
    }
    const reconcileRestoredCapacity = (signal: AbortSignal) => {
      const children = policy.taskStateRecords().flatMap((task) =>
        task.completedAt
          ? []
          : task.children
            .filter((child) => child.status === "active")
            .map((child) => ({ parentID: task.parentID, childID: child.sessionID })))
      let next = 0
      const report = (message: string, childID: string | undefined, error: unknown) => {
        if (!signal.aborted) console.error(message, ...(childID ? [childID] : []), error)
      }
      const worker = async () => {
        for (;;) {
          const child = children[next++]
          if (!child || signal.aborted) return
          try {
            await reconcileRestoredChild(child.parentID, child.childID, signal)
          } catch (error) {
            report("restored child capacity reconciliation failed", child.childID, error)
          }
        }
      }
      for (let started = 0; started < Math.min(RESTORED_CAPACITY_WAITS, children.length); started++) {
        void worker().catch((error) => report("restored child capacity reconciliation worker failed", undefined, error))
      }
    }
    const todoLaunches = new Map<string, { parentID: string }>()
    const todoLaunchKey = (parentID: string, callID: string) => `${parentID}\u0000${callID}`
    const refreshTasks = async () =>
      policy.restoreTaskState(await ctx.storage.get(TASK_STATE_KEY))
    const requireGoalSession = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID })
      if (session.projectID !== ctx.location.project.id) throw new Error("Goal session belongs to another project")
      return session
    }
    const controller = new AbortController()
    reconcileRestoredCapacity(controller.signal)
    let publishGoalUpdate: (sessionID: string) => Promise<void> = async () => {}
    goalManager = createGoalManager({
      storage: ctx.storage,
      onStateChange: (sessionID) => publishGoalUpdate(sessionID),
      getSession: requireGoalSession,
      waitForIdle: (sessionID, signal) => ctx.session.wait({ sessionID }, {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      }),
      buildAgentAvailable: async () => {
        try {
          await ctx.agent.get({ agentID: "build" })
          return true
        } catch {
          return false
        }
      },
      switchAgent: (sessionID, agent) => ctx.session.switchAgent({ sessionID, agent }),
      switchModel: (sessionID, model) => ctx.session.switchModel({ sessionID, model }),
      prompt: (sessionID, text, delivery = "steer") => ctx.session.prompt({ sessionID, text, delivery }),
      taskIncomplete: async (sessionID) => {
        await refreshTasks()
        const task = policy.taskState(sessionID)
        return Boolean(task && !task.completedAt)
      },
      requireDispatch: async (sessionID) => {
        await refreshTasks()
        await refreshEnforcements()
        await policy.requireTodoDispatch(sessionID)
      },
    })
    const goalRpc = await ctx.rpc.register(GoalRpc, {
      command: async (raw, rpcContext) => {
        const input = raw as GoalRpcCommandInput
        await requireGoalSession(input.sessionID)
        const result = await goalManager.command(input.sessionID, input.command, rpcContext.signal)
        return { text: result.text, ...(result.cancelInboxID ? { cancelInboxID: result.cancelInboxID } : {}) }
      },
      state: async (raw) => {
        const sessionID = (raw as { sessionID: string }).sessionID
        await requireGoalSession(sessionID)
        return goalDisplayState(await goalManager.get(sessionID))
      },
      toggleHandoff: async (raw, rpcContext) => {
        const sessionID = (raw as { sessionID: string }).sessionID
        await requireGoalSession(sessionID)
        await goalManager.toggleHandoff(sessionID, rpcContext.signal)
        await goalManager.driveIdle(sessionID)
        return goalDisplayState(await goalManager.get(sessionID))
      },
    })
    publishGoalUpdate = (sessionID) => goalRpc.events.emit("updated", { sessionID })
    const cancellationWaiters = new Map<string, Set<() => void>>()
    const notifyCancellationWaiters = (sessionID: string) => {
      for (const notify of [...(cancellationWaiters.get(sessionID) ?? [])]) notify()
    }
    const waitForCancellationLifecycle = (parentID: string, childID: string, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const waiters = cancellationWaiters.get(childID) ?? new Set<() => void>()
        const cleanup = () => {
          signal.removeEventListener("abort", abort)
          waiters.delete(observe)
          if (!waiters.size) cancellationWaiters.delete(childID)
        }
        const observe = () => {
          if (!policy.isDeletedChild(parentID, childID) && !policy.hasPendingFollowup(parentID, childID) &&
            !policy.hasChildFollowupState(parentID, childID)) return
          cleanup()
          resolve()
        }
        const abort = () => {
          cleanup()
          reject(signal.reason)
        }
        cancellationWaiters.set(childID, waiters)
        waiters.add(observe)
        if (signal.aborted) abort()
        else {
          signal.addEventListener("abort", abort, { once: true })
          observe()
        }
      })

    await ctx.tool.hook("execute.before", async (event) => {
      await refreshTasks()
      await refreshEnforcements()
      await policy.before(event)
      if (event.tool === "subagent") {
        const input = event.input as { description?: unknown } | undefined
        const description = typeof input?.description === "string" ? input.description.trim() : ""
        try {
          await reserveTodoBinding(event.sessionID, event.id, description)
          todoLaunches.set(todoLaunchKey(event.sessionID, event.id), { parentID: event.sessionID })
        } catch (error) {
          policy.rejectDirectLaunch(event)
          throw error
        }
      }
    })
    await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "question" || !(await autoBuildQuestion(event.sessionID))) return
      event.effect = "deny"
      event.message = "question is unavailable while Goal handoff is Auto or invalid in this same-project Build session; switch to Manual and repair invalid Goal state before asking"
    })
    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool === "subagent") {
        const key = todoLaunchKey(event.sessionID, event.id)
        const launch = todoLaunches.get(key)
        if (launch) {
          const childID = event.status === "completed"
            ? subagentSessionIDFromResult(event.result)
            : policy.pendingChildForLaunch(event.id)
          if (childID) {
            await bindTodoChild(launch.parentID, event.id, childID)
          } else if (event.status === "error") {
            await releaseTodoBinding(launch.parentID, event.id)
          }
          todoLaunches.delete(key)
        }
      }
      const toolErrorChanged = policy.after(event)
      if (event.tool === "subagent") await persistTasks()
      if (toolErrorChanged) await persistToolErrors()
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "plan_ready",
        description:
          "Record an actually ready Plan for this top-level Plan session. Call only after the Plan is complete; provide its full objective, concrete acceptance criteria, and bounded implementation plan. This control-plane call arms the explicit Plan→Build handoff.",
        input: {
          type: "object",
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 2_000 },
            acceptanceCriteria: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            plan: { type: "string", minLength: 1, maxLength: 8_000 },
          },
          required: ["objective", "acceptanceCriteria", "plan"],
          additionalProperties: false,
        },
        async execute(raw, context) {
          const sessionID = String(context.sessionID)
          const session = await requireGoalSession(sessionID)
          assertPlanParent(session)
          const goal = await goalManager.planReady(sessionID, raw as PlanReadyInput)
          return { content: `Plan ready for Goal: ${goal.originalObjective}. Handoff: ${goal.handoff}.` }
        },
      })
      editor.add({
        name: "goal_report",
        description:
          "Record model-reported Goal progress, a blocker, or completion. Keep the original objective unchanged; completion needs reported evidence for every acceptance criterion, which this tool does not independently verify. An active repository task must first pass task_complete and its existing child, Todo, error, correction-ledger, and acceptance-claim gates.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["progress", "blocked", "complete"] },
            evidence: { type: "string", minLength: 1, maxLength: 2_000 },
            acceptanceEvidence: {
              type: "array",
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 2_000 },
            },
          },
          required: ["status", "evidence"],
          additionalProperties: false,
        },
        async execute(raw, context) {
          const sessionID = String(context.sessionID)
          const session = await requireGoalSession(sessionID)
          if (session.agent !== "build") {
            throw new Error("goal_report is available only to a Build session in this project")
          }
          const goal = await goalManager.report(sessionID, raw as GoalReportInput)
          return { content: goalSummary(goal) }
        },
      })
      editor.add({
        name: "task_status",
        description: "Read the current persisted repository-task enforcement state for this session.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_value, context) {
          await refreshTasks()
          const task = policy.taskState(String(context.sessionID))
          return { content: JSON.stringify(task ?? { active: false }, null, 2) }
        },
      })
      editor.add({
        name: "subagent_cancel",
        description:
          "Interrupt one active direct child owned by this parent task; keep capacity reserved until idle, deletion, or terminal state is verified and parent follow-up is due.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", pattern: "^ses_[A-Za-z0-9]+$" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const parentID = String(context.sessionID)
          const childID = (value as { sessionID: string }).sessionID
          await refreshTasks()
          const result = await cancelDirectChild(policy, {
            get: (input) => ctx.session.get(input),
            interrupt: (input) => ctx.session.interrupt(input),
            waitForLifecycle: (input, signal) => waitForCancellationLifecycle(parentID, input.sessionID, signal),
          }, parentID, childID, persistLifecycle)
          return { content: `Background child cancellation observed ${result.outcome}; parent follow-up is required.` }
        },
      })
      editor.add({
        name: "task_declare",
        description:
          "Declare a repository change, review, release, or correction task before repository mutation. Optional requiredClaimIDs bind to claims in v3 acceptance-evidence.json. Completion requires each claim to be complete, rejects non-planned visible claims while the UI inventory is pending, and checks that evidence references resolve to regular non-symlink files beneath the project. It does not hash or substantiate evidence files (including host screenshots), and it does not run check-acceptance-evidence.py. A task may launch background children and requires accepted parent follow-up.",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["change", "review", "release", "correction"] },
            summary: { type: "string", minLength: 1, maxLength: 1000 },
            requiredClaimIDs: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const sessionID = String(context.sessionID)
          await refreshTasks()
          const current = await ctx.session.get({ sessionID }).catch(() => undefined)
          if (current?.parentID) throw new Error("child agents cannot declare parent tasks")
          const task = policy.declareTask(sessionID, value as TaskDeclarationInput)
          await persistTasks()
          return { content: `Task declared: ${task.kind}; background delegation and accepted follow-up required.` }
        },
      })
      editor.add({
        name: "correction_ledger_ack",
        description:
          "Acknowledge one correction ledger after updating the project roadmap, active todo list, or project-bound memory, or record an explicit scoped no-write resolution.",
        input: {
          type: "object",
          properties: {
            ledger: { type: "string", enum: ["roadmap", "todo", "memory"] },
            status: { type: "string", enum: ["updated", "no_write"] },
            evidence: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["ledger", "status", "evidence"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const task = policy.acknowledgeCorrection(String(context.sessionID), value as CorrectionLedgerInput)
          await persistTasks()
          return { content: `Correction ledger acknowledged: ${(value as CorrectionLedgerInput).ledger}; ${Object.keys(task.ledgers).length}/3 complete.` }
        },
      })
      editor.add({
        name: "tool_error_ack",
        description:
          "Acknowledge one sanitized top-level tool-error obligation, acknowledge all bounded obligations for this task, or explicitly recover from corrupt persisted error state.",
        input: {
          type: "object",
          properties: {
            obligationID: { type: "string", pattern: "^terr_[a-f0-9]{64}$" },
            acknowledgeAll: { type: "boolean" },
            acknowledgeCorruption: { type: "boolean" },
            evidence: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["evidence"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const result = policy.acknowledgeToolError(String(context.sessionID), value as ToolErrorAcknowledgementInput)
          await persistToolErrors()
          return {
            content: `Top-level tool-error acknowledgement recorded; remaining=${result.remaining}; stateCorrupt=${result.stateCorrupt}.`,
          }
        },
      })
      editor.add({
        name: "task_complete",
        description:
          "Record verified task completion. Fails unless delegation, child completion, accepted parent follow-up, correction ledgers, zero actionable Todos, and every task-scoped required acceptance claim are complete.",
        input: {
          type: "object",
          properties: {
            verification: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["verification"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const completed = await policy.completeTask(String(context.sessionID), value as TaskCompletionInput)
          await Promise.all([
            persistTasks(),
            ctx.storage.set(`orchestration-task/audit/${context.sessionID}/${completed.completedAt}`, completed),
          ])
          return { content: `Task completion recorded: ${completed.kind}.` }
        },
      })
      editor.add({
        name: "rule_reconciliation",
        description:
          "Complete a due project-scoped durable-rule reconciliation after reviewing the automatically loaded Basic Memory context, or return an idempotent no-op when no reconciliation is due. Report conflicts truthfully; unresolved conflicts require the question tool first.",
        input: {
          type: "object",
          properties: {
            outcome: { type: "string", enum: ["aligned", "resolved", "conflict"] },
            conflicts: {
              type: "array",
              maxItems: 16,
              items: { type: "string", maxLength: 500 },
            },
            resolution: { type: "string", maxLength: 1000 },
          },
          required: ["outcome", "conflicts"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const input = value as ReconciliationInput
          const audit = policy.completeReconciliation(String(context.sessionID), input)
          await Promise.all([
            ctx.storage.set(`reconciliation/${context.sessionID}`, audit),
            persistReconciliation(),
          ])
          return {
            content: `Rule reconciliation complete: ${audit.outcome}; ${audit.noteCount} bound notes; digest ${audit.memoryDigest}.`,
          }
        },
      })
      editor.add({
        name: "subagent_followup",
        description:
          "Record the parent agent's review and independent verification of a completed background child. Each completed child must be reviewed before further child launches, task completion, commit, or push.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", pattern: "^ses_[A-Za-z0-9]+$" },
            outcome: { type: "string", enum: ["accepted", "changes_required", "failed"] },
            verification: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["sessionID", "outcome", "verification"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const parentID = String(context.sessionID)
          const input = value as SubagentFollowupInput
          await refreshTasks()
          let audit
          try {
            audit = policy.reviewFollowup(parentID, input)
          } catch (error) {
            const child = await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
            if (!policy.recoverCompletedFollowup(parentID, child)) throw error
            audit = policy.reviewFollowup(parentID, input)
          }
          await enqueueWrite(async () => {
            const remaining = policy.pendingFollowupRecords().filter(
              (record) => record.parentID !== audit.parentID || record.childID !== audit.childID,
            )
            const taskState = policy.taskStateRecords().map((task) =>
              task.parentID === audit.parentID
                ? {
                    ...task,
                    children: task.children.map((child) => child.sessionID === audit.childID
                      ? { ...child, status: "reviewed" as const, outcome: audit.outcome }
                      : child),
                  }
                : task)
            await Promise.all([
              ctx.storage.set(FOLLOWUP_STATE_KEY, remaining),
              ctx.storage.set(TASK_STATE_KEY, taskState),
              ctx.storage.set(`subagent-followup/audit/${audit.parentID}/${audit.childID}/${audit.reviewedAt}`, audit),
            ])
          })
          if (!policy.acknowledgeFollowup(audit.parentID, audit.childID, audit.outcome)) {
            throw new Error("background agent follow-up changed during audit persistence")
          }
          return { content: `Background agent follow-up recorded for ${audit.childID}: ${audit.outcome}.` }
        },
      })
    })
    await ctx.session.hook("prompt", async (event) => {
      await refreshEnforcements()
      const sessionID = String(event.sessionID)
      if (policy.userPrompt(sessionID)) await persistReconciliation()
      const admitted = await goalManager.consumeQueuedPrompt(sessionID, event.prompt.text)
      event.prompt.text = admitted.prompt
    })
    await ctx.session.hook("context", async (event) => {
      await refreshTasks()
      await refreshEnforcements()
      if (policy.options.enforceAgentIndex) policy.setIndexErrors(await agentPolicyIndexErrors(root))
      const sessionID = String(event.sessionID)
      if (policy.enforcementState().enforcements.memoryReconciliation && policy.options.memoryProject && policy.options.memoryDirectory && policy.needsMemorySnapshot(sessionID)) {
        let loading = memoryLoads.get(sessionID)
        if (!loading) {
          loading = loadMemory(policy.options.memoryProject, policy.options.memoryBindings, policy.options.memoryDirectory)
          memoryLoads.set(sessionID, loading)
        }
        try {
          policy.setMemorySnapshot(sessionID, await loading)
        } finally {
          memoryLoads.delete(sessionID)
        }
      }
      const todoReminderCount = await policy.todoReminderCount(sessionID)
      const text = policy.instructions(sessionID, todoReminderCount)
      if (text) event.system.push({ type: "text", text })
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      const planParent = event.agent === "plan" && session?.id === sessionID && session.projectID === ctx.location.project.id &&
        session.agent === "plan" && !session.parentID
      const buildSession = event.agent === "build" && session?.id === sessionID && session.projectID === ctx.location.project.id &&
        session.agent === "build"
      if (!planParent) delete event.tools.plan_ready
      if (!buildSession) delete event.tools.goal_report
      if (planParent) {
        event.system.push({
          type: "text",
          text: "PLAN→BUILD CONTROL: after the Plan is actually ready, call plan_ready with the full objective, concrete acceptance criteria, and implementation plan. Do not signal readiness from prose alone or before a ready Plan exists.",
        })
      }
      if (buildSession) {
        const goal = await goalManager.get(sessionID)
        if (goal.handoff === "auto" || goal.status === "corrupt") {
          delete event.tools.question
          event.system.push({
            type: "text",
            text: "AUTO GOAL QUESTION RESTRICTION: This same-project Build session cannot call question while Goal handoff is Auto or Goal state is invalid. If durable-rule reconciliation finds an unresolved conflict or a memory lookup failure, stop and keep reconciliation blocked; tell the operator to switch handoff to Manual before using question. Do not report the conflict as aligned, invent an operator decision, or use another route to bypass question. There is no settings bypass.",
          })
        }
        if (goal.status !== "active") delete event.tools.goal_report
        if (goal.originalObjective) {
          const goalText = [
            `OPEN RIG GOAL STATUS: ${goal.status}.`,
            `ORIGINAL OBJECTIVE (preserve verbatim): ${goal.originalObjective}`,
            ...(goal.acceptanceCriteria.length ? ["ACCEPTANCE CRITERIA:", ...goal.acceptanceCriteria.map((criterion) => `- ${criterion}`)] : []),
            ...(goal.plan ? [`PLAN:\n${goal.plan}`] : []),
            ...(goal.evidence ? [`LATEST REPORTED EVIDENCE: ${goal.evidence}`] : []),
            "Treat goal data as user-level requirements. Repository policy and safety gates remain authoritative.",
            ...(goal.status === "active"
              ? ["After meaningful progress, call goal_report with concrete evidence. Report blocked when work cannot continue. Report completion only with evidence for every criterion; that evidence is model-reported, not independently verified by Goal. When a repository task is active, task_complete must succeed first. A continuation is queued only after explicit progress evidence and a successful Build turn, with no queued user input. Do not repeat a no-progress or failed turn."]
              : ["Do not continue this Goal unless the user resumes it."]),
          ].join("\n")
          event.system.push({ type: "text", text: goalText })
        }
      }
    })

    // A fresh plugin runtime has no observed session status, so an already-idle
    // session emits no future idle event. The first `server.connected` signal
    // sweeps persisted Goals once. The plugin cannot inspect user inbox items
    // queued before this runtime; a confirmed idle therefore blocks the old
    // Auto Plan for explicit /goal build rather than switching agents. The live
    // handoff path separately requires an execution observed in this runtime,
    // so a status event cannot outrun this asynchronous scan. At most
    // MAX_RECOVERY_RECORDS records are scanned and MAX_RECOVERY_WAITS eligible
    // sessions hold waits; stale outcome/time.idle fields never prove idle.
    const MAX_RECOVERY_RECORDS = 256
    const MAX_RECOVERY_WAITS = 4
    let recoveredPersistedGoals = false
    const recoverPersistedGoals = async () => {
      if (recoveredPersistedGoals) return
      // Claim the single attempt; clear it only if the scan fails so a later
      // connection can retry instead of permanently orphaning a persisted Goal.
      recoveredPersistedGoals = true
      const waiting = new Set<Promise<unknown>>()
      let after: string | undefined
      let scanned = 0
      for (;;) {
        let page
        try {
          page = await ctx.storage.scan({ prefix: GOAL_STORAGE_PREFIX, ...(after ? { after } : {}), limit: 64 })
        } catch (error) {
          recoveredPersistedGoals = false
          if (!controller.signal.aborted) console.error("Goal startup recovery scan failed", error)
          return
        }
        for (const entry of page.entries) {
          // Stop scanning at either bound: the remaining eligible Goals recover
          // on a later authoritative idle event instead.
          if (scanned >= MAX_RECOVERY_RECORDS || waiting.size >= MAX_RECOVERY_WAITS) return
          scanned++
          const sessionID = entry.key.slice(GOAL_STORAGE_PREFIX.length)
          if (!recoverableStoredGoal(entry.value, sessionID)) continue
          // Each eligible Goal awaits its own authoritative idle observation; a
          // pending wait holds one plugin-scoped request and resolves when that
          // session becomes idle (or aborts with the plugin lifetime).
          const task = goalManager.recoverIdle(sessionID).catch((error) => {
            if (!controller.signal.aborted) console.error("Goal startup recovery failed", error)
          })
          waiting.add(task)
          void task.finally(() => waiting.delete(task))
        }
        if (!page.next || controller.signal.aborted) return
        after = page.next
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "server.connected") {
            void recoverPersistedGoals()
          }
          else if (event.type === "session.created") {
            if (policy.sessionCreated(event.data.sessionID, event.data.parentID)) await persistTasks()
          }
          else if (event.type === "session.execution.started") {
            await goalManager.observeExecution(event.data.sessionID, "started", event.id)
          }
          else if (event.type === "session.execution.succeeded") {
            const sessionID = event.data.sessionID
            const executionID = await goalManager.observeExecution(sessionID, "succeeded", event.id)
            if (executionID) {
              void ctx.session.wait({ sessionID }, { signal: controller.signal }).then(
                () => goalManager.observeWaitedIdle(sessionID, executionID),
                () => controller.signal.aborted ? undefined : goalManager.observeWaitFailure(sessionID, executionID),
              ).catch((error) => {
                if (!controller.signal.aborted) console.error("Goal idle handoff failed", error)
              })
            }
          }
          else if (event.type === "session.execution.failed") {
            await goalManager.observeExecution(event.data.sessionID, "failed", event.id)
          }
          else if (event.type === "session.execution.interrupted") {
            await goalManager.observeExecution(event.data.sessionID, "interrupted", event.id)
          }
          else if (event.type === "session.agent.selected") {
            await goalManager.agentSelected(event.data.sessionID, event.data.agent)
          }
          else if (event.type === "session.inbox.enqueued") {
            await goalManager.observeInbox(event.data.sessionID, event.data.inboxID, event.data.item)
          }
          else if (event.type === "session.inbox.delivered" || event.type === "session.inbox.cancelled") {
            await goalManager.finishInbox(event.data.sessionID, event.data.inboxID, event.type === "session.inbox.cancelled")
          }
          else if (event.type === "session.inbox.delivery.changed") {
            await goalManager.updateInboxDelivery(event.data.sessionID, event.data.inboxID, event.data.delivery)
          }
          else if (event.type === "session.status") {
            await goalManager.observeStatus(event.data.sessionID, event.data.status.type, event.id)
            if (!policy.isKnownChild(event.data.sessionID)) {
              const found = await ctx.session.get({ sessionID: event.data.sessionID }).catch(() => undefined)
              policy.sessionCreated(event.data.sessionID, found?.parentID)
            }
            const followupChanged = policy.sessionStatus(event.data.sessionID, event.data.status.type)
            if (followupChanged) await persistFollowups()
            await persistTasks()
            notifyCancellationWaiters(event.data.sessionID)
          }
          else if (event.type === "session.deleted") {
            if (policy.sessionDeleted(event.data.sessionID)) await persistFollowups()
            await persistTasks()
            notifyCancellationWaiters(event.data.sessionID)
            memoryLoads.delete(event.data.sessionID)
            goalManager.forgetRuntime(event.data.sessionID)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("orchestration policy event stream failed", error)
      }
    })()
    return async () => {
      controller.abort()
      await goalRpc.dispose()
    }
  },
})
