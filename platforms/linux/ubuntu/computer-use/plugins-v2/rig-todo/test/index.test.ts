import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import plugin from "../src/index.ts"

const SESSION = "ses_historytool"

interface RegisteredTool {
  readonly name: string
  readonly execute: (input: unknown, context: { readonly sessionID: string }) => Promise<{ readonly content: string }>
}

test("todo_history serves filtered latest states and cursor-paged transitions", async () => {
  const dataHome = await mkdtemp(path.join(tmpdir(), "rig-todo-history-tool-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dataHome
  const storage = new Map<string, unknown>()
  const tools = new Map<string, RegisteredTool>()
  let cleanup: (() => Promise<void> | void) | undefined

  try {
    const dispose = await plugin.setup({
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => { storage.set(key, value) },
        remove: async (key: string) => { storage.delete(key) },
      },
      tool: {
        transform: async (register: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
          register({ add: (tool) => tools.set(tool.name, tool) })
        },
      },
      event: { subscribe: async function* () {} },
    } as never)
    if (typeof dispose === "function") cleanup = dispose

    assert.deepEqual([...tools.keys()], ["todowrite", "todoread", "todo_history"])
    const write = tools.get("todowrite")!
    const history = tools.get("todo_history")!
    await write.execute({
      todos: [
        { content: "Ship the release checklist", status: "pending" },
        { content: "Review the release notes", status: "pending" },
      ],
    }, { sessionID: SESSION })
    await write.execute({
      todos: [
        { content: "Ship the release checklist", status: "completed" },
        { content: "Review the release notes", status: "in_progress" },
      ],
    }, { sessionID: SESSION })

    const first = await history.execute({ view: "events", limit: 1 }, { sessionID: SESSION })
    assert.match(first.content, /Todo transitions: rows 1-1 · more available/)
    assert.match(first.content, /Review the release notes/)
    const cursor = Number(/next beforeSeq: (\d+)/.exec(first.content)?.[1])
    assert.ok(Number.isInteger(cursor) && cursor > 0, first.content)

    const older = await history.execute({ view: "events", beforeSeq: cursor, limit: 1 }, { sessionID: SESSION })
    assert.match(older.content, /Ship the release checklist/)
    assert.match(older.content, /pending -> completed/)

    const completed = await history.execute({ view: "todos", status: "completed" }, { sessionID: SESSION })
    assert.match(completed.content, /Ship the release checklist/)
    assert.doesNotMatch(completed.content, /Review the release notes/)
  } finally {
    await cleanup?.()
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    await rm(dataHome, { recursive: true, force: true })
  }
})
