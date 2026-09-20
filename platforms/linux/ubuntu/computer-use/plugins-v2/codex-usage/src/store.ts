import {
  CodexUsageError,
  DeepSeekUsageError,
  type CodexUsageSnapshot,
  type DeepSeekBalanceSnapshot,
  type UsageErrorCode,
  fetchCodexUsage,
  fetchDeepSeekBalance,
  readDeepSeekCredential,
  readOpenAICredential,
} from "./usage.ts"
import {
  providerStates,
  readProviderCooldowns,
  withCodexStatus,
  withDeepSeekStatus,
  withProviderCooldowns,
  type ProviderCooldowns,
  type ProviderState,
} from "./providers.ts"

export type UsageState = {
  status: "loading" | "ready" | "error"
  snapshot?: CodexUsageSnapshot
  deepSeekBalance?: DeepSeekBalanceSnapshot
  message?: string
  retryAt?: number
  providers?: ProviderState[]
}

export type UsageStore = {
  getState(): UsageState
  subscribe(listener: (state: UsageState) => void): () => void
  refresh(force?: boolean): Promise<UsageState>
  dispose(): void
  updateProviders(catalog: readonly unknown[] | undefined): void
}

export type UsageStoreOptions = {
  authPath?: string
  endpoint?: string
  deepSeekEndpoint?: string
  fallbackStatePath?: string
  timeoutMs?: number
  supportsLunaReserve?: boolean
  fetchImpl?: typeof fetch
}

const MIN_REFRESH_MS = 15_000
const DEFAULT_TIMEOUT_MS = 10_000

function boundedNumber(value: unknown, fallback: number, minimum: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback
}

function cleanCodexError(error: unknown, timedOut: boolean) {
  if (error instanceof CodexUsageError) return error
  if (timedOut) return new CodexUsageError("Codex usage check timed out.", "network")
  return new CodexUsageError("Codex usage check failed.", "network")
}

function cleanDeepSeekError(error: unknown, timedOut: boolean) {
  if (error instanceof DeepSeekUsageError) return error
  if (timedOut) return new DeepSeekUsageError("DeepSeek balance check timed out.", "network")
  return new DeepSeekUsageError("DeepSeek balance check failed.", "network")
}

function codexLeftPercent(snapshot: CodexUsageSnapshot | undefined) {
  if (!snapshot) return undefined
  const values = snapshot.buckets.flatMap((bucket) => bucket.windows.map((window) => window.leftPercent))
  return values.length > 0 ? Math.min(...values) : undefined
}

function lastFetchedAt(state: UsageState) {
  return Math.max(state.snapshot?.fetchedAt ?? 0, state.deepSeekBalance?.fetchedAt ?? 0)
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000)
  const listeners = new Set<(state: UsageState) => void>()
  let state: UsageState = { status: "loading", providers: providerStates(undefined) }
  let catalog: readonly unknown[] | undefined
  let cooldowns: ProviderCooldowns = {}
  let codexErrorCode: UsageErrorCode | undefined
  let deepSeekErrorCode: UsageErrorCode | undefined
  let codexNextAllowedAt = 0
  let deepSeekNextAllowedAt = 0
  let running: Promise<UsageState> | undefined
  let controller: AbortController | undefined
  let disposed = false

  const publish = (next: UsageState) => {
    state = next
    for (const listener of listeners) listener(state)
  }

  const currentProviders = (
    snapshot = state.snapshot,
    deepSeekBalance = state.deepSeekBalance,
  ) => withProviderCooldowns(
    withDeepSeekStatus(
      withCodexStatus(providerStates(catalog), {
        hasSnapshot: snapshot !== undefined,
        leftPercent: codexLeftPercent(snapshot),
        errorCode: codexErrorCode,
      }),
      { snapshot: deepSeekBalance, errorCode: deepSeekErrorCode },
    ),
    cooldowns,
  )

  const refresh = (force = false): Promise<UsageState> => {
    if (disposed) return Promise.resolve(state)
    if (running) return running

    const now = Date.now()
    const fetchedAt = lastFetchedAt(state)
    if (!force && fetchedAt > 0 && now - fetchedAt < MIN_REFRESH_MS) return Promise.resolve(state)

    const task = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      controller = new AbortController()
      timer = setTimeout(() => {
        timedOut = true
        controller?.abort()
      }, timeoutMs)

      const codexProbe = (async () => {
        if (now < codexNextAllowedAt) {
          throw new CodexUsageError("Codex usage refresh is backing off after rate limiting.", "rate-limit", codexNextAllowedAt)
        }
        const credential = await readOpenAICredential(options.authPath)
        return fetchCodexUsage(credential, {
          endpoint: options.endpoint,
          signal: controller?.signal,
          supportsLunaReserve: options.supportsLunaReserve,
          fetchImpl: options.fetchImpl,
        })
      })()
      const deepSeekProbe = (async () => {
        if (now < deepSeekNextAllowedAt) {
          throw new DeepSeekUsageError("DeepSeek balance refresh is backing off after rate limiting.", "rate-limit", deepSeekNextAllowedAt)
        }
        const credential = await readDeepSeekCredential(options.authPath)
        return fetchDeepSeekBalance(credential, {
          endpoint: options.deepSeekEndpoint,
          signal: controller?.signal,
          fetchImpl: options.fetchImpl,
        })
      })()
      const cooldownProbe = readProviderCooldowns(options.fallbackStatePath)

      const [codexResult, deepSeekResult, cooldownResult] = await Promise.allSettled([
        codexProbe,
        deepSeekProbe,
        cooldownProbe,
      ] as const)
      if (timer) clearTimeout(timer)
      controller = undefined
      if (disposed) return state

      let snapshot = state.snapshot
      let deepSeekBalance = state.deepSeekBalance
      const messages: string[] = []
      const retryTimes: number[] = []

      if (codexResult.status === "fulfilled") {
        snapshot = codexResult.value
        codexErrorCode = undefined
        codexNextAllowedAt = 0
      } else {
        const error = cleanCodexError(codexResult.reason, timedOut)
        codexErrorCode = error.code
        if (error.code === "auth") snapshot = undefined
        if (error.retryAt) {
          codexNextAllowedAt = error.retryAt
          retryTimes.push(error.retryAt)
        }
        messages.push(error.message)
      }

      if (deepSeekResult.status === "fulfilled") {
        deepSeekBalance = deepSeekResult.value
        deepSeekErrorCode = undefined
        deepSeekNextAllowedAt = 0
      } else {
        const error = cleanDeepSeekError(deepSeekResult.reason, timedOut)
        deepSeekErrorCode = error.code
        if (error.code === "auth") deepSeekBalance = undefined
        if (error.retryAt) {
          deepSeekNextAllowedAt = error.retryAt
          retryTimes.push(error.retryAt)
        }
        messages.push(error.message)
      }

      if (cooldownResult.status === "fulfilled") cooldowns = cooldownResult.value

      publish({
        status: messages.length > 0 ? "error" : "ready",
        ...(snapshot ? { snapshot } : {}),
        ...(deepSeekBalance ? { deepSeekBalance } : {}),
        ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
        ...(retryTimes.length > 0 ? { retryAt: Math.min(...retryTimes) } : {}),
        providers: currentProviders(snapshot, deepSeekBalance),
      })
      return state
    })().finally(() => {
      running = undefined
    })

    running = task
    return task
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    updateProviders(nextCatalog) {
      catalog = nextCatalog
      publish({ ...state, providers: currentProviders() })
    },
    dispose() {
      disposed = true
      controller?.abort()
      listeners.clear()
    },
  }
}
