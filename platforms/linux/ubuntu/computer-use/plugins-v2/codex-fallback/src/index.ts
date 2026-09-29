import { homedir } from "node:os"
import { join } from "node:path"

import { Plugin } from "@opencode/plugin"

import { catalogFromModels, isTierAvailable, pickTier, type Catalog } from "./chain.ts"
import {
  normalizeOptions,
  parseAgentFallback,
  resolveEffective,
  type AgentFallbackConfig,
  type EffectiveFallback,
} from "./config.ts"
import { classifyFailure, shouldTrigger } from "./detect.ts"
import { isRecord, modelKey, parseModelKey, type ModelRef } from "./model.ts"
import { createStateStore } from "./state.ts"
import { createQuotaChecker } from "./usage.ts"

const STATE_FILE = "codex-fallback.json"
const CATALOG_CACHE_MS = 60_000
const RETRY_DELAY_MS = 250

function defaultStatePath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", STATE_FILE)
}

/** The V2 model reference carries its model id on `id`; normalise it. */
function refToModel(ref: { providerID: string; id: string; variant?: string }): ModelRef {
  return {
    providerID: String(ref.providerID),
    modelID: String(ref.id),
    ...(typeof ref.variant === "string" && ref.variant ? { variant: ref.variant } : {}),
  }
}

function storedModel(key: string | undefined, variant: string | undefined): ModelRef | undefined {
  const model = parseModelKey(key)
  return model && variant ? { ...model, variant } : model
}

function modelIdentity(model: ModelRef): string {
  return `${modelKey(model)}#${model.variant ?? ""}`
}

function sameRouteModel(left: ModelRef, right: ModelRef): boolean {
  return modelKey(left) === modelKey(right) && (!left.variant || !right.variant || left.variant === right.variant)
}

