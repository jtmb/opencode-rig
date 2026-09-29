import type { Context } from "@opencode/plugin/tui/context"

import { TASKS_PANEL_NAME } from "./tasks.ts"

export function registerTasksCommand(context: Pick<Context, "keymap" | "ui">): () => void {
  return context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "opencode-rig.todo.tasks",
            title: "Todo tasks",
            description: "Open the full-screen Todo Kanban and retained history.",
            group: "Todo",
            palette: true,
            slash: { name: "tasks" },
            run: () => {
              const opened = context.ui.panel.open(TASKS_PANEL_NAME, { presentation: "fullscreen" })
              if (!opened) {
                void context.ui.dialog.alert({ title: "Todo tasks", message: "This view requires an active session." }).catch(() => undefined)
              }
            },
          },
        ],
      }))
      return null as never
    },
  })
}
