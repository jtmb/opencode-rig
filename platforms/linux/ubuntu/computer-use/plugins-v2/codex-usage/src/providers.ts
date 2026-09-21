import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import type { DeepSeekBalanceSnapshot, UsageErrorCode } from "./usage.ts"

export type TrackedProvider = "codex" | "deepseek" | "opencode-go" | "opencode-zen"

export type ProviderStatus = "available" | "unavailable" | "usage-unavailable" | "quota-exhausted" | "cooling" | "stale"

export type ProviderState = {
  id: TrackedProvider
  label: string
  status: ProviderStatus
  detail: string
}

type ProviderLike = {
  id?: unknown
  canonical?: unknown
  providerID?: unknown
  activation?: unknown
  enabled?: unknown
}

const DEFINITIONS: readonly [TrackedProvider, string, readonly string[]][] = [
  ["codex", "Codex", ["openai", "codex"]],
  ["deepseek", "DeepSeek", ["deepseek"]],
  ["opencode-go", "OpenCode Go", ["opencode-go"]],
  ["opencode-zen", "OpenCode Zen", ["opencode", "opencode-zen", "zen"]],
]

function providerIdentity(provider: ProviderLike) {
  const direct = [provider.id, provider.providerID].find((value): value is string => typeof value === "string")
  const identity = direct ?? (typeof provider.canonical === "string" ? provider.canonical : undefined)
  return identity?.toLowerCase()
}

function matches(provider: ProviderLike, aliases: readonly string[]) {
  const identity = providerIdentity(provider)
  return identity !== undefined && aliases.includes(identity)
}

/** Build truthful availability without inspecting or exposing credentials. */
export function providerStates(catalog: readonly unknown[] | undefined): ProviderState[] {
  return DEFINITIONS.map(([id, label, aliases]) => {
    if (!catalog) return { id, label, status: "usage-unavailable", detail: "Provider catalog unavailable." }
    const provider = (catalog ?? []).find(
      (value): value is ProviderLike => typeof value === "object" && value !== null && matches(value as ProviderLike, aliases),
    )
    if (!provider) return { id, label, status: "unavailable", detail: "Not available in the provider catalog." }
    if (provider.activation === "disabled" || provider.enabled === false) {
      return { id, label, status: "unavailable", detail: "Disabled in provider catalog." }
    }
    return { id, label, status: "available", detail: "Available in provider catalog." }
  })
}

export function withCodexStatus(states: readonly ProviderState[], input: {
  hasSnapshot: boolean
  leftPercent?: number
  errorCode?: UsageErrorCode
}): ProviderState[] {
  return states.map((state) => {
    if (state.id !== "codex") return state
    if (input.errorCode === "rate-limit") return { ...state, status: "cooling", detail: "Cooling after rate limiting." }
    if (input.errorCode === "auth") return { ...state, status: "unavailable", detail: "OpenAI subscription login unavailable." }
    if (input.errorCode && input.hasSnapshot) return { ...state, status: "stale", detail: "Saved subscription quota retained; refresh failed." }
    if (input.hasSnapshot && input.leftPercent === 0) return { ...state, status: "quota-exhausted", detail: "Weekly quota exhausted." }
    if (input.hasSnapshot) return { ...state, status: "available", detail: "Subscription quota available." }
    return state
  })
}

function deepSeekDetail(snapshot: DeepSeekBalanceSnapshot) {
  const balances = snapshot.balances.map((balance) => `${balance.currency} ${balance.totalBalance}`).join(", ")
  return snapshot.available ? `Balance ${balances}.` : `Insufficient balance (${balances}).`
}

export function withDeepSeekStatus(states: readonly ProviderState[], input: {
  snapshot?: DeepSeekBalanceSnapshot
  errorCode?: UsageErrorCode
}): ProviderState[] {
  return states.map((state) => {
    if (state.id !== "deepseek") return state
    if (input.errorCode === "rate-limit") {
      return { ...state, status: "cooling", detail: "Balance check is cooling after rate limiting." }
    }
    if (input.errorCode === "auth") {
      return { ...state, status: "unavailable", detail: "DeepSeek API login unavailable." }
    }
    if (input.errorCode && input.snapshot) {
      return { ...state, status: "stale", detail: `Saved ${deepSeekDetail(input.snapshot)} Refresh failed.` }
    }
    if (input.snapshot) {
      return {
        ...state,
        status: input.snapshot.available ? "available" : "quota-exhausted",
        detail: deepSeekDetail(input.snapshot),
      }
    }
    return state
  })
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
