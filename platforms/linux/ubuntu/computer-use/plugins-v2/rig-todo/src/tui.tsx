/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"

import { parseTodoState, todoStatePath } from "./state.ts"
import type { TodoItem, TodoStatus } from "./store.ts"

const POLL_MS = 1_000
const MAX_VISIBLE = 12

function marker(status: TodoStatus): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[~]"
  if (status === "cancelled") return "[-]"
  return "[ ]"
}

function TodoPanel(props: { sessionID: string }) {
  const context = usePlugin()
  const [items, setItems] = createSignal<TodoItem[]>([])
  const [collapsed, setCollapsed] = createSignal(false)

  const refresh = async () => {
    try {
      const text = await readFile(todoStatePath(props.sessionID), "utf8")
      setItems(parseTodoState(text))
    } catch {
      setItems([])
    }
  }

  createEffect(() => {
    // Re-read immediately when the sidebar switches sessions.
    void props.sessionID
    void refresh()
  })

  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))

  const theme = () => context.theme
  const done = () => items().filter((item) => item.status === "completed").length
  const toggle = () => setCollapsed((value) => !value)

  // The header can be hit-tested to the container or to a text child; mark the
  // event so the first handler to see it toggles exactly once.
  const activateHeader = (event: { button?: number; preventDefault?: () => void; __rigHandled?: boolean }) => {
    if (event.__rigHandled) return
    event.__rigHandled = true
    if (event.button !== 0) return
    event.preventDefault?.()
    toggle()
  }

  const markerColor = (status: TodoStatus) => {
    if (status === "completed") return theme().diff.text.added
    if (status === "in_progress") return theme().hue.accent[200]
    return theme().text.subdued
  }
  const contentColor = (status: TodoStatus) =>
    status === "completed" || status === "cancelled" ? theme().text.subdued : theme().text.default

  return (
    <Show when={items().length > 0}>
      <box flexDirection="column" gap={0}>
        <box
          flexDirection="row"
          gap={1}
          focusable
          onMouseDown={activateHeader}
          onKeyDown={(event) => {
            if (event.name === "return" || event.name === "space") {
              event.preventDefault()
              toggle()
            }
          }}
        >
          <text fg={theme().text.default} onMouseDown={activateHeader}>
            <b>{collapsed() ? "+" : "-"} Todo</b>
          </text>
          <text fg={theme().hue.accent[200]} onMouseDown={activateHeader}>
            <b>
              {done()}/{items().length}
            </b>
          </text>
        </box>
        <Show when={!collapsed()}>
          <For each={items().slice(0, MAX_VISIBLE)}>
            {(item) => (
              <text fg={contentColor(item.status)}>
                <span fg={markerColor(item.status)}>{marker(item.status)} </span>
                {item.content}
              </text>
            )}
          </For>
          <Show when={items().length > MAX_VISIBLE}>
            <text fg={theme().text.subdued}>+{items().length - MAX_VISIBLE} more</text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-rig.todo-panel",
  setup(context) {
    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <TodoPanel sessionID={sessionID} />,
    })
    return () => stopSidebar()
  },
})
