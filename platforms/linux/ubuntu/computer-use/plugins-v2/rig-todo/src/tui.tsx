/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { TextAttributes, type ColorInput } from "@opentui/core"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"

import { parseTodoState, todoStatePath } from "./state.ts"
import { historySummary, overlayRunningChildTodos, visibleTodosForDisplay, type TodoItem, type TodoStatus } from "./store.ts"
import { queryArchivedTodos, todoArchiveRoot, type ArchivedTodo } from "./archive.ts"
import { todoPalette } from "./palette.ts"
import { registerTasksCommand } from "./commands.ts"
import { TASKS_PANEL_NAME } from "./tasks.ts"
import { TasksPanel } from "./tasks-panel.tsx"

const POLL_MS = 1_000
const MAX_CHILD_SESSIONS = 32
const HISTORY_PAGE_SIZE = 8

async function runningDirectChildTitles(context: ReturnType<typeof usePlugin>, sessionID: string): Promise<Set<string>> {
  try {
    const parent = await context.client.session.get({ sessionID })
    const [children, active] = await Promise.all([
      context.client.session.list({
        parentID: parent.id,
        project: parent.projectID,
        directory: parent.location.directory,
        order: "desc",
        limit: MAX_CHILD_SESSIONS,
      }),
      context.client.session.active(),
    ])
    return new Set(
      children.data
        .filter((child) => child.parentID === parent.id && child.projectID === parent.projectID && child.location.directory === parent.location.directory && active[child.id]?.type === "running")
        .map((child) => child.title?.trim() ?? "")
        .filter((title) => title.length > 0),
    )
  } catch {
    return new Set()
  }
}

function marker(status: TodoStatus | "removed"): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[~]"
  if (status === "cancelled" || status === "removed") return "[-]"
  return "[ ]"
}

export function TodoRow(props: {
  item: TodoItem
  markerColor: (status: TodoStatus) => ColorInput
  contentColor: (status: TodoStatus) => ColorInput
}) {
  return (
    <box flexDirection="row" width="100%" gap={1} paddingLeft={2}>
      <text flexShrink={0} wrapMode="word" fg={props.markerColor(props.item.status)}>
        {marker(props.item.status)}
      </text>
      <box flexGrow={1} minWidth={0} flexShrink={1}>
        <text
          wrapMode="word"
          fg={props.contentColor(props.item.status)}
        >
          {props.item.content}
        </text>
      </box>
    </box>
  )
}

