import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Service } from "@opencode/client/service"
import { fileURLToPath } from "node:url"
import { isAbsolute, resolve } from "node:path"

import { saveGeneratedImage } from "./output.ts"

const MAX_SESSION_ID_LENGTH = 512
const MAX_PROJECT_DIRECTORY_LENGTH = 4096
const MAX_PROMPT_LENGTH = 8000
const MAX_IMAGE_PROMPT_LENGTH = 4000
const MAX_QUERY_LENGTH = 512
const MAX_TEXT_BYTES = 64 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const MAX_RPC_RESPONSE_BYTES = 24 * 1024 * 1024
const MAX_SEARCH_SOURCES = 20
const MAX_SOURCE_TITLE_LENGTH = 512
const MAX_SOURCE_URL_LENGTH = 2048
const SESSION_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 120_000

export const CHATGPT_TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate an image through the active OpenAI OAuth connection and save the validated PNG under assets/generated in the invoking OpenCode session's project.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_IMAGE_PROMPT_LENGTH,
          description: "Image-generation prompt (maximum 4,000 characters)",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "web_search",
    description:
      "Search the web through OAuth-backed Codex search. quick performs one bounded query; research performs bounded agentic research. Successful results include validated HTTP(S) source links.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH,
          description: "Search query (maximum 512 characters)",
        },
        mode: {
          type: "string",
          enum: ["quick", "research"],
          description: "Search mode (default is selected by the service)",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "chat",
    description:
      "Chat through the active OpenAI OAuth connection with private continuity scoped to this OpenCode session and account.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROMPT_LENGTH,
          description: "Message to send (maximum 8,000 characters)",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
] as const

type ChatgptAction = "generate_image" | "web_search" | "chat"
export type ChatgptRpcInput = {
  action: ChatgptAction
  sessionID: string
  prompt?: string
  query?: string
  mode?: "quick" | "research"
  projectDirectory?: string
}

type RpcSource = { title: string; url: string }
type RpcOutput = {
  text: string
  imageBase64?: string
  sources?: RpcSource[]
  searchPerformed?: boolean
}

type SavedImage = {
  absolutePath: string
  relativePath: string
  bytes: number
  mimeType: "image/png"
}

type SaveImage = (input: {
  projectDirectory: string
  imageBase64: string
}) => Promise<SavedImage>

export type ChatgptToolDependencies = {
  sessionDirectory: (sessionID: string) => Promise<string>
  callRpc: (input: ChatgptRpcInput, locationDirectory: string) => Promise<unknown>
  saveImage?: SaveImage
}

class ToolFailure extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function canonicalDirectory(value: unknown): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > MAX_PROJECT_DIRECTORY_LENGTH ||
    value.includes("\0") || !isAbsolute(value) || resolve(value) !== value
  ) {
    throw new ToolFailure("The invoking session does not have a valid project location.")
  }
  return value
}

function invokingSessionID(request: unknown): string {
  if (!isRecord(request) || !isRecord(request.params)) {
    throw new ToolFailure("The MCP tool request is invalid.")
  }
  const meta = request.params._meta
  if (!isRecord(meta) || !Object.hasOwn(meta, "sessionID")) {
    throw new ToolFailure("OpenCode session context is required to use this tool.")
  }
  const sessionID = meta.sessionID
  if (
    typeof sessionID !== "string" || sessionID.length === 0 || sessionID.length > MAX_SESSION_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(sessionID)
  ) {
    throw new ToolFailure("The OpenCode session context is invalid.")
  }
  return sessionID
}

function toolRequest(request: unknown): { name: string; args: Record<string, unknown> } {
  if (!isRecord(request) || !isRecord(request.params)) {
    throw new ToolFailure("The MCP tool request is invalid.")
  }
  const name = request.params.name
  const args = request.params.arguments
  if (typeof name !== "string" || !isRecord(args)) {
    throw new ToolFailure("The MCP tool arguments are invalid.")
  }
  return { name, args }
}

function exactKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed)
  if (Object.keys(args).some((key) => !accepted.has(key))) {
    throw new ToolFailure("The tool request contains unsupported fields.")
  }
}

function boundedText(value: unknown, label: string, maxCharacters: number, maxBytes: number): string {
  if (
    typeof value !== "string" || value.trim().length === 0 || value.length > maxCharacters ||
    textBytes(value) > maxBytes
  ) {
    throw new ToolFailure(`${label} must be non-empty and within its size limit.`)
  }
  return value
}

