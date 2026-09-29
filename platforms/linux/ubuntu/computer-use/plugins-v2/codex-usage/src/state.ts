export type ProviderStatus = "READY" | "EMPTY" | "COOLING" | "OFFLINE" | "STALE"

export interface ProviderUsageRow {
  id: string
  name: string
  status: ProviderStatus
  detail: string
  usage?: string
  /** Provider-derived normalized remaining ratio; absent means health is unknown. */
  remainingRatio?: number
}

export interface ProviderUsageSnapshot {
  generated: number
  rows: ProviderUsageRow[]
  diagnostics: string[]
}

export const OFFLINE_RECENCY_MS = 2 * 60 * 60 * 1000
export const RUNTIME_AUTHORITY_MS = OFFLINE_RECENCY_MS

export type ProviderActivity = {
  providerID: string
  at: number
}

export type ProviderRuntimeState = {
  providerID: string
  ready: boolean
  at?: number
}

export interface ProviderStateInput {
  providers: ReadonlyArray<{
    id: string
    name: string
    canonical?: string
    activation: "auto" | "enabled" | "disabled"
    integrationID?: string
    ambientReady?: boolean
    modelCount?: number
  }>
  connections: ReadonlyArray<{
    integrationID: string
    kind: "credential" | "env"
    active: boolean
  }>
  probes?: Readonly<Record<string, {
    outcome: "ok" | "empty" | "auth" | "rate" | "transient" | "unavailable"
    usage?: string
    remainingRatio?: number
    detail?: string
  }>>
  /** Metadata-only activity captured from OpenCode session/model history or hooks. */
  activities?: ReadonlyArray<ProviderActivity>
  activity?: ReadonlyArray<ProviderActivity>
  /** Compatibility input for callers that already reduced activity to last-used metadata. */
  lastUsedAt?: Readonly<Record<string, number>>
  /** Runtime readiness observed on an actual OpenCode model path. */
  runtime?: ReadonlyArray<ProviderRuntimeState>
  now?: number
}

type ProviderInput = ProviderStateInput["providers"][number]
type Probe = NonNullable<ProviderStateInput["probes"]>[string]

export type OpenCodeProviderInfo = Pick<ProviderInput, "id" | "name" | "canonical" | "activation" | "integrationID"> & {
  /** Provider.Info.settings is inspected only to derive a boolean capability. */
  settings?: Readonly<Record<string, unknown>>
}
export type OpenCodeConnectionInfo = ProviderStateInput["connections"][number]
export type OpenCodeIntegrationInfo = { id: string }

/**
 * Reduce the authoritative V2 provider/integration shape to the pure state
 * pipeline. Provider.Info has no ambient connection kind, so the server
 * derives a boolean capability from resolved static provider settings and the
 * integration definitions without retaining those settings.
 */
export function providerStateInputFromOpenCode(input: {
  providers: ReadonlyArray<OpenCodeProviderInfo>
  integrations?: ReadonlyArray<OpenCodeIntegrationInfo>
  connections: ReadonlyArray<OpenCodeConnectionInfo>
  probes?: ProviderStateInput["probes"]
  activities?: ReadonlyArray<ProviderActivity>
  runtime?: ReadonlyArray<ProviderRuntimeState>
  now?: number
}): ProviderStateInput {
  const integrationIDs = new Set((input.integrations ?? []).map((integration) => normalize(integration.id)))
  return {
    providers: input.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      ...(provider.canonical ? { canonical: provider.canonical } : {}),
      activation: provider.activation,
      ...(provider.integrationID ? { integrationID: provider.integrationID } : {}),
      ambientReady: ambientProviderCapability(provider, integrationIDs),
    })),
    connections: input.connections.map((connection) => ({
      integrationID: connection.integrationID,
      kind: connection.kind,
      active: connection.active,
    })),
    ...(input.probes ? { probes: input.probes } : {}),
    ...(input.activities ? { activities: input.activities } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  }
}

function ambientProviderCapability(provider: OpenCodeProviderInfo, integrationIDs: ReadonlySet<string>) {
  if (provider.activation !== "enabled") return false
  const settings = provider.settings
  const staticApiKey = typeof settings?.apiKey === "string" && settings.apiKey.trim().length > 0
  if (staticApiKey) return true
  if (provider.integrationID) return false
  const providerIDs = [provider.id, provider.canonical]
    .filter((value): value is string => typeof value === "string")
    .map(normalize)
  return providerIDs.every((providerID) => !integrationIDs.has(providerID))
}

type ProviderGroup = {
  providers: ProviderInput[]
  aliases: Set<string>
}

