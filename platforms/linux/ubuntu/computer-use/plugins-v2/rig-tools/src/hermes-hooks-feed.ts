import type { HermesHookSnapshot } from "./hermes-hooks-snapshot.ts"

export const HERMES_HOOK_SNAPSHOT_POLL_MS = 750

export type HermesHookSnapshotFeed = {
  start(): void
  refresh(): Promise<void>
  stop(): void
}

export function createHermesHookSnapshotFeed(
  read: () => Promise<HermesHookSnapshot>,
  publish: (snapshot: HermesHookSnapshot) => Promise<unknown>,
  intervalMs = HERMES_HOOK_SNAPSHOT_POLL_MS,
): HermesHookSnapshotFeed {
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let refreshing = false
  let previous: string | undefined

  const refresh = async (): Promise<void> => {
    if (disposed || refreshing) return
    refreshing = true
    try {
      const snapshot = await read()
      const signature = JSON.stringify(snapshot)
      if (!disposed && signature !== previous) {
        await publish(snapshot)
        previous = signature
      }
    } catch {
      return
    } finally {
      refreshing = false
    }
  }

  return {
    start() {
      if (disposed || timer) return
      timer = setInterval(() => void refresh(), intervalMs)
      timer.unref?.()
      void refresh()
    },
    refresh,
    stop() {
      disposed = true
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
