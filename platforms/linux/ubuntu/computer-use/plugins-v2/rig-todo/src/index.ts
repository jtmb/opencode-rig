import { Plugin } from "@opencode/plugin"

import { enforceSingleInProgress, normalizeTodos, summarize, type TodoItem } from "./store.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export default Plugin.define({
  id: "opencode-rig.todo",
  async setup(ctx) {
    const keyFor = (sessionID: string) => `todos/${sessionID}`

    const readTodos = async (sessionID: string): Promise<TodoItem[]> =>
      normalizeTodos(await ctx.storage.get(keyFor(sessionID)))

    const writeTodos = async (sessionID: string, todos: readonly TodoItem[]): Promise<void> => {
      await ctx.storage.set(keyFor(sessionID), todos as unknown as Parameters<typeof ctx.storage.set>[1])
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "todowrite",
        description:
          "Create or replace the session todo list to track multi-step work. Send the complete list on every call; it replaces the previous list. Keep exactly one item in_progress while working and mark items completed only after their verification passes.",
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
          await writeTodos(String(context.sessionID), todos)
          return { content: summarize(todos) }
        },
      })

      editor.add({
        name: "todoread",
        description: "Read the session todo list to see what is pending, in progress, or done.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_raw, context) {
          return { content: summarize(await readTodos(String(context.sessionID))) }
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
          if (sessionID) await ctx.storage.remove(keyFor(sessionID)).catch(() => undefined)
        }
      } catch {
        // The subscription ends when the plugin unloads; nothing else to do.
      }
    })()

    return () => controller.abort()
  },
})
