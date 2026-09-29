import { createHash } from "node:crypto"

import type { TodoItem, TodoPriority, TodoStatus } from "./store.ts"

/**
 * Stable per-item Todo identity.
 *
 * A `todowrite` call replaces the whole list, so identity cannot be derived
 * from the task text: duplicate texts would alias and an edited text would
 * change identity. Instead the accepted list is paired with a small persisted
 * identity map. Matching reuses an existing id for the same text when possible
 * (occurrence order disambiguates duplicates), otherwise for the item that
 * still occupies the same slot, so a normal status change or content edit keeps
 * the same id. Only genuinely new slots get a fresh ordinal id.
 */

export interface TodoIdentityEntry {
  readonly id: string
  readonly content: string
  readonly status: TodoStatus
  readonly priority?: TodoPriority
}

export interface TodoIdentity {
  readonly version: 1
  readonly nextOrdinal: number
  readonly entries: readonly TodoIdentityEntry[]
}

export interface IdentifiedTodo extends TodoItem {
  readonly id: string
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Deterministic, collision-resistant id for the nth item introduced in a session. */
export function todoItemId(sessionID: string, ordinal: number): string {
  return createHash("sha256").update(`${sessionID}#${ordinal}`).digest("hex").slice(0, 24)
}

export function emptyTodoIdentity(): TodoIdentity {
  return { version: 1, nextOrdinal: 0, entries: [] }
}

export function normalizeTodoIdentity(value: unknown): TodoIdentity {
  if (!isRecord(value) || value.version !== 1) return emptyTodoIdentity()
  const nextOrdinal = typeof value.nextOrdinal === "number" && Number.isInteger(value.nextOrdinal) && value.nextOrdinal >= 0
    ? value.nextOrdinal
    : 0
  if (!Array.isArray(value.entries)) return emptyTodoIdentity()
  const entries: TodoIdentityEntry[] = []
  for (const raw of value.entries) {
    if (!isRecord(raw)) continue
    const id = typeof raw.id === "string" ? raw.id : ""
    const content = typeof raw.content === "string" ? raw.content : ""
    const status = typeof raw.status === "string" && STATUSES.has(raw.status) ? (raw.status as TodoStatus) : undefined
    if (!id || !content || !status) continue
    const priority = typeof raw.priority === "string" && PRIORITIES.has(raw.priority) ? (raw.priority as TodoPriority) : undefined
    entries.push(priority ? { id, content, status, priority } : { id, content, status })
  }
  const maximumOrdinal = entries.length
  return { version: 1, nextOrdinal: Math.max(nextOrdinal, maximumOrdinal), entries }
}

/**
 * Assign stable ids to a replacement list against the previous identity.
 *
 * Matching runs in three phases so insertion and reordering cannot steal an
 * unchanged item's id:
 *  1. exact-text matches consume ids in occurrence order (duplicates included);
 *  2. unmatched items reuse the still-unused id at the same slot (an in-place
 *     content edit keeps its id);
 *  3. anything left gets a fresh ordinal id.
 */
export function assignTodoIds(
  identity: TodoIdentity,
  next: readonly TodoItem[],
  sessionID: string,
): { todos: IdentifiedTodo[]; identity: TodoIdentity } {
  const byContent = new Map<string, string[]>()
  for (const entry of identity.entries) {
    const bucket = byContent.get(entry.content)
    if (bucket) bucket.push(entry.id)
    else byContent.set(entry.content, [entry.id])
  }

  const used = new Set<string>()
  const assigned: Array<string | undefined> = new Array(next.length).fill(undefined)

  for (let index = 0; index < next.length; index += 1) {
    const id = byContent.get(next[index]!.content)?.find((candidate) => !used.has(candidate))
    if (id) {
      used.add(id)
      assigned[index] = id
    }
  }
  for (let index = 0; index < next.length; index += 1) {
    if (assigned[index]) continue
    const positional = identity.entries[index]
    if (positional && !used.has(positional.id)) {
      used.add(positional.id)
      assigned[index] = positional.id
    }
  }
  let ordinal = identity.nextOrdinal
  for (let index = 0; index < next.length; index += 1) {
    if (assigned[index]) continue
    assigned[index] = todoItemId(sessionID, ordinal)
    ordinal += 1
  }

  const todos: IdentifiedTodo[] = next.map((todo, index) => ({
    id: assigned[index]!,
    content: todo.content,
    status: todo.status,
    ...(todo.priority ? { priority: todo.priority } : {}),
  }))
  const entries: TodoIdentityEntry[] = todos.map((todo) =>
    todo.priority
      ? { id: todo.id, content: todo.content, status: todo.status, priority: todo.priority }
      : { id: todo.id, content: todo.content, status: todo.status },
  )
  return { todos, identity: { version: 1, nextOrdinal: ordinal, entries } }
}
