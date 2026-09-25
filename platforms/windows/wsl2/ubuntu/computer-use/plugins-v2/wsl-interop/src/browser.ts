import { createHash } from "node:crypto"

import { PowerShellHostClient, type HostRequestOptions } from "./powershell-host.ts"
import { RawTokenStore, type RawIntent } from "./token-store.ts"
import type {
  PowerShellExecutable,
  PowerShellOptions,
  RawOptions,
  WslStatus,
} from "./types.ts"
import { assertWsl2Interop, detectWsl, systemProbes } from "./wsl-detect.ts"

const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024
const MAX_SCREENSHOT_OUTPUT_BYTES = 9 * 1024 * 1024
const WINDOW_ID = /^[a-f0-9]{64}$/u
const ELEMENT_ID = /^[a-f0-9]{64}$/u

export type BrowserScheme = "http" | "https"
export type BrowserAction = "click" | "focus" | "type" | "press"

export interface BrowserHostResponse {
  executable: Exclude<PowerShellExecutable, "auto">
  executablePath: string
  executableIdentity: string
  result: unknown
}

export interface BrowserHostTransport {
  request(
    preferred: PowerShellExecutable,
    method: string,
    params: Record<string, unknown>,
    options?: HostRequestOptions,
  ): Promise<BrowserHostResponse>
  requestExact(
    name: Exclude<PowerShellExecutable, "auto">,
    expectedPath: string,
    expectedIdentity: string,
    method: string,
    params: Record<string, unknown>,
    options?: HostRequestOptions,
  ): Promise<BrowserHostResponse>
}

export interface BrowserWindowSnapshot {
  windowId: string
  processId: number
  windowHandle: string
  runtimeId: string
  title: string
  className: string
  bounds: { x: number; y: number; width: number; height: number }
}

export interface BrowserElementSnapshot {
  windowId: string
  elementId: string
  processId: number
  runtimeId: string
  name: string
  automationId: string
  controlType: string
  className: string
  enabled: boolean
  offscreen: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

export interface BrowserWindowsInput {
  scheme?: BrowserScheme
  maxItems?: number
}

export interface BrowserSnapshotInput extends BrowserWindowsInput {
  windowId: string
  maxDepth?: number
  maxNodes?: number
  maxResults?: number
}

export interface BrowserActionInput extends BrowserWindowsInput {
  windowId: string
  elementId: string
  action: BrowserAction
  value?: string
  key?: string
  apply?: boolean
  expectToken?: string
}

interface BrowserCaller {
  sessionID: string
  agent: string
  fingerprint: string
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} host returned an invalid result`)
  return value as Record<string, unknown>
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} is malformed or exceeds ${maximum} characters`)
  }
  return value
}

function boundedCoordinate(value: unknown, label: string, allowNegative: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 10_000_000 ||
    (!allowNegative && value < 0)
  ) {
    throw new Error(`${label} is malformed or unbounded`)
  }
  return value
}

function parseBounds(value: unknown, label: string): BrowserWindowSnapshot["bounds"] {
  const source = asObject(value, `${label} bounds`)
  return {
    x: boundedCoordinate(source.x, `${label} x`, true),
    y: boundedCoordinate(source.y, `${label} y`, true),
    width: boundedCoordinate(source.width, `${label} width`, false),
    height: boundedCoordinate(source.height, `${label} height`, false),
  }
}

export function canonicalBrowserWindow(value: unknown): BrowserWindowSnapshot {
  const source = asObject(value, "Windows browser window")
  if (typeof source.windowId !== "string" || !WINDOW_ID.test(source.windowId)) throw new Error("Windows browser window identity is invalid")
  if (!Number.isInteger(source.processId) || Number(source.processId) < 1 || Number(source.processId) > 2_147_483_647) {
    throw new Error("Windows browser window processId is invalid")
  }
  const windowHandle = boundedText(source.windowHandle, "Windows browser window handle", 18)
  if (!/^0x[0-9a-f]{1,16}$/iu.test(windowHandle)) throw new Error("Windows browser window handle is invalid")
  const runtimeId = boundedText(source.runtimeId, "Windows browser window runtimeId", 512)
  if (!/^-?[0-9]+(?:\.-?[0-9]+)*$/u.test(runtimeId)) throw new Error("Windows browser window runtimeId is invalid")
  return {
    windowId: source.windowId,
    processId: Number(source.processId),
    windowHandle,
    runtimeId,
    title: boundedText(source.title, "Windows browser window title", 1_024),
    className: boundedText(source.className, "Windows browser window className", 512),
    bounds: parseBounds(source.bounds, "Windows browser window"),
  }
}

