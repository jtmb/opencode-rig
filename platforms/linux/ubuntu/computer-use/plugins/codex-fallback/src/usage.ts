import {
  fetchCodexUsage,
  overallWeeklyWindow,
  readOpenAICredential,
  type CodexUsageSnapshot,
} from "../../codex-usage/src/usage.ts"

export type QuotaSnapshot = {
  limitReached: boolean
  resetsAt?: number
  planType?: string
  fetchedAt: number
}

export type QuotaChecker = {
  check(force?: boolean): Promise<QuotaSnapshot | undefined>
}

export type QuotaCheckerOptions = {
  endpoint?: string
  authPath?: string
  cacheMs: number
  timeoutMs: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const FAILURE_CACHE_MAX_MS = 15_000

export function quotaFromSnapshot(snapshot: CodexUsageSnapshot): QuotaSnapshot {
  const overall = snapshot.buckets.find((bucket) => bucket.id === "codex")
  const weekly = overallWeeklyWindow(snapshot)
  const explicit = overall?.limitReached !== undefined || overall?.allowed !== undefined
  const limitReached =
    snapshot.reachedType !== undefined ||
    overall?.limitReached === true ||
    overall?.allowed === false ||
    (!explicit && weekly !== undefined && weekly.usedPercent >= 100)

  return {
    limitReached,
    resetsAt: weekly?.resetsAt !== undefined ? weekly.resetsAt * 1000 : undefined,
    planType: snapshot.planType,
    fetchedAt: snapshot.fetchedAt,
  }
}

export function createQuotaChecker(options: QuotaCheckerOptions): QuotaChecker {
  const now = options.now ?? Date.now
  let cached: QuotaSnapshot | undefined
  let cachedAt = 0
  let failedAt = 0
  let running: Promise<QuotaSnapshot | undefined> | undefined

  const run = (force: boolean): Promise<QuotaSnapshot | undefined> => {
    const current = now()
    if (!force) {
      if (cached && current - cachedAt < options.cacheMs) return Promise.resolve(cached)
      if (failedAt && current - failedAt < Math.min(options.cacheMs, FAILURE_CACHE_MAX_MS)) {
        return Promise.resolve(undefined)
      }
    }
    if (running) return running

    running = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      try {
        const credential = await readOpenAICredential(options.authPath)
        const snapshot = await fetchCodexUsage(credential, {
          endpoint: options.endpoint,
          signal: controller.signal,
          fetchImpl: options.fetchImpl,
          now: now(),
        })
        const quota = quotaFromSnapshot(snapshot)
        cached = quota
        cachedAt = current
        failedAt = 0
        return quota
      } catch {
        failedAt = current
        return undefined
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      running = undefined
    })

    return running
  }

  return { check: (force = false) => run(force) }
}
