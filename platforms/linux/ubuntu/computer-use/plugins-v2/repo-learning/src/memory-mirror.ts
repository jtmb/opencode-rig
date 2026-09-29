import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open, realpath, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  markInstructionMirrorPending,
  markInstructionReadbackVerified,
  quarantineInstruction,
  recoverApprovedInstruction,
  validateInstructionPlan,
  type CanonicalInstructionPlan,
  type RepositoryWriterOptions,
} from "./repo-writer.ts"

export const BASIC_MEMORY_PROJECT = "computer-assistant"
export const BASIC_MEMORY_CLI_VERSION = "0.23.2"
export const MAX_BASIC_MEMORY_STDOUT_BYTES = 64 * 1024
export const MAX_BASIC_MEMORY_STDERR_BYTES = 8 * 1024
export const BASIC_MEMORY_COMMAND_TIMEOUT_MS = 20_000
export const MAX_BASIC_MEMORY_STDIN_BYTES = 32 * 1024

export type BasicMemoryProfile = "native" | "wsl2"

export type BasicMemoryBinding = {
  project: typeof BASIC_MEMORY_PROJECT
  profile: BasicMemoryProfile
  version: typeof BASIC_MEMORY_CLI_VERSION
  notesRootDigest: string
  configDigest: string
  runnerDigest: string
}

export type BasicMemoryNote = {
  project: string
  profile: string
  title: string
  permalink: string
  content: string
  frontmatter: Record<string, unknown>
  filePath?: string
}

export type MirroredInstruction = {
  title: string
  folder: string
  permalink: string
  filePath: string
  content: string
  contentDigest: string
  frontmatter: Record<string, unknown>
}

export type BasicMemoryCLIRequest = {
  argv: readonly string[]
  stdin?: string
}

export type BasicMemoryCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type BasicMemoryCLIClient = {
  binding: () => Promise<BasicMemoryBinding>
  readNote: (permalink: string) => Promise<BasicMemoryNote | undefined>
  writeNote: (note: MirroredInstruction) => Promise<void>
}

export type MirrorResult = {
  contentID: string
  permalink: string
  state: "readback-verified"
  idempotent: boolean
}

export type BasicMemoryResolverOptions = {
  env?: NodeJS.ProcessEnv
  home?: string
  policyPath?: string
  spawnProcess?: typeof spawn
}

type ProjectPaths = {
  profile: BasicMemoryProfile
  home: string
  notesRoot: string
  configDirectory: string
  configFile: string
  uvCache?: string
  nativeRoot?: string
  profileRoot?: string
}

const SECRET_ENV_KEY = /(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE|API_KEY|AUTH)/i
const SAFE_ENV_KEYS = new Set([
  "HOME",
  "BASIC_MEMORY_HOME",
  "BASIC_MEMORY_CONFIG_DIR",
  "BASIC_MEMORY_DEFAULT_PROJECT",
  "BASIC_MEMORY_NO_PROMOS",
  "UV_CACHE_DIR",
  "PATH",
  "LANG",
])
const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../../../config/mcp-versions.json", import.meta.url))
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_POLICY_BYTES = 64 * 1024

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