export function canonicalBrowserElement(value: unknown): BrowserElementSnapshot {
  const source = asObject(value, "Windows browser element")
  if (typeof source.windowId !== "string" || !WINDOW_ID.test(source.windowId)) throw new Error("Windows browser element windowId is invalid")
  if (typeof source.elementId !== "string" || !ELEMENT_ID.test(source.elementId)) throw new Error("Windows browser element identity is invalid")
  if (!Number.isInteger(source.processId) || Number(source.processId) < 1 || Number(source.processId) > 2_147_483_647) {
    throw new Error("Windows browser element processId is invalid")
  }
  const runtimeId = boundedText(source.runtimeId, "Windows browser element runtimeId", 512)
  if (!/^-?[0-9]+(?:\.-?[0-9]+)*$/u.test(runtimeId)) throw new Error("Windows browser element runtimeId is invalid")
  if (typeof source.enabled !== "boolean" || typeof source.offscreen !== "boolean") throw new Error("Windows browser element states are invalid")
  return {
    windowId: source.windowId,
    elementId: source.elementId,
    processId: Number(source.processId),
    runtimeId,
    name: boundedText(source.name, "Windows browser element name", 1_024),
    automationId: boundedText(source.automationId, "Windows browser element automationId", 512),
    controlType: boundedText(source.controlType, "Windows browser element controlType", 256),
    className: boundedText(source.className, "Windows browser element className", 512),
    enabled: source.enabled,
    offscreen: source.offscreen,
    bounds: parseBounds(source.bounds, "Windows browser element"),
  }
}

function schemeValue(value: unknown): BrowserScheme {
  if (value === undefined || value === "https") return "https"
  if (value === "http") return "http"
  throw new Error("scheme must be http or https")
}

function validateWindowId(value: unknown): string {
  if (typeof value !== "string" || !WINDOW_ID.test(value)) throw new Error("windowId must be a discovered Windows browser window identity")
  return value
}

function validateElementId(value: unknown): string {
  if (typeof value !== "string" || !ELEMENT_ID.test(value)) throw new Error("elementId must be a discovered Windows UI Automation element identity")
  return value
}

export function validateBrowserUrl(value: unknown): { url: string; scheme: BrowserScheme } {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || /[\0\r\n]/u.test(value)) {
    throw new Error("url must be an absolute HTTP(S) URL no larger than 2048 characters")
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("url must be an absolute HTTP(S) URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("only HTTP and HTTPS URLs are supported")
  if (parsed.username || parsed.password) throw new Error("URLs containing embedded credentials are not accepted")
  if (parsed.href.length > 2_048) throw new Error("normalized URL exceeds 2048 characters")
  return { url: parsed.href, scheme: parsed.protocol.slice(0, -1) as BrowserScheme }
}

export function validateBrowserWindows(input: BrowserWindowsInput): { scheme: BrowserScheme; maxItems: number } {
  const scheme = schemeValue(input.scheme)
  const maxItems = input.maxItems ?? 50
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new Error("maxItems must be an integer from 1 through 100")
  return { scheme, maxItems }
}

export function validateBrowserSnapshot(input: BrowserSnapshotInput): {
  scheme: BrowserScheme
  windowId: string
  maxDepth: number
  maxNodes: number
  maxResults: number
} {
  const scheme = schemeValue(input.scheme)
  const windowId = validateWindowId(input.windowId)
  const maxDepth = input.maxDepth ?? 8
  const maxNodes = input.maxNodes ?? 1_000
  const maxResults = input.maxResults ?? 150
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", maxDepth, 1, 12],
    ["maxNodes", maxNodes, 1, 2_000],
    ["maxResults", maxResults, 1, 200],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return { scheme, windowId, maxDepth, maxNodes, maxResults }
}

const SAFE_KEYS = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", "Space",
])

