import { isRecord, parseModelKey, type ModelRef } from "./model.ts"

export type TriggerMode = "quota" | "any-retryable"

export type AgentFallbackConfig = {
  mode?: "chain" | "off"
  chain?: ModelRef[]
  proactive?: boolean
  triggerOn?: TriggerMode
  failureCooldownSeconds?: number
  sourceCooldownSeconds?: number
}

export type GlobalOptions = {
  defaultChain: ModelRef[]
  proactive: boolean
  notify: boolean
  triggerOn: TriggerMode
  failureCooldownSeconds: number
  sourceCooldownSeconds: number
  usageEndpoint?: string
  usageCacheMs: number
  usageTimeoutMs: number
  debug: boolean
}

export type EffectiveFallback = {
  enabled: boolean
  chain: ModelRef[]
  proactive: boolean
  triggerOn: TriggerMode
  failureCooldownSeconds: number
  sourceCooldownSeconds: number
}

export type CollectedAgents = {
  fallbacks: Map<string, AgentFallbackConfig>
  models: Map<string, ModelRef>
}

export const DEFAULT_FAILURE_COOLDOWN_SECONDS = 300
export const DEFAULT_SOURCE_COOLDOWN_SECONDS = 10_800
export const DEFAULT_USAGE_CACHE_MS = 60_000
export const DEFAULT_USAGE_TIMEOUT_MS = 5_000

const MIN_USAGE_CACHE_MS = 1_000
const MIN_USAGE_TIMEOUT_MS = 500

function boundedNumber(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function optionalSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

export function parseChain(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return []
  const chain: ModelRef[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const model = parseModelKey(entry)
    if (!model) continue
    const key = `${model.providerID}/${model.modelID}`
    if (seen.has(key)) continue
    seen.add(key)
    chain.push(model)
  }
  return chain
}

export function parseAgentFallback(raw: unknown): AgentFallbackConfig | undefined {
  if (!isRecord(raw)) return undefined
  const config: AgentFallbackConfig = {}

  if (raw.mode === "chain" || raw.mode === "off") config.mode = raw.mode
  if (raw.enabled === false) config.mode = "off"
  if (raw.enabled === true && config.mode === undefined) config.mode = "chain"
  if (raw.chain !== undefined) config.chain = parseChain(raw.chain)
  if (typeof raw.proactive === "boolean") config.proactive = raw.proactive
  if (raw.triggerOn === "quota" || raw.triggerOn === "any-retryable") config.triggerOn = raw.triggerOn
  const failure = optionalSeconds(raw.failureCooldownSeconds)
  if (failure !== undefined) config.failureCooldownSeconds = failure
  const source = optionalSeconds(raw.sourceCooldownSeconds)
  if (source !== undefined) config.sourceCooldownSeconds = source

  return config
}

export function collectAgentConfigs(config: unknown): CollectedAgents {
  const collected: CollectedAgents = { fallbacks: new Map(), models: new Map() }
  if (!isRecord(config)) return collected
  const agents = config.agent
  if (!isRecord(agents)) return collected

  for (const [name, entry] of Object.entries(agents)) {
    if (!isRecord(entry)) continue

    if (typeof entry.model === "string") {
      const model = parseModelKey(entry.model)
      if (model) collected.models.set(name, model)
    }

    const options = isRecord(entry.options) ? entry.options : undefined
    const raw = options?.codexFallback ?? entry.codexFallback
    const parsed = parseAgentFallback(raw)
    if (parsed) collected.fallbacks.set(name, parsed)
  }

  return collected
}

export function stripAgentFallback(config: unknown): number {
  if (!isRecord(config)) return 0
  const agents = config.agent
  if (!isRecord(agents)) return 0

  let removed = 0
  for (const entry of Object.values(agents)) {
    if (!isRecord(entry)) continue
    if (isRecord(entry.options) && "codexFallback" in entry.options) {
      delete entry.options.codexFallback
      removed += 1
    }
    if ("codexFallback" in entry) {
      delete entry.codexFallback
      removed += 1
    }
  }
  return removed
}

export function normalizeOptions(raw: unknown): GlobalOptions {
  const source = isRecord(raw) ? raw : {}
  return {
    defaultChain: parseChain(source.defaultChain),
    proactive: source.proactive !== false,
    notify: source.notify !== false,
    triggerOn: source.triggerOn === "any-retryable" ? "any-retryable" : "quota",
    failureCooldownSeconds: boundedNumber(
      source.failureCooldownSeconds,
      DEFAULT_FAILURE_COOLDOWN_SECONDS,
      1,
    ),
    sourceCooldownSeconds: boundedNumber(
      source.sourceCooldownSeconds,
      DEFAULT_SOURCE_COOLDOWN_SECONDS,
      1,
    ),
    usageEndpoint:
      typeof source.usageEndpoint === "string" && source.usageEndpoint
        ? source.usageEndpoint
        : undefined,
    usageCacheMs: boundedNumber(source.usageCacheMs, DEFAULT_USAGE_CACHE_MS, MIN_USAGE_CACHE_MS),
    usageTimeoutMs: boundedNumber(
      source.usageTimeoutMs,
      DEFAULT_USAGE_TIMEOUT_MS,
      MIN_USAGE_TIMEOUT_MS,
    ),
    debug: source.debug === true,
  }
}

export function resolveEffective(
  agentName: string | undefined,
  fallbacks: ReadonlyMap<string, AgentFallbackConfig>,
  options: GlobalOptions,
): EffectiveFallback {
  const override = agentName ? fallbacks.get(agentName) : undefined
  const chain = override?.chain ?? options.defaultChain
  const disabled =
    override?.mode === "off" || (override?.mode === undefined && override?.chain !== undefined && chain.length === 0)

  return {
    enabled: !disabled && chain.length > 0,
    chain,
    proactive: override?.proactive ?? options.proactive,
    triggerOn: override?.triggerOn ?? options.triggerOn,
    failureCooldownSeconds: override?.failureCooldownSeconds ?? options.failureCooldownSeconds,
    sourceCooldownSeconds: override?.sourceCooldownSeconds ?? options.sourceCooldownSeconds,
  }
}
