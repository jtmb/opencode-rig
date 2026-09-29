import assert from "node:assert/strict"
import test from "node:test"

import { createRefreshQueue } from "../src/refresh-queue.ts"

test("refresh requests that arrive during a fetch trigger one follow-up pass", async () => {
  let finishFirst: (() => void) | undefined
  let firstStarted: (() => void) | undefined
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve })
  const firstFetch = new Promise<void>((resolve) => { finishFirst = resolve })
  let calls = 0
  const queue = createRefreshQueue(async () => {
    calls += 1
    if (calls === 1) {
      firstStarted?.()
      await firstFetch
    }
  })

  const initialRefresh = queue.refresh()
  await firstStartedPromise
  await queue.refresh()
  assert.equal(calls, 1)

  finishFirst?.()
  await initialRefresh
  assert.equal(calls, 2)

  queue.dispose()
  await queue.refresh()
  assert.equal(calls, 2)
})