function decodeUniqueJSON(source: string): unknown {
  let offset = 0

  const whitespace = (): void => {
    while (/\s/.test(source[offset] ?? "")) offset += 1
  }

  const stringToken = (): string => {
    const start = offset
    if (source[offset] !== '"') throw new Error("expected JSON string")
    offset += 1
    let escaped = false
    while (offset < source.length) {
      const character = source[offset++]!
      if (escaped) {
        escaped = false
        continue
      }
      if (character === "\\") {
        escaped = true
        continue
      }
      if (character === '"') return JSON.parse(source.slice(start, offset)) as string
    }
    throw new Error("unterminated JSON string")
  }

  const value = (): unknown => {
    whitespace()
    const character = source[offset]
    if (character === '"') return stringToken()
    if (character === "{") {
      offset += 1
      whitespace()
      const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      if (source[offset] === "}") {
        offset += 1
        return record
      }
      while (offset < source.length) {
        whitespace()
        const key = stringToken()
        if (Object.prototype.hasOwnProperty.call(record, key)) throw new Error("duplicate JSON object key")
        whitespace()
        if (source[offset++] !== ":") throw new Error("invalid JSON object separator")
        record[key] = value()
        whitespace()
        const separator = source[offset++]
        if (separator === "}") return record
        if (separator !== ",") throw new Error("invalid JSON object delimiter")
      }
      throw new Error("unterminated JSON object")
    }
    if (character === "[") {
      offset += 1
      whitespace()
      const items: unknown[] = []
      if (source[offset] === "]") {
        offset += 1
        return items
      }
      while (offset < source.length) {
        items.push(value())
        whitespace()
        const separator = source[offset++]
        if (separator === "]") return items
        if (separator !== ",") throw new Error("invalid JSON array delimiter")
      }
      throw new Error("unterminated JSON array")
    }
    const start = offset
    while (offset < source.length && !/[\s,}\]]/.test(source[offset]!)) offset += 1
    if (start === offset) throw new Error("invalid JSON value")
    const token = source.slice(start, offset)
    if (token === "true") return true
    if (token === "false") return false
    if (token === "null") return null
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return JSON.parse(token) as number
    throw new Error("invalid JSON token")
  }

  const parsed = value()
  whitespace()
  if (offset !== source.length) throw new Error("trailing JSON data")
  return parsed
}

async function assertSafePath(target: string, leaf: "directory" | "file", required = true): Promise<void> {
  if (!path.isAbsolute(target)) throw new Error("Basic Memory path must be absolute")
  const absolute = path.resolve(target)
  const parsed = path.parse(absolute)
  let current = parsed.root
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if (isErrorCode(error, "ENOENT") && !required) return
      throw new Error("Basic Memory profile path is unavailable")
    }
    if (metadata.isSymbolicLink()) throw new Error("symlinked Basic Memory profile path refused")
    if (index < components.length - 1 && !metadata.isDirectory()) throw new Error("Basic Memory profile ancestor is not a directory")
    if (index === components.length - 1 && leaf === "directory" && !metadata.isDirectory()) {
      throw new Error("Basic Memory profile root is not a directory")
    }
    if (index === components.length - 1 && leaf === "file" && !metadata.isFile()) {
      throw new Error("Basic Memory profile configuration is not a regular file")
    }
  }
}

async function readSafeFile(file: string, maximum: number): Promise<Buffer> {
  await assertSafePath(file, "file")
  const metadata = await lstat(file)
  if (metadata.size > maximum) throw new Error("Basic Memory profile file exceeds its byte bound")
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size > maximum) {
      throw new Error("Basic Memory profile file changed during read")
    }
    const bytes = await handle.readFile()
    if (bytes.length > maximum) throw new Error("Basic Memory profile file exceeds its byte bound")
    return bytes
  } finally {
    await handle.close()
  }
}

