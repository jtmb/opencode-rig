// redact.ts — secret redaction for repo-learning observation summaries.
//
// Summaries-only rule: observation records must never carry raw transcripts,
// tool output, or credentials. Every free-text field passes through here
// before storage. Fail-closed: over-cap input throws instead of truncating
// silently, so callers handle the bound explicitly.

export const REDACTED_MARKER = "[REDACTED]"

/** Maximum UTF-8 input size accepted by redactText (64 KiB). Larger input throws. */
export const MAX_REDACT_INPUT_CHARS = 64 * 1024
export const MAX_REDACT_INPUT_BYTES = 64 * 1024

const UTF8_ENCODER = new TextEncoder()

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength
}

type SecretPattern = {
  kind: string
  pattern: RegExp
}

const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "aws-secret", pattern: /\baws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9\/+=]{16,}['"]?/gi },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g },
  { kind: "openai-token", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  { kind: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: "bearer-token", pattern: /\b[Bb]earer\s+[A-Za-z0-9\-._~+\/=]{16,}/g },
  { kind: "password-assignment", pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s'"]{4,})/gi },
];

/** True when text matches any known secret pattern. Pure predicate for gating. */
export function containsSensitive(text: string): boolean {
  if (typeof text !== "string") return true
  if (text.length === 0) return false
  if (text.length > MAX_REDACT_INPUT_CHARS || utf8ByteLength(text) > MAX_REDACT_INPUT_BYTES) return true
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/**
 * Replace known secret shapes with `[REDACTED:<kind>]`.
 * Throws on non-string or over-cap input (fail-closed, never silent).
 */
export function redactText(input: string): string {
  if (typeof input !== "string") throw new Error("redactText requires a string")
  if (input.length > MAX_REDACT_INPUT_CHARS || utf8ByteLength(input) > MAX_REDACT_INPUT_BYTES) {
    throw new Error(`redactText input exceeds ${MAX_REDACT_INPUT_BYTES} UTF-8 bytes`)
  }
  let output = input
  for (const { kind, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    output = output.replace(pattern, `${REDACTED_MARKER}:${kind}`)
  }
  return output
}

/**
 * Redact every string value in a flat record. Non-string values pass through
 * unchanged; nested objects/arrays are replaced with `[REDACTED:nested]` so
 * raw transcripts cannot hide in structure. Throws on invalid input.
 */
export function redactFields(record: Record<string, unknown>): Record<string, unknown> {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("redactFields requires a flat object record")
  }
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    const safeKey = redactText(key)
    if (typeof value === "string") {
      output[safeKey] = redactText(value)
    } else if (value !== null && typeof value === "object") {
      output[safeKey] = `${REDACTED_MARKER}:nested`
    } else {
      output[safeKey] = value
    }
  }
  return output
}
