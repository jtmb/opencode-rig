import { PowerShellHostClient } from "./powershell-host.ts"
import { RawTokenStore, type RawIntent } from "./token-store.ts"
import type {
  PowerShellExecutable,
  PowerShellOptions,
  RawOptions,
  WindowsActInput,
  WindowsAppsInput,
  WindowsCaptureInput,
  WindowsFindInput,
  WslStatus,
} from "./types.ts"
import { assertWsl2Interop, detectWsl, systemProbes } from "./wsl-detect.ts"

const MAX_CAPTURE_BYTES = 6 * 1024 * 1024
const MAX_CAPTURE_OUTPUT_BYTES = 9 * 1024 * 1024
const WINDOW_ID = /^[a-f0-9]{64}$/u
const WINDOW_HANDLE = /^0x[0-9a-f]{1,16}$/iu

export interface UiElementSnapshot {
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

export interface FindResult {
  items: UiElementSnapshot[]
  visited: number
  truncated: boolean
}

interface CallerState {
  sessionID: string
  agent: string
  fingerprint: string
}

export function normalizeHostItems(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") return [value]
  throw new Error(`${label} host returned an invalid result`)
}

export function validateWindowsFind(input: WindowsFindInput): void {
  if (!Number.isInteger(input.processId) || input.processId < 1 || input.processId > 2_147_483_647) throw new Error("processId must be a positive Windows process ID")
  const selectors = [input.name, input.automationId, input.controlType]
  if (!selectors.some((value) => typeof value === "string" && value.length > 0)) throw new Error("at least one name, automationId, or controlType selector is required")
  for (const [name, value, maximum] of [
    ["name", input.name, 256],
    ["automationId", input.automationId, 256],
    ["controlType", input.controlType, 128],
  ] as const) {
    if (value !== undefined && (!value || value.length > maximum || /[\0\r\n]/u.test(value))) throw new Error(`${name} is invalid or exceeds ${maximum} characters`)
  }
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", input.maxDepth ?? 8, 1, 12],
    ["maxNodes", input.maxNodes ?? 1_000, 1, 2_000],
    ["maxResults", input.maxResults ?? 20, 1, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
}

export function validateWindowsAct(input: WindowsActInput): void {
  validateWindowsFind(input)
  if (!( ["focus", "invoke", "setValue", "toggle", "select"] as const).includes(input.action)) throw new Error("unsupported Windows UI Automation action")
  if (input.action === "setValue") {
    if (input.value === undefined || input.value.length > 4_096 || input.value.includes("\0")) throw new Error("setValue requires a value no larger than 4096 characters without NUL")
  } else if (input.value !== undefined) {
    throw new Error("value is valid only for action=setValue")
  }
}

export type WindowsCaptureTransforms = {
  processId: number
  windowHandle: string
  title: string
  className?: string
}

export interface WindowsCapture {
  windowId: string
  processId: number
  windowHandle: string
  title: string
  className: string
  bounds: { x: number; y: number; width: number; height: number }
  mimeType: "image/png"
  data: string
  bytes: number
  width: number
  height: number
}

export function validateWindowsCapture(input: WindowsCaptureInput): WindowsCaptureTransforms {
  if (!Number.isInteger(input.processId) || input.processId < 1 || input.processId > 2_147_483_647) {
    throw new Error("processId must be a positive Windows process ID")
  }
  if (typeof input.windowHandle !== "string" || !WINDOW_HANDLE.test(input.windowHandle)) {
    throw new Error("windowHandle must be a Windows window handle such as 0x1234")
  }
  if (typeof input.title !== "string" || input.title.length > 1_024 || /[\0\r\n]/u.test(input.title)) {
    throw new Error("title is invalid or exceeds 1024 characters")
  }
  const result: WindowsCaptureTransforms = {
    processId: input.processId,
    windowHandle: input.windowHandle.toLowerCase(),
    title: input.title,
  }
  if (input.className !== undefined) {
    if (typeof input.className !== "string" || input.className.length > 512 || /[\0\r\n]/u.test(input.className)) {
      throw new Error("className is invalid or exceeds 512 characters")
    }
    result.className = input.className
  }
  return result
}

export function parseWindowsCapture(value: unknown, expected: WindowsCaptureTransforms): WindowsCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows window capture host returned an invalid result")
  const source = value as Record<string, unknown>
  if (typeof source.windowId !== "string" || !WINDOW_ID.test(source.windowId)) throw new Error("Windows window capture identity is invalid")
  const windowHandle = typeof source.windowHandle === "string" ? source.windowHandle : ""
  const title = typeof source.title === "string" ? source.title : ""
  const className = typeof source.className === "string" ? source.className : ""
  if (
    !Number.isInteger(source.processId) ||
    Number(source.processId) !== expected.processId ||
    windowHandle.toLowerCase() !== expected.windowHandle ||
    title !== expected.title ||
    (expected.className !== undefined && className !== expected.className)
  ) {
    throw new Error("Windows window capture does not match the selected window identity")
  }
  if (!WINDOW_HANDLE.test(windowHandle)) throw new Error("Windows window capture handle is invalid")
  if (!source.bounds || typeof source.bounds !== "object" || Array.isArray(source.bounds)) throw new Error("Windows window capture bounds are invalid")
  const bounds = source.bounds as Record<string, unknown>
  const parsedBounds = {
    x: boundedCoordinate(bounds.x, "x", true),
    y: boundedCoordinate(bounds.y, "y", true),
    width: boundedCoordinate(bounds.width, "width", false),
    height: boundedCoordinate(bounds.height, "height", false),
  }
  if (source.mimeType !== "image/png" || typeof source.data !== "string") throw new Error("Windows window capture did not return a PNG")
  if (!Number.isInteger(source.width) || Number(source.width) < 1 || Number(source.width) > 8_192) throw new Error("Windows window capture width is invalid")
  if (!Number.isInteger(source.height) || Number(source.height) < 1 || Number(source.height) > 8_192) throw new Error("Windows window capture height is invalid")
  if (Number(source.width) * Number(source.height) > 16_777_216) throw new Error("Windows window capture exceeds the pixel boundary")
  if (!Number.isInteger(source.bytes) || Number(source.bytes) < 1 || Number(source.bytes) > MAX_CAPTURE_BYTES) {
    throw new Error("Windows window capture exceeds the 6 MiB attachment boundary")
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.data)) {
    throw new Error("Windows window capture data is not canonical base64")
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
    throw new Error("Windows window capture PNG data is malformed or inconsistent")
  }
  return {
    windowId: source.windowId,
    processId: Number(source.processId),
    windowHandle: windowHandle.toLowerCase(),
    title,
    className,
    bounds: parsedBounds,
    mimeType: "image/png",
    data: source.data,
    bytes: bytes.length,
    width: Number(source.width),
    height: Number(source.height),
  }
}