function parseProjectPaths(env: NodeJS.ProcessEnv, home: string): ProjectPaths {
  const profileValue = env.OPENCODE_MCP_PROFILE ?? "native"
  if (profileValue !== "native" && profileValue !== "wsl2") throw new Error("unsupported Basic Memory MCP profile")
  if ((env.BASIC_MEMORY_PROJECT ?? BASIC_MEMORY_PROJECT) !== BASIC_MEMORY_PROJECT) {
    throw new Error("Basic Memory project does not match the configured learning namespace")
  }
  if (!path.isAbsolute(home)) throw new Error("Basic Memory HOME must be absolute")
  const profile = profileValue as BasicMemoryProfile

  if (profile === "native") {
    const nativeRoot = env.OPENCODE_MCP_NATIVE_ROOT ?? path.join(home, ".local", "share", "opencode", "mcp")
    const notesRoot = env.BASIC_MEMORY_HOME ?? path.join(home, "Documents", "computer-assistant", "basic-memory")
    if (!path.isAbsolute(nativeRoot) || !path.isAbsolute(notesRoot)) throw new Error("native Basic Memory paths must be absolute")
    const configDirectory = path.join(nativeRoot, "basic-memory", "config")
    return {
      profile,
      home,
      notesRoot: path.resolve(notesRoot),
      configDirectory,
      configFile: path.join(configDirectory, "config.json"),
      nativeRoot: path.resolve(nativeRoot),
    }
  }

  const profileRootValue = env.OPENCODE_MCP_PROFILE_ROOT ?? env.OPENCODE_WSL2_PILOT_DIR ?? path.join(home, ".opencode-wsl2-pilot")
  if (!path.isAbsolute(profileRootValue)) throw new Error("WSL2 Basic Memory profile root must be absolute")
  const profileRoot = path.resolve(profileRootValue)
  const basicRoot = path.join(profileRoot, "mcp", "basic-memory")
  const basicHome = path.join(basicRoot, "home")
  return {
    profile,
    home: basicHome,
    notesRoot: path.join(basicRoot, "notes"),
    configDirectory: basicHome,
    configFile: path.join(basicHome, "config.json"),
    uvCache: path.join(profileRoot, "cache", "uv"),
    profileRoot,
  }
}

async function resolveTrustedUVX(env: NodeJS.ProcessEnv, home: string): Promise<string> {
  const override = env.OPENCODE_MCP_UVX_BIN
  const candidates = override
    ? [override]
    : [path.join(home, ".local", "bin", "uvx"), "/usr/local/bin/uvx", "/usr/bin/uvx"]
  const uid = typeof process.getuid === "function" ? process.getuid() : -1
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      const resolved = await realpath(candidate)
      const metadata = await stat(resolved)
      if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || (metadata.uid !== 0 && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0) {
        continue
      }
      return resolved
    } catch {
      if (override) throw new Error("configured uvx runner is not a trusted absolute executable")
    }
  }
  throw new Error("trusted uvx runner is unavailable")
}

