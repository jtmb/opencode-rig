import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { normalizeTodoIdentity, type IdentifiedTodo, type TodoIdentity } from "./identity.ts"
import { todoDataRoot } from "./state.ts"
import type { TodoPriority, TodoStatus } from "./store.ts"

const MAX_STATE_BYTES = 64 * 1024
const MAX_ITEMS = 512
const SESSION_ID = /^ses_[A-Za-z0-9]+$/
const CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/
const TODO_ID = /^[a-f0-9]{24}$/
const SESSION_ID_IN_TEXT = /\bses_[A-Za-z0-9]+\b/
const writerQueues = new Map<string, Promise<void>>()
const activeBindings = new Map<string, Map<string, string>>()

export interface TodoDispatchBinding {
  readonly callID: string
  readonly todoID: string
  readonly description: string
  readonly childSessionID?: string
}

export interface TodoDispatchItem {
  readonly id?: string
  readonly content: string
  readonly status: TodoStatus
  readonly priority?: TodoPriority
}

export interface TodoDispatchSnapshot {
  readonly version: 1
  readonly updatedAt: string
  readonly items: readonly TodoDispatchItem[]
  readonly identity?: TodoIdentity
  readonly bindings: readonly TodoDispatchBinding[]
}

export function todoDescriptionMatches(content: string, description: string) {
  return content === description || content.startsWith(`${description} —`)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function pathIsContained(root: string, candidate: string) {
  const child = relative(root, candidate)
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function sessionPaths(sessionID: string, root: string) {
  if (!SESSION_ID.test(sessionID)) throw new Error("Todo session ID is invalid")
  if (!isAbsolute(root)) throw new Error("Todo data root must be absolute")
  const directory = resolve(root)
  const state = join(directory, `${sessionID}.json`)
  if (!pathIsContained(directory, state)) {
    throw new Error("Todo state path escapes its root")
  }
  return { directory, state }
}

async function ensureRoot(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Todo data root is unsafe")
  await realpath(directory)
}

async function readFileBounded(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error("Todo state file is unsafe")
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset > MAX_STATE_BYTES) throw new Error("Todo state file is oversized")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function todoItem(raw: unknown, requireID: boolean) {
  const item = record(raw)
  const content = item?.content
  const status = item?.status
  const priority = item?.priority
  const id = item?.id
  if (
    typeof content !== "string" || !content.trim() || content.length > 4_096 || SESSION_ID_IN_TEXT.test(content) ||
    typeof status !== "string" || !["pending", "in_progress", "completed", "cancelled"].includes(status) ||
    (priority !== undefined && (typeof priority !== "string" || !["high", "medium", "low"].includes(priority))) ||
    (requireID && (typeof id !== "string" || !TODO_ID.test(id))) ||
    (id !== undefined && (typeof id !== "string" || !TODO_ID.test(id)))
  ) throw new Error("Todo snapshot contains a malformed item")
  return {
    ...(typeof id === "string" ? { id } : {}),
    content: content.trim(),
    status: status as TodoStatus,
    ...(typeof priority === "string" ? { priority: priority as TodoPriority } : {}),
  }
}

function identityFor(items: readonly IdentifiedTodo[], raw: unknown): TodoIdentity {
  const object = record(raw)
  const identity = normalizeTodoIdentity(raw)
  if (
    !object || object.version !== 1 || !Array.isArray(object.entries) ||
    object.entries.length !== items.length || identity.entries.length !== items.length ||
    identity.nextOrdinal < items.length
  ) throw new Error("Todo snapshot identity is malformed")
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    const entry = identity.entries[index]!
    if (
      item.id !== entry.id || item.content !== entry.content || item.status !== entry.status ||
      item.priority !== entry.priority
    ) throw new Error("Todo snapshot identity does not match its items")
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("Todo snapshot contains duplicate identities")
  }
  return identity
}

function parseBindings(raw: unknown, items: readonly TodoDispatchItem[]) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new Error("Todo snapshot bindings are malformed")
  const bindings = raw.map((value): TodoDispatchBinding => {
    const binding = record(value)
    if (
      !binding || typeof binding.callID !== "string" || !CALL_ID.test(binding.callID) ||
      typeof binding.todoID !== "string" || !TODO_ID.test(binding.todoID) ||
      typeof binding.description !== "string" || !binding.description.trim() || binding.description.length > 1_000 ||
      SESSION_ID_IN_TEXT.test(binding.description) ||
      (binding.childSessionID !== undefined &&
        (typeof binding.childSessionID !== "string" || !SESSION_ID.test(binding.childSessionID)))
    ) throw new Error("Todo snapshot contains a malformed binding")
    const todo = items.find((item) => item.id === binding.todoID)
    if (
      !todo || (todo.status !== "pending" && todo.status !== "in_progress") ||
      !todoDescriptionMatches(todo.content, binding.description)
    ) throw new Error("Todo snapshot binding does not match an actionable item")
    return {
      callID: binding.callID,
      todoID: binding.todoID,
      description: binding.description,
      ...(typeof binding.childSessionID === "string" ? { childSessionID: binding.childSessionID } : {}),
    }
  })
  if (
    new Set(bindings.map((binding) => binding.callID)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.todoID)).size !== bindings.length
  ) throw new Error("Todo snapshot contains duplicate bindings")
  return bindings
}

