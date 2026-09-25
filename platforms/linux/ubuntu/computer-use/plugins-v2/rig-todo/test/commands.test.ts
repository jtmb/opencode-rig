import assert from "node:assert/strict"
import test from "node:test"

import { registerTasksCommand } from "../src/commands.ts"
import { TASKS_PANEL_NAME } from "../src/tasks.ts"

test("/tasks registers the full-screen panel command in the app keymap layer", () => {
  const claims: Array<{ append?: string; render: () => unknown }> = []
  const layers: Array<() => { commands?: Array<{ slash?: { name: string }; run: () => void }> }> = []
  const opened: unknown[][] = []
  const alerts: unknown[] = []
  const context = {
    ui: {
      slot: (claim: { append?: string; render: () => unknown }) => {
        claims.push(claim)
        return () => undefined
      },
      panel: {
        open: (name: string, options: { presentation: string }) => {
          opened.push([name, options])
          return true
        },
      },
      dialog: { alert: async (input: unknown) => { alerts.push(input) } },
    },
    keymap: { layer: (layer: () => never) => { layers.push(layer as never) } },
  } as never

  const stop = registerTasksCommand(context)
  assert.equal(claims[0]?.append, "app")
  claims[0]?.render()
  const command = layers[0]?.().commands?.[0]
  assert.equal(command?.slash?.name, "tasks")
  command?.run()
  assert.deepEqual(opened, [[TASKS_PANEL_NAME, { presentation: "fullscreen" }]])
  assert.deepEqual(alerts, [])
  stop()
})

test("/tasks explains when there is no active session to host the panel", async () => {
  const claims: Array<{ append?: string; render: () => unknown }> = []
  const layers: Array<() => { commands?: Array<{ run: () => void }> }> = []
  const alerts: unknown[] = []
  const context = {
    ui: {
      slot: (claim: { append?: string; render: () => unknown }) => {
        claims.push(claim)
        return () => undefined
      },
      panel: { open: () => false },
      dialog: { alert: async (input: unknown) => { alerts.push(input) } },
    },
    keymap: { layer: (layer: () => never) => { layers.push(layer as never) } },
  } as never

  registerTasksCommand(context)
  claims[0]?.render()
  layers[0]?.().commands?.[0]?.run()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(alerts, [{ title: "Todo tasks", message: "This view requires an active session." }])
})
