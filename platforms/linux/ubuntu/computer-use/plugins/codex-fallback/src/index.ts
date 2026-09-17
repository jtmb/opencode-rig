import { homedir } from "node:os"
import { join } from "node:path"

import type { Config, Hooks, Plugin } from "@opencode-ai/plugin"

import { catalogFromProviderList, isTierAvailable, pickTier, type Catalog } from "./chain.ts"
import {
  collectAgentConfigs,
  normalizeOptions,
  resolveEffective,
  stripAgentFallback,
  type AgentFallbackConfig,
  type EffectiveFallback,
} from "./config.ts"
import { classifyFailure, classifyRetryMessage, shouldTrigger } from "./detect.ts"
import { isRecord, modelFromMessage, modelKey, parseModelKey, type ModelRef } from "./model.ts"
import { createStateStore } from "./state.ts"
import { createQuotaChecker, type QuotaSnapshot } from "./usage.ts"

const STATE_FILE = "codex-fallback.json"
const CATALOG_CACHE_MS = 60_000
const POST_ABORT_DELAY_MS = 150
const REVERT_ATTEMPTS = 3
const REVERT_RETRY_DELAY_MS = 250
const SWITCH_GRACE_MS = 2_000
const TOAST_MIN_INTERVAL_MS = 15_000

type InputPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; url: string; filename?: string; source?: unknown }
  | { type: "agent"; name: string; source?: unknown }

type ReplayTurn = {
  messageID: string
  parts: InputPart[]
}

type FailureInput = {
  sessionID: string
  error?: unknown
  message?: string
  agent?: string
  model?: ModelRef
  source: string
}

function defaultStatePath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", STATE_FILE)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readAgent(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.agent === "string" && value.agent) return value.agent
  if (typeof value.mode === "string" && value.mode) return value.mode
  return undefined
}

function toInputPart(part: unknown): InputPart | undefined {
  if (!isRecord(part)) return undefined

  if (part.type === "text") {
    if (part.synthetic === true || part.ignored === true) return undefined
    if (typeof part.text !== "string" || !part.text.trim()) return undefined
    return { type: "text", text: part.text }
  }

  if (part.type === "file") {
    if (typeof part.mime !== "string" || typeof part.url !== "string") return undefined
    return {
      type: "file",
      mime: part.mime,
      url: part.url,
      ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      ...(isRecord(part.source) ? { source: part.source } : {}),
    }
  }

  if (part.type === "agent") {
    if (typeof part.name !== "string") return undefined
    return {
      type: "agent",
      name: part.name,
      ...(isRecord(part.source) ? { source: part.source } : {}),
    }
  }

  return undefined
}