function sanitizedEnvironment(input: {
  home: string
  notesRoot: string
  configDirectory: string
  executable: string
  uvCache?: string
}): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: input.home,
    BASIC_MEMORY_HOME: input.notesRoot,
    BASIC_MEMORY_CONFIG_DIR: input.configDirectory,
    BASIC_MEMORY_DEFAULT_PROJECT: BASIC_MEMORY_PROJECT,
    BASIC_MEMORY_NO_PROMOS: "1",
    PATH: `${path.dirname(input.executable)}:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8",
  }
  if (input.uvCache) environment.UV_CACHE_DIR = input.uvCache
  return environment
}

function validateSanitizedEnvironment(environment: Record<string, string>): void {
  const entries = Object.entries(environment)
  if (entries.length === 0 || entries.length > SAFE_ENV_KEYS.size) throw new Error("Basic Memory child environment is not bounded")
  let bytes = 0
  for (const [key, value] of entries) {
    if (!SAFE_ENV_KEYS.has(key) || SECRET_ENV_KEY.test(key)) throw new Error("Basic Memory child environment contains an unsupported variable")
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new Error("Basic Memory child environment value is invalid")
    bytes += Buffer.byteLength(`${key}=${value}`, "utf8")
  }
  if (bytes > 16 * 1024 || environment.BASIC_MEMORY_DEFAULT_PROJECT !== BASIC_MEMORY_PROJECT || environment.BASIC_MEMORY_NO_PROMOS !== "1") {
    throw new Error("Basic Memory child environment exceeds its safety contract")
  }
}

export async function runBoundedBasicMemoryProcess(
  executable: string,
  argv: readonly string[],
  environment: Record<string, string>,
  input: { stdin?: string; cwd: string; timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number },
  spawnProcess: typeof spawn = spawn,
): Promise<BasicMemoryCommandResult> {
  if (!path.isAbsolute(executable)) throw new Error("Basic Memory CLI executable must be absolute")
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 32 || argv.some((arg) => typeof arg !== "string" || arg.length > 32 * 1024 || arg.includes("\0"))) {
    throw new Error("Basic Memory CLI argv is invalid or oversized")
  }
  validateSanitizedEnvironment(environment)
  if (!path.isAbsolute(input.cwd)) throw new Error("Basic Memory CLI working directory must be absolute")
  const stdin = input.stdin ?? ""
  if (Buffer.byteLength(stdin, "utf8") > MAX_BASIC_MEMORY_STDIN_BYTES) throw new Error("Basic Memory CLI stdin exceeds its byte bound")
  const timeoutMs = input.timeoutMs ?? BASIC_MEMORY_COMMAND_TIMEOUT_MS
  const maxStdoutBytes = input.maxStdoutBytes ?? MAX_BASIC_MEMORY_STDOUT_BYTES
  const maxStderrBytes = input.maxStderrBytes ?? MAX_BASIC_MEMORY_STDERR_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1 || maxStdoutBytes > MAX_BASIC_MEMORY_STDOUT_BYTES ||
    !Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1 || maxStderrBytes > MAX_BASIC_MEMORY_STDERR_BYTES) {
    throw new Error("Basic Memory CLI process limits are invalid")
  }

  return await new Promise<BasicMemoryCommandResult>((resolve, reject) => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let overflow = false
    let settled = false
    let stdinError = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(executable, [...argv], {
        cwd: input.cwd,
        env: { ...environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch {
      reject(new Error("Basic Memory CLI could not be started"))
      return
    }

    const stop = (): void => {
      if (!child.killed) child.kill("SIGKILL")
    }
    timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stdout.length + bytes.length > maxStdoutBytes) {
        overflow = true
        stop()
        return
      }
      stdout = Buffer.concat([stdout, bytes])
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stderr.length + bytes.length > maxStderrBytes) {
        overflow = true
        stop()
        return
      }
      stderr = Buffer.concat([stderr, bytes])
    })
    child.stdin.on("error", () => { stdinError = true })
    child.once("error", () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(new Error("Basic Memory CLI process failed"))
    })
    child.once("close", (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (timedOut) {
        reject(new Error("Basic Memory CLI timed out"))
      } else if (overflow) {
        reject(new Error("Basic Memory CLI output exceeded its byte bound"))
      } else if (stdinError && exitCode === 0) {
        reject(new Error("Basic Memory CLI did not accept the bounded stdin payload"))
      } else if (exitCode === null) {
        reject(new Error("Basic Memory CLI exited without a status"))
      } else {
        resolve({ exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") })
      }
    })
    if (input.stdin === undefined) child.stdin.end()
    else child.stdin.end(stdin)
  })
}

export async function resolveBasicMemoryCLI(options: BasicMemoryResolverOptions = {}): Promise<{
  binding: BasicMemoryBinding
  executable: string
  baseArgs: string[]
  environment: Record<string, string>
  notesRoot: string
  configFile: string
  spawnProcess: typeof spawn
}> {
  const env = options.env ?? process.env
  const homeValue = options.home ?? env.HOME ?? homedir()
  if (!path.isAbsolute(homeValue)) throw new Error("Basic Memory HOME must be absolute")
  const home = path.resolve(homeValue)
  const paths = parseProjectPaths(env, home)
  await assertSafePath(paths.home, "directory")
  await assertSafePath(paths.notesRoot, "directory")
  await assertSafePath(paths.configDirectory, "directory")
  await assertSafePath(paths.configFile, "file")
  const configBytes = await readSafeFile(paths.configFile, MAX_CONFIG_BYTES)
  const config = decodeUniqueJSON(configBytes.toString("utf8"))
  if (!isRecord(config) || !isRecord(config.projects)) throw new Error("Basic Memory project configuration is invalid")
  const project = config.projects[BASIC_MEMORY_PROJECT]
  if (!isRecord(project) || typeof project.path !== "string" || !path.isAbsolute(project.path) ||
    path.resolve(project.path) !== path.resolve(paths.notesRoot) || project.mode !== "local" ||
    config.default_project !== BASIC_MEMORY_PROJECT) {
    throw new Error("Basic Memory project/profile does not match the exact configured local namespace")
  }
  await assertSafePath(project.path, "directory")

  const policyPath = options.policyPath ?? DEFAULT_POLICY_PATH
  const policyBytes = await readSafeFile(policyPath, MAX_POLICY_BYTES)
  const policy = decodeUniqueJSON(policyBytes.toString("utf8"))
  if (!isRecord(policy) || policy.schemaVersion !== 2 || policy.basicMemory !== BASIC_MEMORY_CLI_VERSION) {
    throw new Error("Basic Memory CLI version pin does not match the canonical wrapper policy")
  }
  const executable = await resolveTrustedUVX(env, home)
  const environment = sanitizedEnvironment({
    home: paths.home,
    notesRoot: paths.notesRoot,
    configDirectory: paths.configDirectory,
    executable,
    ...(paths.uvCache ? { uvCache: paths.uvCache } : {}),
  })
  validateSanitizedEnvironment(environment)
  const baseArgs = ["--offline", "--prerelease=allow", "--from", `basic-memory==${BASIC_MEMORY_CLI_VERSION}`, "basic-memory"]
  const binding: BasicMemoryBinding = {
    project: BASIC_MEMORY_PROJECT,
    profile: paths.profile,
    version: BASIC_MEMORY_CLI_VERSION,
    notesRootDigest: digest(path.resolve(paths.notesRoot)),
    configDigest: digest(configBytes),
    runnerDigest: digest(executable),
  }
  return {
    binding,
    executable,
    baseArgs,
    environment,
    notesRoot: paths.notesRoot,
    configFile: paths.configFile,
    spawnProcess: options.spawnProcess ?? spawn,
  }
}

function parseCLIJSON(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error("Basic Memory CLI returned empty JSON output")
  try {
    return decodeUniqueJSON(trimmed)
  } catch {
    throw new Error("Basic Memory CLI returned invalid JSON output")
  }
}

function unwrapResult(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (Object.prototype.hasOwnProperty.call(value, "result")) {
    const result = value.result
    if (typeof result === "string") {
      try {
        return decodeUniqueJSON(result)
      } catch {
        return result
      }
    }
    return result
  }
  return value
}

function parseReadNote(value: unknown, binding: BasicMemoryBinding): BasicMemoryNote {
  const result = unwrapResult(value)
  if (!isRecord(result) || typeof result.title !== "string" || typeof result.permalink !== "string" ||
    typeof result.content !== "string" || !isRecord(result.frontmatter)) {
    throw new Error("Basic Memory read-note response has an unsupported shape")
  }
  const note: BasicMemoryNote = {
    project: binding.project,
    profile: binding.profile,
    title: result.title,
    permalink: result.permalink,
    content: result.content,
    frontmatter: result.frontmatter,
  }
  if (typeof result.file_path === "string") note.filePath = result.file_path
  else if (typeof result.filePath === "string") note.filePath = result.filePath
  return note
}

function parseSearchResult(value: unknown): unknown[] {
  const result = unwrapResult(value)
  if (Array.isArray(result)) return result
  if (isRecord(result)) {
    if (Array.isArray(result.results)) return result.results
    if (Array.isArray(result.items)) return result.items
  }
  throw new Error("Basic Memory search-notes response has an unsupported shape")
}

function assertSafeBasicMemoryArgs(args: readonly string[], stdin: string | undefined): void {
  if (args.length === 8 && args[0] === "tool" && args[1] === "read-note" &&
    new RegExp(`^${BASIC_MEMORY_PROJECT}/learnings/[a-z0-9-]{1,64}/[0-9a-f]{64}$`).test(args[2] ?? "") &&
    args[3] === "--include-frontmatter" && args[4] === "--project" && args[5] === BASIC_MEMORY_PROJECT &&
    args[6] === "--local" && args[7] === "--json" && stdin === undefined) return
  if (args.length === 10 && args[0] === "tool" && args[1] === "search-notes" && args[2] === "--permalink" &&
    new RegExp(`^${BASIC_MEMORY_PROJECT}/learnings/[a-z0-9-]{1,64}/[0-9a-f]{64}$`).test(args[3] ?? "") &&
    args[4] === "--project" && args[5] === BASIC_MEMORY_PROJECT && args[6] === "--local" && args[7] === "--json" &&
    args[8] === "--page-size" && args[9] === "2" && stdin === undefined) return
  if (args.length === 9 && args[0] === "tool" && args[1] === "write-note" && args[2] === "--title" &&
    /^[0-9a-f]{64}$/.test(args[3] ?? "") && args[4] === "--folder" && /^learnings\/[a-z0-9-]{1,64}$/.test(args[5] ?? "") &&
    args[6] === "--project" && args[7] === BASIC_MEMORY_PROJECT && args[8] === "--local" && stdin !== undefined) return
  throw new Error("Basic Memory CLI request is outside the pinned read/write contract")
}

function exactFrontmatter(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length || !leftKeys.every((key, index) => key === rightKeys[index])) return false
  return leftKeys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]))
}

export function buildMirroredInstruction(plan: CanonicalInstructionPlan): MirroredInstruction {
  validateInstructionPlan(plan)
  const folder = plan.repoNamespace.slice(0, -1)
  const title = plan.contentID
  const permalink = `${BASIC_MEMORY_PROJECT}/${folder}/${title}`
  const filePath = `${folder}/${title}.md`
  const body = [
    `# ${plan.title}`,
    "",
    plan.instruction,
    "",
    `Repository authority: ${plan.targetPath} (SHA-256 ${plan.contentDigest}).`,
    "This Basic Memory note is a subordinate mirror; repository policy and independent operator decisions remain authoritative.",
    "",
  ].join("\n")
  const frontmatter: Record<string, unknown> = {
    schema: "open-rig-basic-memory-learning/v1",
    type: "learned-instruction",
    title,
    content_id: plan.contentID,
    repo_namespace: plan.repoNamespace,
    repo_identity_sha256: plan.repoIdentityDigest,
    repo_content_sha256: plan.contentDigest,
    body_sha256: digest(body),
    repo_file: plan.targetPath,
    authority: "subordinate",
    tags: ["repo-learning", "subordinate"],
  }
  const content = [
    "---",
    `schema: ${frontmatter.schema}`,
    `type: ${frontmatter.type}`,
    `title: ${JSON.stringify(title)}`,
    `content_id: ${plan.contentID}`,
    `repo_namespace: ${plan.repoNamespace}`,
    `repo_identity_sha256: ${plan.repoIdentityDigest}`,
    `repo_content_sha256: ${plan.contentDigest}`,
    `body_sha256: ${frontmatter.body_sha256 as string}`,
    `repo_file: ${JSON.stringify(plan.targetPath)}`,
    "authority: subordinate",
    "tags:",
    "  - repo-learning",
    "  - subordinate",
    "---",
    "",
    body,
  ].join("\n")
  return {
    title,
    folder,
    permalink,
    filePath,
    content,
    contentDigest: digest(content),
    frontmatter,
  }
}

