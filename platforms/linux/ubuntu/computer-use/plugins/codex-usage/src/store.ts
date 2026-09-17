import {
  CodexUsageError,
  type CodexUsageSnapshot,
  fetchCodexUsage,
  readOpenAICredential,
} from "./usage.ts"

export type UsageState = {
  status: "loading" | "ready" | "error"
  snapshot?: CodexUsageSnapshot
  message?: string
  retryAt?: number
}

export type UsageStore = {
  getState(): UsageState
  subscribe(listener: (state: UsageState) => void): () => void
  refresh(force?: boolean): Promise<UsageState>
  dispose(): void
}

export type UsageStoreOptions = {
  authPath?: string
  endpoint?: string
  timeoutMs?: number
}

const MIN_REFRESH_MS = 15_000
const DEFAULT_TIMEOUT_MS = 10_000

function boundedNumber(value: unknown, fallback: number, minimum: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback
}

function cleanError(error: unknown, timedOut: boolean) {
  if (timedOut) return new CodexUsageError("Codex usage check timed out.", "network")
  if (error instanceof CodexUsageError) return error
  return new CodexUsageError("Codex usage check failed.", "network")
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000)
  const listeners = new Set<(state: UsageState) => void>()
  let state: UsageState = { status: "loading" }
  let accountId: string | undefined
  let running: Promise<UsageState> | undefined
  let controller: AbortController | undefined
  let nextAllowedAt = 0
  let disposed = false

  const publish = (next: UsageState) => {
    state = next
    for (const listener of listeners) listener(state)
  }

  const refresh = (force = false): Promise<UsageState> => {
    if (disposed) return Promise.resolve(state)
    if (running) return running

    const now = Date.now()
    if (now < nextAllowedAt) {
      publish({
        status: "error",
        snapshot: state.snapshot,
        message: "Usage refresh is backing off after rate limiting.",
        retryAt: nextAllowedAt,
      })
      return Promise.resolve(state)
    }
    if (!force && state.snapshot && now - state.snapshot.fetchedAt < MIN_REFRESH_MS) {
      return Promise.resolve(state)
    }

    const task = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const credential = await readOpenAICredential(options.authPath)
        if (accountId && accountId !== credential.accountId) publish({ status: "loading" })
        accountId = credential.accountId

        controller = new AbortController()
        timer = setTimeout(() => {
          timedOut = true
          controller?.abort()
        }, timeoutMs)

        const snapshot = await fetchCodexUsage(credential, {
          endpoint: options.endpoint,
          signal: controller.signal,
        })
        nextAllowedAt = 0
        publish({ status: "ready", snapshot })
      } catch (error) {
        if (disposed) return state
        const usageError = cleanError(error, timedOut)
        if (usageError.retryAt) nextAllowedAt = usageError.retryAt
        publish({
          status: "error",
          snapshot: usageError.code === "auth" ? undefined : state.snapshot,
          message: usageError.message,
          retryAt: usageError.retryAt,
        })
      } finally {
        if (timer) clearTimeout(timer)
        controller = undefined
      }
      return state
    })()

    running = task.finally(() => {
      running = undefined
    })
    return running
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    dispose() {
      disposed = true
      controller?.abort()
      listeners.clear()
    },
  }
}
