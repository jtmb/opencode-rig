import { Plugin } from "@opencode/plugin"
import { resolve } from "node:path"

import {
  createChatGPTBackend,
  type ChatGPTBackend,
  type ChatMessage,
  type CodexCredential,
} from "./backend.ts"
import {
  ChatGPT,
  MAX_IMAGE_BASE64,
  MAX_RESULT_SOURCES,
  MAX_RESULT_TEXT,
  type ChatGPTInput,
  type ChatGPTResult,
  type ChatGPTSource,
} from "./rpc.ts"

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/
const OPENAI_MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const MAX_STATES = 128
const MAX_CHAT_MESSAGES = 12
const MAX_CHAT_CHARS = 32_768
const MAX_CHAT_MESSAGE_CHARS = 8_192
const REQUEST_TIMEOUT_MS = 45_000

type ServerContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
type SessionLocation = {
  id?: string
  projectID?: string
  location?: { directory?: string }
  model?: unknown
}

type ServerDependencies = { backend?: ChatGPTBackend }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function isSafeModelID(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false
  return OPENAI_MODEL_ID_PATTERN.exec(value)?.[0] === value
}

function safeAccountID(value: unknown) {
  if (typeof value !== "string") return undefined
  const accountID = value.trim()
  return /^[A-Za-z0-9._:-]{1,256}$/.test(accountID) ? accountID : undefined
}

function tokenAccountID(accessToken: string, metadata: unknown) {
  if (isRecord(metadata)) {
    for (const key of ["accountId", "accountIdOverride", "chatgpt_account_id", "chatgptAccountId"]) {
      const accountID = safeAccountID(metadata[key])
      if (accountID) return accountID
    }
  }
  try {
    const encoded = accessToken.split(".")[1]
    if (!encoded) return undefined
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    if (!isRecord(payload)) return undefined
    const claims = payload["https://api.openai.com/auth"]
    return isRecord(claims) ? safeAccountID(claims.chatgpt_account_id) : undefined
  } catch {
    return undefined
  }
}

function validateOAuth(value: unknown, now = Date.now()): CodexCredential {
  if (!isRecord(value) || value.type !== "oauth") {
    throw new Error("OpenAI API-key authentication is not supported; use an active OpenAI OAuth connection.")
  }
  const accessToken = typeof value.access === "string" ? value.access.trim() : ""
  if (!accessToken || accessToken.length > 16_384 || /[\u0000-\u0020\u007f]/.test(accessToken)) {
    throw new Error("An active OpenAI OAuth connection is required.")
  }
  if (typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires <= now) {
    throw new Error("OpenAI OAuth has expired; sign in again.")
  }
  const accountID = tokenAccountID(accessToken, value.metadata)
  if (!accountID) throw new Error("The active OpenAI OAuth account identity is unavailable.")
  return { accessToken, accountID }
}

async function resolveOpenAIOAuth(ctx: ServerContext): Promise<CodexCredential> {
  try {
    const [providerResult, integrationResult] = await Promise.all([
      ctx.provider.list(),
      ctx.integration.list(),
    ])
    const providers = providerResult.data.filter((provider) => {
      const aliases = [provider.id, provider.canonical]
        .filter((item): item is string => typeof item === "string")
        .map(normalize)
      return aliases.includes("openai") || aliases.includes("codex")
    })
    const integrationIDs = [...new Set(providers
      .map((provider) => provider.integrationID)
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0))]
    const knownIntegrations = new Set(integrationResult.data.map((integration) => normalize(integration.id)))
    const matchingIDs = integrationIDs.filter((id) => knownIntegrations.has(normalize(id)))
    if (matchingIDs.length === 0) throw new Error("Active OpenAI OAuth connection is unavailable.")

    const resolved: CodexCredential[] = []
    for (const integrationID of matchingIDs) {
      const connection = await ctx.integration.connection.active(integrationID)
      if (!connection) continue
      if (connection.type !== "credential") continue
      const credential = await ctx.integration.connection.resolve(connection)
      if (isRecord(credential) && credential.type === "key") {
        throw new Error("OpenAI API-key authentication is not supported; use an active OpenAI OAuth connection.")
      }
      if (credential !== undefined) resolved.push(validateOAuth(credential))
    }
    if (resolved.length !== 1) throw new Error("A single active OpenAI OAuth connection is required.")
    return resolved[0]!
  } catch (error) {
    if (error instanceof Error && (
      error.message === "OpenAI API-key authentication is not supported; use an active OpenAI OAuth connection." ||
      error.message === "OpenAI OAuth has expired; sign in again." ||
      error.message === "The active OpenAI OAuth account identity is unavailable." ||
      error.message === "A single active OpenAI OAuth connection is required." ||
      error.message === "Active OpenAI OAuth connection is unavailable."
    )) throw error
    throw new Error("Unable to resolve the active OpenAI OAuth connection.")
  }
}