function validateReadback(note: BasicMemoryNote | undefined, mirror: MirroredInstruction, binding: BasicMemoryBinding): boolean {
  return note !== undefined && note.project === binding.project && note.profile === binding.profile &&
    note.title === mirror.title && note.permalink === mirror.permalink && note.content === mirror.content &&
    exactFrontmatter(note.frontmatter, mirror.frontmatter) &&
    (note.filePath === undefined || note.filePath === mirror.filePath)
}

export async function mirrorApprovedInstruction(input: {
  repositoryRoot: string
  plan: CanonicalInstructionPlan
  expectedBinding: BasicMemoryBinding
  client: BasicMemoryCLIClient
  options?: RepositoryWriterOptions
}): Promise<MirrorResult> {
  const { repositoryRoot, plan, expectedBinding, client, options = {} } = input
  validateInstructionPlan(plan)
  const recovered = await recoverApprovedInstruction(repositoryRoot, plan.contentID, options)
  if (recovered.plan.contentDigest !== plan.contentDigest) throw new Error("durable approval does not match the requested mirror")
  if (recovered.state === "readback-verified") {
    return { contentID: plan.contentID, permalink: buildMirroredInstruction(plan).permalink, state: "readback-verified", idempotent: true }
  }

  const mirror = buildMirroredInstruction(plan)
  await markInstructionMirrorPending(repositoryRoot, plan, options)
  const binding = await client.binding()
  if (binding.project !== BASIC_MEMORY_PROJECT || expectedBinding.project !== BASIC_MEMORY_PROJECT ||
    binding.project !== expectedBinding.project || binding.version !== BASIC_MEMORY_CLI_VERSION ||
    expectedBinding.version !== BASIC_MEMORY_CLI_VERSION) {
    await quarantineInstruction(repositoryRoot, plan, "memory-project-mismatch", options)
    throw new Error("Basic Memory binding does not match the exact configured project; quarantined")
  }
  if (binding.profile !== expectedBinding.profile || (binding.profile !== "native" && binding.profile !== "wsl2")) {
    await quarantineInstruction(repositoryRoot, plan, "memory-profile-mismatch", options)
    throw new Error("Basic Memory profile does not match the selected profile; quarantined")
  }
  if (binding.configDigest !== expectedBinding.configDigest || binding.notesRootDigest !== expectedBinding.notesRootDigest ||
    binding.runnerDigest !== expectedBinding.runnerDigest) {
    await quarantineInstruction(repositoryRoot, plan, "memory-project-mismatch", options)
    throw new Error("Basic Memory profile binding changed after approval; quarantined")
  }

  const existing = await client.readNote(mirror.permalink)
  if (existing !== undefined && !validateReadback(existing, mirror, binding)) {
    const reason = existing.project !== binding.project
      ? "memory-project-mismatch"
      : existing.profile !== binding.profile
        ? "memory-profile-mismatch"
        : "memory-note-conflict"
    await quarantineInstruction(repositoryRoot, plan, reason, options)
    throw new Error("an existing Basic Memory note has a different identity or content; quarantined")
  }

  let idempotent = existing !== undefined
  if (existing === undefined) {
    const beforeWrite = await client.readNote(mirror.permalink)
    if (beforeWrite !== undefined && !validateReadback(beforeWrite, mirror, binding)) {
      await quarantineInstruction(repositoryRoot, plan, "memory-note-conflict", options)
      throw new Error("Basic Memory note appeared with conflicting content before write; quarantined")
    }
    if (beforeWrite === undefined) await client.writeNote(mirror)
    else idempotent = true
  }

  const readback = existing ?? await client.readNote(mirror.permalink)
  if (!validateReadback(readback, mirror, binding)) {
    await quarantineInstruction(repositoryRoot, plan, "readback-mismatch", options)
    throw new Error("Basic Memory readback did not match the approved repository instruction; quarantined")
  }
  await markInstructionReadbackVerified(repositoryRoot, plan, options)
  return {
    contentID: plan.contentID,
    permalink: mirror.permalink,
    state: "readback-verified",
    idempotent,
  }
}

