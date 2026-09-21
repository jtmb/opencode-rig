import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { execFile } from "node:child_process"

import type { WslStatus } from "./types.ts"

export interface WslProbes {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  cwd: string
  readText(path: string): Promise<string | undefined>
  exists(path: string): Promise<boolean>
  systemdState(): Promise<string>
}

function defaultReadText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined)
}

async function defaultExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function defaultSystemdState(): Promise<string> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-system-running"], { timeout: 3_000, shell: false }, (error, stdout, stderr) => {
      const value = `${stdout}${stderr}`.trim().split(/\s+/u)[0]
      resolve(value || (error ? "unavailable" : "unknown"))
    })
  })
}

export function systemProbes(cwd = process.cwd()): WslProbes {
  return {
    platform: process.platform,
    env: process.env,
    cwd,
    readText: defaultReadText,
    exists: defaultExists,
    systemdState: defaultSystemdState,
  }
}

export function parseWslConf(text: string | undefined): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  let section = ""
  for (const rawLine of (text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase()
      result[section] ??= {}
      continue
    }
    const separator = line.indexOf("=")
    if (!section || separator < 1) continue
    result[section]![line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
  }
  return result
}

function configuredBoolean(value: string | undefined): boolean | "unknown" {
  if (value === undefined) return "unknown"
  if (/^(1|true|yes)$/iu.test(value)) return true
  if (/^(0|false|no)$/iu.test(value)) return false
  return "unknown"
}

export async function detectWsl(probes: WslProbes = systemProbes()): Promise<WslStatus> {
  const [releaseText, versionText, configText, initText, interopText, systemdDirectory] = await Promise.all([
    probes.readText("/proc/sys/kernel/osrelease"),
    probes.readText("/proc/version"),
    probes.readText("/etc/wsl.conf"),
    probes.readText("/proc/1/comm"),
    probes.readText("/proc/sys/fs/binfmt_misc/WSLInterop"),
    probes.exists("/run/systemd/system"),
  ])
  const kernel = (releaseText ?? versionText ?? "unknown").trim()
  const kernelMarker = (releaseText ?? "").toLowerCase()
  const isWsl = probes.platform === "linux" && kernelMarker.includes("microsoft")
  const version: 0 | 1 | 2 = !isWsl ? 0 : /wsl2|microsoft-standard/iu.test(kernelMarker) ? 2 : 1
  const config = parseWslConf(configText)
  const systemdConfigured = configuredBoolean(config.boot?.systemd)
  const interopConfigured = configuredBoolean(config.interop?.enabled)
  const pathEnabled = configuredBoolean(config.interop?.appendwindowspath)
  const initIsSystemd = (initText ?? "").trim() === "systemd"
  const state = isWsl && (initIsSystemd || systemdDirectory) ? await probes.systemdState() : "unavailable"
  const statusWithoutFingerprint = {
    platform: probes.platform,
    isWsl,
    version,
    distro: probes.env.WSL_DISTRO_NAME || undefined,
    kernel,
    workspace: probes.cwd === "/mnt" || probes.cwd.startsWith("/mnt/") ? "windows-mount" as const : "linux" as const,
    systemd: {
      configured: systemdConfigured,
      running: initIsSystemd && state !== "offline" && state !== "unavailable",
      state,
    },
    interop: {
      configured: interopConfigured,
      registered: isEffectiveInteropRegistration(interopText),
      pathEnabled,
    },
    wslg: Boolean(probes.env.WAYLAND_DISPLAY && probes.env.WSLG_RUNTIME_DIR),
    network: {
      proxyConfigured: Boolean(probes.env.HTTPS_PROXY || probes.env.https_proxy || probes.env.ALL_PROXY || probes.env.all_proxy),
      customCaConfigured: Boolean(probes.env.NODE_EXTRA_CA_CERTS || probes.env.SSL_CERT_FILE || probes.env.SSL_CERT_DIR),
    },
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(statusWithoutFingerprint)).digest("hex")
  return { ...statusWithoutFingerprint, fingerprint }
}

export function isEffectiveInteropRegistration(text: string | undefined): boolean {
  if (!text) return false
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  return lines.includes("enabled") && lines.some((line) => /^interpreter\s+\/[^\s]+$/u.test(line))
}

export function assertWsl2Interop(status: WslStatus): void {
  if (status.platform !== "linux" || !status.isWsl || status.version !== 2) {
    throw new Error(`Windows host operation requires kernel-confirmed WSL2; detected ${status.kernel}`)
  }
  if (!status.interop.registered) {
    throw new Error("Windows host operation requires an effective WSL interoperability registration")
  }
}
