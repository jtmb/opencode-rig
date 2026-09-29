import type { TodoItem, TodoStatus } from "./store.ts"

export const TASKS_PANEL_NAME = "opencode-rig.todo.tasks"

export interface TodoColumn {
  readonly status: TodoStatus
  readonly title: string
  readonly items: readonly TodoItem[]
}

const COLUMNS: readonly Pick<TodoColumn, "status" | "title">[] = [
  { status: "in_progress", title: "In Progress" },
  { status: "pending", title: "To Do" },
  { status: "completed", title: "Completed" },
  { status: "cancelled", title: "Cancelled" },
]

export function groupTodosByStatus(todos: readonly TodoItem[]): TodoColumn[] {
  const itemsByStatus = new Map<TodoStatus, TodoItem[]>(COLUMNS.map(({ status }) => [status, []]))
  for (const todo of todos) itemsByStatus.get(todo.status)?.push(todo)
  return COLUMNS.map(({ status, title }) => ({ status, title, items: itemsByStatus.get(status) ?? [] }))
}
