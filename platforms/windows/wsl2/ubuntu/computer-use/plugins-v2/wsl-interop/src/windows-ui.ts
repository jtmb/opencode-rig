import { PowerShellHostClient } from "./powershell-host.ts"
import { RawTokenStore, type RawIntent } from "./token-store.ts"
import type {
  PowerShellOptions,
  RawOptions,
  WindowsActInput,
  WindowsAppsInput,
  WindowsFindInput,
  WslStatus,
} from "./types.ts"
import { assertWsl2Interop, detectWsl, systemProbes } from "./wsl-detect.ts"

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

  async #requireReady(): Promise<WslStatus> {
    const status = await this.#gate()
    assertWsl2Interop(status)
    return status
  }
}