export function TodoPanel(props: { sessionID: string }) {
  const context = usePlugin()
  const [items, setItems] = createSignal<TodoItem[]>([])
  const [runningChildTitles, setRunningChildTitles] = createSignal<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = createSignal(false)
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [historyPage, setHistoryPage] = createSignal(0)
  const [historyItems, setHistoryItems] = createSignal<readonly ArchivedTodo[]>([])
  const [historyHasMore, setHistoryHasMore] = createSignal(false)
  const [historyTruncated, setHistoryTruncated] = createSignal(false)
  const [historyLoaded, setHistoryLoaded] = createSignal(false)

  const loadHistory = async (page: number): Promise<void> => {
    const result = await queryArchivedTodos(todoArchiveRoot(), {
      sessionID: props.sessionID,
      limit: HISTORY_PAGE_SIZE,
      offset: page * HISTORY_PAGE_SIZE,
    }).catch(() => undefined)
    if (!result) return
    setHistoryItems(result.items)
    setHistoryHasMore(result.hasMore)
    setHistoryTruncated(result.truncated)
    setHistoryLoaded(true)
  }

  const refresh = async () => {
    const [nextItems, nextChildTitles] = await Promise.all([
      readFile(todoStatePath(props.sessionID), "utf8").then((text) => parseTodoState(text)).catch(() => []),
      runningDirectChildTitles(context, props.sessionID),
    ])
    setItems(nextItems)
    setRunningChildTitles(nextChildTitles)
    if (historyOpen()) await loadHistory(historyPage())
  }

  createEffect(() => {
    // Re-read immediately when the sidebar switches sessions.
    void props.sessionID
    void refresh()
  })

  const timer = setInterval(() => void refresh(), POLL_MS)
  onCleanup(() => clearInterval(timer))

  const [themeVersion, setThemeVersion] = createSignal(0)
  const refreshTheme = () => setThemeVersion((value) => value + 1)
  if (typeof context.renderer.on === "function") {
    context.renderer.on("palette", refreshTheme)
    context.renderer.on("theme_mode", refreshTheme)
  }
  onCleanup(() => {
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })
  const theme = () => {
    themeVersion()
    return context.theme
  }
  const palette = () => todoPalette(theme())
  const done = () => items().filter((item) => item.status === "completed").length
  const display = () => visibleTodosForDisplay(overlayRunningChildTodos(items(), runningChildTitles()))
  const toggle = () => setCollapsed((value) => !value)
  const toggleHistory = () => {
    const next = !historyOpen()
    setHistoryOpen(next)
    if (next) {
      setHistoryPage(0)
      void loadHistory(0)
    }
  }
  const pageHistory = (delta: number) => {
    const next = Math.max(0, historyPage() + delta)
    setHistoryPage(next)
    void loadHistory(next)
  }

  // The header can be hit-tested to the container or to a text child; mark the
  // event so the first handler to see it toggles exactly once.
  const activateHeader = (event: { button?: number; preventDefault?: () => void; __rigHandled?: boolean }) => {
    if (event.__rigHandled) return
    event.__rigHandled = true
    if (event.button !== 0) return
    event.preventDefault?.()
    toggle()
  }
  const activateHistory = (event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void; __rigHandled?: boolean }) => {
    if (event.__rigHandled) return
    event.__rigHandled = true
    if (event.button !== 0) return
    event.preventDefault?.()
    event.stopPropagation?.()
    toggleHistory()
  }

  const markerColor = (status: TodoStatus | "removed") => {
    if (status === "completed") return palette().ready
    if (status === "in_progress") return palette().primary
    return palette().subdued
  }
  const contentColor = (status: TodoStatus | "removed") =>
    status === "in_progress" ? palette().primary : palette().subdued

  return (
    <Show when={items().length > 0}>
      <box flexDirection="column" width="100%" gap={0} marginTop={1} flexShrink={0}>
        <box
          flexDirection="row"
          width="100%"
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
          <text fg={palette().primary} attributes={TextAttributes.BOLD} onMouseDown={activateHeader}>
            {collapsed() ? "+ Todo" : "- Todo"}
          </text>
          <box flexGrow={1} />
          <Show when={display().hiddenHistory > 0 || historyOpen()}>
            <text fg={palette().action} onMouseDown={activateHistory}>
              {historyOpen() ? "hide history" : "history"}
            </text>
          </Show>
          <text fg={palette().sectionCount} attributes={TextAttributes.BOLD} onMouseDown={activateHeader}>
            {`${done()}/${items().length}`}
          </text>
        </box>
        <Show when={!collapsed()}>
          <For each={display().items}>
            {(item) => <TodoRow item={item} markerColor={markerColor} contentColor={contentColor} />}
          </For>
          <Show when={display().hiddenHistory > 0}>
            <box paddingLeft={2}>
              <text fg={theme().text.subdued} attributes={TextAttributes.DIM}>{historySummary(display().hiddenHistory)}</text>
            </box>
          </Show>
          <Show when={historyOpen()}>
            <box flexDirection="column" width="100%" gap={0}>
              <Show when={historyLoaded() && historyItems().length === 0}>
                <box paddingLeft={2}>
                  <text fg={theme().text.subdued} attributes={TextAttributes.DIM}>No archived history yet.</text>
                </box>
              </Show>
              <For each={historyItems()}>
                {(item) => <ArchivedTodoRow item={item} markerColor={markerColor} contentColor={contentColor} />}
              </For>
              <box flexDirection="row" width="100%" gap={1} paddingLeft={2}>
                <text fg={palette().action} onMouseDown={() => pageHistory(-1)}>
                  {historyPage() > 0 ? "‹ newer" : ""}
                </text>
                <box flexGrow={1} />
                <text fg={theme().text.subdued} attributes={TextAttributes.DIM}>
                  {`history page ${historyPage() + 1}`}
                </text>
                <box flexGrow={1} />
                <text fg={palette().action} onMouseDown={() => pageHistory(1)}>
                  {historyHasMore() ? "older ›" : ""}
                </text>
              </box>
              <Show when={historyTruncated()}>
                <box paddingLeft={2}>
                  <text fg={theme().text.subdued} attributes={TextAttributes.DIM}>
                    Bounded scan reached; refine the history filters.
                  </text>
                </box>
              </Show>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

/** Read-only archive row. Unlike the live sidebar it may render terminal states. */
export function ArchivedTodoRow(props: {
  item: ArchivedTodo
  markerColor: (status: TodoStatus | "removed") => ColorInput
  contentColor: (status: TodoStatus | "removed") => ColorInput
}) {
  return (
    <box flexDirection="row" width="100%" gap={1} paddingLeft={2}>
      <text flexShrink={0} wrapMode="word" fg={props.markerColor(props.item.status)}>
        {marker(props.item.status)}
      </text>
      <box flexGrow={1} minWidth={0} flexShrink={1}>
        <text wrapMode="word" fg={props.contentColor(props.item.status)}>
          {props.item.content}
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.todo-panel",
  setup(context) {
    const stopSidebar = context.ui.slot({
      after: "sidebar.content",
      render: ({ sessionID }) => <TodoPanel sessionID={sessionID} />,
    })
    const stopPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => panel.name === TASKS_PANEL_NAME ? <TasksPanel panel={panel} /> : null,
    })
    const stopCommand = registerTasksCommand(context)
    return () => {
      stopSidebar()
      stopPanel()
      stopCommand()
    }
  },
})
