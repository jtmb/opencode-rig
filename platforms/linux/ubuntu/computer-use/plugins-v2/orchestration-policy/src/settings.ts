import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"

export const ENFORCEMENT_NAMES = [
  "requireTaskDeclare",
  "strictShellClassification",
  "parentDelegationOnly",
  "backgroundChildrenOnly",
  "correctionLedgers",
  "memoryReconciliation",
] as const

export type EnforcementName = typeof ENFORCEMENT_NAMES[number]
export type EnforcementSettings = Record<EnforcementName, boolean>
export const ORCHESTRATION_MODES = ["parallel", "single-subagent"] as const
export type OrchestrationMode = typeof ORCHESTRATION_MODES[number]

export const DEFAULT_ENFORCEMENTS: EnforcementSettings = Object.freeze({
  requireTaskDeclare: true,
  strictShellClassification: true,
  parentDelegationOnly: true,
  backgroundChildrenOnly: true,
  correctionLedgers: true,
  memoryReconciliation: true,
})

export type LoadedEnforcementSettings = {
  enforcements: EnforcementSettings
  orchestrationMode?: OrchestrationMode
  status: "missing" | "valid" | "invalid"
  message?: string
}

const MAX_SETTINGS_BYTES = 4_096
const SETTINGS_FILE = "orchestration-policy-settings.json"
const VALIDATOR_MESSAGE = "settings are malformed or unreadable; all workflow enforcements remain ON"
const DEFAULT_RESULT: LoadedEnforcementSettings = {
  enforcements: { ...DEFAULT_ENFORCEMENTS },
  status: "missing",
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined
}

function ensureOutsideProject(path: string, projectRoot?: string) {
  if (!projectRoot) return
  const root = resolve(projectRoot)
  const fromRoot = relative(root, path)
  if (!fromRoot || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
    throw new Error("operator settings must be stored outside the repository")
  }
}

export function operatorEnforcementSettingsPath(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const configured = environment.XDG_CONFIG_HOME
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    throw new Error("XDG_CONFIG_HOME must be absolute")
  }
  const configHome = configured || join(home, ".config")
  return resolve(configHome, "opencode", SETTINGS_FILE)
}

export function parseEnforcementSettings(text: string): EnforcementSettings {
  return parseSettings(text).enforcements
}

function parseSettings(text: string) {
  if (Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) throw new Error("settings exceed the size limit")
  const value: unknown = JSON.parse(text)
  const root = record(value)
  const enforcements = record(root?.enforcements)
  if (
    !root || root.schemaVersion !== 1 ||
    Object.keys(root).some((key) => !["schemaVersion", "enforcements", "orchestrationMode"].includes(key)) ||
    (root.orchestrationMode !== undefined && !ORCHESTRATION_MODES.includes(root.orchestrationMode as OrchestrationMode)) ||
    !enforcements || Object.keys(enforcements).length !== ENFORCEMENT_NAMES.length ||
    ENFORCEMENT_NAMES.some((name) => typeof enforcements[name] !== "boolean")
  ) throw new Error("settings schema is invalid")

  const settings = Object.fromEntries(ENFORCEMENT_NAMES.map((name) => [name, enforcements[name]])) as EnforcementSettings
  // Canonical form rejects ambiguous duplicate JSON keys as well as unsupported formatting.
  const orchestrationMode = root.orchestrationMode as OrchestrationMode | undefined
  if (serializeEnforcementSettings(settings, orchestrationMode) !== text) {
    throw new Error("settings are not canonical JSON")
  }
  return { enforcements: settings, orchestrationMode: orchestrationMode ?? "parallel" as const }
}

export function serializeEnforcementSettings(enforcements: EnforcementSettings, orchestrationMode?: OrchestrationMode) {
  if (orchestrationMode !== undefined && !ORCHESTRATION_MODES.includes(orchestrationMode)) throw new Error("orchestration mode is invalid")
  if (
    !enforcements || Object.keys(enforcements).length !== ENFORCEMENT_NAMES.length ||
    ENFORCEMENT_NAMES.some((name) => typeof enforcements[name] !== "boolean")
  ) throw new Error("enforcement settings must contain exactly the supported boolean fields")
  const ordered = Object.fromEntries(ENFORCEMENT_NAMES.map((name) => [name, enforcements[name]])) as EnforcementSettings
  return `${JSON.stringify({ schemaVersion: 1, enforcements: ordered, ...(orchestrationMode ? { orchestrationMode } : {}) }, null, 2)}\n`
}

async function checkDirectoryChain(directory: string, create: boolean, configHome: string) {
  const root = parse(directory).root
  let current = root
  for (const part of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || !create) {
        if (errorCode(error) === "ENOENT" && !create) return false
        throw error
      }
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError
      }
      info = await lstat(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("settings directory is not a regular directory")
    if ((current === configHome || current === dirname(join(configHome, "opencode", SETTINGS_FILE))) &&
      (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)) {
      throw new Error("settings directory is not operator-owned and private")
    }
  }
  return true
}

export async function readEnforcementSettings(
  projectRoot?: string,
  settingsPath = operatorEnforcementSettingsPath(),
): Promise<LoadedEnforcementSettings> {
  try {
    const path = resolve(settingsPath)
    ensureOutsideProject(path, projectRoot)
    const configHome = dirname(dirname(path))
    if (!await checkDirectoryChain(dirname(path), false, configHome)) return { ...DEFAULT_RESULT, enforcements: { ...DEFAULT_ENFORCEMENTS } }
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new Error("settings file is not a private operator-owned regular file")
    }
    if (info.size > MAX_SETTINGS_BYTES) throw new Error("settings exceed the size limit")
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_SETTINGS_BYTES) {
        throw new Error("settings changed while being read")
      }
      const settings = parseSettings(await handle.readFile("utf8"))
      return { ...settings, status: "valid" }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { enforcements: { ...DEFAULT_ENFORCEMENTS }, status: "missing" }
    return { enforcements: { ...DEFAULT_ENFORCEMENTS }, status: "invalid", message: VALIDATOR_MESSAGE }
  }
}

export async function writeEnforcementSettings(
  enforcements: EnforcementSettings,
  projectRoot?: string,
  settingsPath = operatorEnforcementSettingsPath(),
  orchestrationMode?: OrchestrationMode,
) {
  const path = resolve(settingsPath)
  ensureOutsideProject(path, projectRoot)
  const configHome = dirname(dirname(path))
  const directory = dirname(path)
  await checkDirectoryChain(directory, true, configHome)
  try {
    const existing = await lstat(path)
    if ((!existing.isFile() && !existing.isSymbolicLink()) || existing.uid !== process.getuid?.()) {
      throw new Error("settings target is not an operator-owned regular file or symlink")
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }

  const contents = serializeEnforcementSettings(enforcements, orchestrationMode)
  if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) throw new Error("settings exceed the size limit")
  const temporary = join(directory, `.${SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(contents, "utf8")
    await handle.sync()
  } catch (error) {
    await handle.close()
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    await rename(temporary, path)
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