export function validateBrowserAction(input: BrowserActionInput): {
  scheme: BrowserScheme
  windowId: string
  elementId: string
  action: BrowserAction
  value?: string
  key?: string
} {
  const scheme = schemeValue(input.scheme)
  const windowId = validateWindowId(input.windowId)
  const elementId = validateElementId(input.elementId)
  if (!["click", "focus", "type", "press"].includes(input.action)) throw new Error("unsupported Windows browser action")
  const result: ReturnType<typeof validateBrowserAction> = { scheme, windowId, elementId, action: input.action }
  if (input.action === "type") {
    if (typeof input.value !== "string" || input.value.length > 4_096 || input.value.includes("\0")) {
      throw new Error("type requires text no larger than 4096 characters without NUL")
    }
    result.value = input.value
  } else if (input.value !== undefined) {
    throw new Error("value is valid only for action=type")
  }
  if (input.action === "press") {
    if (typeof input.key !== "string" || !SAFE_KEYS.has(input.key)) throw new Error("press requires one supported unmodified keyboard key")
    result.key = input.key
  } else if (input.key !== undefined) {
    throw new Error("key is valid only for action=press")
  }
  return result
}

function parseBrowserWindows(value: unknown, expectedScheme: BrowserScheme, maximum: number): {
  items: BrowserWindowSnapshot[]
  truncated: boolean
} {
  const source = asObject(value, "Windows default-browser window list")
  if (source.scheme !== expectedScheme || !Array.isArray(source.items)) throw new Error("Windows default-browser host returned a malformed window list")
  if (!Number.isInteger(source.visited) || Number(source.visited) < 0 || Number(source.visited) > 100) throw new Error("Windows default-browser host returned an invalid window count")
  if (typeof source.truncated !== "boolean") throw new Error("Windows default-browser host omitted its truncation state")
  const items = source.items.map(canonicalBrowserWindow)
  if (items.length > maximum) throw new Error("Windows default-browser host exceeded the requested window limit")
  if (items.length === 0) throw new Error("no accessible UI Automation window belongs to the Windows default browser")
  if (new Set(items.map((item) => item.windowId)).size !== items.length) throw new Error("Windows default-browser host returned ambiguous window identities")
  return { items, truncated: source.truncated }
}

function parseBrowserSnapshot(value: unknown, expectedWindowId: string): {
  window: BrowserWindowSnapshot
  items: BrowserElementSnapshot[]
  visited: number
  truncated: boolean
} {
  const source = asObject(value, "Windows browser UI Automation snapshot")
  const window = canonicalBrowserWindow(source.window)
  if (window.windowId !== expectedWindowId || !Array.isArray(source.items)) throw new Error("Windows browser snapshot does not match the selected window")
  if (!Number.isInteger(source.visited) || Number(source.visited) < 0 || Number(source.visited) > 2_000) throw new Error("Windows browser snapshot returned an invalid visited count")
  if (typeof source.truncated !== "boolean") throw new Error("Windows browser snapshot omitted its truncation state")
  const items = source.items.map(canonicalBrowserElement)
  if (items.some((item) => item.windowId !== expectedWindowId)) throw new Error("Windows browser snapshot mixed window identities")
  if (items.length > 200) throw new Error("Windows browser snapshot exceeded the result bound")
  if (new Set(items.map((item) => item.elementId)).size !== items.length) throw new Error("Windows browser snapshot returned ambiguous element identities")
  return { window, items, visited: Number(source.visited), truncated: source.truncated }
}

