import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, realpath, stat } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

import { decodeProcessOutput, runBoundedProcess } from "./process-boundary.ts"
import type { PowerShellExecutable, PowerShellOptions, PowerShellStatus } from "./types.ts"

const HOST_PATH = fileURLToPath(new URL("../powershell/OpenRig.WindowsHost.ps1", import.meta.url))

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface HostRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ResolvedExecutable {
  name: Exclude<PowerShellExecutable, "auto">
  path: string
  identity: string
}

function executableCandidates(preferred: PowerShellExecutable): Array<Exclude<PowerShellExecutable, "auto">> {
  if (preferred === "pwsh.exe" || preferred === "powershell.exe") return [preferred]
  return ["pwsh.exe", "powershell.exe"]
}

function isExpectedPowerShellPath(name: Exclude<PowerShellExecutable, "auto">, path: string): boolean {
  if (name === "powershell.exe") {
    return /^\/mnt\/[A-Za-z]\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/iu.test(path)
  }
  return /^\/mnt\/[A-Za-z]\/Program Files\/PowerShell\/[A-Za-z0-9._-]+\/pwsh\.exe$/iu.test(path)
}

async function executableIdentity(path: string): Promise<string> {
  const metadata = await stat(path, { bigint: true })
  if (!metadata.isFile()) throw new Error(`trusted executable is not a regular file: ${path}`)
  return createHash("sha256").update(JSON.stringify({
    path,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    modifiedNanoseconds: metadata.mtimeNs.toString(),
  })).digest("hex")
}

export async function resolvePowerShellExecutable(
  name: Exclude<PowerShellExecutable, "auto">,
  pathValue = process.env.PATH ?? "",
): Promise<ResolvedExecutable> {
  const candidates = pathValue.split(delimiter).filter((directory) => directory.startsWith("/"))
  for (const directory of candidates) {
    const candidate = join(directory, name)
    try {
      const canonical = await realpath(candidate)
      if (!isExpectedPowerShellPath(name, canonical)) continue
      await access(canonical, constants.X_OK)
      return { name, path: canonical, identity: await executableIdentity(canonical) }
    } catch {
      continue
    }
  }
  throw new Error(`${name} was not found at an expected absolute Windows installation path`)
}

async function resolveWslPath(): Promise<{ path: string; identity: string }> {
  for (const candidate of ["/usr/bin/wslpath", "/bin/wslpath"]) {
    try {
      const canonical = await realpath(candidate)
      if (canonical !== "/init" && canonical !== "/usr/bin/wslpath" && canonical !== "/bin/wslpath") continue
      await access(candidate, constants.X_OK)
      return { path: candidate, identity: await executableIdentity(canonical) }
    } catch {
      continue
    }
  }
  throw new Error("trusted /usr/bin/wslpath is unavailable")
}

async function verifyHostSource(): Promise<void> {
  const [metadata, canonical] = await Promise.all([lstat(HOST_PATH), realpath(HOST_PATH)])
  if (!metadata.isFile() || metadata.isSymbolicLink() || canonical !== HOST_PATH) {
    throw new Error("PowerShell host source must be the checked-in regular non-symlink file")
  }
}

export function createRpcRequest(method: string, params: Record<string, unknown>, id = 1): JsonRpcRequest {
  if (!method || method.length > 128) throw new Error("PowerShell host RPC method must be 1..128 characters")
  return { jsonrpc: "2.0", id, method, params }
}