export const CodexFallbackPlugin: Plugin = async (ctx, rawOptions) => {
  const options = normalizeOptions(rawOptions)
  const log = (...args: unknown[]) => {
    if (options.debug) console.error("[codex-fallback]", ...args)
  }
  const warn = (...args: unknown[]) => console.error("[codex-fallback]", ...args)

  const state = createStateStore(defaultStatePath())
  await state.load().catch((error) => warn("failed to load fallback state", error))

  const quota = createQuotaChecker({
    endpoint: options.usageEndpoint,
    cacheMs: options.usageCacheMs,
    timeoutMs: options.usageTimeoutMs,
  })

  const fallbacks = new Map<string, AgentFallbackConfig>()
  const agentModels = new Map<string, ModelRef>()
  const sessionAgent = new Map<string, string>()
  const switching = new Set<string>()
  const switchedAt = new Map<string, number>()
  const toastAt = new Map<string, number>()
  let catalogCache: { at: number; value?: Catalog } = { at: 0 }

  const effectiveFor = (agentName: string | undefined): EffectiveFallback =>
    resolveEffective(agentName, fallbacks, options)

  const configuredModel = (agentName: string | undefined): ModelRef | undefined =>
    agentName ? agentModels.get(agentName) : undefined

  const toast = async (
    subject: string,
    title: string,
    message: string,
    variant: "info" | "success" | "warning" | "error",
  ) => {
    if (!options.notify) return
    const now = Date.now()
    const last = toastAt.get(subject) ?? 0
    if (now - last < TOAST_MIN_INTERVAL_MS) return
    toastAt.set(subject, now)
    try {
      await ctx.client.tui.showToast({ body: { title, message, variant, duration: 5000 } })
    } catch {
      // The TUI may not be attached (headless runs); ignore.
    }
  }

  const getCatalog = async (force = false): Promise<Catalog | undefined> => {
    if (!force && catalogCache.value && Date.now() - catalogCache.at < CATALOG_CACHE_MS) {
      return catalogCache.value
    }
    try {
      const response = await ctx.client.provider.list({ query: { directory: ctx.directory } })
      const value = catalogFromProviderList(response.data)
      if (value) catalogCache = { at: Date.now(), value }
      return value ?? catalogCache.value
    } catch (error) {
      log("provider catalog unavailable", error)
      return catalogCache.value
    }
  }

  const pickAvailableTier = async (
    sessionID: string,
    effective: EffectiveFallback,
    startIndex: number,
  ) => {
    const catalog = await getCatalog()
    const result = pickTier({
      chain: effective.chain,
      startIndex,
      isCooling: (key) => state.cooling(key),
      isAvailable: (tier) => isTierAvailable(catalog, tier),
    })
    if (result.skipped.length) log("skipped fallback tiers", sessionID, result.skipped)
    if (!result.tier) log("fallback chain exhausted", sessionID)
    return result.tier
  }

  const rememberSession = (
    sessionID: string,
    patch: { agent?: string; source?: string; active?: string; tier?: string },
  ) => {
    state.setSession(sessionID, patch)
  }

  const abortSession = async (sessionID: string) => {
    try {
      await ctx.client.session.abort({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
    } catch (error) {
      log("session abort failed", sessionID, error)
    }
  }

  const revertSession = async (sessionID: string, messageID: string): Promise<boolean> => {
    try {
      const response = await ctx.client.session.revert({
        path: { id: sessionID },
        body: { messageID },
        query: { directory: ctx.directory },
      })
      return !response.error
    } catch {
      return false
    }
  }

  const lastUserTurn = async (sessionID: string): Promise<ReplayTurn | undefined> => {
    try {
      const response = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const messages = response.data ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const entry = messages[index]
        if (!entry || entry.info?.role !== "user") continue
        const parts: InputPart[] = []
        for (const part of entry.parts ?? []) {
          const input = toInputPart(part)
          if (input) parts.push(input)
        }
        if (parts.length === 0) continue
        return { messageID: entry.info.id, parts }
      }
    } catch (error) {
      log("failed to read session messages", sessionID, error)
    }
    return undefined
  }

  const switchSession = async (input: {
    sessionID: string
    agent?: string
    sourceKey?: string
    tier: ModelRef
    reason: string
  }) => {
    const { sessionID, tier } = input
    if (switching.has(sessionID)) return
    switching.add(sessionID)
    const targetKey = modelKey(tier)
    try {
      const replay = await lastUserTurn(sessionID)
      if (!replay) {
        warn("no user message available to replay", sessionID)
        return
      }
      log("switching session", sessionID, "to", targetKey, `(${input.reason})`)

      await abortSession(sessionID)
      await sleep(POST_ABORT_DELAY_MS)

      let reverted = false
      for (let attempt = 0; attempt < REVERT_ATTEMPTS && !reverted; attempt += 1) {
        reverted = await revertSession(sessionID, replay.messageID)
        if (!reverted && attempt < REVERT_ATTEMPTS - 1) await sleep(REVERT_RETRY_DELAY_MS)
      }
      if (!reverted) log("revert unavailable; replaying without cleanup", sessionID)

      const body = {
        ...(input.agent ? { agent: input.agent } : {}),
        model: { providerID: tier.providerID, modelID: tier.modelID },
        parts: replay.parts,
      } as Parameters<typeof ctx.client.session.promptAsync>[0]["body"]

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body,
        query: { directory: ctx.directory },
      })
      log("switched session", sessionID, "to", targetKey, reverted ? "(reverted)" : "(replay only)")

      rememberSession(sessionID, {
        agent: input.agent,
        source: input.sourceKey,
        active: targetKey,
        tier: targetKey,
      })
      await toast(
        `switch:${sessionID}`,
        "Codex fallback",
        `Continuing on ${targetKey} (${input.reason})`,
        "warning",
      )
    } catch (error) {
      warn("fallback switch failed", sessionID, error)
    } finally {
      switchedAt.set(sessionID, Date.now())
      switching.delete(sessionID)
    }
  }

  const handleFailure = async (input: FailureInput) => {
    const { sessionID } = input
    if (switching.has(sessionID)) return

    const record = state.session(sessionID)
    const agentName = input.agent ?? record?.agent ?? sessionAgent.get(sessionID)
    const effective = effectiveFor(agentName)
    if (!effective.enabled) {
      log("failure ignored: fallback disabled", input.source, sessionID, agentName)
      return
    }

    const failure =
      input.error !== undefined ? classifyFailure(input.error) : classifyRetryMessage(input.message)
    if (!failure || failure.kind === "aborted") {
      log("failure ignored: no signal", input.source, sessionID, failure?.kind)
      return
    }
    log("failure received", input.source, sessionID, failure.kind, failure.status)

    const switched = switchedAt.get(sessionID)
    if (switched && Date.now() - switched < SWITCH_GRACE_MS) {
      log("ignoring failure during post-switch grace", sessionID)
      return
    }

    const failedModel =
      input.model ??
      (record?.active ? parseModelKey(record.active) : undefined) ??
      (record?.source ? parseModelKey(record.source) : undefined) ??
      configuredModel(agentName)
    if (!failedModel) {
      log("failure ignored: could not resolve model", sessionID)
      return
    }
    const failedKey = modelKey(failedModel)

    if (
      failure.kind !== "quota" &&
      state.cooling(failedKey) &&
      record?.active &&
      record.active !== failedKey &&
      effective.chain.some((tier) => modelKey(tier) === record.active)
    ) {
      log("ignoring stale failure for already-cooled model", sessionID, failedKey)
      return
    }

    const chainIndex = effective.chain.findIndex((tier) => modelKey(tier) === failedKey)
    const isTierFailure = chainIndex >= 0

    let trigger = shouldTrigger(failure, effective.triggerOn)
    let snapshot: QuotaSnapshot | undefined
    if (!isTierFailure && failedModel.providerID.toLowerCase() === "openai") {
      snapshot = await quota.check(true)
      if (snapshot?.limitReached) trigger = true
    }
    if (!trigger) {
      log("failure did not trigger fallback", input.source, failure.kind, failure.status)
      return
    }

    const quotaDriven = !isTierFailure && (failure.kind === "quota" || snapshot?.limitReached === true)
    const until = quotaDriven
      ? snapshot?.resetsAt && snapshot.resetsAt > Date.now()
        ? snapshot.resetsAt
        : Date.now() + effective.sourceCooldownSeconds * 1000
      : Date.now() + effective.failureCooldownSeconds * 1000
    state.setCooldown(failedKey, until, quotaDriven ? "usage-limit" : failure.kind)

    const tier = await pickAvailableTier(sessionID, effective, isTierFailure ? chainIndex + 1 : 0)
    if (!tier) {
      await toast(
        `exhausted:${sessionID}`,
        "Fallback unavailable",
        "All fallback models are cooling down or unavailable.",
        "error",
      )
      return
    }

    const sourceModel =
      (record?.source ? parseModelKey(record.source) : undefined) ??
      configuredModel(agentName) ??
      failedModel
    await switchSession({
      sessionID,
      agent: agentName,
      sourceKey: modelKey(sourceModel),
      tier,
      reason: failure.kind,
    })
  }

  const onChatMessage: NonNullable<Hooks["chat.message"]> = async (input, output) => {
    const sessionID = input.sessionID
    if (!sessionID) return

    const agentName = input.agent
    if (agentName) sessionAgent.set(sessionID, agentName)

    const current = modelFromMessage(output.message) ?? input.model
    if (!current) return

    const effective = effectiveFor(agentName)
    const currentKey = modelKey(current)
    if (!effective.enabled) {
      rememberSession(sessionID, {
        agent: agentName,
        source: currentKey,
        active: currentKey,
        tier: undefined,
      })
      return
    }

    const record = state.session(sessionID)
    const chainIndex = effective.chain.findIndex((tier) => modelKey(tier) === currentKey)

    if (state.cooling(currentKey)) {
      const tier = await pickAvailableTier(sessionID, effective, chainIndex >= 0 ? chainIndex + 1 : 0)
      if (tier) {
        output.message.model = { providerID: tier.providerID, modelID: tier.modelID }
        const sourceKey = chainIndex >= 0 ? record?.source : currentKey
        rememberSession(sessionID, {
          agent: agentName,
          ...(sourceKey ? { source: sourceKey } : {}),
          active: modelKey(tier),
          tier: modelKey(tier),
        })
        log("routed cooling model", sessionID, currentKey, "->", modelKey(tier))
        await toast(
          `route:${sessionID}`,
          "Codex fallback",
          `Using ${modelKey(tier)} while ${sourceKey ?? "the primary model"} recovers`,
          "warning",
        )
        return
      }
      await toast(
        `exhausted:${sessionID}`,
        "Fallback unavailable",
        chainIndex >= 0
          ? "No further fallback model is available."
          : "No fallback model is currently available.",
        "error",
      )
      return
    }

    if (chainIndex >= 0) {
      const source = record?.source ? parseModelKey(record.source) : configuredModel(agentName)
      if (source && modelKey(source) !== currentKey && !state.cooling(modelKey(source))) {
        const catalog = await getCatalog()
        if (isTierAvailable(catalog, source)) {
          output.message.model = { providerID: source.providerID, modelID: source.modelID }
          rememberSession(sessionID, {
            agent: agentName,
            source: modelKey(source),
            active: modelKey(source),
            tier: undefined,
          })
          log("recovered session", sessionID, "to", modelKey(source))
          await toast(`recover:${sessionID}`, "Codex restored", `Continuing on ${modelKey(source)}`, "info")
        }
      }
      return
    }

    rememberSession(sessionID, {
      agent: agentName,
      source: currentKey,
      active: currentKey,
      tier: undefined,
    })

    if (effective.proactive && current.providerID.toLowerCase() === "openai") {
      const snapshot = await quota.check(false)
      if (snapshot?.limitReached) {
        const until =
          snapshot.resetsAt && snapshot.resetsAt > Date.now()
            ? snapshot.resetsAt
            : Date.now() + effective.sourceCooldownSeconds * 1000
        state.setCooldown(currentKey, until, "usage-limit")

        const tier = await pickAvailableTier(sessionID, effective, 0)
        if (!tier) {
          await toast(
            `exhausted:${sessionID}`,
            "Codex usage exhausted",
            "No fallback model is currently available.",
            "error",
          )
          return
        }
        output.message.model = { providerID: tier.providerID, modelID: tier.modelID }
        rememberSession(sessionID, {
          agent: agentName,
          source: currentKey,
          active: modelKey(tier),
          tier: modelKey(tier),
        })
        log("proactive quota switch", sessionID, currentKey, "->", modelKey(tier))
        await toast(
          `switch:${sessionID}`,
          "Codex usage exhausted",
          `Continuing on ${modelKey(tier)}`,
          "warning",
        )
      }
    }
  }

  const onEvent: NonNullable<Hooks["event"]> = async ({ event }) => {
    const generic = event as unknown as { type?: string; properties?: Record<string, unknown> }
    const type = generic.type
    if (!type) return
    const properties = generic.properties ?? {}

    if (type === "session.deleted") {
      const info = isRecord(properties.info) ? properties.info : undefined
      const id = typeof info?.id === "string" ? info.id : undefined
      if (id) {
        sessionAgent.delete(id)
        switchedAt.delete(id)
        state.deleteSession(id)
      }
      return
    }

    if (type === "session.status") {
      const status = isRecord(properties.status) ? properties.status : undefined
      if (!status || status.type !== "retry") return
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
      if (!sessionID) return
      const record = state.session(sessionID)
      await handleFailure({
        sessionID,
        message: typeof status.message === "string" ? status.message : "",
        agent: record?.agent,
        source: "session.status",
      })
      return
    }

    if (type === "session.error") {
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
      if (!sessionID || properties.error === undefined) return
      const record = state.session(sessionID)
      await handleFailure({
        sessionID,
        error: properties.error,
        agent: readAgent(properties.error) ?? record?.agent,
        source: "session.error",
      })
      return
    }

    if (type === "message.updated") {
      const info = isRecord(properties.info) ? properties.info : undefined
      if (!info || info.role !== "assistant" || info.error === undefined) return
      const sessionID = typeof info.sessionID === "string" ? info.sessionID : undefined
      if (!sessionID) return
      const record = state.session(sessionID)
      await handleFailure({
        sessionID,
        error: info.error,
        agent: readAgent(info) ?? record?.agent,
        model: modelFromMessage(info),
        source: "message.updated",
      })
    }
  }

  return {
    config: async (config: Config) => {
      const collected = collectAgentConfigs(config)
      fallbacks.clear()
      agentModels.clear()
      for (const [name, value] of collected.fallbacks) fallbacks.set(name, value)
      for (const [name, value] of collected.models) agentModels.set(name, value)
      const removed = stripAgentFallback(config)
      log(
        "config: agent overrides",
        [...fallbacks.keys()],
        "agent models",
        [...agentModels.keys()],
        "stripped keys",
        removed,
      )
    },
    "chat.message": onChatMessage,
    "chat.params": async (_input, output) => {
      if (isRecord(output.options) && "codexFallback" in output.options) {
        delete output.options.codexFallback
      }
    },
    event: onEvent,
    dispose: async () => {
      await state.flush().catch(() => {})
    },
  }
}

export default CodexFallbackPlugin