function parseBrowserTarget(value: unknown, expectedWindowId: string, expectedElementId: string): {
  window: BrowserWindowSnapshot
  target: BrowserElementSnapshot
  visited: number
} {
  const source = asObject(value, "Windows browser action target")
  if (source.truncated !== false) throw new Error("Windows browser action refuses incomplete UI Automation discovery")
  if (!Number.isInteger(source.visited) || Number(source.visited) < 1 || Number(source.visited) > 2_000) throw new Error("Windows browser action target discovery is invalid")
  const window = canonicalBrowserWindow(source.window)
  const target = canonicalBrowserElement(source.target)
  if (window.windowId !== expectedWindowId || target.windowId !== expectedWindowId || target.elementId !== expectedElementId) {
    throw new Error("Windows browser action target does not match the explicit window and element identities")
  }
  return { window, target, visited: Number(source.visited) }
}

function parseScreenshot(value: unknown, expectedWindowId: string): {
  data: string
  bytes: number
  width: number
  height: number
} {
  const source = asObject(value, "Windows browser screenshot")
  if (source.windowId !== expectedWindowId || source.mimeType !== "image/png" || typeof source.data !== "string") {
    throw new Error("Windows browser screenshot did not match the selected window or PNG format")
  }
  if (!Number.isInteger(source.width) || Number(source.width) < 1 || Number(source.width) > 8_192) throw new Error("Windows browser screenshot width is invalid")
  if (!Number.isInteger(source.height) || Number(source.height) < 1 || Number(source.height) > 8_192) throw new Error("Windows browser screenshot height is invalid")
  if (Number(source.width) * Number(source.height) > 16_777_216) throw new Error("Windows browser screenshot exceeds the pixel boundary")
  if (!Number.isInteger(source.bytes) || Number(source.bytes) < 1 || Number(source.bytes) > MAX_SCREENSHOT_BYTES) {
    throw new Error("Windows browser screenshot exceeds the 6 MiB attachment boundary")
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.data)) {
    throw new Error("Windows browser screenshot data is not canonical base64")
  }
  const bytes = Buffer.from(source.data, "base64")
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (
    bytes.toString("base64") !== source.data ||
    bytes.length !== source.bytes ||
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
    bytes.readUInt32BE(16) !== source.width ||
    bytes.readUInt32BE(20) !== source.height
  ) {
    throw new Error("Windows browser screenshot PNG data is malformed or inconsistent")
  }
  return { data: source.data, bytes: bytes.length, width: Number(source.width), height: Number(source.height) }
}

function targetDigest(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash("sha256").update(value, "utf8").digest("hex")
}

export class WindowsBrowserManager {
  readonly #cwd: string
  readonly #powershell: PowerShellOptions
  readonly #host: BrowserHostTransport
  readonly #tokens: RawTokenStore
  readonly #gate: () => Promise<WslStatus>

  constructor(
    cwd: string,
    powershell: PowerShellOptions,
    raw: RawOptions,
    gate: () => Promise<WslStatus> = () => detectWsl(systemProbes(cwd)),
    host?: BrowserHostTransport,
  ) {
    this.#cwd = cwd
    this.#powershell = powershell
    this.#host = host ?? new PowerShellHostClient(cwd, powershell)
    this.#tokens = new RawTokenStore(raw.tokenTtlMs, Date.now, undefined, raw.maxTokens)
    this.#gate = gate
  }

