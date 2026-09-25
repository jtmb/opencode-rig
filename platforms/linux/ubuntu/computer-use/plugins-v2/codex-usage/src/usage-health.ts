export type UsageHealth = "healthy" | "warning" | "critical" | "neutral"

export type UsageToken = {
  text: string
  emphasized: boolean
  health: UsageHealth
}

/**
 * Remaining-ratio policy for verified allowance windows:
 *
 * - healthy: ratio >= 0.50
 * - warning: 0.20 <= ratio < 0.50
 * - critical: ratio < 0.20
 *
 * The input is a normalized remaining ratio, not a provider-specific amount.
 * Unknown values deliberately resolve to neutral instead of guessing.
 */
export const HEALTHY_REMAINING_RATIO = 0.5
export const WARNING_REMAINING_RATIO = 0.2

type UsageStatus = "available" | "quota-exhausted" | "cooling" | "stale" | "unavailable" | "usage-unavailable"

const NUMBER_PATTERN = /[-+]?(?:\d+(?:[.,]\d+)?(?:[.,]\d{3})*)/g
const CURRENCY_SYMBOL_PATTERN = /[$€£¥₹₽₩]/u
const CURRENCY_CODE_PATTERN = /(?:AED|AUD|BRL|CAD|CHF|CNY|EUR|GBP|HKD|INR|JPY|KRW|MXN|NZD|RUB|SGD|USD|ZAR)$/i
const VALUE_UNIT_PATTERN = /^(?:percent|percentage|credits?|tokens?|requests?|calls?|units?)\b/i
const MEASUREMENT_CONTEXT_PATTERN = /\b(?:allowance|available|balance|call|credit|left|quota|remaining|request|token|unit|usage)\b/i

function finiteRatio(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

export function remainingRatioFromPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value / 100))
}

export function usageHealthForRemainingRatio(value: number | undefined): UsageHealth {
  const ratio = finiteRatio(value)
  if (ratio === undefined) return "neutral"
  if (ratio >= HEALTHY_REMAINING_RATIO) return "healthy"
  if (ratio >= WARNING_REMAINING_RATIO) return "warning"
  return "critical"
}

function parseNumber(value: string): number | undefined {
  const lastDot = value.lastIndexOf(".")
  const lastComma = value.lastIndexOf(",")
  let normalized = value
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalIndex = Math.max(lastDot, lastComma)
    normalized = value
      .slice(0, decimalIndex)
      .replace(/[.,]/g, "") + "." + value.slice(decimalIndex + 1)
  } else if (lastComma >= 0) {
    const fractionalDigits = value.length - lastComma - 1
    normalized = fractionalDigits === 3 ? value.replace(/,/g, "") : value.replace(",", ".")
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isUnavailable(status: UsageStatus | undefined) {
  return status === "stale" || status === "unavailable" || status === "usage-unavailable" || status === "cooling"
}

function localMeasurementContext(value: string, start: number, end: number) {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const boundaryBefore = Math.max(before.lastIndexOf(";"), before.lastIndexOf("|"), before.lastIndexOf("\n"))
  const nextSemicolon = after.search(/[;|\n]/)
  const boundaryAfter = nextSemicolon < 0 ? value.length : end + nextSemicolon
  return value.slice(boundaryBefore + 1, boundaryAfter)
}

function pushToken(tokens: UsageToken[], token: UsageToken) {
  if (!token.text) return
  const previous = tokens[tokens.length - 1]
  if (previous && previous.emphasized === token.emphasized && previous.health === token.health) {
    previous.text += token.text
    return
  }
  tokens.push(token)
}

/**
 * Split a provider measurement without applying color to its surrounding
 * labels. Directly attached currency symbols, percentages, and bounded
 * allowance units stay attached to the numeric token; separated currency
 * codes identify a balance but remain part of the muted label. Prose such as
 * `Weekly:` and `left` remains a plain token.
 */
export function tokenizeUsage(
  value: string,
  options: { remainingRatio?: number; status?: UsageStatus } = {},
): UsageToken[] {
  const tokens: UsageToken[] = []
  const matches = [...value.matchAll(NUMBER_PATTERN)]
  let cursor = 0
  const unavailable = isUnavailable(options.status)

  for (const match of matches) {
    const originalStart = match.index ?? 0
    const originalEnd = originalStart + match[0].length
    let start = originalStart
    let end = originalEnd
    let explicitRatio: number | undefined
    let isMeasurement = false

    if (start > 0 && CURRENCY_SYMBOL_PATTERN.test(value[start - 1] ?? "")) {
      start -= 1
      isMeasurement = true
    }
    if (CURRENCY_SYMBOL_PATTERN.test(value[end] ?? "")) {
      end += 1
      isMeasurement = true
    }

    const suffix = value.slice(originalEnd)
    const percentWord = /^(\s+)(percent|percentage)\b/i.exec(suffix)
    if (value[end] === "%") {
      end += 1
      explicitRatio = remainingRatioFromPercent(parseNumber(match[0]))
      isMeasurement = true
    } else if (percentWord) {
      end = originalEnd + percentWord[0].length
      explicitRatio = remainingRatioFromPercent(parseNumber(match[0]))
      isMeasurement = true
    } else {
      const unit = /^(\s+)([A-Za-z]+\b)/.exec(suffix)
      if (unit && VALUE_UNIT_PATTERN.test(unit[2] ?? "")) {
        end = originalEnd + unit[0].length
        isMeasurement = true
      }
    }

    const prefix = value.slice(0, originalStart)
    const currencyCode = /(?:^|\s)([A-Za-z]{3})\s*$/i.exec(prefix)
    if (currencyCode && CURRENCY_CODE_PATTERN.test(currencyCode[1] ?? "")) {
      isMeasurement = true
    }

    if (MEASUREMENT_CONTEXT_PATTERN.test(localMeasurementContext(value, originalStart, originalEnd))) isMeasurement = true

    if (!isMeasurement) {
      if (originalStart > cursor) pushToken(tokens, { text: value.slice(cursor, originalStart), emphasized: false, health: "neutral" })
      pushToken(tokens, { text: value.slice(originalStart, originalEnd), emphasized: false, health: "neutral" })
      cursor = originalEnd
      continue
    }

    if (start < cursor) start = originalStart
    if (originalStart > cursor) pushToken(tokens, { text: value.slice(cursor, start), emphasized: false, health: "neutral" })

    const ratio = explicitRatio ?? finiteRatio(options.remainingRatio)
    const health = unavailable ? "neutral" : usageHealthForRemainingRatio(ratio)
    pushToken(tokens, {
      text: value.slice(start, end),
      emphasized: true,
      health,
    })
    cursor = end
  }

  if (cursor < value.length) pushToken(tokens, { text: value.slice(cursor), emphasized: false, health: "neutral" })
  if (tokens.length === 0 && value) tokens.push({ text: value, emphasized: false, health: "neutral" })
  return tokens
}
