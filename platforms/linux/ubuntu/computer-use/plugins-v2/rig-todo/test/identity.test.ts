import assert from "node:assert/strict"
import test from "node:test"

import {
  assignTodoIds,
  emptyTodoIdentity,
  normalizeTodoIdentity,
  todoItemId,
} from "../src/identity.ts"
import type { TodoItem } from "../src/store.ts"

const SESSION = "ses_identity"

function item(content: string, status: TodoItem["status"] = "pending"): TodoItem {
  return { content, status }
}

test("ids are deterministic per session and ordinal and never content-derived", () => {
  assert.equal(todoItemId(SESSION, 0), todoItemId(SESSION, 0))
  assert.notEqual(todoItemId(SESSION, 0), todoItemId(SESSION, 1))
  assert.notEqual(todoItemId(SESSION, 0), todoItemId("ses_other", 0))
})

test("assigns distinct ids to duplicate content and advances the ordinal", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("duplicate task"), item("duplicate task")], SESSION)
  assert.notEqual(first.todos[0]?.id, first.todos[1]?.id)
  assert.equal(first.identity.nextOrdinal, 2)
  assert.deepEqual(first.identity.entries.map((entry) => entry.id), first.todos.map((todo) => todo.id))
})

test("keeps the same id across a normal status change", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("ship it", "pending")], SESSION)
  const second = assignTodoIds(first.identity, [item("ship it", "completed")], SESSION)
  assert.equal(second.todos[0]?.id, first.todos[0]?.id)
  assert.equal(second.identity.nextOrdinal, first.identity.nextOrdinal)
  assert.equal(second.identity.entries[0]?.status, "completed")
})

test("keeps the same id when a task text is edited in place", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("draft the plan"), item("review the plan")], SESSION)
  const edited = assignTodoIds(first.identity, [item("draft the plan v2"), item("review the plan")], SESSION)
  assert.equal(edited.todos[0]?.id, first.todos[0]?.id)
  assert.equal(edited.todos[1]?.id, first.todos[1]?.id)
  assert.equal(edited.identity.entries[0]?.content, "draft the plan v2")
})

test("inserting a new item ahead does not steal the unchanged items' ids", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("A"), item("B")], SESSION)
  const inserted = assignTodoIds(first.identity, [item("X"), item("A"), item("B")], SESSION)
  assert.equal(inserted.todos[1]?.id, first.todos[0]?.id)
  assert.equal(inserted.todos[2]?.id, first.todos[1]?.id)
  assert.notEqual(inserted.todos[0]?.id, first.todos[0]?.id)
  assert.notEqual(inserted.todos[0]?.id, first.todos[1]?.id)
})

test("reordering unchanged items keeps each item's identity", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("A"), item("B"), item("C")], SESSION)
  const reordered = assignTodoIds(first.identity, [item("C"), item("A"), item("B")], SESSION)
  assert.equal(reordered.todos[0]?.id, first.todos[2]?.id)
  assert.equal(reordered.todos[1]?.id, first.todos[0]?.id)
  assert.equal(reordered.todos[2]?.id, first.todos[1]?.id)
})

test("insertion ahead keeps duplicate occurrences distinct", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("same"), item("same")], SESSION)
  const inserted = assignTodoIds(first.identity, [item("new"), item("same"), item("same")], SESSION)
  assert.equal(inserted.todos[1]?.id, first.todos[0]?.id)
  assert.equal(inserted.todos[2]?.id, first.todos[1]?.id)
  assert.notEqual(inserted.todos[1]?.id, inserted.todos[2]?.id)
  assert.notEqual(inserted.todos[0]?.id, first.todos[0]?.id)
})

test("reordering duplicates keeps stable occurrence identity", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("same"), item("same")], SESSION)
  const shifted = assignTodoIds(first.identity, [item("same")], SESSION)
  // Removing the trailing duplicate keeps the first occurrence's id.
  assert.equal(shifted.todos[0]?.id, first.todos[0]?.id)
})

test("duplicate contents stay distinct across a status change", () => {
  const first = assignTodoIds(emptyTodoIdentity(), [item("same", "pending"), item("same", "pending")], SESSION)
  const second = assignTodoIds(first.identity, [item("same", "completed"), item("same", "pending")], SESSION)
  assert.equal(second.todos[0]?.id, first.todos[0]?.id)
  assert.equal(second.todos[1]?.id, first.todos[1]?.id)
  assert.notEqual(second.todos[0]?.id, second.todos[1]?.id)
})

test("normalizes persisted identity and drops malformed entries", () => {
  assert.deepEqual(normalizeTodoIdentity(undefined), emptyTodoIdentity())
  assert.deepEqual(normalizeTodoIdentity("{not json"), emptyTodoIdentity())
  const normalized = normalizeTodoIdentity({
    version: 1,
    nextOrdinal: 1,
    entries: [
      { id: "a", content: "keep", status: "pending" },
      { id: "", content: "drop", status: "pending" },
      { id: "b", content: "drop", status: "nope" },
      "not an object",
    ],
  })
  assert.deepEqual(normalized.entries, [{ id: "a", content: "keep", status: "pending" }])
  assert.ok(normalized.nextOrdinal >= normalized.entries.length)
})