export function parseRpcResponse(text: string, expectedID = 1): unknown {
  let response: JsonRpcResponse
  try {
    response = JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new Error("PowerShell host returned malformed JSON-RPC")
  }
  if (response.jsonrpc !== "2.0" || response.id !== expectedID) throw new Error("PowerShell host returned a mismatched JSON-RPC response")
  if (response.error) throw new Error(`PowerShell host error: ${response.error.message ?? "unknown error"}`)
  if (!("result" in response)) throw new Error("PowerShell host response omitted result")
  return response.result
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

async function windowsPath(cwd: string, signal?: AbortSignal): Promise<string> {
  await verifyHostSource()
  const wslpath = await resolveWslPath()
  const converted = await runBoundedProcess(wslpath.path, ["-w", HOST_PATH], "", {
    cwd,
    env: filteredEnvironment(),
    timeoutMs: 3_000,
    maxOutputBytes: 16_384,
    signal,
  })
  if (converted.exitCode !== 0) {
    throw new Error(`wslpath failed: ${decodeProcessOutput(converted.stderr).trim() || `exit ${converted.exitCode}`}`)
  }
  const value = decodeProcessOutput(converted.stdout).trim()
  if (!value || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new Error("wslpath returned an invalid PowerShell host path")
  }
  const roundTrip = await runBoundedProcess(wslpath.path, ["-u", value], "", {
    cwd,
    env: filteredEnvironment(),
    timeoutMs: 3_000,
    maxOutputBytes: 16_384,
    signal,
  })
  if (roundTrip.exitCode !== 0) throw new Error("wslpath could not round-trip the PowerShell host path")
  const linuxPath = decodeProcessOutput(roundTrip.stdout).trim()
  const canonical = await realpath(linuxPath)
  if (canonical !== HOST_PATH) throw new Error("wslpath translated to an unexpected PowerShell host source")
  return value
}

export class PowerShellHostClient {
  readonly #cwd: string
  readonly #options: PowerShellOptions

  constructor(cwd: string, options: PowerShellOptions) {
    this.#cwd = cwd
    this.#options = options
  }

  async status(preferred: PowerShellExecutable = this.#options.preferred, signal?: AbortSignal): Promise<PowerShellStatus> {
    let lastError = "no trusted Windows PowerShell executable was found"
    for (const name of executableCandidates(preferred)) {
      try {
        const executable = await resolvePowerShellExecutable(name)
        const result = await this.requestWith(executable, "status", {}, {
          timeoutMs: Math.min(5_000, this.#options.timeoutMs),
          signal,
        }) as { version?: unknown; edition?: unknown; uiAutomation?: unknown }
        return {
          available: true,
          executable: executable.name,
          executablePath: executable.path,
          executableIdentity: executable.identity,
          version: typeof result.version === "string" ? result.version : "unknown",
          edition: typeof result.edition === "string" ? result.edition : "unknown",
          uiAutomation: result.uiAutomation === true,
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    return { available: false, error: lastError.slice(0, 1_024) }
  }

  async request(
    preferred: PowerShellExecutable,
    method: string,
    params: Record<string, unknown>,
    options: HostRequestOptions = {},
  ): Promise<{ executable: Exclude<PowerShellExecutable, "auto">; executablePath: string; executableIdentity: string; result: unknown }> {
    let lastError = "PowerShell is unavailable"
    for (const name of executableCandidates(preferred)) {
      try {
        const executable = await resolvePowerShellExecutable(name)
        return {
          executable: executable.name,
          executablePath: executable.path,
          executableIdentity: executable.identity,
          result: await this.requestWith(executable, method, params, options),
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(lastError)
  }

  async requestExact(
    name: Exclude<PowerShellExecutable, "auto">,
    expectedPath: string,
    expectedIdentity: string,
    method: string,
    params: Record<string, unknown>,
    options: HostRequestOptions = {},
  ): Promise<{ executable: Exclude<PowerShellExecutable, "auto">; executablePath: string; executableIdentity: string; result: unknown }> {
    const executable = await resolvePowerShellExecutable(name)
    if (executable.path !== expectedPath || executable.identity !== expectedIdentity) {
      throw new Error("trusted PowerShell executable changed; preview the operation again")
    }
    return {
      executable: executable.name,
      executablePath: executable.path,
      executableIdentity: executable.identity,
      result: await this.requestWith(executable, method, params, options),
    }
  }

  private async requestWith(
    executable: ResolvedExecutable,
    method: string,
    params: Record<string, unknown>,
    options: HostRequestOptions,
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > this.#options.timeoutMs) {
      throw new Error(`PowerShell host timeout must be 100..${this.#options.timeoutMs}ms`)
    }
    const host = await windowsPath(this.#cwd, options.signal)
    const request = createRpcRequest(method, params)
    const result = await runBoundedProcess(
      executable.path,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", host],
      `${JSON.stringify(request)}\n`,
      {
        cwd: this.#cwd,
        env: filteredEnvironment(),
        timeoutMs,
        maxOutputBytes: this.#options.maxOutputBytes,
        signal: options.signal,
      },
    )
    const stderr = decodeProcessOutput(result.stderr).trim()
    if (result.exitCode !== 0) throw new Error(`PowerShell host failed (exit ${result.exitCode}): ${stderr || "no error text"}`)
    return parseRpcResponse(decodeProcessOutput(result.stdout).trim())
  }
}