function normalizedPrompt(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string") throw new Error(`${label} is required.`)
  const text = value.trim()
  if (!text) throw new Error(`${label} is required.`)
  if (text.length > maxLength) throw new Error(`${label} exceeds the size limit.`)
  return text
}

async function resolveSession(ctx: ServerContext, input: ChatGPTInput) {
  if (!SESSION_ID_PATTERN.test(input.sessionID)) throw new Error("A valid OpenCode session ID is required.")
  let session: SessionLocation
  try {
    session = await ctx.session.get({ sessionID: input.sessionID })
  } catch {
    throw new Error("The OpenCode session was not found.")
  }
  if (session.id !== input.sessionID) throw new Error("The OpenCode session ID did not match.")
  const directory = session.location?.directory
  if (typeof directory !== "string" || !directory.trim() || typeof session.projectID !== "string" || !session.projectID) {
    throw new Error("The OpenCode session location is unavailable.")
  }
  const invokingDirectory = ctx.location.directory
  const invokingProjectID = ctx.location.project.id
  if (typeof invokingDirectory !== "string" || !invokingDirectory.trim() ||
    typeof invokingProjectID !== "string" || !invokingProjectID) {
    throw new Error("The invoking project location is unavailable.")
  }
  if (session.projectID !== invokingProjectID || resolve(directory) !== resolve(invokingDirectory)) {
    throw new Error("The OpenCode session does not belong to the invoking project.")
  }
  if (input.projectDirectory !== undefined) {
    if (typeof input.projectDirectory !== "string" || !input.projectDirectory.trim()) {
      throw new Error("The requested project directory is invalid.")
    }
    let matches = false
    try {
      matches = resolve(input.projectDirectory) === resolve(directory)
    } catch {
      matches = false
    }
    if (!matches) throw new Error("The OpenCode session does not belong to the requested project directory.")
  }
  return { sessionID: input.sessionID, projectID: session.projectID, directory, model: session.model }
}

async function resolveOpenAIModel(ctx: ServerContext, session: Awaited<ReturnType<typeof resolveSession>>) {
  let availableModels: Awaited<ReturnType<typeof ctx.model.list>>["data"]
  try {
    availableModels = (await ctx.model.list()).data.filter((candidate) => {
      const providerID = candidate.providerID
      const modelID = candidate.id
      return typeof providerID === "string" &&
        normalize(providerID) === "openai" &&
        candidate.enabled &&
        isSafeModelID(modelID) &&
        modelID.toLowerCase().includes("codex")
    })
  } catch {
    throw new Error("Unable to resolve an available OpenAI Codex model.")
  }
  const sessionModel = session.model
  let preferredModelID: string | undefined
  if (isRecord(sessionModel)) {
    const providerID = sessionModel.providerID
    const modelID = sessionModel.id
    if (typeof providerID === "string" && normalize(providerID) === "openai" &&
      isSafeModelID(modelID) && modelID.toLowerCase().includes("codex")) {
      preferredModelID = modelID
    }
  }
  const preferred = preferredModelID === undefined
    ? undefined
    : availableModels.find((candidate) => candidate.id === preferredModelID)
  const selected = preferred ?? [...availableModels].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )[0]
  if (!selected) throw new Error("No available OpenAI Codex model is configured.")
  return selected.id
}

