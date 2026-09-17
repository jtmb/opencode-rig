import { isRecord, modelKey, type ModelRef } from "./model.ts"

export type Catalog = {
  connected: Set<string>
  models: Map<string, Set<string>>
}

export type TierSkip = {
  tier: ModelRef
  reason: "cooldown" | "unavailable"
}

export function catalogFromProviderList(data: unknown): Catalog | undefined {
  if (!isRecord(data)) return undefined

  const connected = new Set<string>()
  if (Array.isArray(data.connected)) {
    for (const id of data.connected) {
      if (typeof id === "string" && id) connected.add(id)
    }
  }

  const models = new Map<string, Set<string>>()
  if (Array.isArray(data.all)) {
    for (const provider of data.all) {
      if (!isRecord(provider) || typeof provider.id !== "string") continue
      const ids = new Set<string>()
      if (isRecord(provider.models)) {
        for (const id of Object.keys(provider.models)) ids.add(id)
      }
      models.set(provider.id, ids)
    }
  }

  if (connected.size === 0 && models.size === 0) return undefined
  return { connected, models }
}

export function isTierAvailable(catalog: Catalog | undefined, tier: ModelRef): boolean {
  if (!catalog) return true
  if (!catalog.connected.has(tier.providerID)) return false
  const models = catalog.models.get(tier.providerID)
  return models ? models.has(tier.modelID) : false
}

export function pickTier(input: {
  chain: ModelRef[]
  startIndex?: number
  isCooling: (key: string) => boolean
  isAvailable?: (tier: ModelRef) => boolean
}): { tier?: ModelRef; skipped: TierSkip[] } {
  const skipped: TierSkip[] = []
  const startIndex = Math.max(0, input.startIndex ?? 0)

  for (let index = startIndex; index < input.chain.length; index += 1) {
    const tier = input.chain[index]
    if (!tier) continue
    if (input.isCooling(modelKey(tier))) {
      skipped.push({ tier, reason: "cooldown" })
      continue
    }
    if (input.isAvailable && !input.isAvailable(tier)) {
      skipped.push({ tier, reason: "unavailable" })
      continue
    }
    return { tier, skipped }
  }

  return { skipped }
}
