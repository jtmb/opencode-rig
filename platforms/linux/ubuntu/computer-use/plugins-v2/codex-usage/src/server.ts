import { Plugin, Rpc } from "@opencode/plugin"

import {
  anthropicRateLimitUsage,
  anthropicWorkspaceCandidate,
  isFirstPartyAnthropicRequest,
  resolveAnthropicWorkspaceID,
  withAnthropicWorkspaceHeader,
  type AnthropicWorkspaceCandidate,
} from "./anthropic.ts"
import {
  accountIdFromAccessToken,
  codexLimitReached,
  CodexUsageError,
  DeepSeekUsageError,
  fetchCodexUsage,
  fetchDeepSeekBalance,
  overallWeeklyWindow,
} from "./usage.ts"
import {
  computeProviderStates,
  OFFLINE_RECENCY_MS,
  providerStateInputFromOpenCode,
  sanitizeProviderText,
  type ProviderActivity,
  type ProviderRuntimeState,
  type ProviderStateInput,
  type ProviderUsageRow,
  type ProviderUsageSnapshot,
} from "./state.ts"
import { providerActivityFromEvent } from "./model.ts"
import {
  defaultActivityStatePath,
  loadActivityState,
  persistActivityState,
} from "./activity-state.ts"

export { computeProviderStates, providerStateInputFromOpenCode } from "./state.ts"
export type {
  ProviderActivity,
  ProviderRuntimeState,
  ProviderStateInput,
  ProviderStatus,
  ProviderUsageRow,
  ProviderUsageSnapshot,
} from "./state.ts"

const REFRESH_EVENTS = new Set([
  "credential.updated",
  "credential.switched",
  "integration.updated",
  "provider.updated",
])
const DEFAULT_REFRESH_MS = 60_000
const MIN_REFRESH_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const STALE_AUTHORITY_MS = 2 * 60 * 60 * 1000
const ANTHROPIC_MEASUREMENT_TTL_MS = 5 * 60 * 1000
const MAX_ROWS = 256
const MAX_DIAGNOSTICS = 64
const MAX_ACTIVITY_PROVIDERS = 512

const ACTIVITY_EVENTS = new Set([
  "session.model.selected",
  "session.message.content.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.updated",
  "session.status.updated",
  "session.status",
  "session.idle",
])

