export function createRefreshQueue(refresh: () => Promise<void>) {
  let disposed = false
  let refreshing = false
  let refreshQueued = false

  const run = async () => {
    if (disposed) return
    if (refreshing) {
      refreshQueued = true
      return
    }

    refreshing = true
    try {
      do {
        refreshQueued = false
        await refresh()
      } while (refreshQueued && !disposed)
    } finally {
      refreshing = false
    }
  }

  return {
    refresh: run,
    dispose() {
      disposed = true
      refreshQueued = false
    },
  }
}
