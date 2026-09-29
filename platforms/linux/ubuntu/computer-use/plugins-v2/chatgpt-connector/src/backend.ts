import {
  MAX_IMAGE_BASE64,
  MAX_RESULT_SOURCES,
  MAX_RESULT_TEXT,
  type ChatGPTMode,
  type ChatGPTResult,
  type ChatGPTSource,
} from "./rpc.ts"

export const IMAGE_ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations"
export const SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search"
export const RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"

const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_STREAM_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_QUERY_LENGTH = 2048
const MAX_SEARCH_INPUTS = 3

export type CodexCredential = {
  accessToken: string
  accountID: string
}

export type ChatMessage = {
  role: "user" | "assistant"
  text: string
}

export type ChatGPTBackend = {
  generateImage(input: { credential: CodexCredential; prompt: string; signal: AbortSignal }): Promise<string>
  webSearch(input: {
    credential: CodexCredential
    model: string
    sessionID: string
    query: string
    mode: ChatGPTMode
    signal: AbortSignal
  }): Promise<ChatGPTResult>
  chat(input: {
    credential: CodexCredential
    model: string
    messages: readonly ChatMessage[]
    signal: AbortSignal
  }): Promise<string>
}

function authHeaders(credential: CodexCredential, accept: string): HeadersInit {
  return {
    Accept: accept,
    Authorization: `Bearer ${credential.accessToken}`,
    "ChatGPT-Account-Id": credential.accountID,
    "Content-Type": "application/json",
    Originator: "opencode_chatgpt_connector",
    "User-Agent": "opencode-chatgpt-connector/0.1.0",
  }
}

async function post(
  fetchImpl: typeof fetch,
  endpoint: string,
  credential: CodexCredential,
  body: unknown,
  accept: string,
  signal: AbortSignal,
) {
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: authHeaders(credential, accept),
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal,
    })
  } catch {
    if (signal.aborted) throw new Error("ChatGPT request was cancelled or timed out.")
    throw new Error("Unable to reach ChatGPT.")
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("ChatGPT OAuth was rejected; sign in again.")
  }
  if (response.status === 429) throw new Error("ChatGPT is temporarily rate limited.")
  if (!response.ok) throw new Error(`ChatGPT request failed with HTTP ${response.status}.`)
  return response
}

async function boundedBody(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("ChatGPT response exceeded the size limit.")
  }
  const reader = response.body?.getReader()
  if (!reader) return ""

  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error("ChatGPT response exceeded the size limit.")
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ChatGPT response exceeded the size limit.") throw error
    throw new Error("ChatGPT response stream failed.")
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream can already be errored or cancelled by the size guard.
    }
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error("ChatGPT returned unreadable data.")
  }
}

async function jsonResponse(response: Response) {
  let text: string
  try {
    text = await boundedBody(response, MAX_JSON_RESPONSE_BYTES)
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof Error && error.message === "ChatGPT response exceeded the size limit.") throw error
    throw new Error("ChatGPT returned unreadable JSON.")
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, maxLength)
}

function validBase64(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IMAGE_BASE64 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
}

function safeSource(value: unknown): ChatGPTSource | undefined {
  if (!record(value)) return undefined
  const title = boundedText(value.title, 512).trim()
  const rawURL = typeof value.url === "string" ? value.url.trim() : ""
  if (!title || rawURL.length === 0 || rawURL.length > 2048) return undefined
  try {
    const url = new URL(rawURL)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) {
      return undefined
    }
    const usableURL = url.toString()
    if (usableURL.length > 2048) return undefined
    return { title, url: usableURL }
  } catch {
    return undefined
  }
}

function searchQueries(query: string, mode: ChatGPTMode) {
  const normalized = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH)
  if (mode === "quick") return [normalized]
  const variants = [normalized]
  for (const suffix of ["official sources", "recent developments"]) {
    const candidate = `${normalized} ${suffix}`
    if (candidate.length <= MAX_SEARCH_QUERY_LENGTH) variants.push(candidate)
  }
  return [...new Set(variants)].slice(0, MAX_SEARCH_INPUTS)
}

function responseOutputText(value: unknown) {
  if (!record(value) || !Array.isArray(value.output)) return ""
  const text: string[] = []
  for (const item of value.output) {
    if (!record(item) || item.type !== "message" || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (record(part) && part.type === "output_text" && typeof part.text === "string") text.push(part.text)
    }
  }
  return text.join("")
}

