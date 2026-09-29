import assert from "node:assert/strict"
import test from "node:test"

import { createGoalStateFeed } from "../src/goal-state.ts"

test("late Goal responses and update events from stale sessions cannot replace the current snapshot", async () => {
  let currentSession = "ses_first"
  let finishFirst!: (value: { status: "active"; handoff: "manual"; objective: string }) => void
  let onUpdated: ((sessionID: string) => void | Promise<void>) | undefined
  const reads: string[] = []
  const feed = createGoalStateFeed(
    (sessionID) => {
      reads.push(sessionID)
      if (sessionID === "ses_first") return new Promise((resolve) => { finishFirst = resolve })
      return Promise.resolve({ status: "active", handoff: "manual", objective: "Current session objective" })
    },
    () => currentSession,
    (listener) => {
      onUpdated = listener
      return () => { onUpdated = undefined }
    },
  )

  const first = feed.refresh("ses_first")
  currentSession = "ses_current"
  await feed.refresh("ses_current")
  finishFirst({ status: "active", handoff: "manual", objective: "Stale session objective" })
  await first

  assert.deepEqual(reads, ["ses_first", "ses_current"])
  const current = feed.forSession("ses_current")
  assert.equal(current.status, "ready")
  if (current.status === "ready") {
    assert.equal(current.goal.objective, "Current session objective")
  }
  assert.equal(feed.forSession("ses_first").status, "loading")
  await onUpdated?.("ses_first")
  assert.deepEqual(reads, ["ses_first", "ses_current"])
  feed.dispose()
})

test("simultaneous footer and sidebar refreshes share the first live Goal response", async () => {
  let reads = 0
  let finishFirst!: (value: { status: "active"; handoff: "manual"; objective: string }) => void
  const feed = createGoalStateFeed(
    () => {
      reads += 1
      return reads === 1
        ? new Promise((resolve) => { finishFirst = resolve })
        : new Promise(() => {})
    },
    () => "ses_current",
    () => () => {},
  )
  const footer = feed.refresh("ses_current")
  const sidebar = feed.refresh("ses_current")
  assert.equal(reads, 1, "a second slot must not invalidate the first response")
  finishFirst({ status: "active", handoff: "manual", objective: "finish the roadmap" })
  await Promise.all([footer, sidebar])
  assert.equal(feed.forSession("ses_current").status, "ready")
  feed.dispose()
})
