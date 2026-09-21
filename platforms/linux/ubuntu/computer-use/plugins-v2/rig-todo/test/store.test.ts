import assert from "node:assert/strict"
import test from "node:test"

import { enforceSingleInProgress, normalizeTodos, summarize } from "../src/store.ts"

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
