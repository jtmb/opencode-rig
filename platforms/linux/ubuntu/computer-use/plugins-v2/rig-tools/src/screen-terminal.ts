import { createHash, randomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const RESIZE_HELPER = fileURLToPath(new URL("../scripts/screen-resize.py", import.meta.url))
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const MAX_CAPTURE_BYTES = 262_144
const MAX_SESSIONS = 64
const MAX_TOKENS = 64
const TOKEN_TTL_MS = 60_000

export type ScreenSession = { pid: number; name: string; state: string }
export type ScreenInput = {
  action: "list" | "capture" | "start" | "input" | "resize" | "stop"
  name?: string
  directory?: string
  continue?: boolean
  kind?: "key" | "text" | "mouse"
  key?: "return" | "escape" | "space" | "up" | "down" | "left" | "right" | "home" | "end" | "pageup" | "pagedown" | "ctrl+a" | "ctrl+l" | "ctrl+p" | "ctrl+s" | "ctrl+x" | "ctrl+x,b" | "ctrl+alt+x" | "b" | "tab" | "shift+tab"
  text?: string
  x?: number
  y?: number
  columns?: number
  rows?: number
  apply?: boolean
  expectToken?: string
}

type MutatingIntent =
  | { action: "start"; name: string; directory: string; continue: boolean }
  | { action: "input"; name: string; kind: "key"; key: NonNullable<ScreenInput["key"]> }
  | { action: "input"; name: string; kind: "text"; text: string }
  | { action: "input"; name: string; kind: "mouse"; x: number; y: number }
  | { action: "resize"; name: string; columns: number; rows: number }
  | { action: "stop"; name: string }

export type ScreenBackend = {
  list(): Promise<ScreenSession[]>
  capture(name: string): Promise<{ text: string; bytes: number; truncated: boolean }>
  start(intent: Extract<MutatingIntent, { action: "start" }>): Promise<void>
  input(intent: Extract<MutatingIntent, { action: "input" }>): Promise<void>
  resize(intent: Extract<MutatingIntent, { action: "resize" }>): Promise<void>
  stop(name: string): Promise<void>
}

type Token = {
  token: string
  sessionID: string
  agent: string
  intent: MutatingIntent
  targetDigest: string
  expiresAt: number
}

function clean(value: string, maximum: number) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, maximum)
}

function sessionName(value: unknown) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error("screen session name is missing or invalid")
  return value
}

function integer(value: unknown, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

export function parseScreenList(text: string): ScreenSession[] {
  const sessions: ScreenSession[] = []
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\.([^\s]+)\s+(.+?)\s*$/)
    if (!match || !NAME.test(match[2])) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const states = [...match[3].matchAll(/\(([^)]+)\)/g)]
    const state = states.at(-1)?.[1]
    if (!state) continue
    sessions.push({ pid, name: match[2], state: clean(state, 64) })
    if (sessions.length >= MAX_SESSIONS) break
  }
  return sessions
}

export function normalizeScreenIntent(input: ScreenInput): MutatingIntent {
  const name = sessionName(input.name)
  if (input.action === "start") {
    if (typeof input.directory !== "string" || !isAbsolute(input.directory)) throw new Error("start requires an absolute directory")
    return { action: "start", name, directory: resolve(input.directory), continue: input.continue === true }
  }
  if (input.action === "stop") return { action: "stop", name }
  if (input.action === "resize") {
    return {
      action: "resize",
      name,
      columns: integer(input.columns, 40, 240, "columns"),
      rows: integer(input.rows, 16, 100, "rows"),
    }
  }
  if (input.action !== "input") throw new Error("action is not a screen mutation")
  if (input.kind === "key") {
    const keys: NonNullable<ScreenInput["key"]>[] = ["return", "escape", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "ctrl+a", "ctrl+l", "ctrl+p", "ctrl+s", "ctrl+x", "ctrl+x,b", "ctrl+alt+x", "b", "tab", "shift+tab"]
    if (!keys.includes(input.key as NonNullable<ScreenInput["key"]>)) throw new Error("input key is missing or unsupported")
    return { action: "input", name, kind: "key", key: input.key! }
  }
  if (input.kind === "text") {
    if (typeof input.text !== "string" || input.text.length < 1 || input.text.length > 256 || !/^[\x20-\x7e]+$/.test(input.text)) {
      throw new Error("input text must be 1-256 printable ASCII characters")
    }
    return { action: "input", name, kind: "text", text: input.text }
  }
  if (input.kind === "mouse") {
    return { action: "input", name, kind: "mouse", x: integer(input.x, 1, 500, "x"), y: integer(input.y, 1, 200, "y") }
  }
  throw new Error("input kind must be key, text, or mouse")
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function targetState(sessions: ScreenSession[], name: string) {
  return sessions.find((session) => session.name === name) ?? null
}

export function createScreenManager(backend: ScreenBackend, now: () => number = Date.now) {
  const tokens = new Map<string, Token>()

  const prune = () => {
    for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key)
    while (tokens.size >= MAX_TOKENS) {
      const oldest = tokens.keys().next().value as string | undefined
      if (!oldest) break
      tokens.delete(oldest)
    }
  }

  const invoke = async (input: ScreenInput, sessionID: string, agent: string) => {
    if (input.action === "list") {
      if (input.apply || input.expectToken) throw new Error("read-only list does not accept apply or expectToken")
      return { sessions: await backend.list(), maximumSessions: MAX_SESSIONS }
    }
    if (input.action === "capture") {
      if (input.apply || input.expectToken) throw new Error("read-only capture does not accept apply or expectToken")
      const name = sessionName(input.name)
      const sessions = await backend.list()
      if (!targetState(sessions, name)) throw new Error(`screen session not found: ${name}`)
      return { name, ...(await backend.capture(name)), untrusted: true }
    }

    const intent = normalizeScreenIntent(input)
    const sessions = await backend.list()
    const state = targetState(sessions, intent.name)
    if (intent.action === "start" ? state !== null : state === null) {
      throw new Error(intent.action === "start" ? `screen session already exists: ${intent.name}` : `screen session not found: ${intent.name}`)
    }
    const stateDigest = digest(state)
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      if (intent.action === "start") {
        const info = await stat(intent.directory).catch(() => undefined)
        if (!info?.isDirectory()) throw new Error(`start directory is unavailable: ${intent.directory}`)
      }
      prune()
      const token = randomBytes(24).toString("base64url")
      const record: Token = { token, sessionID, agent, intent, targetDigest: stateDigest, expiresAt: now() + TOKEN_TTL_MS }
      tokens.set(token, record)
      return { dryRun: true, intent, expectToken: token, expiresAt: record.expiresAt }
    }

    const token = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!token || token.expiresAt <= now()) throw new Error("screen preview token is missing or expired")
    tokens.delete(token.token)
    if (token.sessionID !== sessionID || token.agent !== agent || digest(token.intent) !== digest(intent)) {
      throw new Error("screen preview token does not match this session, agent, and intent")
    }
    const current = targetState(await backend.list(), intent.name)
    if (digest(current) !== token.targetDigest) throw new Error("screen target state changed after preview; preview again")
    if (intent.action === "start") await backend.start(intent)
    else if (intent.action === "input") await backend.input(intent)
    else if (intent.action === "resize") await backend.resize(intent)
    else await backend.stop(intent.name)
    return { dryRun: false, intent, target: targetState(await backend.list(), intent.name) }
  }

  return { invoke }
}

