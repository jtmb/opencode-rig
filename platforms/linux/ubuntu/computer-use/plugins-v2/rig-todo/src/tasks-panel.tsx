/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { TextAttributes, type ColorInput } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { readFile } from "node:fs/promises"

import { ARCHIVE_MAX_SCAN, queryArchivedTodos, todoArchiveRoot, type ArchivedTodo } from "./archive.ts"
import { todoPalette } from "./palette.ts"
import { parseTodoState, todoStatePath } from "./state.ts"
import { groupTodosByStatus, type TodoColumn } from "./tasks.ts"
import type { TodoItem, TodoStatus } from "./store.ts"

const POLL_MS = 1_000
const HISTORY_PAGE_SIZE = 8
const WIDE_LAYOUT_MIN_WIDTH = 112

type TasksView = "board" | "history"

function marker(status: TodoStatus | "removed"): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[~]"
  if (status === "cancelled" || status === "removed") return "[-]"
  return "[ ]"
}

function statusLabel(status: TodoStatus | "removed"): string {
  if (status === "in_progress") return "In progress"
  if (status === "pending") return "To do"
  if (status === "completed") return "Completed"
  if (status === "removed") return "Removed"
  return "Cancelled"
}

function statusColor(status: TodoStatus | "removed", palette: ReturnType<typeof todoPalette>) {
  if (status === "in_progress") return palette.action
  if (status === "completed") return palette.ready
  if (status === "pending") return palette.primary
  return palette.subdued
}

function eventButton(event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void }, action: () => void) {
  if (event.button !== 0) return
  event.preventDefault?.()
  event.stopPropagation?.()
  action()
}

function TodoCard(props: {
  item: TodoItem
  selected: boolean
  palette: ReturnType<typeof todoPalette>
  background: ColorInput
  border: ColorInput
  onSelect: () => void
}) {
  return (
    <box
      flexDirection="column"
      width="100%"
      gap={1}
      padding={1}
      marginBottom={1}
      borderStyle="single"
      borderColor={props.selected ? props.palette.action : props.border}
      backgroundColor={props.selected ? props.background : undefined}
      focusable
      onMouseDown={(event) => eventButton(event, props.onSelect)}
    >
      <box flexDirection="row" gap={1} height={1}>
        <text fg={statusColor(props.item.status, props.palette)} attributes={TextAttributes.BOLD}>
          {marker(props.item.status)}
        </text>
        <Show when={props.item.priority}>
          <text fg={props.palette.subdued} attributes={TextAttributes.DIM}>{props.item.priority}</text>
        </Show>
      </box>
      <text wrapMode="word" fg={props.item.status === "completed" || props.item.status === "cancelled" ? props.palette.subdued : props.palette.primary}>
        {props.item.content}
      </text>
    </box>
  )
}

