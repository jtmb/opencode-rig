import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ProviderUsageRow, ProviderUsageSnapshot } from "./state.ts"

export type TrackedProvider = string

export type ProviderStatus = "available" | "unavailable" | "usage-unavailable" | "quota-exhausted" | "cooling" | "stale"

export type ProviderState = {
  id: string
  label: string
  status: ProviderStatus
  detail: string
  usage?: string
  remainingRatio?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isProviderStatus(value: unknown): value is ProviderUsageRow["status"] {
  return value === "READY" || value === "EMPTY" || value === "COOLING" || value === "OFFLINE" || value === "STALE"
}

function isProviderUsageRow(value: unknown): value is ProviderUsageRow {
  if (!isRecord(value)) return false
  return typeof value.id === "string" &&
    typeof value.name === "string" &&
    isProviderStatus(value.status) &&
    typeof value.detail === "string" &&
    (value.remainingRatio === undefined || (typeof value.remainingRatio === "number" && Number.isFinite(value.remainingRatio) && value.remainingRatio >= 0 && value.remainingRatio <= 1))
}

function snapshotRows(value: unknown): ProviderUsageRow[] {
  if (Array.isArray(value)) return value.filter(isProviderUsageRow)
  if (!isRecord(value) || !Array.isArray(value.rows)) return []
  return value.rows.filter(isProviderUsageRow)
}

function displayState(row: ProviderUsageRow): ProviderState {
  const status: ProviderStatus = row.status === "READY"
    ? "available"
    : row.status === "EMPTY"
      ? "quota-exhausted"
      : row.status === "COOLING"
        ? "cooling"
        : row.status === "STALE"
          ? "stale"
          : "unavailable"
  return {
    id: row.id,
    label: row.name,
    status,
    detail: row.detail,
    ...(typeof row.usage === "string" && row.usage.length > 0 ? { usage: row.usage } : {}),
    ...(typeof row.remainingRatio === "number" ? { remainingRatio: row.remainingRatio } : {}),
  }
}

/** Map only server-supplied rows; this function never invents catalog entries. */
export function providerStates(snapshot: ProviderUsageSnapshot | readonly ProviderUsageRow[] | undefined): ProviderState[] {
  return snapshotRows(snapshot).map(displayState)
}

export type ProviderCooldowns = Partial<Record<TrackedProvider, number>>

export function defaultFallbackStatePath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "codex-fallback.json")
}

const PROVIDER_FOR_ID: Record<string, TrackedProvider | undefined> = {
  openai: "codex",
  codex: "codex",
  deepseek: "deepseek",
  "opencode-go": "opencode-go",
  opencode: "opencode-zen",
  "opencode-zen": "opencode-zen",
  zen: "opencode-zen",
}

export async function readProviderCooldowns(
  path = defaultFallbackStatePath(),
  now = Date.now(),
): Promise<ProviderCooldowns> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return {}
  }
  if (Buffer.byteLength(raw, "utf8") > 1_048_576) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
  const cooldowns = (parsed as { cooldowns?: unknown }).cooldowns
  if (typeof cooldowns !== "object" || cooldowns === null || Array.isArray(cooldowns)) return {}

  const result: ProviderCooldowns = {}
  for (const [model, value] of Object.entries(cooldowns).slice(0, 512)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue
    const until = (value as { until?: unknown }).until
    if (typeof until !== "number" || !Number.isFinite(until) || until <= now) continue
    const provider = PROVIDER_FOR_ID[model.split("/", 1)[0]?.toLowerCase() ?? ""]
    if (provider) result[provider] = Math.max(result[provider] ?? 0, until)
  }
  return result
}

export function withProviderCooldowns(
  states: readonly ProviderState[],
  cooldowns: ProviderCooldowns,
  now = Date.now(),
): ProviderState[] {
  return states.map((state) => {
    const until = cooldowns[state.id]
    if (!until || until <= now || state.status === "quota-exhausted" || state.status === "unavailable") return state
    const minutes = Math.max(1, Math.ceil((until - now) / 60_000))
    return { ...state, status: "cooling", detail: `Fallback route cooling for ${minutes}m.` }
  })
}
