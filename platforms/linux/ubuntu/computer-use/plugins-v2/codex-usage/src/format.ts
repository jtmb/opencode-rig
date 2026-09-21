import { lunaReserveWindow, overallWeeklyWindow, type CodexUsageSnapshot } from "./usage.ts"
import type { UsageState } from "./store.ts"
import type { ProviderState, ProviderStatus } from "./providers.ts"

export function percent(value: number) {
  return `${Math.round(value)}%`
}

export function relativeTime(timestampSeconds: number | undefined, now = Date.now()) {
  if (timestampSeconds === undefined) return "reset unknown"
  const seconds = Math.max(0, Math.round(timestampSeconds - now / 1000))
  if (seconds < 60) return "resets now"

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return `resets in ${hours}h ${restMinutes}m`
  const days = Math.floor(hours / 24)
  return `resets in ${days}d ${hours % 24}h`
}

export function compactReset(timestampSeconds: number | undefined, now = Date.now()) {
  return relativeTime(timestampSeconds, now)
    .replace(/^resets in /, "")
    .replace(/^resets /, "")
}

export function providerStatusLabel(status: ProviderStatus) {
  if (status === "available") return "READY"
  if (status === "quota-exhausted") return "EMPTY"
  if (status === "cooling") return "COOLING"
  if (status === "stale") return "STALE"
  if (status === "unavailable") return "OFFLINE"
  return "OFFLINE"
}

export function providerPanelDetail(provider: ProviderState) {
  const insufficient = /^Insufficient balance \((.+)\)\.$/.exec(provider.detail)
  if (insufficient) return `Insufficient · ${insufficient[1]}`
  const balance = /^Balance (.+)\.$/.exec(provider.detail)
  if (balance) return `Balance · ${balance[1]}`
  if (provider.detail === "Subscription quota available.") return "Subscription quota available."
  if (provider.detail === "OpenAI subscription login unavailable.") return "Subscription login unavailable."
  if (provider.detail === "Available in provider catalog.") return "Available in provider catalog."
  if (provider.detail === "Available; usage has not been checked.") return "Available in provider catalog."
  if (provider.detail === "Disabled in provider catalog.") return "Disabled in provider catalog."
  if (provider.detail === "Not available in the provider catalog.") return "Not in provider catalog."
  return provider.detail
}

export function providerCompactParts(provider: ProviderState, snapshot?: CodexUsageSnapshot) {
  const measurements: string[] = []
  if (provider.id === "codex" && snapshot) {
    const weekly = overallWeeklyWindow(snapshot)
    const reserve = lunaReserveWindow(snapshot)
    if (weekly) measurements.push(`Weekly ${percent(weekly.leftPercent)}`)
    if (reserve) measurements.push(`Reserve ${percent(reserve.leftPercent)}`)
  }
  return {
    label: provider.label,
    status: providerStatusLabel(provider.status),
    measurements,
  }
}

export function providerCompactLine(provider: ProviderState, snapshot?: CodexUsageSnapshot) {
  const parts = providerCompactParts(provider, snapshot)
  return [`${parts.label} ${parts.status}`, ...parts.measurements].join(" · ")
}

export function providerUsageSummary(providers: readonly ProviderState[]) {
  const labels: Record<string, string> = {
    available: "ready",
    "quota-exhausted": "empty",
    cooling: "cooling",
    stale: "stale",
    unavailable: "offline",
    "usage-unavailable": "offline",
  }
  const counts = new Map<string, number>()
  for (const provider of providers) {
    const label = labels[provider.status] ?? "offline"
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return ["ready", "empty", "cooling", "stale", "offline"]
    .filter((label) => counts.has(label))
    .map((label) => `${counts.get(label)} ${label}`)
    .join(" · ")
}

export function updatedAgo(fetchedAt: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000))
  const time = new Date(fetchedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
  if (seconds < 10) return `Updated ${time} (just now)`
  if (seconds < 60) return `Updated ${time} (${seconds}s ago)`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Updated ${time} (${minutes}m ago)`
  return `Updated ${time} (${Math.floor(minutes / 60)}h ago)`
}

export function usageUpdatedLabel(state: UsageState, now = Date.now()) {
  const fetchedAt = Math.max(state.snapshot?.fetchedAt ?? 0, state.deepSeekBalance?.fetchedAt ?? 0)
  const updated = updatedAgo(fetchedAt, now)
  return state.status === "error" ? `Saved values · ${updated}` : updated
}

function exactTime(timestampSeconds: number | undefined) {
  if (timestampSeconds === undefined) return "unknown"
  return new Date(timestampSeconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function formatDetails(state: UsageState, now = Date.now()) {
  const providerLines = state.providers?.map(
    (provider) => `${provider.label}: ${providerStatusLabel(provider.status)} — ${providerPanelDetail(provider)}`,
  ) ?? []
  if (!state.snapshot) return [state.message ?? "Provider usage is unavailable.", ...providerLines].join("\n")
  const snapshot = state.snapshot
  const weekly = overallWeeklyWindow(snapshot)
  if (!weekly) return ["The overall weekly Codex limit is unavailable.", ...providerLines].join("\n")
  const reserve = lunaReserveWindow(snapshot)

  const lines = [
    "Overall weekly limit",
    `${percent(weekly.leftPercent)} left, ${percent(weekly.usedPercent)} used`,
    `${relativeTime(weekly.resetsAt, now)} (${exactTime(weekly.resetsAt)})`,
  ]
  if (reserve) lines.push(`Luna Reserve: ${percent(reserve.leftPercent)} left, ${relativeTime(reserve.resetsAt, now)}`)
  if (state.status === "error" && state.message) lines.push(`Refresh error: ${state.message}`)
  lines.push(...providerLines)
  lines.push(updatedAgo(snapshot.fetchedAt, now))
  return lines.join("\n")
}

export function formatSnapshot(snapshot: CodexUsageSnapshot, now = Date.now()) {
  return formatDetails({ status: "ready", snapshot }, now)
}