function TodoColumnView(props: {
  column: TodoColumn
  columnIndex: number
  selectedColumn: number
  selectedRow: number
  compact: boolean
  palette: ReturnType<typeof todoPalette>
  background: ColorInput
  border: ColorInput
  onSelectColumn: (index: number) => void
  onSelectRow: (column: number, row: number) => void
}) {
  const columnFocused = () => props.selectedColumn === props.columnIndex
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      minHeight={0}
      width={props.compact ? "100%" : undefined}
      borderStyle="single"
      borderColor={columnFocused() ? props.palette.action : props.border}
      padding={1}
      onMouseDown={(event) => eventButton(event, () => props.onSelectColumn(props.columnIndex))}
    >
      <box flexDirection="row" gap={1} paddingBottom={1}>
        <text fg={columnFocused() ? props.palette.action : props.palette.primary} attributes={TextAttributes.BOLD}>
          {props.column.title}
        </text>
        <text fg={props.palette.sectionCount}>{String(props.column.items.length)}</text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
        <Show when={props.column.items.length > 0} fallback={<text fg={props.palette.subdued}>No {props.column.title.toLowerCase()} tasks.</text>}>
          <For each={props.column.items}>
            {(item, row) => (
              <TodoCard
                item={item}
                selected={columnFocused() && props.selectedRow === row()}
                palette={props.palette}
                background={props.background}
                border={props.border}
                onSelect={() => props.onSelectRow(props.columnIndex, row())}
              />
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  )
}

function ArchivedTodoRow(props: {
  item: ArchivedTodo
  palette: ReturnType<typeof todoPalette>
}) {
  return (
    <box flexDirection="column" width="100%" gap={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
      <box flexDirection="row" gap={1} height={1}>
        <text fg={statusColor(props.item.status, props.palette)} attributes={TextAttributes.BOLD}>
          {marker(props.item.status)} {statusLabel(props.item.status)}
        </text>
        <Show when={props.item.priority}>
          <text fg={props.palette.subdued} attributes={TextAttributes.DIM}>{props.item.priority}</text>
        </Show>
        <box flexGrow={1} />
        <text fg={props.palette.subdued} attributes={TextAttributes.DIM}>{props.item.updatedAt}</text>
      </box>
      <text wrapMode="word" fg={props.palette.subdued}>{props.item.content}</text>
    </box>
  )
}

function HistoryPageControls(props: {
  page: number
  hasMore: boolean
  palette: ReturnType<typeof todoPalette>
  onPage: (delta: number) => void
}) {
  return (
    <box flexDirection="row" gap={2} paddingTop={1}>
      <box focusable onMouseDown={(event) => eventButton(event, () => props.onPage(-1))}>
        <text fg={props.page > 0 ? props.palette.action : props.palette.subdued}>{props.page > 0 ? "‹ newer" : ""}</text>
      </box>
      <box flexGrow={1} />
      <text fg={props.palette.subdued} attributes={TextAttributes.DIM}>{`History page ${props.page + 1}`}</text>
      <box flexGrow={1} />
      <box focusable onMouseDown={(event) => eventButton(event, () => props.onPage(1))}>
        <text fg={props.hasMore ? props.palette.action : props.palette.subdued}>{props.hasMore ? "older ›" : ""}</text>
      </box>
    </box>
  )
}

export function TasksPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const [items, setItems] = createSignal<TodoItem[]>([])
  const [currentMessage, setCurrentMessage] = createSignal("Loading tasks…")
  const [view, setView] = createSignal<TasksView>("board")
  const [selectedColumn, setSelectedColumn] = createSignal(0)
  const [selectedRow, setSelectedRow] = createSignal(0)
  const [historyPage, setHistoryPage] = createSignal(0)
  const [historyItems, setHistoryItems] = createSignal<readonly ArchivedTodo[]>([])
  const [historyHasMore, setHistoryHasMore] = createSignal(false)
  const [historyTruncated, setHistoryTruncated] = createSignal(false)
  const [historyLoaded, setHistoryLoaded] = createSignal(false)
  const [historyMessage, setHistoryMessage] = createSignal("")
  const [themeVersion, setThemeVersion] = createSignal(0)
  const refreshTheme = () => setThemeVersion((value) => value + 1)
  const columns = () => groupTodosByStatus(items())
  const compact = () => props.panel.width < WIDE_LAYOUT_MIN_WIDTH
  const theme = () => {
    themeVersion()
    return context.theme
  }
  const palette = () => todoPalette(theme())

  if (typeof context.renderer.on === "function") {
    context.renderer.on("palette", refreshTheme)
    context.renderer.on("theme_mode", refreshTheme)
  }

  let disposed = false
  let currentRequest = 0
  let historyRequest = 0

  const refreshCurrent = async (sessionID: string): Promise<void> => {
    const request = ++currentRequest
    try {
      const text = await readFile(todoStatePath(sessionID), "utf8")
      if (disposed || request !== currentRequest || sessionID !== props.panel.sessionID) return
      const next = parseTodoState(text)
      setItems(next)
      setCurrentMessage("")
      setSelectedRow((row) => Math.min(row, Math.max(0, columns()[selectedColumn()]?.items.length - 1)))
    } catch (error) {
      if (disposed || request !== currentRequest || sessionID !== props.panel.sessionID) return
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
      if (code === "ENOENT") {
        setItems([])
        setCurrentMessage("")
      } else {
        setCurrentMessage("Unable to read the current Todo list.")
      }
    }
  }

  const loadHistory = async (page: number, sessionID: string, showLoading = true): Promise<void> => {
    const request = ++historyRequest
    if (showLoading) setHistoryLoaded(false)
    setHistoryMessage("")
    try {
      const result = await queryArchivedTodos(todoArchiveRoot(), {
        sessionID,
        offset: page * HISTORY_PAGE_SIZE,
        limit: HISTORY_PAGE_SIZE,
        maxScan: ARCHIVE_MAX_SCAN,
      })
      if (disposed || request !== historyRequest || page !== historyPage() || sessionID !== props.panel.sessionID) return
      setHistoryItems(result.items)
      setHistoryHasMore(result.hasMore && !result.truncated)
      setHistoryTruncated(result.truncated)
      setHistoryLoaded(true)
    } catch {
      if (disposed || request !== historyRequest || sessionID !== props.panel.sessionID) return
      setHistoryItems([])
      setHistoryHasMore(false)
      setHistoryTruncated(false)
      setHistoryMessage("Unable to read retained Todo history.")
      setHistoryLoaded(true)
    }
  }

  createEffect(() => {
    const sessionID = props.panel.sessionID
    setItems([])
    setCurrentMessage("Loading tasks…")
    setSelectedColumn(0)
    setSelectedRow(0)
    setHistoryPage(0)
    setHistoryItems([])
    setHistoryHasMore(false)
    setHistoryTruncated(false)
    setHistoryLoaded(false)
    setHistoryMessage("")
    void refreshCurrent(sessionID)
    if (untrack(view) === "history") void loadHistory(0, sessionID)
  })

  const toggleHistory = () => {
    if (view() === "history") {
      setView("board")
      return
    }
    setHistoryPage(0)
    setView("history")
    void loadHistory(0, props.panel.sessionID)
  }

  const pageHistory = (delta: number) => {
    const next = Math.max(0, historyPage() + delta)
    if (next === historyPage() || (delta > 0 && !historyHasMore())) return
    setHistoryPage(next)
    void loadHistory(next, props.panel.sessionID)
  }

  const selectColumn = (index: number) => {
    const bounded = Math.max(0, Math.min(columns().length - 1, index))
    setSelectedColumn(bounded)
    setSelectedRow((row) => Math.min(row, Math.max(0, columns()[bounded]?.items.length - 1)))
  }

  const moveSelection = (delta: number) => {
    const count = columns()[selectedColumn()]?.items.length ?? 0
    if (count === 0) return
    setSelectedRow((row) => Math.max(0, Math.min(count - 1, row + delta)))
  }

  useKeyboard((key) => {
    if (!props.panel.focused) return
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      props.panel.close()
      return
    }
    if (key.name === "f") {
      key.preventDefault()
      key.stopPropagation()
      props.panel.toggleFullscreen()
      return
    }
    if (key.name === "h") {
      key.preventDefault()
      key.stopPropagation()
      toggleHistory()
      return
    }
    if (key.name === "r") {
      key.preventDefault()
      key.stopPropagation()
      void refreshCurrent(props.panel.sessionID)
      if (view() === "history") void loadHistory(historyPage(), props.panel.sessionID)
      return
    }
    if (view() === "history") {
      if (key.name === "n" || key.name === "right") {
        key.preventDefault()
        key.stopPropagation()
        pageHistory(1)
      } else if (key.name === "p" || key.name === "left") {
        key.preventDefault()
        key.stopPropagation()
        pageHistory(-1)
      }
      return
    }
    if (key.name === "left") {
      key.preventDefault()
      key.stopPropagation()
      selectColumn(selectedColumn() - 1)
    } else if (key.name === "right") {
      key.preventDefault()
      key.stopPropagation()
      selectColumn(selectedColumn() + 1)
    } else if (key.name === "up") {
      key.preventDefault()
      key.stopPropagation()
      moveSelection(-1)
    } else if (key.name === "down") {
      key.preventDefault()
      key.stopPropagation()
      moveSelection(1)
    }
  })

  const timer = setInterval(() => void refreshCurrent(props.panel.sessionID), POLL_MS)
  const historyTimer = setInterval(() => {
    if (view() === "history") void loadHistory(historyPage(), props.panel.sessionID, false)
  }, 5_000)

  onCleanup(() => {
    disposed = true
    clearInterval(timer)
    clearInterval(historyTimer)
    historyRequest += 1
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })

  const activateView = (next: TasksView) => (event: { button?: number; preventDefault?: () => void; stopPropagation?: () => void }) =>
    eventButton(event, () => {
      if (next === "history") {
        if (view() !== "history") toggleHistory()
      } else {
        setView("board")
      }
    })

  return (
    <box
      focused
      focusable
      flexDirection="column"
      width="100%"
      height="100%"
      padding={1}
      borderStyle="single"
      borderColor={palette().action}
    >
      <box flexDirection="row" gap={2} width="100%" height={1}>
        <text fg={palette().primary} attributes={TextAttributes.BOLD}>Todo tasks</text>
        <box focusable onMouseDown={activateView("board")}>
          <text fg={view() === "board" ? palette().action : palette().subdued}>Board</text>
        </box>
        <box focusable onMouseDown={activateView("history")}>
          <text fg={view() === "history" ? palette().action : palette().subdued}>History</text>
        </box>
        <box flexGrow={1} />
        <text fg={palette().sectionCount}>{`${items().length} current`}</text>
      </box>
      <text fg={palette().subdued} attributes={TextAttributes.DIM}>
        {view() === "board" ? "Tasks by status · arrows move selection · h history · r refresh" : "Retained task history · n/→ older · p/← newer"}
      </text>

      <Show when={view() === "board"} fallback={
        <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
          <Show when={!historyLoaded()} fallback={
            <Show when={historyMessage()} fallback={
              <Show when={historyItems().length > 0} fallback={<text fg={palette().subdued}>No retained Todo history yet.</text>}>
                <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
                  <For each={historyItems()}>{(item) => <ArchivedTodoRow item={item} palette={palette()} />}</For>
                </scrollbox>
              </Show>
            }>
              <text fg={theme().text.feedback.error.default}>{historyMessage()}</text>
            </Show>
          }>
            <text fg={palette().subdued}>Loading retained history…</text>
          </Show>
          <Show when={historyTruncated()}>
            <text fg={palette().subdued} attributes={TextAttributes.DIM}>
              Bounded scan reached its {ARCHIVE_MAX_SCAN.toLocaleString()}-transition limit; older history is not included in this view.
            </text>
          </Show>
          <HistoryPageControls page={historyPage()} hasMore={historyHasMore()} palette={palette()} onPage={pageHistory} />
        </box>
      }>
          <Show when={!currentMessage()} fallback={<box flexGrow={1} justifyContent="center" alignItems="center"><text fg={currentMessage().includes("Loading") ? palette().subdued : theme().text.feedback.error.default}>{currentMessage()}</text></box>}>
            <Show when={items().length === 0}>
              <text fg={palette().subdued} attributes={TextAttributes.DIM}>No tasks yet. Add Todo items with todowrite.</text>
            </Show>
          <Show when={compact()} fallback={
            <box flexDirection="row" flexGrow={1} minHeight={0} width="100%" gap={1}>
              <For each={columns()}>
                {(column, index) => (
                  <TodoColumnView
                    column={column}
                    columnIndex={index()}
                    selectedColumn={selectedColumn()}
                    selectedRow={selectedRow()}
                    compact={false}
                    palette={palette()}
                    background={theme().background.surface.offset}
                    border={theme().border.default}
                    onSelectColumn={selectColumn}
                    onSelectRow={(columnIndex, row) => {
                      setSelectedColumn(columnIndex)
                      setSelectedRow(row)
                    }}
                  />
                )}
              </For>
            </box>
          }>
            <box flexDirection="column" flexGrow={1} minHeight={0} width="100%" gap={1}>
              <box flexDirection="row" width="100%" gap={1}>
                <For each={columns()}>
                  {(column, index) => (
                    <box flexGrow={1} flexShrink={1} minWidth={0} focusable onMouseDown={(event) => eventButton(event, () => selectColumn(index()))}>
                      <text fg={selectedColumn() === index() ? palette().action : palette().subdued} attributes={selectedColumn() === index() ? TextAttributes.BOLD : TextAttributes.DIM}>
                        {`${column.title} ${column.items.length}`}
                      </text>
                    </box>
                  )}
                </For>
              </box>
              <TodoColumnView
                column={columns()[selectedColumn()]!}
                columnIndex={selectedColumn()}
                selectedColumn={selectedColumn()}
                selectedRow={selectedRow()}
                compact={true}
                palette={palette()}
                background={theme().background.surface.offset}
                border={theme().border.default}
                onSelectColumn={selectColumn}
                onSelectRow={(columnIndex, row) => {
                  setSelectedColumn(columnIndex)
                  setSelectedRow(row)
                }}
              />
            </box>
          </Show>
        </Show>
      </Show>

      <box flexDirection="row" gap={2}>
        <text fg={palette().subdued} attributes={TextAttributes.DIM}>Esc close</text>
        <text fg={palette().subdued} attributes={TextAttributes.DIM}>f resize</text>
      <text fg={palette().subdued} attributes={TextAttributes.DIM}>current tasks refresh every second</text>
      </box>
    </box>
  )
}
