import assert from "node:assert/strict"
import test from "node:test"

import type { TodoArchiveDraft } from "../src/archive.ts"
import type { TodoDispatchBinding, TodoDispatchSnapshot } from "../src/dispatch.ts"
import { emptyTodoIdentity, type IdentifiedTodo, type TodoIdentity } from "../src/identity.ts"
import { createTodoRecorder } from "../src/recording.ts"
import { normalizeTodos, type TodoItem } from "../src/store.ts"

const SESSION = "ses_recording"
const AT = "2026-09-22T00:00:00.000Z"

function item(content: string, status: TodoItem["status"]): TodoItem {
  return { content, status }
}

function harness(options: { failAppend?: boolean; failMirrorOnce?: boolean; delayMs?: number } = {}) {
  let todos: TodoItem[] = []
  let identity: TodoIdentity = emptyTodoIdentity()
  let mirror: TodoDispatchSnapshot | undefined
  let failMirror = options.failMirrorOnce ?? false
  let writeCalls = 0
  const appended: TodoArchiveDraft[][] = []
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 0))
  const deps = {
    readTodos: async () => { await wait(); return [...todos] },
    writeTodos: async (_sessionID: string, next: readonly TodoItem[]) => { await wait(); todos = normalizeTodos(next); writeCalls += 1 },
    readIdentity: async () => { await wait(); return identity },
    writeIdentity: async (_sessionID: string, next: TodoIdentity) => { identity = next },
    withWriterLease: async <T>(_sessionID: string, action: () => Promise<T>) => action(),
    readSnapshot: async () => mirror,
    mirrorTodos: async (_sessionID: string, next: readonly IdentifiedTodo[], nextIdentity: TodoIdentity, bindings: readonly TodoDispatchBinding[]) => {
      if (failMirror) {
        failMirror = false
        throw new Error("mirror readback failed")
      }
      mirror = { version: 1, updatedAt: AT, items: [...next], identity: nextIdentity, bindings: [...bindings] }
    },
    appendTransitions: async (_root: string, drafts: readonly TodoArchiveDraft[]) => {
      if (options.failAppend) throw new Error("archive disk is unavailable")
      appended.push([...drafts])
      return drafts.length
    },
    archiveRoot: () => "/tmp/rig-todo-archive",
    now: () => AT,
  }
  return {
    recorder: createTodoRecorder(deps),
    appended,
    snapshot: () => ({ todos: [...todos], identity, writeCalls, mirror }),
  }
}

test("refuses the replacement when the archive write fails, without changing the list", async () => {
  const { recorder, snapshot } = harness({ failAppend: true })
  await assert.rejects(
    () => recorder.write(SESSION, [item("must not be accepted", "pending")]),
    /todowrite refused: durable Todo archive write failed \(archive disk is unavailable\); the previous list was not changed/,
  )
  const { todos, writeCalls } = snapshot()
  assert.deepEqual(todos, [])
  assert.equal(writeCalls, 0)
})

test("restores stored Todo and identity state when the durable mirror write fails", async () => {
  const { recorder, snapshot } = harness({ failMirrorOnce: true })
  await assert.rejects(
    () => recorder.write(SESSION, [item("mirror must be durable", "pending")]),
    /durable Todo snapshot write failed \(mirror readback failed\); the previous list was restored/,
  )
  assert.deepEqual(snapshot(), {
    todos: [],
    identity: emptyTodoIdentity(),
    writeCalls: 2,
    mirror: {
      version: 1,
      updatedAt: AT,
      items: [],
      identity: emptyTodoIdentity(),
      bindings: [],
    },
  })
})

test("records transitions before accepting the list and persists stable identity", async () => {
  const { recorder, appended, snapshot } = harness()
  const first = await recorder.write(SESSION, [item("alpha", "pending"), item("beta", "pending")])
  assert.match(first.content, /2 todos/)
  assert.deepEqual(appended[0]?.map((draft) => [draft.content, draft.kind]), [
    ["alpha", "created"],
    ["beta", "created"],
  ])
  const alphaId = snapshot().identity.entries[0]?.id

  await recorder.write(SESSION, [item("alpha", "completed"), item("beta", "pending")])
  assert.deepEqual(appended[1]?.map((draft) => [draft.content, draft.kind, draft.previousStatus]), [
    ["alpha", "status_changed", "pending"],
  ])
  assert.equal(snapshot().identity.entries[0]?.id, alphaId)
  assert.equal(snapshot().identity.entries[0]?.status, "completed")
})

test("serializes concurrent writes per session so no transition is dropped", async () => {
  const { recorder, appended, snapshot } = harness({ delayMs: 8 })
  const [first, second] = await Promise.all([
    recorder.write(SESSION, [item("race", "pending")]),
    recorder.write(SESSION, [item("race", "completed")]),
  ])
  assert.match(first.content, /1 todos/)
  assert.match(second.content, /1 todos/)
  assert.deepEqual(appended.map((drafts) => drafts.map((draft) => draft.kind)), [
    ["created"],
    ["status_changed"],
  ])
  assert.equal(snapshot().todos[0]?.status, "completed")
  assert.equal(snapshot().writeCalls, 2)
})
