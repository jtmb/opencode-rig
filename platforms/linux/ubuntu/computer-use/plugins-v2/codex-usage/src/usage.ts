import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
export const DEFAULT_DEEPSEEK_BALANCE_ENDPOINT = "https://api.deepseek.com/user/balance"

export type CodexUsageWindow = {
  id: "primary" | "secondary"
  label: string
  usedPercent: number
  leftPercent: number
  windowMinutes?: number
  resetsAt?: number
}

export type CodexUsageBucket = {
  id: string
  name: string
  allowed?: boolean
  limitReached?: boolean
  windows: CodexUsageWindow[]
}

export type CodexUsageSnapshot = {
  fetchedAt: number
  planType?: string
  buckets: CodexUsageBucket[]
  creditBalance?: string
  unlimitedCredits?: boolean
  resetCredits?: number
  reachedType?: string
}

const LUNA_RESERVE_NAME = "gpt-reserve"

export type OpenAICredential = {
  accessToken: string
  accountId: string
  expiresAt?: number
}

export type DeepSeekCredential = {
  apiKey: string
}

export type DeepSeekBalance = {
  currency: string
  totalBalance: string
  grantedBalance?: string
  toppedUpBalance?: string
}

export type DeepSeekBalanceSnapshot = {
  fetchedAt: number
  available: boolean
  balances: DeepSeekBalance[]
}

export function overallWeeklyWindow(snapshot: CodexUsageSnapshot) {
  const overall = snapshot.buckets.find((bucket) => bucket.id === "codex")
  if (!overall) return undefined
  return overall.windows.find((window) => window.windowMinutes === 10080) ??
    overall.windows.find((window) => window.id === "secondary")
}

export function lunaReserveWindow(snapshot: CodexUsageSnapshot) {
  const reserve = snapshot.buckets.find(
    (bucket) => bucket.id.toLowerCase() === LUNA_RESERVE_NAME || bucket.name.toLowerCase() === LUNA_RESERVE_NAME,
  )
  if (!reserve) return undefined
  return reserve.windows.find((window) => window.windowMinutes === 10080) ??
    reserve.windows.find((window) => window.id === "secondary") ??
    reserve.windows.find((window) => window.id === "primary")
}

export type UsageErrorCode = "auth" | "network" | "rate-limit" | "response"

export class CodexUsageError extends Error {
  readonly code: UsageErrorCode
  readonly retryAt?: number

  constructor(message: string, code: UsageErrorCode, retryAt?: number) {
    super(message)
    this.name = "CodexUsageError"
    this.code = code
    this.retryAt = retryAt
  }
}

export class DeepSeekUsageError extends Error {
  readonly code: UsageErrorCode
  readonly retryAt?: number

  constructor(message: string, code: UsageErrorCode, retryAt?: number) {
    super(message)
    this.name = "DeepSeekUsageError"
    this.code = code
    this.retryAt = retryAt
  }
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function safeText(value: unknown) {
  return text(value)?.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 48)
}

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function safeLabel(value: unknown, fallback: string) {
  return safeText(value) ?? fallback
}

function jwtPayload(token: string): JsonRecord | undefined {
  try {
    const payload = token.split(".")[1]
    if (!payload) return undefined
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function accountIdFrom(token: string, auth: JsonRecord) {
  const direct = text(auth.accountId) ?? text(auth.accountIdOverride)
  if (direct) return direct

  const payload = jwtPayload(token)
  const claims = payload?.["https://api.openai.com/auth"]
  return isRecord(claims) ? text(claims.chatgpt_account_id) : undefined
}

export function defaultAuthPath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "auth.json")
}

export async function readOpenAICredential(authPath = defaultAuthPath()): Promise<OpenAICredential> {
  let raw: string
  try {
    raw = await readFile(authPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexUsageError("OpenAI login not found. Run `opencode auth login`.", "auth")
    }
    throw new CodexUsageError("Could not read the OpenCode authentication file.", "auth")
  }

  let file: unknown
  try {
    file = JSON.parse(raw)
  } catch {
    throw new CodexUsageError("The OpenCode authentication file is invalid.", "auth")
  }

  const openai = isRecord(file) && isRecord(file.openai) ? file.openai : undefined
  if (!openai || openai.type !== "oauth") {
    throw new CodexUsageError("Codex subscription quota requires an OpenAI OAuth login.", "auth")
  }

  const accessToken = text(openai.access)
  if (!accessToken) throw new CodexUsageError("The OpenAI OAuth access token is missing.", "auth")

  const expiresAt = finiteNumber(openai.expires)
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    throw new CodexUsageError("OpenAI login needs renewal. Use OpenAI in OpenCode or log in again.", "auth")
  }

  const accountId = accountIdFrom(accessToken, openai)
  if (!accountId) throw new CodexUsageError("Could not determine the ChatGPT account for this login.", "auth")

  return { accessToken, accountId, expiresAt }
}

