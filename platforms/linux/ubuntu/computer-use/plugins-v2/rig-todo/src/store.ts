export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type TodoPriority = "high" | "medium" | "low"

export interface TodoItem {
  content: string
  status: TodoStatus
  priority?: TodoPriority
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"])

// Retain the exported bound for callers while the sidebar renders no history rows.
export const MAX_VISIBLE_HISTORY = 0

const DISPLAY_STATUS_ORDER: Readonly<Record<TodoStatus, number>> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Normalise untrusted tool input into a clean todo list. */
export function normalizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  const items: TodoItem[] = []
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const content = typeof raw.content === "string" ? raw.content.trim() : ""
    if (!content) continue
    const status = typeof raw.status === "string" && STATUSES.has(raw.status) ? (raw.status as TodoStatus) : "pending"
    const priority =
      typeof raw.priority === "string" && PRIORITIES.has(raw.priority) ? (raw.priority as TodoPriority) : undefined
    items.push(priority ? { content, status, priority } : { content, status })
  }
  return items
}

/** Only the first in-progress item stays in progress; the rest fall back to pending. */
export function enforceSingleInProgress(todos: readonly TodoItem[]): TodoItem[] {
  let seen = false
  return todos.map((todo) => {
    if (todo.status !== "in_progress") return { ...todo }
    if (!seen) {
      seen = true
      return { ...todo }
    }
    return { ...todo, status: "pending" }
  })
}

export function isCurrentTodo(status: TodoStatus): boolean {
  return status === "in_progress" || status === "pending"
}

function todoMatchesChildTitle(content: string, title: string): boolean {
  return content === title || content.startsWith(`${title} —`)
}

/** Overlay live direct-child activity without changing the persisted todo contract. */
export function overlayRunningChildTodos(
  todos: readonly TodoItem[],
  runningChildTitles: ReadonlySet<string>,
): TodoItem[] {
  return todos.map((todo) => {
    if (!isCurrentTodo(todo.status)) return { ...todo }
    const matchesChild = [...runningChildTitles].some((title) => {
      const normalizedTitle = title.trim()
      return normalizedTitle.length > 0 && todoMatchesChildTitle(todo.content, normalizedTitle)
    })
    return matchesChild ? { ...todo, status: "in_progress" } : { ...todo }
  })
}

/** Put current work before bounded history for the sidebar. */
export function orderTodosForDisplay(todos: readonly TodoItem[]): TodoItem[] {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort(
      (left, right) =>
        DISPLAY_STATUS_ORDER[left.todo.status] - DISPLAY_STATUS_ORDER[right.todo.status] || left.index - right.index,
    )
    .map(({ todo }) => todo)
}

export interface TodoDisplay {
  items: TodoItem[]
  hiddenHistory: number
}

/** Keep only actionable work visible and aggregate all completed/cancelled history. */
export function visibleTodosForDisplay(
  todos: readonly TodoItem[],
  maxHistory = MAX_VISIBLE_HISTORY,
): TodoDisplay {
  void maxHistory
  const ordered = orderTodosForDisplay(todos)
  const current = ordered.filter((todo) => isCurrentTodo(todo.status))
  const history = ordered.filter((todo) => !isCurrentTodo(todo.status))

  return {
    items: current,
    hiddenHistory: history.length,
  }
}

export function historySummary(hiddenHistory: number): string | undefined {
  const count = Math.max(0, Math.floor(hiddenHistory))
  return count > 0 ? `+${count} history items hidden` : undefined
}

function marker(status: TodoStatus): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[~]"
  if (status === "cancelled") return "[-]"
  return "[ ]"
}

export function summarize(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "Todo list is empty."
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 }
  for (const todo of todos) counts[todo.status] += 1
  const header = `${todos.length} todos: ${counts.pending} pending, ${counts.in_progress} in progress, ${counts.completed} completed, ${counts.cancelled} cancelled`
  const lines = todos.map((todo) => `${marker(todo.status)} ${todo.content}${todo.priority ? ` (${todo.priority})` : ""}`)
  return `${header}\n${lines.join("\n")}`
}
