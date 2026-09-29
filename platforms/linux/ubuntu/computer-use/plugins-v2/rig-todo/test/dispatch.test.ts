import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { emptyTodoIdentity, assignTodoIds } from "../src/identity.ts"
import {
  readTodoDispatchSnapshot,
  reserveTodoBinding,
  withTodoWriterLease,
  writeTodoDispatchSnapshot,
} from "../src/dispatch.ts"
import type { TodoItem } from "../src/store.ts"

const SESSION = "ses_dispatch"
const AT = "2026-09-26T00:00:00.000Z"

function item(content: string, status: TodoItem["status"] = "pending"): TodoItem {
  return { content, status }
}

async function fixture(todos: readonly TodoItem[]) {
  await mkdir("/tmp/opencode", { recursive: true })
  const root = await mkdtemp("/tmp/opencode/rig-todo-dispatch-")
  const assigned = assignTodoIds(emptyTodoIdentity(), todos, SESSION)
  await writeTodoDispatchSnapshot(SESSION, {
    version: 1,
    updatedAt: AT,
    items: assigned.todos,
    identity: assigned.identity,
    bindings: [],
  }, root)
  return { root, todos: assigned.todos }
}

test("reserves one stable Todo by readable leading description and rejects duplicates", async (context) => {
  const current = await fixture([item("Build the server"), item("Review the server — verify tests")])
  context.after(() => rm(current.root, { recursive: true, force: true }))

  const binding = await reserveTodoBinding(SESSION, "call_review", "Review the server", current.root)
  assert.equal(binding.todoID, current.todos[1]?.id)
  assert.deepEqual((await readTodoDispatchSnapshot(SESSION, current.root))?.bindings, [binding])
  await assert.rejects(
    reserveTodoBinding(SESSION, "call_duplicate", "Review the server", current.root),
    /already reserved/,
  )

  const duplicate = await fixture([item("Build the server"), item("Build the server")])
  context.after(() => rm(duplicate.root, { recursive: true, force: true }))
  await assert.rejects(
    reserveTodoBinding(SESSION, "call_ambiguous", "Build the server", duplicate.root),
    /match exactly one actionable todo/,
  )
})

test("writer leases serialize release and dispatch snapshots until the first writer exits", async (context) => {
  const current = await fixture([item("Finish the candidate")])
  context.after(() => rm(current.root, { recursive: true, force: true }))
  let acquired!: () => void
  let release!: () => void
  const hasLease = new Promise<void>((resolve) => { acquired = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = withTodoWriterLease(SESSION, async () => {
    acquired()
    await gate
  }, current.root)
  await hasLease

  let secondEntered = false
  const second = withTodoWriterLease(SESSION, async () => { secondEntered = true }, current.root)
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(secondEntered, false)
  release()
  await Promise.all([first, second])
  assert.equal(secondEntered, true)
})

test("legacy mirrors remain readable but cannot reserve without persisted identity", async (context) => {
  const current = await fixture([item("Legacy task")])
  context.after(() => rm(current.root, { recursive: true, force: true }))
  await writeFile(join(current.root, `${SESSION}.json`), JSON.stringify({
    items: [{ content: "Legacy task", status: "pending" }],
    updatedAt: AT,
  }))
  const snapshot = await readTodoDispatchSnapshot(SESSION, current.root)
  assert.equal(snapshot?.identity, undefined)
  await assert.rejects(
    reserveTodoBinding(SESSION, "call_legacy", "Legacy task", current.root),
    /identity is unavailable/,
  )
})
