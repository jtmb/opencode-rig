import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Plugin } from "@opencode/plugin"

import {
  appendTodoTransitions,
  formatArchivedTodoPage,
  formatTodoEventPage,
  isTodoArchiveStatus,
  queryArchivedTodos,
  queryTodoEvents,
  todoArchiveRoot,
  type TodoArchiveQuery,
} from "./archive.ts"
import { normalizeTodoIdentity, type TodoIdentity } from "./identity.ts"
import { createTodoRecorder } from "./recording.ts"
import { serializeTodoState, todoStatePath } from "./state.ts"
import { enforceSingleInProgress, normalizeTodos, summarize, type TodoItem } from "./store.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export default Plugin.define({
  id: "opencode-rig.todo",
  async setup(ctx) {
    const keyFor = (sessionID: string) => `todos/${sessionID}`
    const identityKeyFor = (sessionID: string) => `todos/${sessionID}/identity`

    const readTodos = async (sessionID: string): Promise<TodoItem[]> =>
      normalizeTodos(await ctx.storage.get(keyFor(sessionID)))

    const writeTodos = async (sessionID: string, todos: readonly TodoItem[]): Promise<void> => {
      await ctx.storage.set(keyFor(sessionID), todos as unknown as Parameters<typeof ctx.storage.set>[1])
    }

    const readIdentity = async (sessionID: string): Promise<TodoIdentity> =>
      normalizeTodoIdentity(await ctx.storage.get(identityKeyFor(sessionID)))

    const writeIdentity = async (sessionID: string, identity: TodoIdentity): Promise<void> => {
      await ctx.storage.set(identityKeyFor(sessionID), identity as unknown as Parameters<typeof ctx.storage.set>[1])
    }

    // Mirror the authoritative storage into a small JSON file so the CLI
    // sidebar panel can render it without a server RPC channel.
    const mirrorTodos = async (sessionID: string, todos: readonly TodoItem[]): Promise<void> => {
      try {
        const target = todoStatePath(sessionID)
        await mkdir(path.dirname(target), { recursive: true })
        const temporary = `${target}.${process.pid}.tmp`
        await writeFile(temporary, serializeTodoState(todos), "utf8")
        await rename(temporary, target)
      } catch {
        // The panel is a convenience; ctx.storage stays authoritative.
      }
    }

    const removeMirror = async (sessionID: string): Promise<void> => {
      await rm(todoStatePath(sessionID), { force: true }).catch(() => undefined)
    }

    // Archive first, then accept the list: a failed archive append refuses the
    // replacement instead of silently dropping history. Durable history is
    // intentionally never removed here, so a deleted or compacted session keeps
    // its full Todo transitions.
    const recorder = createTodoRecorder({
      readTodos,
      writeTodos,
      readIdentity,
      writeIdentity,
      mirrorTodos,
      appendTransitions: appendTodoTransitions,
      archiveRoot: () => todoArchiveRoot(),
      now: () => new Date().toISOString(),
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "todowrite",
        description:
          "Create or replace the session todo list to track multi-step work. Send the complete list on every call; it replaces the previous list. Keep exactly one item in_progress while working and mark items completed only after their verification passes. The replacement is refused if its history cannot be durably archived.",
        input: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "The complete todo list; replaces any existing list.",
              items: {
                type: "object",
                properties: {
                  content: { type: "string", description: "Task description" },
                  status: {
                    type: "string",
                    enum: ["pending", "in_progress", "completed", "cancelled"],
                    description: "Task state; at most one item may be in_progress.",
                  },
                  priority: { type: "string", enum: ["high", "medium", "low"], description: "Optional priority" },
                },
                required: ["content", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["todos"],
          additionalProperties: false,
        },
        async execute(raw, context) {
          const todos = enforceSingleInProgress(normalizeTodos((raw as { todos?: unknown }).todos))
          const sessionID = String(context.sessionID)
          return recorder.write(sessionID, todos)
        },
      })

      editor.add({
        name: "todoread",
        description: "Read the session todo list to see what is pending, in progress, or done.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_raw, context) {
          const sessionID = String(context.sessionID)
          const todos = await readTodos(sessionID)
          await mirrorTodos(sessionID, todos)
          return { content: summarize(todos) }
        },
      })

      editor.add({
        name: "todo_history",
        description:
          "Read a bounded, read-only page of the durable Todo history. The archive is append-only and is retained after the session is deleted or compacted. Filter by text, status, kind, or time range, and continue into older transitions with beforeSeq.",
        input: {
          type: "object",
          properties: {
            view: {
              type: "string",
              enum: ["todos", "events"],
              description: "todos returns the latest state per item; events returns raw transition records with a continuation cursor.",
            },
            text: { type: "string", description: "Case-insensitive task text filter." },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled", "removed"],
              description: "Filter by recorded status (events view) or latest status (todos view).",
            },
            kind: {
              type: "string",
              enum: ["created", "status_changed", "content_changed", "priority_changed", "removed"],
              description: "Events view only: filter by transition kind.",
            },
            from: { type: "string", description: "Inclusive ISO lower bound on transition time." },
            to: { type: "string", description: "Inclusive ISO upper bound on transition time." },
            beforeSeq: {
              type: "integer",
              minimum: 1,
              description: "Events view only: only return transitions with seq below this cursor. Use the previous page's nextBeforeSeq.",
            },
            page: { type: "integer", minimum: 0, description: "Zero-based page index." },
            limit: { type: "integer", minimum: 1, maximum: 50, description: "Page size (max 50)." },
          },
          additionalProperties: false,
        },
        async execute(raw, context) {
          const input = isRecord(raw) ? raw : {}
          const sessionID = String(context.sessionID)
          const limit = typeof input.limit === "number" ? Math.min(50, Math.max(1, Math.floor(input.limit))) : undefined
          const page = typeof input.page === "number" ? Math.max(0, Math.floor(input.page)) : 0
          const status = isTodoArchiveStatus(input.status) ? input.status : undefined
          const kind = input.kind === "created" || input.kind === "status_changed" || input.kind === "content_changed" || input.kind === "priority_changed" || input.kind === "removed" ? input.kind : undefined
          const beforeSeq =
            typeof input.beforeSeq === "number" && Number.isFinite(input.beforeSeq) && input.beforeSeq > 0
              ? Math.floor(input.beforeSeq)
              : undefined
          const query: TodoArchiveQuery = {
            sessionID,
            ...(typeof input.text === "string" && input.text.length > 0 ? { text: input.text } : {}),
            ...(typeof input.from === "string" && input.from.length > 0 ? { from: input.from } : {}),
            ...(typeof input.to === "string" && input.to.length > 0 ? { to: input.to } : {}),
            ...(status ? { status } : {}),
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
            limit,
          }
          const root = todoArchiveRoot()
          if (input.view === "events") {
            const result = await queryTodoEvents(root, { ...query, offset: beforeSeq !== undefined ? 0 : (limit ?? 20) * page, ...(kind ? { kind } : {}) })
            return { content: formatTodoEventPage(result) }
          }
          const result = await queryArchivedTodos(root, { ...query, offset: (limit ?? 20) * page })
          return { content: formatArchivedTodoPage(result) }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const generic = event as unknown as { type?: string; data?: unknown }
          if (generic.type !== "session.deleted") continue
          const data = isRecord(generic.data) ? generic.data : {}
          const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
          if (sessionID) {
            // The archive deliberately survives: only session-scoped storage and
            // the sidebar mirror are removed.
            await ctx.storage.remove(keyFor(sessionID)).catch(() => undefined)
            await ctx.storage.remove(identityKeyFor(sessionID)).catch(() => undefined)
            await removeMirror(sessionID)
          }
        }
      } catch {
        // The subscription ends when the plugin unloads; nothing else to do.
      }
    })()

    return () => controller.abort()
  },
})