function parseToolInput(name: string, args: Record<string, unknown>): Omit<ChatgptRpcInput, "sessionID" | "projectDirectory"> {
  if (name === "generate_image") {
    exactKeys(args, ["prompt"])
    return {
      action: "generate_image",
      prompt: boundedText(args.prompt, "prompt", MAX_IMAGE_PROMPT_LENGTH, 16 * 1024),
    }
  }
  if (name === "web_search") {
    exactKeys(args, ["query", "mode"])
    if (args.mode !== undefined && args.mode !== "quick" && args.mode !== "research") {
      throw new ToolFailure("mode must be quick or research.")
    }
    return {
      action: "web_search",
      query: boundedText(args.query, "query", MAX_QUERY_LENGTH, 2048),
      ...(args.mode === undefined ? {} : { mode: args.mode }),
    }
  }
  if (name === "chat") {
    exactKeys(args, ["prompt"])
    return {
      action: "chat",
      prompt: boundedText(args.prompt, "prompt", MAX_PROMPT_LENGTH, 32 * 1024),
    }
  }
  throw new ToolFailure("Unknown ChatGPT tool.")
}

function validateSource(value: unknown): RpcSource {
  if (!isRecord(value)) throw new ToolFailure("The ChatGPT service returned an invalid source list.")
  const title = value.title
  const sourceURL = value.url
  if (
    typeof title !== "string" || title.trim().length === 0 || title.length > MAX_SOURCE_TITLE_LENGTH ||
    textBytes(title) > 2048 || /[\u0000-\u001f\u007f]/u.test(title) ||
    typeof sourceURL !== "string" || sourceURL.length > MAX_SOURCE_URL_LENGTH ||
    /[\u0000-\u0020\u007f]/u.test(sourceURL)
  ) {
    throw new ToolFailure("The ChatGPT service returned an invalid source list.")
  }
  let parsed: URL
  try {
    parsed = new URL(sourceURL)
  } catch {
    throw new ToolFailure("The ChatGPT service returned an invalid source URL.")
  }
  if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) {
    throw new ToolFailure("The ChatGPT service returned an invalid source URL.")
  }
  return { title, url: sourceURL }
}

function validateRpcOutput(value: unknown): RpcOutput {
  if (!isRecord(value) || typeof value.text !== "string" || textBytes(value.text) > MAX_TEXT_BYTES) {
    throw new ToolFailure("The ChatGPT service returned an invalid response.")
  }
  const allowed = new Set(["text", "imageBase64", "sources", "searchPerformed"])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToolFailure("The ChatGPT service returned an invalid response.")
  }

  let imageBase64: string | undefined
  if (value.imageBase64 !== undefined) {
    if (
      typeof value.imageBase64 !== "string" || value.imageBase64.length === 0 ||
      value.imageBase64.length > MAX_IMAGE_BASE64_LENGTH
    ) {
      throw new ToolFailure("The ChatGPT service returned an invalid image.")
    }
    imageBase64 = value.imageBase64
  }

  let sources: RpcSource[] | undefined
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources) || value.sources.length > MAX_SEARCH_SOURCES) {
      throw new ToolFailure("The ChatGPT service returned an invalid source list.")
    }
    sources = value.sources.map(validateSource)
  }

  if (value.searchPerformed !== undefined && typeof value.searchPerformed !== "boolean") {
    throw new ToolFailure("The ChatGPT service returned an invalid search status.")
  }

  return {
    text: value.text,
    ...(imageBase64 === undefined ? {} : { imageBase64 }),
    ...(sources === undefined ? {} : { sources }),
    ...(value.searchPerformed === undefined ? {} : { searchPerformed: value.searchPerformed }),
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) }
}

function searchText(output: RpcOutput): string {
  const sourceText = output.sources?.length
    ? `Sources:\n${output.sources.map((source, index) => `${index + 1}. ${source.title} — ${source.url}`).join("\n")}`
    : "Sources: none returned."
  return `${output.text}${output.text ? "\n\n" : ""}${sourceText}`
}

export function createCallToolHandler(dependencies: ChatgptToolDependencies) {
  const saveImage = dependencies.saveImage ?? saveGeneratedImage

  return async (request: unknown) => {
    try {
      const { name, args } = toolRequest(request)
      const toolInput = parseToolInput(name, args)
      const sessionID = invokingSessionID(request)
      const projectDirectory = canonicalDirectory(await dependencies.sessionDirectory(sessionID))
      const rpcInput: ChatgptRpcInput = {
        ...toolInput,
        sessionID,
        ...(toolInput.action === "generate_image" ? { projectDirectory } : {}),
      }
      const output = validateRpcOutput(await dependencies.callRpc(rpcInput, projectDirectory))

      if (toolInput.action === "generate_image") {
        if (output.sources !== undefined || output.searchPerformed !== undefined) {
          throw new ToolFailure("The ChatGPT service returned an invalid image response.")
        }
        if (!output.imageBase64) throw new ToolFailure("The ChatGPT service did not return an image.")
        let saved: SavedImage
        try {
          saved = await saveImage({ projectDirectory, imageBase64: output.imageBase64 })
        } catch {
          throw new ToolFailure("The generated image could not be safely saved under this project's assets/generated directory.")
        }
        const summary = output.text ? `${output.text}\n\n` : ""
        return textResult(
          `${summary}Saved image: ${saved.absolutePath}\nProject-relative path: ${saved.relativePath}\nMIME: ${saved.mimeType}\nSize: ${saved.bytes} bytes`,
        )
      }

      if (toolInput.action === "web_search") {
        if (output.searchPerformed !== true) {
          return textResult(`Search was not completed; no sources are being returned.\n${output.text}`, true)
        }
        if (output.imageBase64 !== undefined || !output.sources?.length) {
          throw new ToolFailure("The ChatGPT service returned no verified HTTP(S) search sources.")
        }
        return textResult(searchText(output))
      }

      if (output.imageBase64 !== undefined || output.sources !== undefined || output.searchPerformed !== undefined) {
        throw new ToolFailure("The ChatGPT service returned an invalid chat response.")
      }
      return textResult(output.text)
    } catch (error) {
      return textResult(error instanceof ToolFailure ? error.message : "The authenticated ChatGPT service request failed.", true)
    }
  }
}