function stateKey(session: { sessionID: string; projectID: string; directory: string }, accountID: string) {
  return JSON.stringify([session.sessionID, accountID, session.projectID, session.directory])
}

function boundedHistory(messages: readonly ChatMessage[]): ChatMessage[] {
  const bounded = messages.slice(-MAX_CHAT_MESSAGES).map((message) => ({
    role: message.role,
    text: message.text.slice(0, MAX_CHAT_MESSAGE_CHARS),
  }))
  let characters = bounded.reduce((total, message) => total + message.text.length, 0)
  while (bounded.length > 1 && characters > MAX_CHAT_CHARS) {
    const removed = bounded.shift()!
    characters -= removed.text.length
  }
  return bounded
}

function usableSource(value: ChatGPTSource): ChatGPTSource | undefined {
  const title = value.title.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512)
  if (!title || value.url.length === 0 || value.url.length > 2048) return undefined
  try {
    const url = new URL(value.url)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
      return undefined
    }
    const normalized = url.toString()
    return normalized.length <= 2048 ? { title, url: normalized } : undefined
  } catch {
    return undefined
  }
}

function eventSessionID(event: unknown) {
  if (!isRecord(event) || !isRecord(event.data) || typeof event.data.sessionID !== "string") return undefined
  return event.data.sessionID
}

function requestScope(parent: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  if (parent.aborted) abort()
  else parent.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener("abort", abort)
    },
  }
}

