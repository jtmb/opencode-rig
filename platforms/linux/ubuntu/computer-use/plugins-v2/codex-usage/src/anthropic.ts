export const ANTHROPIC_WORKSPACE_HEADER = "anthropic-workspace-id"

const WORKSPACE_METADATA_KEYS = [
  "anthropicWorkspaceId",
  "anthropicWorkspaceIds",
  "anthropic_workspace_id",
  "anthropic_workspace_ids",
  "workspaceId",
  "workspaceIds",
  "workspace_id",
  "workspace_ids",
] as const

const RATE_LIMIT_METRICS = [
  {
    label: "Requests",
    remaining: "anthropic-ratelimit-requests-remaining",
    limit: "anthropic-ratelimit-requests-limit",
  },
  {
    label: "Tokens",
    remaining: "anthropic-ratelimit-tokens-remaining",
    limit: "anthropic-ratelimit-tokens-limit",
  },
] as const

export type AnthropicWorkspaceCandidate = {
  workspaceIDs: readonly string[]
  unambiguous: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validWorkspaceID(value: unknown) {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(result) ? result : undefined
}

/** Read only workspace identifiers attached to the resolved API-key metadata. */
export function anthropicWorkspaceCandidate(metadata: unknown): AnthropicWorkspaceCandidate {
  if (!isRecord(metadata)) return { workspaceIDs: [], unambiguous: false }

  const values: string[] = []
  let found = false
  for (const key of WORKSPACE_METADATA_KEYS) {
    if (!Object.hasOwn(metadata, key)) continue
    found = true
    const value = metadata[key]
    const entries = Array.isArray(value) ? value : [value]
    if (entries.length === 0 || entries.length > 16) return { workspaceIDs: [], unambiguous: false }
    for (const entry of entries) {
      const workspaceID = validWorkspaceID(entry)
      if (!workspaceID) return { workspaceIDs: [], unambiguous: false }
      values.push(workspaceID)
    }
  }

  const workspaceIDs = [...new Set(values)]
  return {
    workspaceIDs,
    unambiguous: found && workspaceIDs.length === 1,
  }
}

/** Prefer a single workspace shared by every active Anthropic API key, then an explicit option. */
export function resolveAnthropicWorkspaceID(
  credentials: readonly AnthropicWorkspaceCandidate[],
  option: unknown,
) {
  if (credentials.length > 0 && credentials.every((candidate) => candidate.unambiguous && candidate.workspaceIDs.length === 1)) {
    const workspaceIDs = new Set(credentials.map((candidate) => candidate.workspaceIDs[0]))
    if (workspaceIDs.size === 1) return credentials[0]?.workspaceIDs[0]
  }
  return validWorkspaceID(option)
}

export function isFirstPartyAnthropicRequest(request: Pick<Request, "url">) {
  try {
    const url = new URL(request.url)
    return url.origin === "https://api.anthropic.com" && !url.username && !url.password && url.pathname.startsWith("/v1/")
  } catch {
    return false
  }
}

export function withAnthropicWorkspaceHeader(request: Request, workspaceID: unknown) {
  const valid = validWorkspaceID(workspaceID)
  if (!valid || !isFirstPartyAnthropicRequest(request)) return undefined
  if (request.headers.has(ANTHROPIC_WORKSPACE_HEADER)) return request

  const headers = new Headers(request.headers)
  headers.set(ANTHROPIC_WORKSPACE_HEADER, valid)
  return new Request(request, { headers })
}

function percentage(headers: Headers, metric: (typeof RATE_LIMIT_METRICS)[number]) {
  const limitValue = headers.get(metric.limit)
  const remainingValue = headers.get(metric.remaining)
  if (!limitValue?.trim() || !remainingValue?.trim()) return undefined
  const limit = Number(limitValue)
  const remaining = Number(remainingValue)
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0 || remaining < 0 || remaining > limit) return undefined
  return Math.round((remaining / limit) * 100)
}

/** Render only ratios backed by a complete provider limit/remaining header pair. */
export function anthropicRateLimitUsage(headers: Headers) {
  const measurements = RATE_LIMIT_METRICS.flatMap((metric) => {
    const value = percentage(headers, metric)
    return value === undefined ? [] : [`${metric.label}: ${value}% left`]
  })
  return measurements.length > 0 ? measurements.join(" · ") : undefined
}