const MAX_ID_LENGTH = 128
const MAX_NAME_LENGTH = 160
const MAX_DETAIL_LENGTH = 240
const MAX_USAGE_LENGTH = 160

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function safe(value: unknown, fallback: string, limit: number) {
  if (typeof value !== "string") return fallback
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned ? cleaned.slice(0, limit) : fallback
}

/** Keep user-visible usage and diagnostics bounded and free of common secret forms. */
export function sanitizeProviderText(value: unknown, fallback: string, limit = MAX_DETAIL_LENGTH) {
  let result = safe(value, fallback, limit)
  result = result
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b(?:secret|token|key)[-_][A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]*(?:access[_-]?token|refresh[_-]?token|oauth[_-]?token|api[_-]?key|secret)[A-Za-z0-9_-]*\b(?!\s*[:=])/gi, "[redacted]")
  return result.slice(0, limit)
}

function aliasesFor(provider: ProviderInput) {
  return [provider.id, provider.canonical]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalize)
    .filter(Boolean)
}

function mergeProviderGroups(groups: ProviderGroup[], provider: ProviderInput) {
  const aliases = new Set(aliasesFor(provider))
  const matching = groups.filter((group) => [...aliases].some((alias) => group.aliases.has(alias)))
  if (matching.length === 0) {
    groups.push({ providers: [provider], aliases })
    return
  }

  const target = matching[0]
  target.providers.push(provider)
  for (const alias of aliases) target.aliases.add(alias)
  for (const group of matching.slice(1)) {
    target.providers.push(...group.providers)
    for (const alias of group.aliases) target.aliases.add(alias)
    const index = groups.indexOf(group)
    if (index >= 0) groups.splice(index, 1)
  }
}

function findProbe(input: ProviderStateInput, group: ProviderGroup): Probe | undefined {
  const probes = input.probes
  if (!probes) return undefined
  const entries = Object.entries(probes)
  for (const provider of group.providers) {
    for (const key of [provider.id, provider.canonical].filter((value): value is string => typeof value === "string")) {
      const direct = probes[key]
      if (direct) return direct
      const normalizedKey = normalize(key)
      const matching = entries.find(([candidate]) => normalize(candidate) === normalizedKey)
      if (matching) return matching[1]
    }
  }
  return undefined
}

function hasActiveConnection(input: ProviderStateInput, group: ProviderGroup) {
  const integrationIDs = new Set(
    group.providers
      .map((provider) => provider.integrationID)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map(normalize),
  )
  return input.connections.some((connection) => connection.active && integrationIDs.has(normalize(connection.integrationID)))
}

/** Provider.Info's resolved ambient capability is safe boolean state only. */
function hasAmbientReadiness(group: ProviderGroup) {
  return group.providers.some((provider) => provider.ambientReady
    ?? (provider.activation === "enabled" && !provider.integrationID))
}

function activityAt(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  return value < 100_000_000_000 ? value * 1000 : value
}

function hasRecentActivity(input: ProviderStateInput, group: ProviderGroup, now: number) {
  const cutoff = now - OFFLINE_RECENCY_MS
  const aliases = group.aliases
  const activities = [...(input.activities ?? []), ...(input.activity ?? [])]
  for (const activity of activities) {
    if (!aliases.has(normalize(activity.providerID))) continue
    const at = activityAt(activity.at)
    if (at !== undefined && at >= cutoff && at <= now) return true
  }
  for (const [providerID, timestamp] of Object.entries(input.lastUsedAt ?? {})) {
    if (!aliases.has(normalize(providerID))) continue
    const at = activityAt(timestamp)
    if (at !== undefined && at >= cutoff && at <= now) return true
  }
  return false
}

function hasRuntimeReadiness(input: ProviderStateInput, group: ProviderGroup, now: number) {
  const aliases = group.aliases
  const cutoff = now - RUNTIME_AUTHORITY_MS
  let latest: ProviderRuntimeState | undefined
  let latestAt = Number.NEGATIVE_INFINITY
  for (const runtime of input.runtime ?? []) {
    if (!aliases.has(normalize(runtime.providerID))) continue
    const at = runtime.at === undefined ? undefined : activityAt(runtime.at)
    if (runtime.at !== undefined && at === undefined) continue
    const candidateAt = at ?? now
    if (candidateAt < cutoff || candidateAt > now) continue
    if (!latest || candidateAt >= latestAt) {
      latest = runtime
      latestAt = candidateAt
    }
  }
  return latest?.ready === true
}

