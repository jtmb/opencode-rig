import assert from "node:assert/strict"
import test from "node:test"

import { parseTodoState, serializeTodoState, todoStatePath } from "../src/state.ts"

test("todoStatePath honours XDG_DATA_HOME", () => {
  assert.equal(todoStatePath("ses_1", { XDG_DATA_HOME: "/data" }), "/data/opencode/rig-todo/ses_1.json")
})

test("todoStatePath falls back under the home directory", () => {
  assert.match(todoStatePath("ses_2", {}), /[/\\]opencode[/\\]rig-todo[/\\]ses_2\.json$/)
})

test("parseTodoState accepts the object and bare-array forms", () => {
  const objectForm = parseTodoState(JSON.stringify({ items: [{ content: "a", status: "pending" }] }))
  assert.deepEqual(objectForm, [{ content: "a", status: "pending" }])

  const arrayForm = parseTodoState(JSON.stringify([{ content: "b", status: "in_progress" }]))
  assert.deepEqual(arrayForm, [{ content: "b", status: "in_progress" }])
})

test("parseTodoState drops invalid items and survives corrupt input", () => {
  const mixed = parseTodoState(JSON.stringify({ items: [{ content: "", status: "pending" }, { content: "ok", status: "nope" }] }))
  assert.deepEqual(mixed, [{ content: "ok", status: "pending" }])
  assert.deepEqual(parseTodoState("{not json"), [])
})

test("serialize and parse round-trip", () => {
  const items = [
    { content: "first", status: "in_progress" as const },
    { content: "second", status: "completed" as const, priority: "high" as const },
  ]
  assert.deepEqual(parseTodoState(serializeTodoState(items)), items)
})
