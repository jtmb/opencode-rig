export type ModelRef = {
  providerID: string
  modelID: string
  variant?: string
}

type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function modelKey(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}`
}

export function parseModelKey(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  const separator = trimmed.indexOf("/")
  if (separator <= 0 || separator === trimmed.length - 1) return undefined
  const providerID = trimmed.slice(0, separator).trim()
  const modelWithVariant = trimmed.slice(separator + 1).trim()
  const variantSeparator = modelWithVariant.indexOf("#")
  const modelID = (variantSeparator >= 0 ? modelWithVariant.slice(0, variantSeparator) : modelWithVariant).trim()
  const variant = variantSeparator >= 0 ? modelWithVariant.slice(variantSeparator + 1).trim() : undefined
  if (!providerID || !modelID) return undefined
  if (/\s/.test(providerID) || /\s/.test(modelID)) return undefined
  if (variantSeparator >= 0 && (!variant || /\s/.test(variant))) return undefined
  return variant ? { providerID, modelID, variant } : { providerID, modelID }
}

export function modelFromMessage(message: unknown): ModelRef | undefined {
  if (!isRecord(message)) return undefined

  if (isRecord(message.model)) {
    const providerID = message.model.providerID
    const modelID = message.model.modelID
    if (typeof providerID === "string" && typeof modelID === "string") {
      const variant = message.model.variant
      return typeof variant === "string" && variant ? { providerID, modelID, variant } : { providerID, modelID }
    }
  }

  const providerID = message.providerID
  const modelID = message.modelID
  return typeof providerID === "string" && typeof modelID === "string"
    ? { providerID, modelID }
    : undefined
}

export function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return (
    !!left &&
    !!right &&
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    left.variant === right.variant
  )
}