function parseResponsesStream(payload: string) {
  const deltas: string[] = []
  let deltaLength = 0
  let completed = false
  let finalText = ""
  let failure = false

  const dispatch = (event: string) => {
    const dataLines: string[] = []
    let eventType = ""
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
      else if (line.startsWith("event:")) eventType = line.slice(6).trim()
    }
    if (dataLines.length === 0) return
    const raw = dataLines.join("\n")
    if (raw === "[DONE]") {
      completed = true
      return
    }

    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      failure = true
      return
    }
    if (!record(value)) return
    const type = typeof value.type === "string" ? value.type : eventType
    if (type === "response.output_text.delta" && typeof value.delta === "string") {
      const part = value.delta.slice(0, Math.max(0, MAX_RESULT_TEXT - deltaLength))
      deltas.push(part)
      deltaLength += part.length
    } else if (type === "response.completed") {
      completed = true
      finalText = boundedText(responseOutputText(value.response), MAX_RESULT_TEXT)
    } else if (type === "response.failed" || type === "error") {
      failure = true
    }
  }

  let pending = ""
  for (const line of payload.split(/\r?\n/)) {
    if (line.length === 0) {
      if (pending) dispatch(pending)
      pending = ""
    } else {
      pending = pending ? `${pending}\n${line}` : line
    }
  }
  if (pending) dispatch(pending)
  if (failure) throw new Error("ChatGPT Responses request did not complete successfully.")
  if (!completed) throw new Error("ChatGPT Responses stream ended before completion.")
  const text = deltas.length ? deltas.join("") : finalText
  if (!text.trim()) throw new Error("ChatGPT returned no text.")
  return text.trim().slice(0, MAX_RESULT_TEXT)
}

export function createChatGPTBackend(fetchImpl: typeof fetch = fetch): ChatGPTBackend {
  return {
    async generateImage({ credential, prompt, signal }) {
      const response = await post(fetchImpl, IMAGE_ENDPOINT, credential, {
        prompt,
        model: "gpt-image-2",
        background: "auto",
        quality: "auto",
        size: "auto",
      }, "application/json", signal)
      const payload = await jsonResponse(response)
      if (!record(payload) || !Array.isArray(payload.data) || !record(payload.data[0])) {
        throw new Error("ChatGPT returned no generated image.")
      }
      const image = payload.data[0].b64_json
      if (!validBase64(image)) throw new Error("ChatGPT returned invalid image data.")
      return image
    },

    async webSearch({ credential, model, sessionID, query, mode, signal }) {
      const response = await post(fetchImpl, SEARCH_ENDPOINT, credential, {
        id: sessionID,
        model,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: query.trim().slice(0, 2048) }],
        }],
        commands: {
          search_query: searchQueries(query, mode).map((q) => ({ q })),
          response_length: mode === "research" ? "long" : "short",
        },
        settings: {
          search_context_size: mode === "research" ? "high" : "low",
          allowed_callers: ["direct"],
          external_web_access: true,
        },
        max_output_tokens: mode === "research" ? 6000 : 2500,
      }, "application/json", signal)
      const payload = await jsonResponse(response)
      if (!record(payload)) throw new Error("ChatGPT returned invalid search data.")

      const sources: ChatGPTSource[] = []
      const seen = new Set<string>()
      if (Array.isArray(payload.results)) {
        for (const item of payload.results.slice(0, 256)) {
          const source = safeSource(item)
          if (!source || seen.has(source.url)) continue
          seen.add(source.url)
          sources.push(source)
          if (sources.length >= MAX_RESULT_SOURCES) break
        }
      }
      if (sources.length === 0) throw new Error("ChatGPT search returned no usable source links.")

      return {
        text: boundedText(payload.output, MAX_RESULT_TEXT),
        sources,
        searchPerformed: true,
      }
    },

    async chat({ credential, model, messages, signal }) {
      const input = messages.map((message) => ({
        type: "message",
        role: message.role,
        content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }],
      }))
      const response = await post(fetchImpl, RESPONSES_ENDPOINT, credential, {
        model,
        input,
        max_output_tokens: 4096,
        store: false,
        stream: true,
      }, "text/event-stream", signal)
      const stream = await boundedBody(response, MAX_STREAM_RESPONSE_BYTES)
      return parseResponsesStream(stream)
    },
  }
}