export interface RetainedCapture {
  path: string
  sha256: string
  dimensions: { width: number; height: number }
}

// Model-facing provenance for one exact-window capture. It reports the validated
// host identity and, when requested, the checked-in bounded saver's retention
// result, and it never claims acceptance-evidence validator support for a
// capture method the checker does not accept.
export function captureProvenanceText(
  capture: WindowsCapture,
  saved: RetainedCapture | undefined,
  savePathSupplied: boolean,
): string {
  const window = {
    windowId: capture.windowId,
    processId: capture.processId,
    windowHandle: capture.windowHandle,
    title: capture.title,
    className: capture.className,
    bounds: capture.bounds,
  }
  const retention = saved
    ? `Retained PNG: ${JSON.stringify(saved)}.`
    : savePathSupplied
      ? "Retention failed, so no file was written."
      : "No file was retained because savePath was omitted."
  return `Captured the exact selected Windows window (${capture.width}x${capture.height}, ${capture.bytes} bytes) without focusing, moving, or typing into it. Provenance: ${JSON.stringify(window)}. ${retention} Retained PNGs are raw identity-bound host evidence; check-acceptance-evidence.py does not accept windows_capture as a rendered-visual capture method.`
}

export interface WindowsRestoreInput {
  processId: number
  windowHandle: string
  title: string
  className?: string
  executable?: PowerShellExecutable
  apply?: boolean
  expectToken?: string
}

export interface RestoreBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface RestoreTarget {
  windowId: string
  processId: number
  windowHandle: string
  title: string
  className: string
  processStartTimeTicks: number
  iconic: boolean
  visible: boolean
  bounds: RestoreBounds
  normalBounds: RestoreBounds
  showCmd: number
}

// Restore reuses the exact-window selection validation: process ID, HWND,
// exact title, and optional exact class. The window identity is revalidated in
// the host at apply time; the request is never trusted on its own.
export function validateWindowsRestore(input: WindowsRestoreInput): WindowsCaptureTransforms {
  return validateWindowsCapture(input)
}

