import { overallWeeklyWindow, type CodexUsageSnapshot } from "./usage.ts"
import type { UsageState } from "./store.ts"

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
  if (!state.snapshot) return state.message ?? "Codex usage is loading."
  const snapshot = state.snapshot
  const weekly = overallWeeklyWindow(snapshot)
  if (!weekly) return "The overall weekly Codex limit is unavailable."

  const lines = [
    "Overall weekly limit",
    `${percent(weekly.leftPercent)} left, ${percent(weekly.usedPercent)} used`,
    `${relativeTime(weekly.resetsAt, now)} (${exactTime(weekly.resetsAt)})`,
  ]
  if (state.status === "error" && state.message) lines.push(`Refresh error: ${state.message}`)
  lines.push(updatedAgo(snapshot.fetchedAt, now))
  return lines.join("\n")
}

export function formatSnapshot(snapshot: CodexUsageSnapshot, now = Date.now()) {
  return formatDetails({ status: "ready", snapshot }, now)
}
