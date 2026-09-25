import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative } from "node:path"

import { createMemoryCapacityEvaluator } from "../../rig-tools/src/memory-capacity.ts"
import {
  createOrchestrationPolicy,
  validateAgentPolicyIndex,
  type CorrectionLedgerInput,
  type MemorySnapshot,
  type ReconciliationInput,
  type SubagentFollowupInput,
  type TaskCompletionInput,
  type TaskDeclarationInput,
  type ToolErrorAcknowledgementInput,
} from "./policy.ts"

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
    const policy = createOrchestrationPolicy(rawOptions, {
      capacityDiagnostic: createMemoryCapacityEvaluator(rawOptions),
      resolveAgentModel: async (agentID) => modelReference((await ctx.agent.get({ agentID })).data.model),
      projectRoot: ctx.location.project.canonical,
    })
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
    const reconciliationSnapshot = policy.options.memoryProject && policy.options.memoryDirectory
      ? await loadMemory(policy.options.memoryProject, policy.options.memoryBindings, policy.options.memoryDirectory)
      : undefined
    policy.restoreReconciliation(await ctx.storage.get(RECONCILIATION_STATE_KEY), reconciliationSnapshot)
    const root = ctx.location.project.canonical
    const memoryLoads = new Map<string, Promise<MemorySnapshot>>()
    const enqueueWrite = createSerialWriteQueue()
    const persistFollowups = () =>
      enqueueWrite(() => ctx.storage.set(FOLLOWUP_STATE_KEY, policy.pendingFollowupRecords()))
    const persistTasks = () =>
      enqueueWrite(() => ctx.storage.set(TASK_STATE_KEY, policy.taskStateRecords()))
    const persistLifecycle = () => enqueueWrite(async () => {
      const tasks = policy.taskStateRecords()
      const followups = policy.pendingFollowupRecords()
      await Promise.all([
        ctx.storage.set(TASK_STATE_KEY, tasks),
        ctx.storage.set(FOLLOWUP_STATE_KEY, followups),
      ])
    })
    const persistToolErrors = () => enqueueWrite(() => ctx.storage.set(TOOL_ERROR_STATE_KEY, policy.toolErrorStorageValue()))
    const persistReconciliation = () =>
      enqueueWrite(() => ctx.storage.set(RECONCILIATION_STATE_KEY, policy.reconciliationStorageValue()))
    const refreshTasks = async () =>
      policy.restoreTaskState(await ctx.storage.get(TASK_STATE_KEY))
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
      await policy.before(event)
    })
    await ctx.tool.hook("execute.after", async (event) => {
      const toolErrorChanged = policy.after(event)
      if (event.tool === "subagent") await persistTasks()
      if (toolErrorChanged) await persistToolErrors()
    })
    await ctx.tool.transform((editor) => {
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
      if (policy.userPrompt(String(event.sessionID))) await persistReconciliation()
    })
    await ctx.session.hook("context", async (event) => {
      await refreshTasks()
      if (policy.options.enforceAgentIndex) policy.setIndexErrors(await agentPolicyIndexErrors(root))
      const sessionID = String(event.sessionID)
      if (policy.options.memoryProject && policy.options.memoryDirectory && policy.needsMemorySnapshot(sessionID)) {
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
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.created") {
            if (policy.sessionCreated(event.data.sessionID, event.data.parentID)) await persistTasks()
          }
          else if (event.type === "session.status") {
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
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("orchestration policy event stream failed", error)
      }
    })()
    return () => controller.abort()
  },
})
