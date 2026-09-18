export type SessionModel = {
  providerID: string
  modelID: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function messageModel(message: unknown): SessionModel | undefined {
  if (!isRecord(message)) return undefined

  if (isRecord(message.model)) {
    const providerID = message.model.providerID
    const modelID = message.model.modelID
    if (typeof providerID === "string" && typeof modelID === "string") return { providerID, modelID }
  }

  const providerID = message.providerID
  const modelID = message.modelID
  return typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : undefined
}

export function latestSessionModel(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messageModel(messages[index])
    if (model) return model
  }
  return undefined
}

export function isCodexSubscriptionModel(model: SessionModel | undefined) {
  if (!model) return false
  const provider = model.providerID.toLowerCase()
  return provider === "openai" || provider.includes("codex")
}