export default Plugin.define({
  id: "opencode-rig.codex-fallback",
  async setup(ctx) {
    const options = normalizeOptions(ctx.options)
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
    const sessionAgent = new Map<string, string>()
    const routing = new Set<string>()
    const routedFailures = new Map<string, string>()
    const pendingSwitches = new Map<string, { target: ModelRef; staleSeen: boolean }>()
    let catalogCache: { at: number; value?: Catalog } = { at: 0 }

    // Per-agent fallback policy is supplied through this plugin's `agents`
    // option so routing stays local to the plugin configuration.
    if (isRecord(ctx.options.agents)) {
      for (const [name, raw] of Object.entries(ctx.options.agents)) {
        const parsed = parseAgentFallback(raw)
        if (parsed) fallbacks.set(name, parsed)
      }
    }

    const effectiveFor = (agentName: string | undefined): EffectiveFallback =>
      resolveEffective(agentName, fallbacks, options)

    const switchSessionModel = async (sessionID: string, tier: ModelRef): Promise<void> => {
      pendingSwitches.set(sessionID, { target: tier, staleSeen: false })
      try {
        await ctx.session.switchModel({
          sessionID,
          model: {
            providerID: tier.providerID,
            id: tier.modelID,
            ...(tier.variant ? { variant: tier.variant } : {}),
          },
        })
      } catch (error) {
        pendingSwitches.delete(sessionID)
        throw error
      }
    }

    const getCatalog = async (force = false): Promise<Catalog | undefined> => {
      if (!force && catalogCache.value && Date.now() - catalogCache.at < CATALOG_CACHE_MS) {
        return catalogCache.value
      }
      try {
        const response = await ctx.model.list()
        const value = catalogFromModels(response.data)
        if (value) catalogCache = { at: Date.now(), value }
        return value ?? catalogCache.value
      } catch (error) {
        log("model catalog unavailable", error)
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
        wrap: true,
        isCooling: (key) => state.cooling(key),
        isAvailable: (tier) => isTierAvailable(catalog, tier),
      })
      if (result.skipped.length) log("skipped fallback tiers", sessionID, result.skipped)
      if (!result.tier) log("fallback chain exhausted", sessionID)
      return result.tier
    }

    const rememberSession = (
      sessionID: string,
      patch: {
        agent?: string
        source?: string
        sourceVariant?: string
        active?: string
        activeVariant?: string
        tier?: string
        tierVariant?: string
      },
    ) => {
      state.setSession(sessionID, patch)
    }

    /** Arm a cooldown and the next fallback tier when a failure should trigger. */
    const onFailure = async (input: {
      sessionID: string
      agent?: string
      model?: ModelRef
      error?: unknown
      message?: string
      attempt?: number
      source: string
    }): Promise<ModelRef | undefined> => {
      const { sessionID } = input

      const record = state.session(sessionID)
      const agentName = input.agent ?? record?.agent ?? sessionAgent.get(sessionID)
      const effective = effectiveFor(agentName)
      if (!effective.enabled) {
        log("failure ignored: fallback disabled", input.source, sessionID, agentName)
        return undefined
      }

      const failure =
        input.error !== undefined ? classifyFailure(input.error) : classifyFailure(input.message)
      if (!failure || failure.kind === "aborted") {
        log("failure ignored: no signal", input.source, sessionID, failure?.kind)
        return undefined
      }
      log("failure received", input.source, sessionID, failure.kind, failure.status)

      const failedModel =
        input.model ??
        storedModel(record?.active, record?.activeVariant) ??
        storedModel(record?.source, record?.sourceVariant)
      if (!failedModel) {
        log("failure ignored: could not resolve model", sessionID)
        return undefined
      }
      const failedKey = modelKey(failedModel)

      const chainIndex = effective.chain.findIndex((tier) => modelKey(tier) === failedKey)
      const isTierFailure = chainIndex >= 0

      let trigger = shouldTrigger(failure, effective.triggerOn)
      let snapshot = undefined as Awaited<ReturnType<typeof quota.check>> | undefined
      if (!isTierFailure && failedModel.providerID.toLowerCase() === "openai") {
        snapshot = await quota.check(true)
        if (snapshot?.limitReached) trigger = true
      }
      if (!trigger) {
        log("failure did not trigger fallback", input.source, failure.kind, failure.status)
        return undefined
      }

      const quotaDriven = failure.kind === "quota" || snapshot?.limitReached === true
      const until = quotaDriven
        ? snapshot?.resetsAt && snapshot.resetsAt > Date.now()
          ? snapshot.resetsAt
          : Date.now() + effective.sourceCooldownSeconds * 1000
        : Date.now() + effective.failureCooldownSeconds * 1000
      state.setCooldown(failedKey, until, quotaDriven ? "usage-limit" : failure.kind)

      const tier = await pickAvailableTier(sessionID, effective, isTierFailure ? chainIndex + 1 : 0)
      if (!tier) {
        warn("all fallback models are cooling down or unavailable", sessionID)
        return undefined
      }

      const sourceModel =
        storedModel(record?.source, record?.sourceVariant) ??
        failedModel
      rememberSession(sessionID, {
        agent: agentName,
        source: modelKey(sourceModel),
        sourceVariant: sourceModel.variant,
        active: failedKey,
        activeVariant: failedModel.variant,
        tier: undefined,
        tierVariant: undefined,
      })
      log("armed fallback", sessionID, failedKey, "->", modelKey(tier), `(${failure.kind})`)
      return tier
    }

    const handleFailure = async (input: Parameters<typeof onFailure>[0]): Promise<ModelRef | undefined> => {
      const token =
        input.attempt !== undefined && input.model
          ? `${input.attempt}:${modelIdentity(input.model)}`
          : undefined
      if (token && routedFailures.get(input.sessionID) === token) {
        log("ignored duplicate failure", input.sessionID, token)
        return undefined
      }
      if (routing.has(input.sessionID)) return undefined
      routing.add(input.sessionID)
      try {
        const tier = await onFailure(input)
        if (!tier) return undefined
        const record = state.session(input.sessionID)
        const failedModel =
          input.model ??
          storedModel(record?.active, record?.activeVariant) ??
          storedModel(record?.source, record?.sourceVariant)
        // switchModel can synchronously cause the next context hook to run.
        // Publish the intended route before calling it so that hook sees a
        // plugin-generated selection rather than treating it as manual.
        rememberSession(input.sessionID, {
          agent: input.agent ?? record?.agent,
          active: modelKey(tier),
          activeVariant: tier.variant,
          tier: modelKey(tier),
          tierVariant: tier.variant,
        })
        try {
          await switchSessionModel(input.sessionID, tier)
        } catch (error) {
          if (failedModel) {
            rememberSession(input.sessionID, {
              agent: input.agent ?? record?.agent,
              active: modelKey(failedModel),
              activeVariant: failedModel.variant,
              tier: undefined,
              tierVariant: undefined,
            })
          }
          throw error
        }
        if (token) routedFailures.set(input.sessionID, token)
        return tier
      } finally {
        routing.delete(input.sessionID)
      }
    }

    const routeRequest = async (input: {
      sessionID: string
      agent: string
      model: ModelRef
    }): Promise<ModelRef | undefined> => {
      const { sessionID, agent } = input
      const current = input.model
      const effective = effectiveFor(agent)
      const currentKey = modelKey(current)
      sessionAgent.set(sessionID, agent)

      if (!effective.enabled) {
        rememberSession(sessionID, {
          agent,
          source: currentKey,
          sourceVariant: current.variant,
          active: currentKey,
          activeVariant: current.variant,
          tier: undefined,
          tierVariant: undefined,
        })
        return undefined
      }

      const record = state.session(sessionID)
      const active = storedModel(record?.active, record?.activeVariant)
      const pending = pendingSwitches.get(sessionID)
      if (pending) {
        if (sameRouteModel(pending.target, current)) {
          pendingSwitches.delete(sessionID)
        } else if (!pending.staleSeen) {
          pending.staleSeen = true
          log("preserving pending model switch", sessionID, modelKey(pending.target))
          return undefined
        } else {
          pendingSwitches.delete(sessionID)
        }
      }
      if (active && !sameRouteModel(active, current)) {
        rememberSession(sessionID, {
          agent,
          source: currentKey,
          sourceVariant: current.variant,
          active: currentKey,
          activeVariant: current.variant,
          tier: undefined,
          tierVariant: undefined,
        })
        log("honoring manual model selection", sessionID, modelKey(current))
        return undefined
      }
      const chainIndex = effective.chain.findIndex((tier) => modelKey(tier) === currentKey)

      if (state.cooling(currentKey)) {
        const tier = await pickAvailableTier(sessionID, effective, chainIndex >= 0 ? chainIndex + 1 : 0)
        if (tier) {
          const sourceModel = chainIndex >= 0 ? storedModel(record?.source, record?.sourceVariant) : current
          rememberSession(sessionID, {
            agent,
            ...(sourceModel
              ? { source: modelKey(sourceModel), sourceVariant: sourceModel.variant }
              : {}),
            active: modelKey(tier),
            activeVariant: tier.variant,
            tier: modelKey(tier),
            tierVariant: tier.variant,
          })
          log("routed cooling model", sessionID, currentKey, "->", modelKey(tier))
          return tier
        }
        warn("no fallback model is currently available", sessionID)
        return undefined
      }

      if (chainIndex >= 0) {
        const source = storedModel(record?.source, record?.sourceVariant)
        if (source && modelKey(source) !== currentKey && !state.cooling(modelKey(source))) {
          const catalog = await getCatalog()
          if (isTierAvailable(catalog, source)) {
            rememberSession(sessionID, {
              agent,
              source: modelKey(source),
              sourceVariant: source.variant,
              active: modelKey(source),
              activeVariant: source.variant,
              tier: undefined,
              tierVariant: undefined,
            })
            log("recovered session", sessionID, "to", modelKey(source))
            return source
          }
        }
        return undefined
      }

      rememberSession(sessionID, {
        agent,
        source: currentKey,
        sourceVariant: current.variant,
        active: currentKey,
        activeVariant: current.variant,
        tier: undefined,
        tierVariant: undefined,
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
            warn("codex usage exhausted and no fallback is available", sessionID)
            return undefined
          }
          rememberSession(sessionID, {
            agent,
            source: currentKey,
            sourceVariant: current.variant,
            active: modelKey(tier),
            activeVariant: tier.variant,
            tier: modelKey(tier),
            tierVariant: tier.variant,
          })
          log("proactive quota switch", sessionID, currentKey, "->", modelKey(tier))
          return tier
        }
      }

      return undefined
    }

    await ctx.session.hook("context", async (event) => {
      try {
        const tier = await routeRequest({
          sessionID: String(event.sessionID),
          agent: String(event.agent),
          model: refToModel(event.model),
        })
        if (tier) await switchSessionModel(String(event.sessionID), tier)
      } catch (error) {
        warn("context routing failed", error)
      }
    })

    await ctx.session.hook("retry", async (event) => {
      try {
        const routed = await handleFailure({
          sessionID: String(event.sessionID),
          agent: String(event.agent),
          model: refToModel(event.model),
          error: event.error,
          attempt: event.attempt,
          source: "retry",
        })
        if (routed) event.decision = { retry: true, delay: RETRY_DELAY_MS }
      } catch (error) {
        warn("retry routing failed", error)
      }
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const generic = event as unknown as { type?: string; data?: unknown }
          if (generic.type === "session.deleted") {
            const data = isRecord(generic.data) ? generic.data : {}
            const id = typeof data.sessionID === "string" ? data.sessionID : undefined
            if (id) {
              sessionAgent.delete(id)
              routedFailures.delete(id)
              pendingSwitches.delete(id)
              state.deleteSession(id)
            }
            continue
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log("event subscription ended", error)
      }
    })()

    return async () => {
      controller.abort()
      await state.flush().catch(() => {})
    }
  },
})