export async function readDeepSeekCredential(authPath = defaultAuthPath()): Promise<DeepSeekCredential> {
  let raw: string
  try {
    raw = await readFile(authPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DeepSeekUsageError("DeepSeek login not found. Run `opencode auth login`.", "auth")
    }
    throw new DeepSeekUsageError("Could not read the OpenCode authentication file.", "auth")
  }

  let file: unknown
  try {
    file = JSON.parse(raw)
  } catch {
    throw new DeepSeekUsageError("The OpenCode authentication file is invalid.", "auth")
  }

  const deepseek = isRecord(file) && isRecord(file.deepseek) ? file.deepseek : undefined
  const apiKey = deepseek?.type === "api" ? text(deepseek.key) : undefined
  if (!apiKey) throw new DeepSeekUsageError("DeepSeek API login is unavailable.", "auth")
  return { apiKey }
}

function windowLabel(minutes: number | undefined, fallback: string) {
  if (minutes === 300) return "5h"
  if (minutes === 10080) return "Weekly"
  if (minutes === 43200) return "Monthly"
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`
  if (minutes) return `${minutes}m`
  return fallback
}

function parseWindow(
  value: unknown,
  id: "primary" | "secondary",
  now: number,
): CodexUsageWindow | undefined {
  if (!isRecord(value)) return undefined

  const used = finiteNumber(value.used_percent) ?? finiteNumber(value.usedPercent)
  if (used === undefined) return undefined

  const seconds = finiteNumber(value.limit_window_seconds)
  const directMinutes = finiteNumber(value.windowDurationMins)
  const windowMinutes = seconds !== undefined ? Math.ceil(seconds / 60) : directMinutes
  const resetSeconds = finiteNumber(value.reset_at) ?? finiteNumber(value.resetsAt)
  const resetAfter = finiteNumber(value.reset_after_seconds)
  const resetsAt = resetSeconds ?? (resetAfter !== undefined ? Math.floor(now / 1000 + resetAfter) : undefined)
  const usedPercent = Math.max(0, Math.min(100, used))

  return {
    id,
    label: windowLabel(windowMinutes, id === "primary" ? "Primary" : "Secondary"),
    usedPercent,
    leftPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }
}

function parseBucket(value: unknown, id: string, name: string, now: number): CodexUsageBucket | undefined {
  if (!isRecord(value)) return undefined

  const primary = parseWindow(value.primary_window ?? value.primary, "primary", now)
  const secondary = parseWindow(value.secondary_window ?? value.secondary, "secondary", now)
  const windows = [primary, secondary].filter((item): item is CodexUsageWindow => item !== undefined)
  if (windows.length === 0) return undefined

  return {
    id,
    name,
    allowed: boolean(value.allowed),
    limitReached: boolean(value.limit_reached) ?? boolean(value.limitReached),
    windows,
  }
}

function additionalEntries(value: unknown): Array<{ key?: string; value: unknown }> {
  if (Array.isArray(value)) return value.map((entry) => ({ value: entry }))
  return isRecord(value) ? Object.entries(value).map(([key, entry]) => ({ key, value: entry })) : []
}

function creditSummary(payload: JsonRecord) {
  const credits = isRecord(payload.credits) ? payload.credits : undefined
  const balanceValue = credits?.balance
  const creditBalance =
    typeof balanceValue === "string" || typeof balanceValue === "number" ? safeText(String(balanceValue)) : undefined
  const unlimitedCredits = boolean(credits?.unlimited)
  const reset = isRecord(payload.rate_limit_reset_credits) ? payload.rate_limit_reset_credits : undefined
  const resetCredits = finiteNumber(reset?.available_count) ?? finiteNumber(reset?.availableCount)
  return { creditBalance, unlimitedCredits, resetCredits }
}

export function parseUsagePayload(payload: unknown, now = Date.now()): CodexUsageSnapshot {
  if (!isRecord(payload)) throw new CodexUsageError("Codex returned an invalid usage response.", "response")

  const buckets: CodexUsageBucket[] = []
  const bucketIds = new Set<string>()
  const appendBucket = (bucket: CodexUsageBucket | undefined) => {
    if (!bucket || bucketIds.has(bucket.id)) return
    bucketIds.add(bucket.id)
    buckets.push(bucket)
  }

  appendBucket(
    parseBucket(
      payload.rate_limit ?? payload.rateLimit ?? payload.rate_limits ?? payload.rateLimits,
      "codex",
      "Overall",
      now,
    ),
  )

  const additional = [
    ...additionalEntries(payload.additional_rate_limits ?? payload.additionalRateLimits),
    ...additionalEntries(payload.rate_limits_by_limit_id ?? payload.rateLimitsByLimitId),
  ]
  for (const [index, entry] of additional.entries()) {
    const value = entry.value
    if (!isRecord(value)) continue
    const rateLimit = value.rate_limit ?? value.rateLimit ?? value
    const id = safeLabel(
      value.metered_feature ?? value.meteredFeature ?? value.limit_id ?? value.limitId ?? entry.key,
      `extra-${index + 1}`,
    )
    const name = safeLabel(value.limit_name ?? value.limitName, id)
    appendBucket(parseBucket(rateLimit, id, name, now))
  }

  if (buckets.length === 0) {
    throw new CodexUsageError("No Codex usage windows were present in the response.", "response")
  }

  const credits = creditSummary(payload)
  return {
    fetchedAt: now,
    planType: safeText(payload.plan_type) ?? safeText(payload.planType),
    buckets,
    ...credits,
    reachedType: safeText(payload.rate_limit_reached_type) ?? safeText(payload.rateLimitReachedType),
  }
}

function retryAt(response: Response, now: number) {
  const value = response.headers.get("retry-after")
  if (!value) return now + 60_000
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : now + 60_000
}

function balanceAmount(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined
  const result = safeText(String(value))
  return result && /^-?\d+(?:\.\d+)?$/.test(result) ? result : undefined
}

export function parseDeepSeekBalance(payload: unknown, now = Date.now()): DeepSeekBalanceSnapshot {
  if (!isRecord(payload) || typeof payload.is_available !== "boolean" || !Array.isArray(payload.balance_infos)) {
    throw new DeepSeekUsageError("DeepSeek returned invalid balance data.", "response")
  }

  const balances: DeepSeekBalance[] = []
  for (const value of payload.balance_infos.slice(0, 8)) {
    if (!isRecord(value)) continue
    const currency = safeText(value.currency)
    const totalBalance = balanceAmount(value.total_balance)
    if (!currency || !/^[A-Za-z0-9._-]{1,16}$/.test(currency) || totalBalance === undefined) continue
    const grantedBalance = balanceAmount(value.granted_balance)
    const toppedUpBalance = balanceAmount(value.topped_up_balance)
    balances.push({
      currency: currency.toUpperCase(),
      totalBalance,
      ...(grantedBalance !== undefined ? { grantedBalance } : {}),
      ...(toppedUpBalance !== undefined ? { toppedUpBalance } : {}),
    })
  }

  if (balances.length === 0) {
    throw new DeepSeekUsageError("DeepSeek returned no readable balances.", "response")
  }
  return { fetchedAt: now, available: payload.is_available, balances }
}

export async function fetchDeepSeekBalance(
  credential: DeepSeekCredential,
  options: {
    endpoint?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    now?: number
  } = {},
) {
  const now = options.now ?? Date.now()
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(options.endpoint ?? DEFAULT_DEEPSEEK_BALANCE_ENDPOINT, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.apiKey}`,
        "User-Agent": "opencode-provider-usage/0.1.0",
      },
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new DeepSeekUsageError("Could not reach the DeepSeek balance service.", "network")
  }

  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekUsageError("DeepSeek login is no longer authorized. Log in again.", "auth")
  }
  if (response.status === 429) {
    const next = retryAt(response, now)
    throw new DeepSeekUsageError("DeepSeek balance checks are temporarily rate limited.", "rate-limit", next)
  }
  if (!response.ok) {
    throw new DeepSeekUsageError(`DeepSeek balance service returned HTTP ${response.status}.`, "network")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new DeepSeekUsageError("DeepSeek returned unreadable balance data.", "response")
  }
  return parseDeepSeekBalance(payload, now)
}

export async function fetchCodexUsage(
  credential: OpenAICredential,
  options: {
    endpoint?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
    now?: number
    supportsLunaReserve?: boolean
  } = {},
) {
  const now = options.now ?? Date.now()
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(options.endpoint ?? DEFAULT_USAGE_ENDPOINT, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
        "ChatGPT-Account-Id": credential.accountId,
        Originator: "opencode_codex_usage",
        "User-Agent": "opencode-codex-usage/0.1.0",
        ...(options.supportsLunaReserve ? { "x-openai-codex-luna-reserve": "1" } : {}),
      },
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new CodexUsageError("Could not reach the Codex usage service.", "network")
  }

  if (response.status === 401 || response.status === 403) {
    throw new CodexUsageError("OpenAI login is no longer authorized. Log in again.", "auth")
  }
  if (response.status === 429) {
    const next = retryAt(response, now)
    throw new CodexUsageError("Codex usage checks are temporarily rate limited.", "rate-limit", next)
  }
  if (!response.ok) {
    throw new CodexUsageError(`Codex usage service returned HTTP ${response.status}.`, "network")
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new CodexUsageError("Codex returned unreadable usage data.", "response")
  }
  return parseUsagePayload(payload, now)
}
