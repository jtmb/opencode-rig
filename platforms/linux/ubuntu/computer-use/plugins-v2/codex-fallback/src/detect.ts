import type { TriggerMode } from "./config.ts"
import { isRecord } from "./model.ts"

export type FailureKind = "quota" | "rate-limit" | "other" | "aborted"

export type FailureInfo = {
  kind: FailureKind
  status?: number
  text: string
}

const QUOTA_PATTERNS = [
  /usage[_ -]?limit/i,
  /usage_limit_reached/i,
  /insufficient_quota/i,
  /insufficient[_ -]?(?:balance|credits?|funds)/i,
  /(?:balance|credits?) (?:is |are )?(?:depleted|exhausted)/i,
  /quota[_ -]?exceed/i,
  /exceeded your current quota/i,
  /out of (?:extra )?usage/i,
  /hit your .{0,40}usage limit/i,
  /billing hard limit/i,
  /(?:weekly|daily|monthly|5[- ]?hour) limit (?:reached|exceeded)/i,
  /(?:free|go)[_ -]?usage(?:[_ -]?(?:limit|exhaust(?:ed|ion)|exceed(?:ed)?|deplet(?:ed|ion)))?/i,
]

const RETRYABLE_PATTERNS = [
  /rate[_ -]?limit/i,
  /too many requests/i,
  /resource[_ -]?exhausted/i,
  /overloaded/i,
  /service[_ -]?unavailable/i,
  /temporarily unavailable/i,
  /try again (?:later|in\b)/i,
]

const ABORT_PATTERNS = [/messageabortederror/i, /\baborted\b/i]

function errorText(error: unknown): string {
  if (error === undefined || error === null) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) return `${error.name} ${error.message}`.trim()

  const parts: string[] = []
  if (isRecord(error)) {
    const name = error.name
    const message = error.message
    if (typeof name === "string") parts.push(name)
    if (typeof message === "string") parts.push(message)
    for (const key of ["type", "code", "reason", "errorType"]) {
      if (typeof error[key] === "string") parts.push(error[key] as string)
    }
    const data = error.data
    if (isRecord(data)) {
      if (typeof data.message === "string") parts.push(data.message)
      for (const key of ["type", "code", "reason", "errorType"]) {
        if (typeof data[key] === "string") parts.push(data[key])
      }
      if (isRecord(data.error)) {
        for (const key of ["type", "code", "reason"]) {
          if (typeof data.error[key] === "string") parts.push(data.error[key] as string)
        }
      }
      if (typeof data.responseBody === "string") parts.push(data.responseBody)
    }
  }
  if (parts.length === 0) {
    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== "{}" && serialized !== "[]") parts.push(serialized)
    } catch {
      parts.push(String(error))
    }
  }
  return parts.join(" ").trim()
}

function extractStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  const candidates = [error.statusCode, error.status, error.code]
  const data = isRecord(error.data) ? error.data : undefined
  if (data) candidates.push(data.statusCode, data.status)
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

function classifyText(text: string, status?: number): FailureInfo | undefined {
  if (!text) return undefined
  if (ABORT_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "aborted", status, text }
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return { kind: "quota", status, text }
  if (status === 429 || RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "rate-limit", status, text }
  }
  return { kind: "other", status, text }
}

export function classifyFailure(error: unknown): FailureInfo | undefined {
  const text = errorText(error)
  const status = extractStatus(error)
  if (!text && status === undefined) return undefined
  if (!text) return { kind: "other", status, text: String(status) }
  return classifyText(text, status)
}

export function classifyRetryMessage(message: unknown): FailureInfo | undefined {
  if (typeof message !== "string" || !message.trim()) return undefined
  return classifyText(message)
}

export function shouldTrigger(info: FailureInfo | undefined, triggerOn: TriggerMode): boolean {
  if (!info || info.kind === "aborted") return false
  if (info.kind === "quota") return true
  if (triggerOn !== "any-retryable") return false
  if (info.kind === "rate-limit") return true
  return info.status !== undefined && (info.status === 429 || info.status >= 500)
}
