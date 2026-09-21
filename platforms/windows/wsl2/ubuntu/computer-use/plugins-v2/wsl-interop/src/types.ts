export type PowerShellExecutable = "auto" | "pwsh.exe" | "powershell.exe"

export interface PowerShellOptions {
  preferred: PowerShellExecutable
  timeoutMs: number
  maxOutputBytes: number
}

export interface RawOptions {
  enabled: boolean
  tokenTtlMs: number
  maxScriptBytes: number
  maxTokens: number
}

export interface WslInteropOptions {
  enabled: boolean
  refreshMs: number
  powershell: PowerShellOptions
  raw: RawOptions
}

export interface WslStatus {
  platform: NodeJS.Platform
  isWsl: boolean
  version: 0 | 1 | 2
  distro?: string
  kernel: string
  workspace: "linux" | "windows-mount"
  systemd: {
    configured: boolean | "unknown"
    running: boolean
    state: string
  }
  interop: {
    configured: boolean | "unknown"
    registered: boolean
    pathEnabled: boolean | "unknown"
  }
  wslg: boolean
  network: {
    proxyConfigured: boolean
    customCaConfigured: boolean
  }
  fingerprint: string
}

export interface PowerShellStatus {
  available: boolean
  executable?: Exclude<PowerShellExecutable, "auto">
  executablePath?: string
  executableIdentity?: string
  version?: string
  edition?: string
  uiAutomation?: boolean
  error?: string
}

export interface StructuredCommandInput {
  operation: "processes" | "services" | "path"
  name?: string
  path?: string
  maxItems?: number
  executable?: PowerShellExecutable
}

export interface RawPowerShellInput {
  script: string
  executable?: PowerShellExecutable
  timeoutMs?: number
  apply?: boolean
  expectToken?: string
}

export interface WindowsAppsInput {
  name?: string
  maxItems?: number
  executable?: PowerShellExecutable
}

export interface WindowsFindInput {
  processId: number
  name?: string
  automationId?: string
  controlType?: string
  maxDepth?: number
  maxNodes?: number
  maxResults?: number
  executable?: PowerShellExecutable
}

export interface WindowsActInput extends WindowsFindInput {
  action: "focus" | "invoke" | "setValue" | "toggle" | "select"
  value?: string
  apply?: boolean
  expectToken?: string
}

export function parseOptions(value: unknown): WslInteropOptions {
  const source = strictObject(value, "options", ["enabled", "refreshMs", "powershell", "raw"])
  const powerShell = strictObject(source.powershell, "options.powershell", ["preferred", "timeoutMs", "maxOutputBytes"])
  const raw = strictObject(source.raw, "options.raw", ["enabled", "tokenTtlMs", "maxScriptBytes", "maxTokens"])
  if (typeof source.enabled !== "boolean") throw new Error("options.enabled must be a boolean")
  if (typeof raw.enabled !== "boolean") throw new Error("options.raw.enabled must be a boolean")
  const preferred = powerShell.preferred
  if (preferred !== "auto" && preferred !== "pwsh.exe" && preferred !== "powershell.exe") {
    throw new Error("options.powershell.preferred is invalid")
  }
  return {
    enabled: source.enabled,
    refreshMs: boundedInteger(source.refreshMs, "options.refreshMs", 1_000, 60_000),
    powershell: {
      preferred,
      timeoutMs: boundedInteger(powerShell.timeoutMs, "options.powershell.timeoutMs", 100, 30_000),
      maxOutputBytes: boundedInteger(powerShell.maxOutputBytes, "options.powershell.maxOutputBytes", 4_096, 1_048_576),
    },
    raw: {
      enabled: raw.enabled,
      tokenTtlMs: boundedInteger(raw.tokenTtlMs, "options.raw.tokenTtlMs", 10_000, 300_000),
      maxScriptBytes: boundedInteger(raw.maxScriptBytes, "options.raw.maxScriptBytes", 1, 65_536),
      maxTokens: boundedInteger(raw.maxTokens, "options.raw.maxTokens", 1, 1_024),
    },
  }
}

function strictObject(value: unknown, label: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const source = value as Record<string, unknown>
  const unexpected = Object.keys(source).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported option: ${unexpected[0]}`)
  for (const key of allowed) {
    if (!(key in source)) throw new Error(`${label}.${key} is required`)
  }
  return source
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return Number(value)
}