function parseSnapshot(text: string): TodoDispatchSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error("Todo snapshot is not valid JSON")
  }

  const object = record(parsed)
  const rawItems = Array.isArray(parsed)
    ? parsed
    : object && Array.isArray(object.items)
      ? object.items
      : undefined
  if (!rawItems || rawItems.length > MAX_ITEMS) throw new Error("Todo snapshot has an invalid item list")

  const versioned = object?.version === 1
  if (object && (Object.hasOwn(object, "version") || Object.hasOwn(object, "identity") || Object.hasOwn(object, "bindings")) && !versioned) {
    throw new Error("Todo snapshot version is unsupported")
  }
  if (versioned && Object.keys(object!).some((key) => !["version", "updatedAt", "items", "identity", "bindings"].includes(key))) {
    throw new Error("Todo snapshot contains unsupported fields")
  }
  const items = rawItems.map((raw) => todoItem(raw, versioned))
  if (object && !Array.isArray(parsed) && (typeof object.updatedAt !== "string" || !object.updatedAt.trim())) {
    throw new Error("Todo snapshot timestamp is malformed")
  }
  const updatedAt = typeof object?.updatedAt === "string" && object.updatedAt.trim()
    ? object.updatedAt
    : "1970-01-01T00:00:00.000Z"
  if (updatedAt.length > 64) throw new Error("Todo snapshot timestamp is malformed")
  if (!versioned) return { version: 1, updatedAt, items, bindings: [] }

  const identified = items as unknown as IdentifiedTodo[]
  const identity = identityFor(identified, object?.identity)
  const bindings = parseBindings(object?.bindings, identified)
  return { version: 1, updatedAt, items: identified, identity, bindings }
}

export function parseTodoDispatchSnapshotText(text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new Error("Todo snapshot is oversized")
  return parseSnapshot(text)
}

function assertWritableSnapshot(snapshot: TodoDispatchSnapshot): asserts snapshot is TodoDispatchSnapshot & {
  identity: TodoIdentity
  items: readonly IdentifiedTodo[]
} {
  if (!snapshot.identity || !Array.isArray(snapshot.items) || snapshot.items.length > MAX_ITEMS) {
    throw new Error("Todo snapshot identity is unavailable")
  }
  const items = snapshot.items.map((raw) => todoItem(raw, true)) as unknown as IdentifiedTodo[]
  if (items.some((item, index) => item.id !== snapshot.items[index]?.id)) {
    throw new Error("Todo snapshot identity is malformed")
  }
  identityFor(items, snapshot.identity)
  parseBindings(snapshot.bindings, items)
  if (typeof snapshot.updatedAt !== "string" || !snapshot.updatedAt.trim() || snapshot.updatedAt.length > 64) {
    throw new Error("Todo snapshot timestamp is malformed")
  }
}