async function command(args: string[], allowNoSessions = false) {
  try {
    const result = await execute("screen", args, { timeout: 10_000, maxBuffer: 524_288, encoding: "utf8", shell: false })
    return `${result.stdout ?? ""}${result.stderr ?? ""}`
  } catch (error) {
    const value = error as Error & { code?: number; stdout?: string; stderr?: string }
    const output = `${value.stdout ?? ""}${value.stderr ?? ""}`
    if (allowNoSessions && value.code === 1 && /No Sockets found/i.test(output)) return output
    throw new Error(`screen command failed: ${clean(output || value.message, 1024)}`)
  }
}

async function executable() {
  const configured = process.env.OPENCODE_V2_BIN
  if (configured && isAbsolute(configured)) return configured
  return readlink("/proc/self/exe")
}

export function inputPayload(intent: Extract<MutatingIntent, { action: "input" }>) {
  if (intent.kind === "text") return intent.text
  if (intent.kind === "mouse") return `\u001b[<0;${intent.x};${intent.y}M\u001b[<0;${intent.x};${intent.y}m`
  return ({
    return: "\r",
    escape: "\u001b",
    space: " ",
    up: "\u001b[A",
    down: "\u001b[B",
    right: "\u001b[C",
    left: "\u001b[D",
    home: "\u001b[H",
    end: "\u001b[F",
    pageup: "\u001b[5~",
    pagedown: "\u001b[6~",
    "ctrl+a": "\u0001",
    "ctrl+l": "\u000c",
    "ctrl+p": "\u0010",
    "ctrl+s": "\u0013",
    "ctrl+x": "\u0018",
    "ctrl+x,b": "\u0018b",
    "ctrl+alt+x": "\u001b\u0018",
    b: "b",
    tab: "\t",
    "shift+tab": "\u001b[Z",
  } as const)[intent.key]
}

export function createSystemScreenBackend(): ScreenBackend {
  return {
    async list() {
      return parseScreenList(await command(["-ls"], true))
    },
    async capture(name) {
      const root = await mkdtemp(join(tmpdir(), "opencode-screen-capture-"))
      const path = join(root, "screen.txt")
      try {
        await command(["-S", name, "-X", "hardcopy", path])
        const raw = await readFile(path)
        const truncated = raw.byteLength > MAX_CAPTURE_BYTES
        const bytes = Math.min(raw.byteLength, MAX_CAPTURE_BYTES)
        const text = clean(raw.subarray(0, bytes).toString("utf8"), MAX_CAPTURE_BYTES)
        return { text, bytes, truncated }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    async start(intent) {
      const binary = await executable()
      const env = { ...process.env }
      delete env.OPENCODE_DISABLE_PROJECT_CONFIG
      const args = ["-dmS", intent.name, binary, "--standalone"]
      if (intent.continue) args.push("--continue")
      args.push(intent.directory)
      await execute("screen", args, { timeout: 10_000, maxBuffer: 262_144, encoding: "utf8", shell: false, env })
    },
    async input(intent) {
      await command(["-S", intent.name, "-p", "0", "-X", "stuff", inputPayload(intent)])
    },
    async resize(intent) {
      await execute("python3", [RESIZE_HELPER, intent.name, String(intent.columns), String(intent.rows)], {
        timeout: 10_000,
        maxBuffer: 262_144,
        encoding: "utf8",
        shell: false,
      })
    },
    async stop(name) {
      await command(["-S", name, "-X", "quit"])
    },
  }
}