function endpointIsLocal(urlValue: unknown): urlValue is string {
  if (typeof urlValue !== "string") return false
  let endpoint: URL
  try {
    endpoint = new URL(urlValue)
  } catch {
    return false
  }
  const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return endpoint.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(host) &&
    !endpoint.username && !endpoint.password && endpoint.pathname === "/" && !endpoint.search && !endpoint.hash
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length")
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("response exceeded its size limit")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("response body is unavailable")
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error("response exceeded its size limit")
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString("utf8")
}

function parseResponseBody(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error("service returned invalid JSON")
  }
}

function createAuthenticatedRpcTransport(): ChatgptToolDependencies {
  type Connection = { baseURL: string; headers: Record<string, string> }
  let connection: Promise<Connection> | undefined

  const connect = (): Promise<Connection> => {
    if (connection) return connection
    const pending = (async () => {
      const endpoint = await Service.discover({ version: (version) => version.startsWith("2.") })
      if (!endpoint || !endpointIsLocal(endpoint.url)) {
        throw new Error("authenticated local OpenCode V2 service is unavailable")
      }
      const headers = Service.headers(endpoint)
      if (!headers?.authorization) throw new Error("local OpenCode service authentication is unavailable")
      const parsed = new URL(endpoint.url)
      return {
        baseURL: parsed.origin,
        headers,
      }
    })()
    connection = pending.catch((error) => {
      connection = undefined
      throw error
    })
    return connection
  }

  const request = async (url: URL, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const connection = await connect()
    if (url.origin !== new URL(connection.baseURL).origin) {
      throw new Error("request escaped the authenticated local service")
    }
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: (() => {
        const headers = new Headers(connection.headers)
        new Headers(init.headers).forEach((value, name) => headers.set(name, value))
        return headers
      })(),
    })
  }

  const sessionDirectory = async (sessionID: string): Promise<string> => {
    const connection = await connect()
    const url = new URL(`/api/session/${encodeURIComponent(sessionID)}`, connection.baseURL)
    const response = await request(url, { method: "GET" }, SESSION_TIMEOUT_MS)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("invoking session could not be retrieved")
    }
    const payload = parseResponseBody(await readBoundedBody(response, 256 * 1024))
    if (!isRecord(payload) || !isRecord(payload.data) || payload.data.id !== sessionID || !isRecord(payload.data.location)) {
      throw new Error("invoking session response is invalid")
    }
    return canonicalDirectory(payload.data.location.directory)
  }

  const callRpc = async (input: ChatgptRpcInput, locationDirectory: string): Promise<unknown> => {
    const connection = await connect()
    const url = new URL("/api/rpc/chatgpt/execute", connection.baseURL)
    url.searchParams.set("location[directory]", canonicalDirectory(locationDirectory))
    const response = await request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      },
      RPC_TIMEOUT_MS,
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error("ChatGPT RPC request failed")
    }
    const payload = parseResponseBody(await readBoundedBody(response, MAX_RPC_RESPONSE_BYTES))
    if (!isRecord(payload) || !Object.hasOwn(payload, "output")) {
      throw new Error("ChatGPT RPC response is invalid")
    }
    return payload.output
  }

  return { sessionDirectory, callRpc }
}

export function createChatgptServer(dependencies: ChatgptToolDependencies = createAuthenticatedRpcTransport()) {
  const server = new Server(
    { name: "chatgpt", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )
  const handleCallTool = createCallToolHandler(dependencies)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...CHATGPT_TOOLS] }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleCallTool(request))
  return server
}

async function main(): Promise<void> {
  const server = createChatgptServer()
  await server.connect(new StdioServerTransport())
}

const entry = process.argv[1]
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("chatgpt MCP failed to start.\n")
    process.exitCode = 1
  })
}