export async function readTodoDispatchSnapshot(
  sessionID: string,
  root = todoDataRoot(),
): Promise<TodoDispatchSnapshot | undefined> {
  const { directory, state } = sessionPaths(sessionID, root)
  let directoryInfo
  try {
    directoryInfo = await lstat(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Todo snapshot is unavailable or invalid")
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Todo snapshot is unavailable or invalid")
  }
  let stateInfo
  try {
    stateInfo = await lstat(state)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Error("Todo snapshot is unavailable or invalid")
  }
  if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || stateInfo.size > MAX_STATE_BYTES) {
    throw new Error("Todo snapshot is unavailable or invalid")
  }
  try {
    return parseTodoDispatchSnapshotText(await readFileBounded(state))
  } catch {
    throw new Error("Todo snapshot is unavailable or invalid")
  }
}

export async function writeTodoDispatchSnapshot(
  sessionID: string,
  snapshot: TodoDispatchSnapshot,
  root = todoDataRoot(),
): Promise<void> {
  const { directory, state } = sessionPaths(sessionID, root)
  assertWritableSnapshot(snapshot)
  await ensureRoot(directory)
  try {
    const target = await lstat(state)
    if (!target.isFile() || target.isSymbolicLink()) throw new Error("Todo snapshot target is unsafe")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) throw new Error("Todo snapshot is oversized")
  const temporary = `${state}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(text, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, state)
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
    if (await readFileBounded(state) !== text) throw new Error("Todo snapshot readback did not match")
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function confirmTodoSnapshotBindings(
  sessionID: string,
  items: readonly TodoDispatchItem[],
) {
  const current = activeBindings.get(sessionID)
  if (!current) return
  for (const [callID, todoID] of current) {
    const todo = items.find((item) => item.id === todoID)
    if (todo && todo.status !== "completed" && todo.status !== "cancelled") continue
    current.delete(callID)
  }
  if (!current.size) activeBindings.delete(sessionID)
}

export async function removeTodoDispatchSnapshot(sessionID: string, root = todoDataRoot()) {
  const { directory, state } = sessionPaths(sessionID, root)
  await ensureRoot(directory)
  try {
    const info = await lstat(state)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Todo snapshot target is unsafe")
    await unlink(state)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export async function withTodoWriterLease<T>(
  sessionID: string,
  action: () => Promise<T>,
  _root = todoDataRoot(),
): Promise<T> {
  if (!SESSION_ID.test(sessionID)) throw new Error("Todo session ID is invalid")
  const previous = writerQueues.get(sessionID) ?? Promise.resolve()
  let unlock!: () => void
  const gate = new Promise<void>((resolveGate) => { unlock = resolveGate })
  const queued = previous.catch(() => undefined).then(() => gate)
  writerQueues.set(sessionID, queued)
  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    unlock()
    if (writerQueues.get(sessionID) === queued) writerQueues.delete(sessionID)
  }
}

export async function reserveTodoBinding(
  sessionID: string,
  callID: string,
  description: string,
  root = todoDataRoot(),
): Promise<TodoDispatchBinding> {
  if (!CALL_ID.test(callID) || !description.trim() || description.length > 1_000 || SESSION_ID_IN_TEXT.test(description)) {
    throw new Error("subagent description is invalid")
  }
  return withTodoWriterLease(sessionID, async () => {
    const snapshot = await readTodoDispatchSnapshot(sessionID, root)
    if (!snapshot?.identity || snapshot.items.some((item) => !item.id)) {
      throw new Error("subagent Todo identity is unavailable; run todoread before dispatch")
    }
    const matches = snapshot.items.filter((item) =>
      (item.status === "pending" || item.status === "in_progress") && todoDescriptionMatches(item.content, description))
    if (matches.length !== 1) throw new Error("subagent description must match exactly one actionable todo")
    const todo = matches[0] as IdentifiedTodo
    if (snapshot.bindings.some((binding) => binding.callID === callID)) {
      throw new Error("subagent tool call already has a Todo binding")
    }
    if (snapshot.bindings.some((binding) => binding.todoID === todo.id)) {
      throw new Error("actionable Todo is already reserved by a direct subagent launch")
    }
    const current = activeBindings.get(sessionID) ?? new Map<string, string>()
    if ([...current.values()].includes(todo.id)) {
      throw new Error("actionable Todo is already reserved by a direct subagent launch")
    }
    current.set(callID, todo.id)
    activeBindings.set(sessionID, current)
    const binding: TodoDispatchBinding = { callID, todoID: todo.id, description }
    try {
      await writeTodoDispatchSnapshot(sessionID, {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        bindings: [...snapshot.bindings, binding],
      }, root)
    } catch {
      await restoreSnapshot(sessionID, snapshot, root).then(() => {
        current.delete(callID)
        if (!current.size) activeBindings.delete(sessionID)
      }).catch(() => undefined)
      throw new Error("Todo reservation could not be durably confirmed")
    }
    return binding
  }, root)
}

export async function bindTodoChild(
  sessionID: string,
  callID: string,
  childSessionID: string,
  root = todoDataRoot(),
): Promise<void> {
  if (!CALL_ID.test(callID) || !SESSION_ID.test(childSessionID)) throw new Error("Todo child binding is invalid")
  await withTodoWriterLease(sessionID, async () => {
    const snapshot = await readTodoDispatchSnapshot(sessionID, root)
    if (!snapshot?.identity) throw new Error("Todo snapshot is unavailable or invalid")
    const binding = snapshot.bindings.find((entry) => entry.callID === callID)
    if (!binding) throw new Error("Todo dispatch reservation is missing")
    if (binding.childSessionID && binding.childSessionID !== childSessionID) {
      throw new Error("Todo dispatch reservation is bound to a different child")
    }
    const next = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      bindings: snapshot.bindings.map((entry) => entry.callID === callID ? { ...entry, childSessionID } : entry),
    }
    await writeTodoDispatchSnapshot(sessionID, next, root)
  }, root)
}

export async function releaseTodoBinding(sessionID: string, callID: string, root = todoDataRoot()): Promise<void> {
  if (!CALL_ID.test(callID)) throw new Error("Todo dispatch call ID is invalid")
  await withTodoWriterLease(sessionID, async () => {
    const snapshot = await readTodoDispatchSnapshot(sessionID, root)
    if (!snapshot?.identity) throw new Error("Todo snapshot is unavailable or invalid")
    const binding = snapshot.bindings.find((entry) => entry.callID === callID)
    if (!binding) {
      if (activeBindings.get(sessionID)?.has(callID)) {
        throw new Error("Todo dispatch reservation is missing from its durable snapshot")
      }
      return
    }
    const next = {
      ...snapshot,
      updatedAt: new Date().toISOString(),
      bindings: snapshot.bindings.filter((entry) => entry.callID !== callID),
    }
    try {
      await writeTodoDispatchSnapshot(sessionID, next, root)
    } catch (error) {
      await restoreSnapshot(sessionID, snapshot, root).catch(() => {
        throw new Error("Todo reservation release failed and its prior snapshot could not be restored")
      })
      throw new Error("Todo reservation release failed; its prior snapshot was restored")
    }
    const current = activeBindings.get(sessionID)
    current?.delete(callID)
    if (!current?.size) activeBindings.delete(sessionID)
  }, root)
}

async function restoreSnapshot(sessionID: string, snapshot: TodoDispatchSnapshot, root: string) {
  await writeTodoDispatchSnapshot(sessionID, snapshot, root)
}