function rowFor(
  input: ProviderStateInput,
  group: ProviderGroup,
  working: boolean,
  connected: boolean,
  ambient: boolean,
): { row: ProviderUsageRow; diagnostic?: string } {
  const configured = group.providers[0]
  const id = safe(configured?.id, "provider", MAX_ID_LENGTH)
  const name = safe(configured?.name, id, MAX_NAME_LENGTH)
  const probe = findProbe(input, group)

  if (!working) {
    return {
      row: { id, name, status: "OFFLINE", detail: "No active provider connection." },
    }
  }

  if (probe?.outcome === "auth") {
    return {
      row: { id, name, status: "READY", detail: "An active provider connection is available." },
      diagnostic: `${name}: optional usage authentication check failed; provider readiness is retained.`,
    }
  }
  if (probe?.outcome === "rate") {
    const detail = sanitizeProviderText(
      probe.detail,
      "Usage measurement is unavailable because the measurement service is rate limited.",
      MAX_DETAIL_LENGTH,
    )
    return {
      row: { id, name, status: "READY", detail },
      diagnostic: `${name}: ${detail}`,
    }
  }
  if (probe?.outcome === "unavailable") {
    const detail = sanitizeProviderText(
      probe.detail,
      "Usage measurement is unavailable.",
      MAX_DETAIL_LENGTH,
    )
    return {
      row: { id, name, status: "READY", detail },
      diagnostic: `${name}: ${detail}`,
    }
  }
  if (probe?.outcome === "transient") {
    const usage = probe.usage === undefined
      ? undefined
      : sanitizeProviderText(probe.usage, "", MAX_USAGE_LENGTH)
    const remainingRatio = typeof probe.remainingRatio === "number" && Number.isFinite(probe.remainingRatio)
      ? Math.max(0, Math.min(1, probe.remainingRatio))
      : undefined
    return {
      row: {
        id,
        name,
        status: "STALE",
        detail: "Usage refresh was temporarily unavailable; the previous value is retained.",
        ...(usage ? { usage } : {}),
        ...(remainingRatio !== undefined ? { remainingRatio } : {}),
      },
      diagnostic: `${name}: temporary usage refresh failure; previous value retained.`,
    }
  }
  if (probe?.outcome === "empty") {
    const usage = probe.usage === undefined
      ? undefined
      : sanitizeProviderText(probe.usage, "", MAX_USAGE_LENGTH)
    const remainingRatio = typeof probe.remainingRatio === "number" && Number.isFinite(probe.remainingRatio)
      ? Math.max(0, Math.min(1, probe.remainingRatio))
      : undefined
    return {
      row: {
        id,
        name,
        status: "EMPTY",
        detail: "Verified usage is exhausted.",
        ...(usage ? { usage } : {}),
        ...(remainingRatio !== undefined ? { remainingRatio } : {}),
      },
    }
  }
  if (probe?.outcome === "ok") {
    const usage = probe.usage === undefined ? undefined : sanitizeProviderText(probe.usage, "", MAX_USAGE_LENGTH)
    const remainingRatio = typeof probe.remainingRatio === "number" && Number.isFinite(probe.remainingRatio)
      ? Math.max(0, Math.min(1, probe.remainingRatio))
      : undefined
    return {
      row: {
        id,
        name,
        status: "READY",
        detail: "Usage is verified.",
        ...(usage ? { usage } : {}),
        ...(remainingRatio !== undefined ? { remainingRatio } : {}),
      },
    }
  }
  return {
    row: {
      id,
      name,
      status: "READY",
      detail: connected
        ? "An active provider connection is available."
        : ambient
          ? "OpenCode provider is enabled without an integration requirement."
          : "OpenCode runtime reports the provider ready.",
    },
  }
}

/** Compute only visible provider rows from OpenCode's already-resolved state. */
export function computeProviderStates(input: ProviderStateInput, at = Date.now()): ProviderUsageSnapshot {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : at
  const groups: ProviderGroup[] = []
  for (const provider of input.providers) {
    if (provider.activation === "disabled") continue
    mergeProviderGroups(groups, provider)
  }

  const rows: ProviderUsageRow[] = []
  const diagnostics: string[] = []
  for (const group of groups) {
    const connected = hasActiveConnection(input, group)
    const ambient = hasAmbientReadiness(group)
    const working = connected || ambient || hasRuntimeReadiness(input, group, now)
    if (!working && !hasRecentActivity(input, group, now)) continue
    const result = rowFor(input, group, working, connected, ambient)
    rows.push(result.row)
    if (result.diagnostic) diagnostics.push(sanitizeProviderText(result.diagnostic, "Provider status unavailable."))
  }

  return { generated: now, rows, diagnostics }
}
