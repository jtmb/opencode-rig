import { PowerShellHostClient } from "./powershell-host.ts"
import { decodeProcessOutput, runBoundedProcess, type ProcessResult } from "./process-boundary.ts"
import { structuredParams } from "./structured-commands.ts"
import { RawTokenStore, type RawIntent } from "./token-store.ts"
import type {
  PowerShellExecutable,
  PowerShellOptions,
  PowerShellStatus,
  RawOptions,
  RawPowerShellInput,
  StructuredCommandInput,
} from "./types.ts"
import type { WslStatus } from "./types.ts"
import { assertWsl2Interop, detectWsl, systemProbes } from "./wsl-detect.ts"

interface RunOptions {
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}

export function executableCandidates(preferred: PowerShellExecutable): Array<Exclude<PowerShellExecutable, "auto">> {
  if (preferred === "pwsh.exe" || preferred === "powershell.exe") return [preferred]
  return ["pwsh.exe", "powershell.exe"]
}

export function decodePowerShellOutput(bytes: Buffer): string {
  return decodeProcessOutput(bytes)
}

function filteredEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "WSL_INTEROP", "WSLENV", "WSL_DISTRO_NAME", "SystemRoot", "SYSTEMROOT",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM",
  ]
  const result: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return result
}

export function runBoundedPowerShell(
  executable: string,
  script: string,
  options: RunOptions,
): Promise<ProcessResult> {
  return runBoundedProcess(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    script,
    { ...options, env: filteredEnvironment() },
  )
}

export interface RawInspection {
  commands: string[]
  warnings: string[]
}

const RAW_DENIALS: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|[;&|\s])git(?:\.exe)?\s+(?:-[^\s]+\s+)*(?:commit|push)(?:\s|$)/iu, "Git commit/push must use the repository gates"],
  [/-encodedcommand\b/iu, "encoded PowerShell commands are not accepted"],
  [/\b(?:Invoke-Expression|iex)\b/iu, "dynamic PowerShell expression execution is not accepted"],
  [/\b(?:Get-Credential|cmdkey|vaultcmd)\b/iu, "credential-store operations are not accepted"],
  [/[\\/](?:\.local[\\/]opt[\\/]opencode-v2|\.opencode[\\/]bin)[\\/]opencode(?:\.exe)?\b/iu, "installed OpenCode binaries are immutable"],
]

export function inspectRawScript(script: string, maxBytes: number): RawInspection {
  const bytes = Buffer.byteLength(script, "utf8")
  if (!script.trim()) throw new Error("raw PowerShell script must not be empty")
  if (bytes > maxBytes) throw new Error(`raw PowerShell script exceeds ${maxBytes} bytes`)
  if (script.includes("\0")) throw new Error("raw PowerShell script contains NUL")
  for (const [expression, message] of RAW_DENIALS) {
    if (expression.test(script)) throw new Error(message)
  }
  const commands = [...script.matchAll(/\b([A-Za-z]+-[A-Za-z][A-Za-z0-9]*)\b/gu)]
    .map((match) => match[1]!)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 64)
  return {
    commands,
    warnings: [
      "Arbitrary PowerShell is not sandboxed and may mutate the Windows host after approval.",
      "The preview identifies common commands but cannot classify all PowerShell semantics.",
    ],
  }
}

export class PowerShellManager {
  readonly #tokens: RawTokenStore
  readonly #cwd: string
  readonly #options: PowerShellOptions
  readonly #rawOptions: RawOptions
  readonly #host: PowerShellHostClient
  readonly #gate: () => Promise<WslStatus>

  constructor(
    cwd: string,
    options: PowerShellOptions,
    rawOptions: RawOptions,
    gate: () => Promise<WslStatus> = () => detectWsl(systemProbes(cwd)),
  ) {
    this.#cwd = cwd
    this.#options = options
    this.#rawOptions = rawOptions
    this.#host = new PowerShellHostClient(cwd, options)
    this.#tokens = new RawTokenStore(rawOptions.tokenTtlMs, Date.now, undefined, rawOptions.maxTokens)
    this.#gate = gate
  }

  async status(preferred: PowerShellExecutable = this.#options.preferred, signal?: AbortSignal): Promise<PowerShellStatus> {
    await this.#requireReady()
    return this.#host.status(preferred, signal)
  }

  async structured(input: StructuredCommandInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#requireReady()
    const params = structuredParams(input)
    const response = await this.#host.request(input.executable ?? this.#options.preferred, input.operation, params, { signal })
    return {
      executable: response.executable,
      operation: input.operation,
      data: response.result,
      untrusted: true,
    }
  }

  async raw(
    input: RawPowerShellInput,
    caller: { sessionID: string; agent: string; fingerprint: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const wsl = await this.#requireReady()
    if (wsl.fingerprint !== caller.fingerprint) throw new Error("WSL state changed before the PowerShell operation")
    if (!this.#rawOptions.enabled) throw new Error("raw PowerShell is disabled by WSL plugin options")
    const localInspection = inspectRawScript(input.script, this.#rawOptions.maxScriptBytes)
    const timeoutMs = input.timeoutMs ?? this.#options.timeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > this.#options.timeoutMs) {
      throw new Error(`timeoutMs must be an integer from 100 through ${this.#options.timeoutMs}`)
    }
    const parsed = await this.#host.request(
      input.executable ?? this.#options.preferred,
      "raw.parse",
      { script: input.script },
      { signal },
    )
    const astInspection = parsed.result && typeof parsed.result === "object"
      ? parsed.result as { commands?: unknown; dynamicCommands?: unknown }
      : {}
    const commands = Array.isArray(astInspection.commands)
      ? astInspection.commands.filter((value): value is string => typeof value === "string").slice(0, 64)
      : localInspection.commands
    const intent: RawIntent = {
      sessionID: caller.sessionID,
      agent: caller.agent,
      script: input.script,
      executable: parsed.executablePath,
      executableIdentity: parsed.executableIdentity,
      workingDirectory: this.#cwd,
      fingerprint: caller.fingerprint,
      timeoutMs,
    }
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      const preview = this.#tokens.preview(intent)
      return {
        action: "preview",
        executable: parsed.executable,
        executablePath: parsed.executablePath,
        executableIdentity: parsed.executableIdentity,
        commands,
        dynamicCommands: astInspection.dynamicCommands === true,
        warnings: localInspection.warnings,
        ...preview,
      }
    }
    if (!input.expectToken) throw new Error("apply=true requires expectToken from the exact preview")
    this.#tokens.consume(input.expectToken, intent)
    const result = await runBoundedPowerShell(parsed.executablePath, input.script, {
      cwd: this.#cwd,
      timeoutMs,
      maxOutputBytes: this.#options.maxOutputBytes,
      signal,
    })
    return {
      action: "apply",
      executable: parsed.executable,
      executablePath: parsed.executablePath,
      executableIdentity: parsed.executableIdentity,
      exitCode: result.exitCode,
      stdout: decodePowerShellOutput(result.stdout),
      stderr: decodePowerShellOutput(result.stderr),
      untrusted: true,
    }
  }

  async #requireReady(): Promise<WslStatus> {
    const status = await this.#gate()
    assertWsl2Interop(status)
    return status
  }
}
