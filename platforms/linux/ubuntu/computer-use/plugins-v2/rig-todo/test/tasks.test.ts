import assert from "node:assert/strict"
import test from "node:test"

import { groupTodosByStatus } from "../src/tasks.ts"

test("groups every current todo into stable Kanban status columns", () => {
  const tasks = [
    { content: "Ship release", status: "in_progress" as const },
    { content: "Review docs", status: "pending" as const },
    { content: "Run checks", status: "completed" as const },
    { content: "Drop obsolete branch", status: "cancelled" as const },
    { content: "Check changelog", status: "pending" as const },
  ]

  const columns = groupTodosByStatus(tasks)
  assert.deepEqual(columns.map((column) => [column.status, column.title, column.items.length]), [
    ["in_progress", "In Progress", 1],
    ["pending", "To Do", 2],
    ["completed", "Completed", 1],
    ["cancelled", "Cancelled", 1],
  ])
  assert.deepEqual(columns[1]?.items.map((item) => item.content), ["Review docs", "Check changelog"])
  assert.equal(columns.reduce((total, column) => total + column.items.length, 0), tasks.length)
})

test("keeps empty Kanban columns available for incoming tasks", () => {
  const columns = groupTodosByStatus([])
  assert.deepEqual(columns.map((column) => column.title), ["In Progress", "To Do", "Completed", "Cancelled"])
  assert.ok(columns.every((column) => column.items.length === 0))
})
