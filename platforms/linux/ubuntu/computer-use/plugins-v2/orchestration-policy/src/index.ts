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
} from "./policy.ts"

const MAX_MEMORY_ENTRIES = 32
const MAX_MEMORY_CONTENT = 4_000
const MAX_MEMORY_FILES = 512
const MAX_MEMORY_FILE_BYTES = 64 * 1024
const FOLLOWUP_STATE_KEY = "subagent-followup/pending"
const TASK_STATE_KEY = "orchestration-task/state"

async function regularText(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} must be a regular non-symlink file`)
  return readFile(path, "utf8")
}

async function indexErrors(root: string) {
  try {
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

export function createSerialWriteQueue() {
  let tail: Promise<void> = Promise.resolve()
  return <T>(write: () => Promise<T>): Promise<T> => {
    const next = tail.then(write, write)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
}

export default Plugin.define({
  id: "opencode-rig.orchestration-policy",
  async setup(ctx) {
    const rawOptions = { ...((ctx.options ?? {}) as Record<string, unknown>) }
    rawOptions.protectedPaths ??= [
      join(homedir(), ".local", "opt", "opencode"),
      join(homedir(), ".local", "lib", "opencode"),
      "/opt/opencode",
      "/usr/local/lib/node_modules/opencode",
      "/usr/lib/node_modules/opencode",
    ]
    const policy = createOrchestrationPolicy(rawOptions, {
      capacity: createMemoryCapacityEvaluator(rawOptions),
      resolveAgentModel: async (agentID) => modelReference((await ctx.agent.get({ agentID })).data.model),
    })
    policy.restoreFollowups(await ctx.storage.get(FOLLOWUP_STATE_KEY))
    policy.restoreTaskState(await ctx.storage.get(TASK_STATE_KEY))
    const root = ctx.location.project.canonical
    const memoryLoads = new Map<string, Promise<MemorySnapshot>>()
    const enqueueWrite = createSerialWriteQueue()
    const persistFollowups = () => {
      const snapshot = policy.pendingFollowupRecords()
      return enqueueWrite(() => ctx.storage.set(FOLLOWUP_STATE_KEY, snapshot))
    }
    const persistTasks = () => {
      const snapshot = policy.taskStateRecords()
      return enqueueWrite(() => ctx.storage.set(TASK_STATE_KEY, snapshot))
    }
    const refreshTasks = async () =>
      policy.restoreTaskState(await ctx.storage.get(TASK_STATE_KEY))

    await ctx.agent.transform((editor) => {
      if (!policy.options.enabled) return
      for (const agentID of policy.options.allowedAgents) {
        editor.update(agentID, (agent) => {
          agent.permissions.push({ action: "subagent", resource: "*", effect: "deny" })
          agent.permissions.push({ action: "repo_commit", resource: "*", effect: "deny" })
          agent.permissions.push({ action: "repo_push", resource: "*", effect: "deny" })
        })
      }
    })

    await ctx.tool.hook("execute.before", async (event) => {
      await refreshTasks()
      await policy.before(event)
    })
    await ctx.tool.hook("execute.after", async (event) => {
      policy.after(event)
      if (event.tool === "subagent") await persistTasks()
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
        name: "task_declare",
        description:
          "Declare a repository change, review, release, or correction task before repository mutation. A task may launch capacity-bounded background children and requires at least one accepted parent follow-up.",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["change", "review", "release", "correction"] },
            summary: { type: "string", minLength: 1, maxLength: 1000 },
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
          "Acknowledge one correction ledger after updating ROADMAP.md, the active todo list, or project-bound Basic Memory, or record an explicit scoped no-write resolution.",
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
        name: "task_complete",
        description:
          "Record verified task completion. Fails unless delegation, child completion, accepted parent follow-up, and correction ledgers are complete.",
        input: {
          type: "object",
          properties: {
            verification: { type: "string", minLength: 1, maxLength: 1000 },
          },
          required: ["verification"],
          additionalProperties: false,
        },
        async execute(value, context) {
          const completed = policy.completeTask(String(context.sessionID), value as TaskCompletionInput)
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
          "Complete a due project-scoped durable-rule reconciliation after reviewing the automatically loaded Basic Memory context. Report conflicts truthfully; unresolved conflicts require the question tool first.",
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
          await ctx.storage.set(`reconciliation/${context.sessionID}`, audit)
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
          await enqueueWrite(async () => {
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
    await ctx.session.hook("prompt", (event) => {
      policy.userPrompt(String(event.sessionID))
    })
    await ctx.session.hook("context", async (event) => {
      await refreshTasks()
      if (policy.options.enforceAgentIndex) policy.setIndexErrors(await indexErrors(root))
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
      const text = policy.instructions(sessionID)
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
          }
          else if (event.type === "session.deleted") {
            if (policy.sessionDeleted(event.data.sessionID)) await persistFollowups()
            await persistTasks()
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
