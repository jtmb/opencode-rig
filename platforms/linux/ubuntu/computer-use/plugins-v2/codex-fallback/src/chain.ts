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

export function catalogFromModels(models: readonly unknown[]): Catalog | undefined {
  const connected = new Set<string>()
  const byProvider = new Map<string, Set<string>>()

  for (const model of models) {
    if (!isRecord(model)) continue
    const providerID = typeof model.providerID === "string" ? model.providerID : undefined
    const modelID = typeof model.modelID === "string" ? model.modelID : undefined
    if (!providerID || !modelID) continue
    if (model.enabled === false) continue
    connected.add(providerID)
    let ids = byProvider.get(providerID)
    if (!ids) {
      ids = new Set<string>()
      byProvider.set(providerID, ids)
    }
    ids.add(modelID)
  }

  if (connected.size === 0) return undefined
  return { connected, models: byProvider }
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
  wrap?: boolean
  isCooling: (key: string) => boolean
  isAvailable?: (tier: ModelRef) => boolean
}): { tier?: ModelRef; skipped: TierSkip[] } {
  const skipped: TierSkip[] = []
  const startIndex = Math.max(0, input.startIndex ?? 0)
  const count = input.chain.length
  if (count === 0) return { skipped }

  const attempts = input.wrap ? count : Math.max(0, count - startIndex)
  for (let offset = 0; offset < attempts; offset += 1) {
    const index = input.wrap ? (startIndex + offset) % count : startIndex + offset
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
