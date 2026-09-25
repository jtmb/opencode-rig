import { diffTodoTransitions, type TodoArchiveDraft } from "./archive.ts"
import { assignTodoIds, normalizeTodoIdentity, type TodoIdentity } from "./identity.ts"
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
  readonly mirrorTodos: (sessionID: string, todos: readonly TodoItem[]) => Promise<void>
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
      return serialize(sessionID, async () => {
        const stored = await deps.readTodos(sessionID)
        const persisted = normalizeTodoIdentity(await deps.readIdentity(sessionID))
        const previous = assignTodoIds(persisted, stored, sessionID)
        const next = assignTodoIds(previous.identity, todos, sessionID)
        const drafts = diffTodoTransitions(previous.todos, next.todos, sessionID, deps.now())

        try {
          await deps.appendTransitions(deps.archiveRoot(), drafts)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            `todowrite refused: durable Todo archive write failed (${detail}); the previous list was not changed`,
          )
        }

        await deps.writeTodos(sessionID, todos)
        await deps.writeIdentity(sessionID, next.identity)
        await deps.mirrorTodos(sessionID, todos)
        return { content: summarize(todos) }
      })
    },
  }
}