  async open(input: { url: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    const validated = validateBrowserUrl(input.url)
    const response = await this.#host.request(this.#powershell.preferred, "browser.open", { url: validated.url }, { signal })
    const result = asObject(response.result, "Windows default-browser open")
    if (result.requestAccepted !== true || result.scheme !== validated.scheme) throw new Error("Windows ShellExecute did not confirm the default-browser request")
    boundedText(result.association, "Windows default-browser association", 256)
    return { requestAccepted: true, scheme: validated.scheme, association: "Windows default URL association", untrusted: true }
  }

  async windows(input: BrowserWindowsInput = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    const validated = validateBrowserWindows(input)
    const response = await this.#host.request(this.#powershell.preferred, "browser.windows", validated, { signal })
    const parsed = parseBrowserWindows(response.result, validated.scheme, validated.maxItems)
    return { scheme: validated.scheme, items: parsed.items, truncated: parsed.truncated, untrusted: true }
  }

  async snapshot(input: BrowserSnapshotInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    const validated = validateBrowserSnapshot(input)
    const response = await this.#host.request(this.#powershell.preferred, "browser.snapshot", validated, { signal })
    return { ...parseBrowserSnapshot(response.result, validated.windowId), untrusted: true }
  }

  async screenshot(input: BrowserWindowsInput & { windowId: string }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    const scheme = schemeValue(input.scheme)
    const windowId = validateWindowId(input.windowId)
    const response = await this.#host.request(this.#powershell.preferred, "browser.screenshot", { scheme, windowId }, {
      maxOutputBytes: MAX_SCREENSHOT_OUTPUT_BYTES,
      signal,
    })
    return { windowId, mimeType: "image/png", ...parseScreenshot(response.result, windowId), untrusted: true }
  }

  async act(input: BrowserActionInput, caller: BrowserCaller, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const wsl = await this.#requireReady()
    if (wsl.fingerprint !== caller.fingerprint) throw new Error("WSL state changed before the Windows browser operation")
    const validated = validateBrowserAction(input)
    if (input.apply !== undefined && typeof input.apply !== "boolean") throw new Error("apply must be a boolean")
    if (input.expectToken !== undefined && (typeof input.expectToken !== "string" || input.expectToken.length > 128)) {
      throw new Error("expectToken must be a string no larger than 128 characters")
    }
    const targetParams = {
      scheme: validated.scheme,
      windowId: validated.windowId,
      elementId: validated.elementId,
      maxDepth: 12,
      maxNodes: 2_000,
      maxResults: 2_000,
    }
    const targetResponse = await this.#host.request(this.#powershell.preferred, "browser.target", targetParams, { signal })
    const resolved = parseBrowserTarget(targetResponse.result, validated.windowId, validated.elementId)
    if (!resolved.target.enabled || resolved.target.offscreen) throw new Error("Windows browser action target must be enabled and visible")

    const safeIntent = JSON.stringify({
      scheme: validated.scheme,
      windowId: validated.windowId,
      elementId: validated.elementId,
      action: validated.action,
      valueSha256: targetDigest(validated.value),
      key: validated.key,
      target: resolved.target,
    })
    const intent: RawIntent = {
      sessionID: caller.sessionID,
      agent: caller.agent,
      script: safeIntent,
      executable: targetResponse.executablePath,
      executableIdentity: targetResponse.executableIdentity,
      workingDirectory: this.#cwd,
      fingerprint: caller.fingerprint,
      timeoutMs: this.#powershell.timeoutMs,
    }
    if (!input.apply) {
      if (input.expectToken !== undefined) throw new Error("expectToken requires apply=true")
      return {
        action: "preview",
        requestedAction: validated.action,
        window: resolved.window,
        target: resolved.target,
        warning: "Apply rechecks the selected Windows default-browser window and the exact UI Automation target; type previews retain only a hash of entered text.",
        ...this.#tokens.preview(intent),
      }
    }
    if (!input.expectToken) throw new Error("apply=true requires expectToken from the exact browser action preview")
    this.#tokens.consume(input.expectToken, intent)
    const applied = await this.#host.requestExact(
      targetResponse.executable,
      targetResponse.executablePath,
      targetResponse.executableIdentity,
      "browser.act",
      {
        ...targetParams,
        action: validated.action,
        value: validated.value,
        key: validated.key,
        expectedTarget: resolved.target,
      },
      { signal },
    )
    const result = asObject(applied.result, "Windows browser action")
    if (result.action !== validated.action || result.windowId !== validated.windowId || result.elementId !== validated.elementId) {
      throw new Error("Windows browser action host returned an inconsistent target result")
    }
    return { action: "apply", requestedAction: validated.action, windowId: validated.windowId, elementId: validated.elementId, untrusted: true }
  }

  async #requireReady(): Promise<WslStatus> {
    const status = await this.#gate()
    assertWsl2Interop(status)
    return status
  }
}