export async function createPinnedBasicMemoryCLI(options: BasicMemoryResolverOptions = {}): Promise<{
  binding: () => Promise<BasicMemoryBinding>
  readNote: (permalink: string) => Promise<BasicMemoryNote | undefined>
  writeNote: (note: MirroredInstruction) => Promise<void>
}> {
  const resolved = await resolveBasicMemoryCLI(options)
  const invoke = async (args: readonly string[], stdin?: string): Promise<BasicMemoryCommandResult> => {
    assertSafeBasicMemoryArgs(args, stdin)
    return await runBoundedBasicMemoryProcess(
      resolved.executable,
      [...resolved.baseArgs, ...args],
      resolved.environment,
      {
        ...(stdin === undefined ? {} : { stdin }),
        cwd: resolved.notesRoot,
      },
      resolved.spawnProcess,
    )
  }

  const run = async (args: readonly string[], stdin?: string): Promise<BasicMemoryCommandResult> => {
    const result = await invoke(args, stdin)
    if (result.exitCode !== 0) throw new Error(`Basic Memory CLI exited with status ${result.exitCode}`)
    return result
  }

  const verifyVersion = await runBoundedBasicMemoryProcess(
    resolved.executable,
    [...resolved.baseArgs, "--version"],
    resolved.environment,
    { cwd: resolved.notesRoot },
    resolved.spawnProcess,
  )
  const versionOutput = `${verifyVersion.stdout}\n${verifyVersion.stderr}`
  if (verifyVersion.exitCode !== 0 || !versionOutput.includes(BASIC_MEMORY_CLI_VERSION)) {
    throw new Error("Basic Memory CLI does not match the pinned version")
  }

  const currentBinding = async (): Promise<BasicMemoryBinding> => {
    const current = await resolveBasicMemoryCLI(options)
    if (JSON.stringify(current.binding) !== JSON.stringify(resolved.binding)) {
      throw new Error("Basic Memory project/profile binding changed after CLI resolution")
    }
    return { ...resolved.binding }
  }

  const readNote = async (permalink: string): Promise<BasicMemoryNote | undefined> => {
    if (typeof permalink !== "string" || !new RegExp(`^${BASIC_MEMORY_PROJECT}/learnings/[a-z0-9-]{1,64}/[0-9a-f]{64}$`).test(permalink)) {
      throw new Error("Basic Memory permalink is outside the repository-learning namespace")
    }
    const binding = await currentBinding()
    const searchResult = await run([
      "tool", "search-notes", "--permalink", permalink, "--project", BASIC_MEMORY_PROJECT, "--local", "--json", "--page-size", "2",
    ])
    const matches = parseSearchResult(parseCLIJSON(searchResult.stdout))
    if (matches.length === 0) return undefined
    if (matches.length !== 1 || !isRecord(matches[0]) || matches[0].permalink !== permalink) {
      throw new Error("Basic Memory exact-permalink search returned an ambiguous result")
    }
    const readResult = await invoke([
      "tool", "read-note", permalink, "--include-frontmatter", "--project", BASIC_MEMORY_PROJECT, "--local", "--json",
    ])
    if (readResult.exitCode !== 0) throw new Error("Basic Memory read-note failed for an indexed exact permalink")
    return parseReadNote(parseCLIJSON(readResult.stdout), binding)
  }

  const writeNote = async (note: MirroredInstruction): Promise<void> => {
    await currentBinding()
    if (!/^[0-9a-f]{64}$/.test(note.title) || !/^learnings\/[a-z0-9-]{1,64}$/.test(note.folder) ||
      note.permalink !== `${BASIC_MEMORY_PROJECT}/${note.folder}/${note.title}` ||
      note.filePath !== `${note.folder}/${note.title}.md` || digest(note.content) !== note.contentDigest ||
      note.frontmatter.content_id !== note.title || note.frontmatter.title !== note.title ||
      note.frontmatter.repo_namespace !== `${note.folder}/` || note.frontmatter.authority !== "subordinate") {
      throw new Error("Basic Memory write-note target is not canonical")
    }
    if (await readNote(note.permalink)) throw new Error("Basic Memory write-note refuses an existing permalink")
    await run([
      "tool", "write-note", "--title", note.title, "--folder", note.folder, "--project", BASIC_MEMORY_PROJECT, "--local",
    ], note.content)
  }

  return { binding: currentBinding, readNote, writeNote }
}