function restoreBounds(value: unknown, label: string): RestoreBounds {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Windows window restore ${label} is invalid`)
  const source = value as Record<string, unknown>
  return {
    x: boundedCoordinate(source.x, "x", true),
    y: boundedCoordinate(source.y, "y", true),
    width: boundedCoordinate(source.width, "width", false),
    height: boundedCoordinate(source.height, "height", false),
  }
}

export function parseRestoreTarget(value: unknown, expected: WindowsCaptureTransforms): RestoreTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows window restore host returned an invalid target")
  const source = value as Record<string, unknown>
  if (typeof source.windowId !== "string" || !WINDOW_ID.test(source.windowId)) throw new Error("Windows window restore identity is invalid")
  if (!Number.isInteger(source.processId) || Number(source.processId) !== expected.processId) throw new Error("Windows window restore does not match the selected process identity")
  if (typeof source.windowHandle !== "string" || source.windowHandle.toLowerCase() !== expected.windowHandle) throw new Error("Windows window restore does not match the selected window handle")
  if (typeof source.title !== "string" || source.title !== expected.title) throw new Error("Windows window restore does not match the exact title")
  if (typeof source.className !== "string" || (expected.className !== undefined && source.className !== expected.className)) {
    throw new Error("Windows window restore does not match the exact class")
  }
  if (!Number.isInteger(source.processStartTimeTicks) || Number(source.processStartTimeTicks) < 1) throw new Error("Windows window restore process start time is invalid")
  if (typeof source.iconic !== "boolean" || typeof source.visible !== "boolean") throw new Error("Windows window restore minimized state is invalid")
  if (!Number.isInteger(source.showCmd) || Number(source.showCmd) < 0 || Number(source.showCmd) > 3) throw new Error("Windows window restore show state is invalid")
  return {
    windowId: source.windowId,
    processId: Number(source.processId),
    windowHandle: source.windowHandle.toLowerCase(),
    title: source.title,
    className: source.className,
    processStartTimeTicks: Number(source.processStartTimeTicks),
    iconic: source.iconic,
    visible: source.visible,
    bounds: restoreBounds(source.bounds, "bounds"),
    normalBounds: restoreBounds(source.normalBounds, "normal placement"),
    showCmd: Number(source.showCmd),
  }
}

export function parseRestorePreview(value: unknown, expected: WindowsCaptureTransforms): RestoreTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows window restore host returned an invalid preview")
  const source = value as Record<string, unknown>
  if (source.mode !== "preview") throw new Error("Windows window restore host did not return a preview")
  const target = parseRestoreTarget(source.target, expected)
  if (!target.iconic) {
    throw new Error(`Windows window restore requires a genuinely minimized target (IsIconic=false, visible=${target.visible}); refusing to restore`)
  }
  return target
}

export function parseRestoreApply(value: unknown, expected: WindowsCaptureTransforms): { target: RestoreTarget; after: RestoreTarget } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows window restore host returned an invalid result")
  const source = value as Record<string, unknown>
  if (source.mode !== "apply" || source.restored !== true) throw new Error("Windows window restore host did not confirm an applied restore")
  const target = parseRestoreTarget(source.target, expected)
  const after = parseRestoreTarget(source.after, expected)
  if (!target.iconic) throw new Error("Windows window restore did not target a genuinely minimized window")
  if (after.iconic || !after.visible) throw new Error("Windows window restore did not leave the target visible and unminimized")
  for (const field of ["windowId", "processId", "windowHandle", "title", "className", "processStartTimeTicks", "showCmd"] as const) {
    if (target[field] !== after[field]) throw new Error("Windows window restore changed the target identity while applying")
  }
  for (const edge of ["x", "y", "width", "height"] as const) {
    if (target.normalBounds[edge] !== after.normalBounds[edge]) throw new Error("Windows window restore changed the target normal placement while applying")
  }
  return { target, after }
}

function findParams(input: WindowsFindInput): Record<string, unknown> {
  const result: Record<string, unknown> = {
    processId: input.processId,
    maxDepth: input.maxDepth ?? 8,
    maxNodes: input.maxNodes ?? 1_000,
    maxResults: input.maxResults ?? 20,
  }
  if (input.name !== undefined) result.name = input.name
  if (input.automationId !== undefined) result.automationId = input.automationId
  if (input.controlType !== undefined) result.controlType = input.controlType
  return result
}

function boundedSnapshotString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new Error(`Windows UI Automation snapshot ${name} is malformed or unbounded`)
  }
  return value
}

function boundedCoordinate(value: unknown, name: string, allowNegative: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 10_000_000 || (!allowNegative && value < 0)) {
    throw new Error(`Windows UI Automation snapshot bound ${name} is malformed or unbounded`)
  }
  return value
}

export function canonicalSnapshot(value: unknown): UiElementSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows UI Automation snapshot is invalid")
  const source = value as Record<string, unknown>
  const processId = source.processId
  if (!Number.isInteger(processId) || Number(processId) < 1 || Number(processId) > 2_147_483_647) throw new Error("Windows UI Automation snapshot processId is invalid")
  const runtimeId = boundedSnapshotString(source.runtimeId, "runtimeId", 512)
  if (!/^-?[0-9]+(?:\.-?[0-9]+)*$/u.test(runtimeId)) throw new Error("Windows UI Automation snapshot runtimeId is invalid")
  if (typeof source.enabled !== "boolean" || typeof source.offscreen !== "boolean") throw new Error("Windows UI Automation snapshot states are invalid")
  if (!source.bounds || typeof source.bounds !== "object" || Array.isArray(source.bounds)) throw new Error("Windows UI Automation snapshot bounds are invalid")
  const bounds = source.bounds as Record<string, unknown>
  return {
    processId: Number(processId),
    runtimeId,
    name: boundedSnapshotString(source.name, "name", 1_024),
    automationId: boundedSnapshotString(source.automationId, "automationId", 512),
    controlType: boundedSnapshotString(source.controlType, "controlType", 256),
    className: boundedSnapshotString(source.className, "className", 512),
    enabled: source.enabled,
    offscreen: source.offscreen,
    bounds: {
      x: boundedCoordinate(bounds.x, "x", true),
      y: boundedCoordinate(bounds.y, "y", true),
      width: boundedCoordinate(bounds.width, "width", false),
      height: boundedCoordinate(bounds.height, "height", false),
    },
  }
}

export function parseFindResult(value: unknown): FindResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows UI Automation host returned an invalid result")
  const result = value as { items?: unknown; visited?: unknown; truncated?: unknown }
  if (!Array.isArray(result.items)) throw new Error("Windows UI Automation host omitted its result list")
  if (!Number.isInteger(result.visited) || Number(result.visited) < 0 || Number(result.visited) > 2_000) throw new Error("Windows UI Automation host returned an invalid visited count")
  if (typeof result.truncated !== "boolean") throw new Error("Windows UI Automation host omitted its explicit truncation state")
  return {
    items: result.items.map(canonicalSnapshot),
    visited: Number(result.visited),
    truncated: result.truncated,
  }
}

export class WindowsUiManager {
  readonly #cwd: string
  readonly #powershell: PowerShellOptions
  readonly #host: PowerShellHostClient
  readonly #tokens: RawTokenStore
  readonly #gate: () => Promise<WslStatus>

  constructor(
    cwd: string,
    powershell: PowerShellOptions,
    raw: RawOptions,
    gate: () => Promise<WslStatus> = () => detectWsl(systemProbes(cwd)),
  ) {
    this.#cwd = cwd
    this.#powershell = powershell
    this.#host = new PowerShellHostClient(cwd, powershell)
    this.#tokens = new RawTokenStore(raw.tokenTtlMs, Date.now, undefined, raw.maxTokens)
    this.#gate = gate
  }

  async apps(input: WindowsAppsInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    const maximum = input.maxItems ?? 50
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("maxItems must be an integer from 1 through 100")
    if (input.name !== undefined && (!input.name || input.name.length > 128 || /[\0\r\n]/u.test(input.name))) throw new Error("name is invalid or exceeds 128 characters")
    const params: Record<string, unknown> = { maxItems: maximum }
    if (input.name !== undefined) params.name = input.name
    const response = await this.#host.request(input.executable ?? this.#powershell.preferred, "windows.apps", params, { signal })
    return {
      executable: response.executable,
      executablePath: response.executablePath,
      executableIdentity: response.executableIdentity,
      items: normalizeHostItems(response.result, "Windows app"),
      untrusted: true,
    }
  }

  async find(input: WindowsFindInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    validateWindowsFind(input)
    const response = await this.#host.request(input.executable ?? this.#powershell.preferred, "windows.find", findParams(input), { signal })
    return {
      executable: response.executable,
      executablePath: response.executablePath,
      executableIdentity: response.executableIdentity,
      ...parseFindResult(response.result),
      untrusted: true,
    }
  }

  async act(input: WindowsActInput, caller: CallerState, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const wsl = await this.#requireReady()
    if (wsl.fingerprint !== caller.fingerprint) throw new Error("WSL state changed before the Windows UI operation")
    validateWindowsAct(input)
    const operation = { ...findParams(input), action: input.action } as Record<string, unknown>
    if (input.value !== undefined) operation.value = input.value
    const find = await this.#host.request(input.executable ?? this.#powershell.preferred, "windows.find", findParams(input), { signal })
    const found = parseFindResult(find.result)
    if (found.truncated) throw new Error("Windows UI Automation action refuses truncated discovery; narrow the selector or increase bounded traversal limits")
    if (found.items.length !== 1) throw new Error(`Windows UI Automation action requires exactly one complete current match; found ${found.items.length}`)
    const target = found.items[0]!
    const intent: RawIntent = {
      sessionID: caller.sessionID,
      agent: caller.agent,
      script: JSON.stringify({ operation, target }),
      executable: find.executablePath,
      executableIdentity: find.executableIdentity,
      workingDirectory: this.#cwd,
      fingerprint: caller.fingerprint,
      timeoutMs: this.#powershell.timeoutMs,
    }
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      return {
        action: "preview",
        executable: find.executable,
        executablePath: find.executablePath,
        executableIdentity: find.executableIdentity,
        requestedAction: input.action,
        target,
        warning: "UI Automation apply acts with the current Windows user's authority and requires complete discovery plus an in-host exact target comparison.",
        ...this.#tokens.preview(intent),
      }
    }
    if (!input.expectToken) throw new Error("apply=true requires expectToken from the exact Windows UI preview")
    this.#tokens.consume(input.expectToken, intent)
    const applied = await this.#host.requestExact(
      find.executable,
      find.executablePath,
      find.executableIdentity,
      "windows.act",
      { ...operation, expectedTarget: target },
      { signal },
    )
    return {
      action: "apply",
      executable: applied.executable,
      executablePath: applied.executablePath,
      executableIdentity: applied.executableIdentity,
      result: applied.result,
      untrusted: true,
    }
  }

  async capture(input: WindowsCaptureInput, signal?: AbortSignal): Promise<WindowsCapture & { untrusted: true }> {
    await this.#requireReady()
    const validated = validateWindowsCapture(input)
    const response = await this.#host.request(input.executable ?? this.#powershell.preferred, "windows.capture", validated, {
      maxOutputBytes: MAX_CAPTURE_OUTPUT_BYTES,
      signal,
    })
    return { ...parseWindowsCapture(response.result, validated), untrusted: true }
  }

  async restore(input: WindowsRestoreInput, caller: CallerState, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const wsl = await this.#requireReady()
    if (wsl.fingerprint !== caller.fingerprint) throw new Error("WSL state changed before the Windows window restore")
    const validated = validateWindowsRestore(input)
    const selection: Record<string, unknown> = { ...validated }
    const preview = await this.#host.request(input.executable ?? this.#powershell.preferred, "windows.restore", selection, { signal })
    const target = parseRestorePreview(preview.result, validated)
    const operation = { ...selection }
    const intent: RawIntent = {
      sessionID: caller.sessionID,
      agent: caller.agent,
      script: JSON.stringify({ operation, target }),
      executable: preview.executablePath,
      executableIdentity: preview.executableIdentity,
      workingDirectory: this.#cwd,
      fingerprint: caller.fingerprint,
      timeoutMs: this.#powershell.timeoutMs,
    }
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      return {
        action: "preview",
        executable: preview.executable,
        executablePath: preview.executablePath,
        executableIdentity: preview.executableIdentity,
        target,
        warning: "Restore reveals a genuinely minimized window with ShowWindow(SW_SHOWNOACTIVATE); it never activates, focuses, moves, or types into the window and fails closed on any identity, placement, or minimized-state change.",
        ...this.#tokens.preview(intent),
      }
    }
    if (!input.expectToken) throw new Error("apply=true requires expectToken from the exact Windows window restore preview")
    this.#tokens.consume(input.expectToken, intent)
    const applied = await this.#host.requestExact(
      preview.executable,
      preview.executablePath,
      preview.executableIdentity,
      "windows.restore",
      { ...operation, expectedTarget: target },
      { signal },
    )
    const appliedResult = parseRestoreApply(applied.result, validated)
    return {
      action: "apply",
      executable: applied.executable,
      executablePath: applied.executablePath,
      executableIdentity: applied.executableIdentity,
      target: appliedResult.target,
      after: appliedResult.after,
      untrusted: true,
    }
  }

  async #requireReady(): Promise<WslStatus> {
    const status = await this.#gate()
    assertWsl2Interop(status)
    return status
  }
}