const PROVIDER_STATUS = ["READY", "EMPTY", "COOLING", "OFFLINE", "STALE"] as const
const PROVIDER_USAGE_RPC = Rpc.define({
  id: "provider.usage",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          generated: { type: "integer" },
          rows: {
            type: "array",
            maxItems: MAX_ROWS,
            items: {
              type: "object",
              properties: {
                id: { type: "string", maxLength: 128 },
                name: { type: "string", maxLength: 160 },
                status: { type: "string", enum: PROVIDER_STATUS },
                detail: { type: "string", maxLength: 240 },
                usage: { type: "string", maxLength: 160 },
                remainingRatio: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["id", "name", "status", "detail"],
              additionalProperties: false,
            },
          },
          diagnostics: {
            type: "array",
            maxItems: MAX_DIAGNOSTICS,
            items: { type: "string", maxLength: 240 },
          },
        },
        required: ["generated", "rows", "diagnostics"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

/** Public definition consumed by the TUI/server RPC client. */
export const ProviderUsage = PROVIDER_USAGE_RPC

type ProbeOutcome = "ok" | "empty" | "auth" | "rate" | "transient" | "unavailable"
type ProbeResult = {
  outcome: ProbeOutcome
  usage?: string
  remainingRatio?: number
  detail?: string
  diagnostic?: string
}

type ResolvedCredential =
  | { type: "oauth"; accessToken: string; accountId?: string; expiresAt?: number }
  | { type: "key"; apiKey: string; workspaceCandidate: AnthropicWorkspaceCandidate }

type ActiveIntegration = {
  integrationID: string
  kind: "credential" | "env"
  active: boolean
  credential?: ResolvedCredential
  resolutionFailed?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function positiveNumber(value: unknown, fallback: number, minimum: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function providerAliases(provider: { id: string; canonical?: string }) {
  return [provider.id, provider.canonical]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalize)
}

function usageAdapter(provider: { id: string; canonical?: string }) {
  const aliases = new Set(providerAliases(provider))
  if (aliases.has("openai") || aliases.has("codex")) return "codex" as const
  if (aliases.has("deepseek")) return "deepseek" as const
  if (aliases.has("anthropic")) return "anthropic" as const
  return undefined
}

function resolvedCredential(value: unknown, now = Date.now()): ResolvedCredential | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === "oauth") {
    const accessToken = text(value.access)
    if (!accessToken) return undefined
    const expiresAt = typeof value.expires === "number" && Number.isFinite(value.expires) ? value.expires : undefined
    if (expiresAt !== undefined && expiresAt <= now) return undefined
    return {
      type: "oauth",
      accessToken,
      accountId: accountIdFromAccessToken(accessToken, value.metadata),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
  }
  if (value.type === "key") {
    const apiKey = text(value.key)
    if (apiKey) return { type: "key", apiKey, workspaceCandidate: anthropicWorkspaceCandidate(value.metadata) }
  }
  return undefined
}

function previousMeasurement(rows: readonly ProviderUsageRow[], provider: { id: string; canonical?: string }) {
  const aliases = new Set(providerAliases(provider))
  const row = rows.find((candidate) => aliases.has(normalize(candidate.id)))
  return {
    usage: row?.usage,
    remainingRatio: row?.remainingRatio,
  }
}

export function codexUsage(snapshot: Awaited<ReturnType<typeof fetchCodexUsage>>) {
  const weekly = overallWeeklyWindow(snapshot)
  const overall = snapshot.buckets.find((bucket) => bucket.id === "codex")
  const windows = overall?.windows ?? []
  const left = windows.length > 0 ? Math.min(...windows.map((window) => window.leftPercent)) : undefined
  const usage = weekly
    ? `${weekly.label}: ${Math.round(weekly.leftPercent)}% left`
    : left === undefined
      ? undefined
      : `${Math.round(left)}% left`
  const remainingRatio = weekly
    ? Math.max(0, Math.min(1, weekly.leftPercent / 100))
    : left === undefined
      ? undefined
      : Math.max(0, Math.min(1, left / 100))
  return {
    outcome: codexLimitReached(snapshot) ? "empty" as const : "ok" as const,
    ...(usage ? { usage } : {}),
    ...(remainingRatio !== undefined ? { remainingRatio } : {}),
  }
}

function deepSeekUsage(snapshot: Awaited<ReturnType<typeof fetchDeepSeekBalance>>) {
  const balances = snapshot.balances.slice(0, 4).map((balance) => `${balance.currency} ${balance.totalBalance}`).join(", ")
  return {
    outcome: snapshot.available ? "ok" as const : "empty" as const,
    ...(balances ? { usage: `Balance ${balances}` } : {}),
  }
}

async function runProbe(
  adapter: "codex" | "deepseek",
  credential: ResolvedCredential,
  signal: AbortSignal,
  retained: { usage?: string; remainingRatio?: number },
): Promise<ProbeResult> {
  try {
    if (adapter === "codex" && credential.type === "oauth") {
      return codexUsage(await fetchCodexUsage(credential.accessToken, {
        signal,
        supportsLunaReserve: true,
        ...(credential.accountId ? { accountId: credential.accountId } : {}),
      }))
    }
    if (adapter === "deepseek" && credential.type === "key") {
      return deepSeekUsage(await fetchDeepSeekBalance(credential.apiKey, { signal }))
    }
    return { outcome: "ok" }
  } catch (error) {
    if (error instanceof CodexUsageError || error instanceof DeepSeekUsageError) {
      if (error.code === "auth") return { outcome: "auth", diagnostic: "Authentication was rejected by the usage service." }
      if (error.code === "rate-limit") return { outcome: "rate", diagnostic: "The usage service is temporarily rate limited." }
    }
    return {
      outcome: "transient",
      ...(retained.usage ? { usage: retained.usage } : {}),
      ...(retained.remainingRatio !== undefined ? { remainingRatio: retained.remainingRatio } : {}),
      diagnostic: "The usage service was temporarily unavailable; the previous value was retained.",
    }
  }
}

function boundedDiagnostics(values: readonly string[]) {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const cleaned = sanitizeProviderText(value, "Provider usage diagnostic unavailable.")
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    result.push(cleaned)
    if (result.length >= MAX_DIAGNOSTICS) break
  }
  return result
}

function staleSnapshot(previous: ProviderUsageSnapshot, diagnostic: string, lastGoodAt: number, now = Date.now()): ProviderUsageSnapshot {
  const retain = lastGoodAt > 0 && now - lastGoodAt <= STALE_AUTHORITY_MS
  const rows = retain
    ? previous.rows
      .filter((row) => row.status !== "OFFLINE")
      .map((row) => ({
        ...row,
        status: "STALE" as const,
        detail: "Provider refresh was temporarily unavailable; the previous value is retained.",
      }))
    : []
  return {
    generated: now,
    rows,
    diagnostics: boundedDiagnostics([...previous.diagnostics, diagnostic]),
  }
}

export default Plugin.define({
  id: "opencode-rig.codex-usage",
  async setup(ctx) {
    const refreshMs = positiveNumber(ctx.options.refreshMs, DEFAULT_REFRESH_MS, MIN_REFRESH_MS)
    const timeoutMs = positiveNumber(ctx.options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000)
    let current: ProviderUsageSnapshot = { generated: Date.now(), rows: [], diagnostics: [] }
    let lastGoodAt = 0
    let lastAttempt = 0
    let refreshTask: Promise<ProviderUsageSnapshot> | undefined
    let refreshController: AbortController | undefined
    let refreshPending = false
    let eventRefreshQueued = false
    let eventRefreshForce = false
    const activityStatePath = defaultActivityStatePath()
    const persistedActivity = await loadActivityState(activityStatePath, Date.now(), OFFLINE_RECENCY_MS)
    const activityByProvider = new Map(persistedActivity.map((activity) => [normalize(activity.providerID), activity.at]))
    const runtimeByProvider = new Map<string, ProviderRuntimeState>()
    let anthropicWorkspaceID = resolveAnthropicWorkspaceID([], ctx.options.anthropicWorkspaceId)
    let anthropicWorkspaceResolved = false
    let anthropicWorkspaceGeneration = 0
    let anthropicWorkspaceTask: Promise<void> | undefined
    let anthropicRateMeasurement: { usage: string; at: number } | undefined
    let activityPersistChain = Promise.resolve()
    let disposed = false

    const discoverAnthropicWorkspace = async () => {
      if (anthropicWorkspaceResolved) return
      if (anthropicWorkspaceTask) {
        const pending = anthropicWorkspaceTask
        await pending
        if (!anthropicWorkspaceResolved) return discoverAnthropicWorkspace()
        return
      }
      const generation = anthropicWorkspaceGeneration
      const task = (async () => {
        try {
          const [providerResult, integrationResult] = await Promise.all([
            ctx.provider.list(),
            ctx.integration.list(),
          ])
          const integrationIDsByAlias = new Map<string, string>()
          for (const provider of providerResult.data) {
            const integrationID = provider.integrationID
            if (usageAdapter(provider) !== "anthropic" || typeof integrationID !== "string" || !integrationID.trim()) continue
            const alias = normalize(integrationID)
            if (!integrationIDsByAlias.has(alias)) integrationIDsByAlias.set(alias, integrationID.trim())
          }
          const integrationIDs = [...integrationIDsByAlias.values()]
          const knownIntegrations = new Set(integrationResult.data.map((integration) => normalize(integration.id)))
          const candidates: AnthropicWorkspaceCandidate[] = []
          for (const integrationID of integrationIDs) {
            if (!knownIntegrations.has(normalize(integrationID))) {
              candidates.push({ workspaceIDs: [], unambiguous: false })
              continue
            }
            const connection = await ctx.integration.connection.active(integrationID)
            if (!connection) {
              candidates.push({ workspaceIDs: [], unambiguous: false })
              continue
            }
            try {
              const credential = await ctx.integration.connection.resolve(connection)
              candidates.push(isRecord(credential) && credential.type === "key" && text(credential.key)
                ? anthropicWorkspaceCandidate(credential.metadata)
                : { workspaceIDs: [], unambiguous: false })
            } catch {
              candidates.push({ workspaceIDs: [], unambiguous: false })
            }
          }
          const workspaceID = resolveAnthropicWorkspaceID(candidates, ctx.options.anthropicWorkspaceId)
          if (generation === anthropicWorkspaceGeneration) anthropicWorkspaceID = workspaceID
        } catch {
          if (generation === anthropicWorkspaceGeneration) {
            anthropicWorkspaceID = resolveAnthropicWorkspaceID([], ctx.options.anthropicWorkspaceId)
          }
        } finally {
          if (generation === anthropicWorkspaceGeneration) anthropicWorkspaceResolved = true
        }
      })()
      anthropicWorkspaceTask = task
      try {
        await task
      } finally {
        if (anthropicWorkspaceTask === task) anthropicWorkspaceTask = undefined
      }
      if (!anthropicWorkspaceResolved) return discoverAnthropicWorkspace()
    }

    const remember = (map: Map<string, number>, key: string, value: number) => {
      if (!key.trim() || !Number.isFinite(value) || value <= 0) return false
      const normalized = normalize(key)
      const previous = map.get(normalized)
      if (previous !== undefined && value <= previous) return false
      map.set(normalized, value)
      if (map.size <= MAX_ACTIVITY_PROVIDERS) return true
      const oldest = [...map.entries()].sort((left, right) => left[1] - right[1])[0]
      if (oldest) map.delete(oldest[0])
      return true
    }

    const pruneActivity = (now = Date.now()) => {
      const cutoff = now - OFFLINE_RECENCY_MS
      let changed = false
      for (const [providerID, at] of activityByProvider) {
        if (!Number.isFinite(at) || at <= 0 || at < cutoff || at > now) {
          activityByProvider.delete(providerID)
          changed = true
        }
      }
      return changed
    }

    const requestActivityPersistence = (now = Date.now()) => {
      const snapshot = activitySnapshot()
      activityPersistChain = activityPersistChain
        .catch(() => undefined)
        .then(() => persistActivityState(activityStatePath, snapshot, now, OFFLINE_RECENCY_MS))
        .catch(() => undefined)
    }

    const rememberActivity = (providerID: string, at = Date.now()) => {
      const changed = remember(activityByProvider, providerID, at)
      const pruned = pruneActivity()
      if (changed || pruned) requestActivityPersistence()
    }

    const rememberRuntime = (providerID: string, ready: boolean, at = Date.now()) => {
      if (!providerID.trim() || !Number.isFinite(at) || at <= 0) return
      const normalized = normalize(providerID)
      const previous = runtimeByProvider.get(normalized)
      if (!previous || at >= (previous.at ?? 0)) runtimeByProvider.set(normalized, { providerID: normalized, ready, at })
      if (runtimeByProvider.size <= MAX_ACTIVITY_PROVIDERS) return
      const oldest = [...runtimeByProvider.entries()].sort((left, right) => (left[1].at ?? 0) - (right[1].at ?? 0))[0]
      if (oldest) runtimeByProvider.delete(oldest[0])
    }

    const pruneRuntime = (now = Date.now()) => {
      const cutoff = now - STALE_AUTHORITY_MS
      for (const [providerID, runtime] of runtimeByProvider) {
        if (runtime.at !== undefined && (!Number.isFinite(runtime.at) || runtime.at < cutoff || runtime.at > now)) {
          runtimeByProvider.delete(providerID)
        }
      }
    }

    const activitySnapshot = (): ProviderActivity[] => [...activityByProvider].map(([providerID, at]) => ({ providerID, at }))
    const runtimeSnapshot = (): ProviderRuntimeState[] => [...runtimeByProvider.values()]

    const refresh = async (force = false): Promise<ProviderUsageSnapshot> => {
      if (disposed) return current
      if (refreshTask) {
        if (force) refreshPending = true
        return refreshTask
      }
      const now = Date.now()
      const workspaceGeneration = anthropicWorkspaceGeneration
      if (pruneActivity(now)) requestActivityPersistence(now)
      pruneRuntime(now)
      if (!force && now - lastAttempt < MIN_REFRESH_MS) return current
      lastAttempt = now

      refreshTask = (async () => {
        const controller = new AbortController()
        refreshController = controller
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const [providerResult, integrationResult] = await Promise.all([
            ctx.provider.list(),
            ctx.integration.list(),
          ])

          const activeIntegrations = await Promise.all(integrationResult.data.map(async (integration): Promise<ActiveIntegration> => {
            const active = await ctx.integration.connection.active(integration.id)
            if (!active) {
              return { integrationID: integration.id, kind: "env", active: false }
            }
            try {
              const value = await ctx.integration.connection.resolve(active)
              const credential = resolvedCredential(value, now)
              return {
                integrationID: integration.id,
                kind: active.type,
                active: credential !== undefined,
                ...(credential ? { credential } : {}),
                ...(credential === undefined ? { resolutionFailed: true } : {}),
              }
            } catch {
              return {
                integrationID: integration.id,
                kind: active.type,
                active: false,
                resolutionFailed: true,
              }
            }
          }))

          const providers = providerResult.data
          const activeByIntegration = new Map(activeIntegrations.map((item) => [normalize(item.integrationID), item]))
          const anthropicIntegrationIDs = [...new Set(providers
            .filter((provider) => usageAdapter(provider) === "anthropic")
            .map((provider) => provider.integrationID)
            .filter((integrationID): integrationID is string => typeof integrationID === "string" && integrationID.trim().length > 0)
            .map(normalize))]
          const workspaceCandidates = anthropicIntegrationIDs.map((integrationID) => {
            const integration = activeByIntegration.get(integrationID)
            return integration?.active && integration.credential?.type === "key"
              ? integration.credential.workspaceCandidate
              : { workspaceIDs: [], unambiguous: false }
          })
          if (workspaceGeneration === anthropicWorkspaceGeneration) {
            anthropicWorkspaceID = resolveAnthropicWorkspaceID(workspaceCandidates, ctx.options.anthropicWorkspaceId)
            anthropicWorkspaceResolved = true
          }
          const integrations = integrationResult.data.map((integration) => ({ id: integration.id }))
          const connections = activeIntegrations
            .filter((integration) => integration.active)
            .map((integration) => ({
              integrationID: integration.integrationID,
              kind: integration.kind,
              active: true,
            })) satisfies ProviderStateInput["connections"]

          const probeResults = new Map<string, ProbeResult>()
          const probeDiagnostics: string[] = []
          for (const provider of providers) {
            const adapter = usageAdapter(provider)
            if (!adapter) continue
            const integration = provider.integrationID
              ? activeByIntegration.get(normalize(provider.integrationID))
              : undefined
            if (!integration?.active) continue
            const aliases = providerAliases(provider)
            if (aliases.some((alias) => probeResults.has(alias))) continue

            let result: ProbeResult | undefined
            if (integration.resolutionFailed) {
              result = {
                outcome: "transient",
                ...(previousMeasurement(current.rows, provider).usage ? { usage: previousMeasurement(current.rows, provider).usage } : {}),
                ...(previousMeasurement(current.rows, provider).remainingRatio !== undefined
                  ? { remainingRatio: previousMeasurement(current.rows, provider).remainingRatio }
                  : {}),
                diagnostic: "The active credential could not be resolved; the previous value was retained.",
              }
            } else if (adapter === "anthropic") {
              const measurement = anthropicRateMeasurement && now - anthropicRateMeasurement.at <= ANTHROPIC_MEASUREMENT_TTL_MS
                ? anthropicRateMeasurement
                : undefined
              result = measurement
                ? { outcome: "ok", usage: measurement.usage }
                : {
                    outcome: "unavailable",
                    detail: anthropicWorkspaceID
                      ? "Anthropic rate-limit measurement is unavailable until a first-party response includes rate-limit headers."
                      : "Anthropic rate-limit measurement is unavailable because no workspace ID could be resolved or configured.",
                  }
            } else if (
              (adapter === "codex" && integration.credential?.type === "oauth") ||
              (adapter === "deepseek" && integration.credential?.type === "key")
            ) {
              result = await runProbe(adapter, integration.credential, controller.signal, previousMeasurement(current.rows, provider))
            }
            if (!result) continue
            for (const alias of aliases) probeResults.set(alias, result)
            if (result.diagnostic) probeDiagnostics.push(`${provider.name}: ${result.diagnostic}`)
          }

          const probes: Record<string, { outcome: ProbeOutcome; usage?: string; remainingRatio?: number; detail?: string }> = {}
          for (const [key, result] of probeResults) {
            probes[key] = {
              outcome: result.outcome,
              ...(result.usage ? { usage: result.usage } : {}),
              ...(result.remainingRatio !== undefined ? { remainingRatio: result.remainingRatio } : {}),
              ...(result.detail ? { detail: result.detail } : {}),
            }
          }
          const computed = computeProviderStates(providerStateInputFromOpenCode({
            providers,
            integrations,
            connections,
            probes,
            activities: activitySnapshot(),
            runtime: runtimeSnapshot(),
            now,
          }))
          current = {
            generated: computed.generated,
            rows: computed.rows.slice(0, MAX_ROWS),
            diagnostics: boundedDiagnostics([...computed.diagnostics, ...probeDiagnostics]),
          }
          lastGoodAt = now
          return current
        } catch {
          current = staleSnapshot(current, "Provider state refresh was temporarily unavailable.", lastGoodAt, now)
          return current
        } finally {
          clearTimeout(timer)
          if (refreshController === controller) refreshController = undefined
        }
      })().finally(() => {
        refreshTask = undefined
        if (refreshPending && !disposed) {
          refreshPending = false
          void refresh(true)
        }
      })
      return refreshTask
    }

    const queueEventRefresh = (force = false) => {
      if (disposed) return
      eventRefreshForce ||= force
      if (eventRefreshQueued) return
      eventRefreshQueued = true
      queueMicrotask(() => {
        eventRefreshQueued = false
        const shouldForce = eventRefreshForce
        eventRefreshForce = false
        if (!disposed) void refresh(shouldForce)
      })
    }

    const modelRequestHook = await ctx.session.hook("model.request", (event) => {
      const providerID = event.model.providerID
      const at = Date.now()
      rememberActivity(providerID, at)
      rememberRuntime(providerID, true, at)
      queueEventRefresh()
    })
    const responseHook = await ctx.session.hook("http.response", (event) => {
      const providerID = event.model.providerID
      const at = Date.now()
      rememberActivity(providerID, at)
      rememberRuntime(providerID, event.response.ok, at)
      queueEventRefresh()
    })
    const anthropicRequestHook = await ctx.session.hook("http.request", async (event) => {
      if (!isFirstPartyAnthropicRequest(event.request)) return
      await discoverAnthropicWorkspace()
      try {
        const request = withAnthropicWorkspaceHeader(event.request, anthropicWorkspaceID)
        if (request) event.request = request
      } catch {
        anthropicRateMeasurement = undefined
      }
    }, { providerID: "anthropic" })
    const anthropicResponseHook = await ctx.session.hook("http.response", (event) => {
      if (!isFirstPartyAnthropicRequest(event.request)) return
      const usage = anthropicRateLimitUsage(event.response.headers)
      anthropicRateMeasurement = usage ? { usage, at: Date.now() } : undefined
      queueEventRefresh(true)
    }, { providerID: "anthropic" })

    const rpc = await ctx.rpc.register(PROVIDER_USAGE_RPC, {
      snapshot: async (input) => {
        void input
        return refresh(false)
      },
    })

    const poll = setInterval(() => {
      void refresh()
    }, refreshMs)
    const controller = new AbortController()
    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (ACTIVITY_EVENTS.has(event.type)) {
            const activity = providerActivityFromEvent(event)
            if (activity) rememberActivity(activity.providerID, activity.at)
            queueEventRefresh(false)
          }
          if (REFRESH_EVENTS.has(event.type)) {
            anthropicWorkspaceGeneration += 1
            anthropicWorkspaceID = resolveAnthropicWorkspaceID([], ctx.options.anthropicWorkspaceId)
            anthropicWorkspaceResolved = false
            anthropicRateMeasurement = undefined
            queueEventRefresh(true)
          }
        }
      } catch {
        // The event stream ends when the plugin unloads; polling remains as fallback.
      }
    })()

    void refresh(true)

    return async () => {
      disposed = true
      clearInterval(poll)
      controller.abort()
      refreshController?.abort()
      await events
      await refreshTask?.catch(() => undefined)
      await rpc.dispose()
      await anthropicResponseHook.dispose()
      await anthropicRequestHook.dispose()
      await responseHook.dispose()
      await modelRequestHook.dispose()
      await activityPersistChain
    }
  },
})
