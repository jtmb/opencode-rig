export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type TodoPriority = "high" | "medium" | "low"

export interface TodoItem {
  content: string
  status: TodoStatus
  priority?: TodoPriority
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"])

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
