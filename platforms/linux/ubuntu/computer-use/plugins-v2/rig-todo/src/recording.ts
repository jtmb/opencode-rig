import { diffTodoTransitions, type TodoArchiveDraft } from "./archive.ts"
import { assignTodoIds, normalizeTodoIdentity, type TodoIdentity } from "./identity.ts"
import type { TodoDispatchBinding, TodoDispatchSnapshot } from "./dispatch.ts"
import { summarize, type TodoItem } from "./store.ts"

/**
 * Fail-closed Todo recording.
 *
 * A `todowrite` replacement is accepted only after every transition has been
 * durably appended to the archive. Per-session writes are serialized so a
 * concurrent call cannot read a stale previous list and drop a transition.
 *
 * Partial-write limit: the archive and `ctx.storage` cannot be committed
 * atomically. The archive is written first, so an accepted transition is never
 * lost; a crash between the archive append and the list/identity write records
 * a transition for a list that was not accepted (over-record), and a stale
 * identity can reassign ids on the next write. Those cases are documented rather
 * than hidden; the recorder never silently drops an accepted transition.
 */
export interface TodoRecordingDeps {
  readonly readTodos: (sessionID: string) => Promise<TodoItem[]>
  readonly writeTodos: (sessionID: string, todos: readonly TodoItem[]) => Promise<void>
  readonly readIdentity: (sessionID: string) => Promise<TodoIdentity>
  readonly writeIdentity: (sessionID: string, identity: TodoIdentity) => Promise<void>
  readonly withWriterLease: <T>(sessionID: string, action: () => Promise<T>) => Promise<T>
  readonly readSnapshot: (sessionID: string) => Promise<TodoDispatchSnapshot | undefined>
  readonly mirrorTodos: (
    sessionID: string,
    todos: ReturnType<typeof assignTodoIds>["todos"],
    identity: TodoIdentity,
    bindings: readonly TodoDispatchBinding[],
  ) => Promise<void>
  readonly appendTransitions: (root: string, drafts: readonly TodoArchiveDraft[]) => Promise<number>
  readonly archiveRoot: () => string
  readonly now: () => string
}

export interface TodoRecorder {
  write(sessionID: string, todos: readonly TodoItem[]): Promise<{ content: string }>
}

export function createTodoRecorder(deps: TodoRecordingDeps): TodoRecorder {
  const chains = new Map<string, Promise<unknown>>()
  const serialize = <T>(sessionID: string, action: () => Promise<T>): Promise<T> => {
    const previous = chains.get(sessionID) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(action)
    chains.set(sessionID, run.catch(() => undefined))
    return run
  }

  return {
    write(sessionID, todos) {
      return serialize(sessionID, () => deps.withWriterLease(sessionID, async () => {
        const stored = await deps.readTodos(sessionID)
        const persisted = normalizeTodoIdentity(await deps.readIdentity(sessionID))
        const snapshot = await deps.readSnapshot(sessionID)
        const previous = assignTodoIds(snapshot?.identity ?? persisted, stored, sessionID)
        if (snapshot?.identity && !sameTodos(snapshot.items, previous.todos)) {
          throw new Error("todowrite refused: durable Todo mirror and stored list disagree")
        }
        const next = assignTodoIds(previous.identity, todos, sessionID)
        const drafts = diffTodoTransitions(previous.todos, next.todos, sessionID, deps.now())
        const bindings = reconcileBindings(snapshot?.bindings ?? [], next.todos)

        try {
          await deps.appendTransitions(deps.archiveRoot(), drafts)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            `todowrite refused: durable Todo archive write failed (${detail}); the previous list was not changed`,
          )
        }

        try {
          await deps.writeTodos(sessionID, next.todos)
          await deps.writeIdentity(sessionID, next.identity)
          await deps.mirrorTodos(sessionID, next.todos, next.identity, bindings)
        } catch (error) {
          try {
            await deps.writeTodos(sessionID, previous.todos)
            await deps.writeIdentity(sessionID, previous.identity)
            await deps.mirrorTodos(sessionID, previous.todos, previous.identity, snapshot?.bindings ?? [])
          } catch {
            throw new Error("todowrite refused: prior Todo snapshot could not be restored; state remains fail-closed")
          }
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`todowrite refused: durable Todo snapshot write failed (${detail}); the previous list was restored`)
        }
        return { content: summarize(todos) }
      }))
    },
  }
}

function sameTodos(
  snapshot: TodoDispatchSnapshot["items"],
  identified: ReturnType<typeof assignTodoIds>["todos"],
) {
  return snapshot.length === identified.length && snapshot.every((item, index) => {
    const next = identified[index]!
    return "id" in item && item.id === next.id && item.content === next.content && item.status === next.status &&
      item.priority === next.priority
  })
}

function reconcileBindings(
  bindings: readonly TodoDispatchBinding[],
  todos: ReturnType<typeof assignTodoIds>["todos"],
) {
  const next = [] as TodoDispatchBinding[]
  for (const binding of bindings) {
    const item = todos.find((todo) => todo.id === binding.todoID)
    if (!item || item.content !== binding.description && !item.content.startsWith(`${binding.description} —`)) {
      throw new Error("todowrite refused: a reserved Todo cannot be removed or renamed")
    }
    if (item.status === "completed" || item.status === "cancelled") continue
    next.push(binding)
  }
  return next
}
