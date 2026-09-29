import assert from "node:assert/strict"
import test from "node:test"

import plugin from "../src/index.ts"

test("registers the shared RPC and one session-scoped agent tool", async () => {
  const tools = new Map<string, { execute: (input: unknown, context: unknown) => Promise<{ content: string }> }>()
  let handlers: Record<string, (input: unknown) => Promise<unknown>> | undefined
  const context = {
    options: {},
    rpc: {
      register: async (_definition: unknown, registered: Record<string, (input: unknown) => Promise<unknown>>) => {
        handlers = registered
        return { events: { emit: async () => {} } }
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }) => void }) => void) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
      },
    },
    event: { subscribe: async function* () {} },
  }

  const cleanup = await plugin.setup(context as never)
  assert.ok(handlers?.status)
  assert.ok(tools.has("integrated_browser"))
  const result = await tools.get("integrated_browser")?.execute({ action: "status" }, { sessionID: "ses_plugin" })
  assert.deepEqual(JSON.parse(result?.content ?? "{}"), {
    sessionID: "ses_plugin",
    state: "stopped",
    tabs: [],
    viewport: { width: 1280, height: 720 },
  })
  await cleanup?.()
})
