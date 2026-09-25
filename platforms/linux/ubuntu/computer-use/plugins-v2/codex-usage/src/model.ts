export type SessionModel = {
  providerID: string
  modelID: string
}

export type ProviderActivity = {
  providerID: string
  at: number
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function messageModel(message: unknown): SessionModel | undefined {
  if (!isRecord(message)) return undefined

  if (isRecord(message.model)) {
    const providerID = message.model.providerID
    const modelID = message.model.modelID ?? message.model.id
    if (typeof providerID === "string" && typeof modelID === "string") return { providerID, modelID }
  }

  const providerID = message.providerID
  const modelID = message.modelID ?? message.id
  return typeof providerID === "string" && typeof modelID === "string" ? { providerID, modelID } : undefined
}

export function latestSessionModel(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messageModel(messages[index])
    if (model) return model
  }
  return undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function epochMilliseconds(value: unknown) {
  const number = finite(value)
  if (number === undefined || number <= 0) return undefined
  return number < 100_000_000_000 ? number * 1000 : number
}

function modelActivityAt(value: unknown) {
  if (!record(value)) return undefined
  const time = record(value.time) ? value.time : undefined
  return epochMilliseconds(time?.created) ?? epochMilliseconds(value.created)
}

/** Extract provider activity without reading or retaining message content. */
export function providerActivityFromMessage(message: unknown): ProviderActivity | undefined {
  const model = messageModel(message)
  const at = modelActivityAt(message)
  if (!model || at === undefined) return undefined
  return { providerID: model.providerID, at }
}

/** Extract activity from an authoritative model-selection event. */
export function providerActivityFromEvent(event: unknown): ProviderActivity | undefined {
  if (!record(event)) return undefined
  if (event.type !== "session.model.selected") return undefined
  const data = record(event.data) ? event.data : undefined
  const model = data && record(data.model) ? data.model : undefined
  const providerID = model?.providerID
  const at = epochMilliseconds(event.created)
  return typeof providerID === "string" && at !== undefined ? { providerID, at } : undefined
}

/**
 * Read a bounded, newest-first message slice. OpenCode's message metadata is
 * enough for recency; message text is intentionally never inspected.
 */
export function recentProviderActivity(
  messages: readonly unknown[],
  now: number,
  windowMs: number,
): ProviderActivity[] {
  const cutoff = now - windowMs
  const result: ProviderActivity[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const activity = providerActivityFromMessage(messages[index])
    if (!activity) continue
    if (activity.at < cutoff) break
    if (activity.at <= now) result.push(activity)
  }
  return result
}

export function isCodexSubscriptionModel(model: SessionModel | undefined) {
  if (!model) return false
  const provider = model.providerID.toLowerCase()
  return provider === "openai" || provider.includes("codex")
}
