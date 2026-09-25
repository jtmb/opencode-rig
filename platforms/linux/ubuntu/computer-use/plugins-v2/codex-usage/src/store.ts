import { providerStates, type ProviderState } from "./providers.ts"
import {
  OFFLINE_RECENCY_MS,
  sanitizeProviderText,
  type ProviderUsageRow,
  type ProviderUsageSnapshot,
} from "./state.ts"

export type UsageState = {
  status: "loading" | "ready" | "error"
  /** The authoritative provider.usage.snapshot response. */
  providerSnapshot?: ProviderUsageSnapshot
  message?: string
  retryAt?: number
  providers?: ProviderState[]
}

export type UsageSnapshotFetcher = (signal?: AbortSignal) => Promise<unknown>

export type UsageStore = {
  getState(): UsageState
  subscribe(listener: (state: UsageState) => void): () => void
  refresh(force?: boolean): Promise<UsageState>
  dispose(): void
}

export type UsageStoreOptions = {
  snapshot?: UsageSnapshotFetcher
  fetchSnapshot?: UsageSnapshotFetcher
  timeoutMs?: number
}

const MIN_REFRESH_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_DIAGNOSTICS = 64
const STALE_AUTHORITY_MS = OFFLINE_RECENCY_MS

function boundedNumber(value: unknown, fallback: number, minimum: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isProviderStatus(value: unknown): value is ProviderUsageRow["status"] {
  return value === "READY" || value === "EMPTY" || value === "COOLING" || value === "OFFLINE" || value === "STALE"
}

function isProviderRow(value: unknown): value is ProviderUsageRow {
  if (!isRecord(value)) return false
  return typeof value.id === "string" &&
    typeof value.name === "string" &&
    isProviderStatus(value.status) &&
    typeof value.detail === "string" &&
    (value.usage === undefined || typeof value.usage === "string") &&
    (value.remainingRatio === undefined || (typeof value.remainingRatio === "number" && Number.isFinite(value.remainingRatio) && value.remainingRatio >= 0 && value.remainingRatio <= 1))
}

function isProviderSnapshot(value: unknown): value is ProviderUsageSnapshot {
  if (!isRecord(value)) return false
  return typeof value.generated === "number" &&
    Number.isFinite(value.generated) &&
    Array.isArray(value.rows) &&
    value.rows.every(isProviderRow) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every((item) => typeof item === "string")
}

function snapshotFromRpc(value: unknown) {
  if (!isProviderSnapshot(value)) throw new Error("Provider usage RPC returned an invalid snapshot.")
  return value
}

function diagnosticFor(error: unknown) {
  const detail = error instanceof Error ? error.message : "Provider usage refresh failed."
  return sanitizeProviderText(`Provider usage refresh failed: ${detail}`, "Provider usage refresh failed.")
}

function staleSnapshot(previous: ProviderUsageSnapshot, error: unknown): ProviderUsageSnapshot {
  const diagnostics = [...previous.diagnostics, diagnosticFor(error)]
    .map((value) => sanitizeProviderText(value, "Provider usage diagnostic unavailable."))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(-MAX_DIAGNOSTICS)
  return {
    generated: Date.now(),
    rows: previous.rows
      .filter((row) => row.status !== "OFFLINE")
      .map((row) => ({
        ...row,
        status: "STALE" as const,
        detail: "Provider refresh was temporarily unavailable; the previous value is retained.",
      })),
    diagnostics,
  }
}

function failedSnapshotFetch(message: string): UsageSnapshotFetcher {
  return async () => {
    throw new Error(message)
  }
}

export function createUsageStore(options: UsageStoreOptions = {}): UsageStore {
  const timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000)
  const fetchSnapshot = options.fetchSnapshot ?? options.snapshot ?? failedSnapshotFetch("Provider usage RPC is unavailable.")
  const listeners = new Set<(state: UsageState) => void>()
  let state: UsageState = { status: "loading", providers: [] }
  let lastGoodAt = 0
  let lastAttemptAt = 0
  let running: Promise<UsageState> | undefined
  let disposed = false

  const publish = (next: UsageState) => {
    state = next
    for (const listener of listeners) listener(state)
  }

  const request = async (signal: AbortSignal) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Provider usage RPC timed out.")), timeoutMs)
      void fetchSnapshot(signal).then(resolve, reject)
    })
    try {
      return snapshotFromRpc(await pending)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const refresh = (force = false): Promise<UsageState> => {
    if (disposed) return Promise.resolve(state)
    if (running) return running

    const now = Date.now()
    if (!force && lastAttemptAt > 0 && now - lastAttemptAt < MIN_REFRESH_MS) return Promise.resolve(state)
    lastAttemptAt = now

    const task = (async () => {
      const controller = new AbortController()
      try {
        const snapshot = await request(controller.signal)
        if (disposed) return state
        publish({
          status: "ready",
          providerSnapshot: snapshot,
          providers: providerStates(snapshot),
        })
        lastGoodAt = Date.now()
      } catch (error) {
        if (disposed) return state
        const previous = state.providerSnapshot
        const retained = previous && lastGoodAt > 0 && Date.now() - lastGoodAt <= STALE_AUTHORITY_MS
          ? staleSnapshot(previous, error)
          : undefined
        publish({
          status: "error",
          ...(retained ? { providerSnapshot: retained, providers: providerStates(retained) } : { providers: [] }),
          message: diagnosticFor(error),
          retryAt: Date.now() + MIN_REFRESH_MS,
        })
      } finally {
        controller.abort()
      }
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
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}
