import assert from "node:assert/strict"
import test from "node:test"

import {
  enforceSingleInProgress,
  historySummary,
  MAX_VISIBLE_HISTORY,
  normalizeTodos,
  overlayRunningChildTodos,
  orderTodosForDisplay,
  summarize,
  visibleTodosForDisplay,
} from "../src/store.ts"

test("normalizes valid todos and drops malformed entries", () => {
  const todos = normalizeTodos([
    { content: "  first  ", status: "completed" },
    { content: "second", status: "in_progress", priority: "high" },
    { content: "", status: "pending" },
    { content: "bad status", status: "nope" },
    "not an object",
    { content: "third" },
  ])
  assert.deepEqual(todos, [
    { content: "first", status: "completed" },
    { content: "second", status: "in_progress", priority: "high" },
    { content: "bad status", status: "pending" },
    { content: "third", status: "pending" },
  ])
  assert.deepEqual(normalizeTodos(undefined), [])
})

test("keeps only the first in-progress item and demotes the rest", () => {
  const todos = enforceSingleInProgress([
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "in_progress" },
  ])
  assert.deepEqual(todos, [
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
  ])
})

test("overlays every matching pending child task while leaving storage-shaped values untouched", () => {
  const todos = [
    { content: "first child — extra detail", status: "pending" as const },
    { content: "second child", status: "pending" as const },
    { content: "unrelated", status: "pending" as const },
    { content: "history", status: "completed" as const },
  ]
  const overlaid = overlayRunningChildTodos(todos, new Set(["first child", "second child"]))
  assert.deepEqual(overlaid.map((todo) => todo.status), ["in_progress", "in_progress", "pending", "completed"])
  assert.deepEqual(todos.map((todo) => todo.status), ["pending", "pending", "pending", "completed"])
})

test("orders current work before stable completed history", () => {
  const ordered = orderTodosForDisplay([
    { content: "completed first", status: "completed" },
    { content: "pending first", status: "pending" },
    { content: "in progress", status: "in_progress" },
    { content: "pending second", status: "pending" },
    { content: "completed second", status: "completed" },
    { content: "cancelled", status: "cancelled" },
  ])

  assert.deepEqual(
    ordered.map((todo) => todo.content),
    ["in progress", "pending first", "pending second", "completed first", "completed second", "cancelled"],
  )
})

test("keeps only actionable work visible when completed history overflows", () => {
  const description = "Investigate the complete codex-usage task description without losing its leading text"
  const history = Array.from({ length: MAX_VISIBLE_HISTORY + 3 }, (_, index) => ({
    content: `completed ${index}`,
    status: "completed" as const,
  }))
  const display = visibleTodosForDisplay([...history, { content: description, status: "in_progress" as const }])

  assert.equal(display.items[0]?.content, description)
  assert.equal(display.items.filter((todo) => todo.status === "completed").length, 0)
  assert.equal(display.hiddenHistory, history.length)
})

test("aggregates all completed history without dropping current or pending work", () => {
  const current = [
    { content: "running child", status: "in_progress" as const },
    { content: "pending child", status: "pending" as const },
  ]
  const history = Array.from({ length: MAX_VISIBLE_HISTORY + 5 }, (_, index) => ({
    content: `completed ${index}`,
    status: "completed" as const,
  }))
  const display = visibleTodosForDisplay([...history, ...current])

  assert.deepEqual(display.items.slice(0, current.length), current)
  assert.equal(display.items.length, current.length)
  assert.equal(display.hiddenHistory, history.length)
})

test("never exposes completed or cancelled body content in sidebar display", () => {
  const completed = "completed item with a full description that must not be shortened"
  const cancelled = "cancelled item with a full description that must not be shortened"
  const display = visibleTodosForDisplay([
    { content: completed, status: "completed" },
    { content: cancelled, status: "cancelled" },
    { content: "current item with a full description", status: "in_progress" },
  ])

  assert.deepEqual(display.items.map((todo) => todo.content), ["current item with a full description"])
  assert.equal(display.hiddenHistory, 2)
})

test("history summary is truthful for hidden rows", () => {
  assert.equal(historySummary(0), undefined)
  assert.equal(historySummary(3), "+3 history items hidden")
})

test("summarizes counts and markers", () => {
  const summary = summarize([
    { content: "one", status: "completed" },
    { content: "two", status: "in_progress", priority: "low" },
    { content: "three", status: "pending" },
    { content: "four", status: "cancelled" },
  ])
  assert.match(summary, /^4 todos: 1 pending, 1 in progress, 1 completed, 1 cancelled/)
  assert.match(summary, /\[x\] one/)
  assert.match(summary, /\[~\] two \(low\)/)
  assert.match(summary, /\[ \] three/)
  assert.match(summary, /\[-\] four/)
})

test("empty list summarizes cleanly", () => {
  assert.equal(summarize([]), "Todo list is empty.")
})
