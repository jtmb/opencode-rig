import { createSignal, untrack } from "solid-js"

import type { GoalRpcStateOutput } from "../../orchestration-policy/src/goal-rpc.ts"

export type GoalStateSnapshot =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; goal: GoalRpcStateOutput }

type UpdatedListener = (sessionID: string) => void | Promise<void>

export function createGoalStateFeed(
  read: (sessionID: string) => Promise<GoalRpcStateOutput>,
  currentSessionID: () => string | undefined,
  subscribe: (listener: UpdatedListener) => () => void,
) {
  const [snapshot, setSnapshot] = createSignal<{ sessionID: string; value: GoalStateSnapshot }>()
  let revision = 0
  let inFlight: { sessionID: string; promise: Promise<void> } | undefined

  const refresh = (sessionID: string): Promise<void> => {
    if (sessionID !== currentSessionID()) return Promise.resolve()
    if (inFlight?.sessionID === sessionID) return inFlight.promise
    const request = ++revision
    const saved = untrack(snapshot)
    // ponytail: keep stale data if state RPC hangs; add a bounded timeout if refresh needs a terminal state.
    if (saved?.sessionID !== sessionID || saved.value.status !== "ready") {
      setSnapshot({ sessionID, value: { status: "loading" } })
    }
    const promise = (async () => {
      let value: GoalStateSnapshot
      try {
        value = { status: "ready", goal: await read(sessionID) }
      } catch {
        value = { status: "unavailable" }
      }
      if (request === revision && sessionID === currentSessionID()) setSnapshot({ sessionID, value })
    })()
    inFlight = { sessionID, promise }
    void promise.then(() => { if (inFlight?.promise === promise) inFlight = undefined })
    return promise
  }

  const stop = subscribe((sessionID) => sessionID === currentSessionID() ? refresh(sessionID) : undefined)

  return {
    refresh,
    forSession(sessionID: string): GoalStateSnapshot {
      const saved = snapshot()
      return sessionID === currentSessionID() && saved?.sessionID === sessionID
        ? saved.value
        : { status: "loading" }
    },
    dispose: stop,
  }
}