export async function setupChatGPTServer(ctx: ServerContext, dependencies: ServerDependencies = {}) {
  const backend = dependencies.backend ?? createChatGPTBackend()
  const histories = new Map<string, { sessionID: string; messages: ChatMessage[] }>()
  const sessionLocks = new Map<string, Promise<void>>()
  const activeSessions = new Map<string, number>()
  const sessionEpochs = new Map<string, number>()
  let globalEpoch = 0
  let disposed = false

  const clearSession = (sessionID: string) => {
    for (const [key, state] of histories) {
      if (state.sessionID === sessionID) histories.delete(key)
    }
    if (activeSessions.has(sessionID)) sessionEpochs.set(sessionID, (sessionEpochs.get(sessionID) ?? 0) + 1)
  }

  const clearAll = () => {
    globalEpoch += 1
    histories.clear()
    sessionEpochs.clear()
  }

  const remember = (key: string, sessionID: string, messages: ChatMessage[]) => {
    histories.delete(key)
    histories.set(key, { sessionID, messages: boundedHistory(messages) })
    while (histories.size > MAX_STATES) {
      const oldest = histories.keys().next().value
      if (oldest === undefined) break
      histories.delete(oldest)
    }
  }

  const serialized = async <T>(key: string, operation: () => Promise<T>) => {
    const previous = sessionLocks.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const barrier = new Promise<void>((resolveBarrier) => { unlock = resolveBarrier })
    const queued = previous.then(() => barrier)
    sessionLocks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      unlock()
      if (sessionLocks.get(key) === queued) sessionLocks.delete(key)
    }
  }

  const runChat = async (
    input: ChatGPTInput,
    model: string,
    signal: AbortSignal,
    credential: CodexCredential,
    session: Awaited<ReturnType<typeof resolveSession>>,
  ) => {
    const prompt = normalizedPrompt(input.prompt, "Prompt", MAX_CHAT_MESSAGE_CHARS)
    const key = stateKey(session, credential.accountID)
    activeSessions.set(session.sessionID, (activeSessions.get(session.sessionID) ?? 0) + 1)
    try {
      return await serialized(key, async () => {
        const globalGeneration = globalEpoch
        const sessionGeneration = sessionEpochs.get(session.sessionID) ?? 0
        const messages = histories.get(key)?.messages ?? []
        const nextMessages = [...messages, { role: "user" as const, text: prompt }]
        const answer = await backend.chat({
          credential,
          model,
          messages: boundedHistory(nextMessages),
          signal,
        })
        const text = normalizedPrompt(answer, "ChatGPT response", MAX_RESULT_TEXT)
        if (globalEpoch === globalGeneration && (sessionEpochs.get(session.sessionID) ?? 0) === sessionGeneration) {
          remember(key, session.sessionID, [...nextMessages, { role: "assistant", text }])
        }
        return { text }
      })
    } finally {
      const active = (activeSessions.get(session.sessionID) ?? 1) - 1
      if (active > 0) activeSessions.set(session.sessionID, active)
      else {
        activeSessions.delete(session.sessionID)
        sessionEpochs.delete(session.sessionID)
      }
    }
  }

  const execute = async (input: ChatGPTInput, parentSignal: AbortSignal): Promise<ChatGPTResult> => {
    if (disposed) throw new Error("ChatGPT connector is unavailable.")
    const session = await resolveSession(ctx, input)
    const credential = await resolveOpenAIOAuth(ctx)
    const scope = requestScope(parentSignal)
    try {
      if (input.action === "generate_image") {
        const prompt = normalizedPrompt(input.prompt, "Prompt", 8192)
        const imageBase64 = await backend.generateImage({ credential, prompt, signal: scope.signal })
        if (imageBase64.length > MAX_IMAGE_BASE64) throw new Error("Generated image exceeded the size limit.")
        return { text: "Image generated.", imageBase64 }
      }
      if (input.action === "web_search") {
        const query = normalizedPrompt(input.query, "Query", 2048)
        const mode = input.mode ?? "quick"
        if (mode !== "quick" && mode !== "research") throw new Error("Search mode must be quick or research.")
        const model = await resolveOpenAIModel(ctx, session)
        const result = await backend.webSearch({
          credential,
          model,
          sessionID: session.sessionID,
          query,
          mode,
          signal: scope.signal,
        })
        if (result.searchPerformed !== true || !Array.isArray(result.sources) || result.sources.length === 0) {
          throw new Error("ChatGPT search did not return verified source links.")
        }
        const sources = result.sources.slice(0, MAX_RESULT_SOURCES)
          .flatMap((source) => {
            const safe = usableSource(source)
            return safe ? [safe] : []
          })
        if (sources.length === 0) throw new Error("ChatGPT search did not return verified source links.")
        return {
          text: result.text.slice(0, MAX_RESULT_TEXT),
          sources,
          searchPerformed: true,
        }
      }
      if (input.action === "chat") {
        const model = await resolveOpenAIModel(ctx, session)
        return runChat(input, model, scope.signal, credential, session)
      }
      throw new Error("Unsupported ChatGPT action.")
    } finally {
      scope.dispose()
    }
  }

  const registration = await ctx.rpc.register(ChatGPT, {
    execute: async (value, context) => execute(value as ChatGPTInput, context.signal),
  })

  const eventController = new AbortController()
  const eventTask = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
        if (disposed) break
        if (event.type === "credential.updated" || event.type === "credential.switched" ||
          event.type === "integration.updated" || event.type === "provider.updated") {
          clearAll()
        } else if (["session.created", "session.updated", "session.deleted", "session.moved"].includes(event.type)) {
          const sessionID = eventSessionID(event)
          if (sessionID) clearSession(sessionID)
        }
      }
    } catch {
      if (!eventController.signal.aborted) clearAll()
    }
  })()

  return async () => {
    disposed = true
    eventController.abort()
    histories.clear()
    await registration.dispose()
    await eventTask
  }
}

export default Plugin.define({
  id: "opencode-rig.chatgpt-connector",
  setup: setupChatGPTServer,
})
