import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  CodexUsageError,
  codexLimitReached,
  fetchCodexUsage,
  overallWeeklyWindow,
  type CodexUsageSnapshot,
  type OpenAICredential,
} from "../../codex-usage/src/usage.ts"

export type QuotaSnapshot = {
  limitReached: boolean
  resetsAt?: number
  planType?: string
  fetchedAt: number
}

export type QuotaChecker = {
  check(force?: boolean): Promise<QuotaSnapshot | undefined>
}

export type QuotaCheckerOptions = {
  endpoint?: string
  authPath?: string
  cacheMs: number
  timeoutMs: number
  fetchImpl?: typeof fetch
  now?: () => number
}

const FAILURE_CACHE_MAX_MS = 15_000

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

function defaultAuthPath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "auth.json")
}

async function readOpenAICredential(authPath = defaultAuthPath()): Promise<OpenAICredential> {
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

export function quotaFromSnapshot(snapshot: CodexUsageSnapshot): QuotaSnapshot {
  const weekly = overallWeeklyWindow(snapshot)

  return {
    limitReached: codexLimitReached(snapshot),
    resetsAt: weekly?.resetsAt !== undefined ? weekly.resetsAt * 1000 : undefined,
    planType: snapshot.planType,
    fetchedAt: snapshot.fetchedAt,
  }
}

export function createQuotaChecker(options: QuotaCheckerOptions): QuotaChecker {
  const now = options.now ?? Date.now
  let cached: QuotaSnapshot | undefined
  let cachedAt = 0
  let failedAt = 0
  let running: Promise<QuotaSnapshot | undefined> | undefined

  const run = (force: boolean): Promise<QuotaSnapshot | undefined> => {
    const current = now()
    if (!force) {
      if (cached && current - cachedAt < options.cacheMs) return Promise.resolve(cached)
      if (failedAt && current - failedAt < Math.min(options.cacheMs, FAILURE_CACHE_MAX_MS)) {
        return Promise.resolve(undefined)
      }
    }
    if (running) return running

    running = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      try {
        const credential = await readOpenAICredential(options.authPath)
        const snapshot = await fetchCodexUsage(credential, {
          endpoint: options.endpoint,
          signal: controller.signal,
          fetchImpl: options.fetchImpl,
          now: now(),
        })
        const quota = quotaFromSnapshot(snapshot)
        cached = quota
        cachedAt = current
        failedAt = 0
        return quota
      } catch {
        failedAt = current
        return undefined
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      running = undefined
    })

    return running
  }

  return { check: (force = false) => run(force) }
}
