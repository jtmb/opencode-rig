import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TOKEN_TTL_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_UNTRACKED_ENTRIES = 4096
const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_EVIDENCE_OUTPUT = 4_000
const MAX_SHELL_COMMAND_BYTES = 16 * 1024
const MAX_SHELL_TOKENS = 256
const MAX_SHELL_SEGMENTS = 64
const MAX_SPLIT_STRING_BYTES = 4 * 1024
const MAX_SPLIT_RECURSION = 3
const MAX_TOKEN_RECORDS = 256
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "fish", "cmd", "powershell", "pwsh"])

export function isDeniedShellGitMutation(command: string): boolean {
  if (typeof command !== "string" || Buffer.byteLength(command, "utf8") > MAX_SHELL_COMMAND_BYTES) return /\bgit\b[\s\S]*\b(?:commit|push)\b/i.test(String(command))
  const lexed = lexShellCommand(command)
  if (!lexed.ok) return looksLikeDirectGitMutation(command)
  if (lexed.segments.length > MAX_SHELL_SEGMENTS) return looksLikeDirectGitMutation(command)
  return lexed.segments.some((tokens) => isDirectGitMutation(tokens, 0))
}

type ShellLexResult = { ok: true; segments: string[][] } | { ok: false }

function lexShellCommand(command: string): ShellLexResult {
  const segments: string[][] = []
  let tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | "" = ""
  let escaped = false
  const flushToken = () => { if (current) { tokens.push(current); current = "" } }
  const flushSegment = () => { flushToken(); if (tokens.length) segments.push(tokens); tokens = [] }
  for (const char of command) {
    if (escaped) { current += char; escaped = false; continue }
    if (quote === "'") { if (char === "'") quote = ""; else current += char; continue }
    if (quote === '"') {
      if (char === '"') quote = ""
      else if (char === "\\") escaped = true
      else current += char
      continue
    }
    if (char === "\\") { escaped = true; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (/[;&|()\n]/.test(char)) { flushSegment(); continue }
    if (/\s/.test(char)) { flushToken(); continue }
    current += char
    if (tokens.length + 1 > MAX_SHELL_TOKENS) return { ok: false }
  }
  if (quote || escaped) return { ok: false }
  flushSegment()
  return { ok: true, segments }
}

const GIT_REQUIRED_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path"])
const GIT_NO_VALUE_OPTIONS = new Set(["--paginate", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch"])
const ENV_REQUIRED_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "--argv0", "--block-signal", "--default-signal", "--ignore-signal"])
const ENV_NO_VALUE_OPTIONS = new Set(["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"])

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function isDirectGitMutation(tokens: string[], depth: number): boolean {
  let index = 0
  while (index < tokens.length && isAssignment(tokens[index]!)) index += 1
  while (index < tokens.length) {
    const wrapper = basename(tokens[index]!)
    if (SHELLS.has(wrapper)) return inspectShellInterpreter(tokens, index, depth)
    if (["powershell", "pwsh", "cmd"].includes(wrapper)) return inspectShellInterpreter(tokens, index, depth)
    if (wrapper === "command" || wrapper === "builtin") {
      index += 1
      while (index < tokens.length && (tokens[index] === "-p" || tokens[index] === "-v" || tokens[index] === "-V" || tokens[index] === "--verbose")) index += 1
      if (tokens[index] === "--") index += 1
      else if (tokens[index]?.startsWith("-")) return remainingLooksLikeGitMutation(tokens, index)
      continue
    }
    if (wrapper === "exec") {
      index += 1
      while (index < tokens.length) {
        const option = tokens[index]!
        if (option === "-c" || option === "-l") index += 1
        else if (option === "-a") index += 2
        else if (option.startsWith("-a") && option.length > 2) index += 1
        else if (option === "--") { index += 1; break }
        else if (option.startsWith("-")) return remainingLooksLikeGitMutation(tokens, index)
        else break
      }
      continue
    }
    if (wrapper === "nohup") {
      index += 1
      if (tokens[index] === "--") index += 1
      else if (tokens[index]?.startsWith("-")) return remainingLooksLikeGitMutation(tokens, index)
      continue
    }
    if (wrapper === "nice") {
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith("-")) {
        const option = tokens[index]!
        if (option === "-n" || option === "--adjustment") index += 2
        else if (option.startsWith("-n") || option.startsWith("--adjustment=") || /^-[0-9]+$/.test(option)) index += 1
        else if (option === "--") { index += 1; break }
        else return remainingLooksLikeGitMutation(tokens, index)
      }
      continue
    }
    if (wrapper === "timeout") {
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith("-")) {
        const option = tokens[index]!
        if (["-k", "--kill-after", "-s", "--signal"].includes(option)) index += 2
        else if (option.startsWith("--kill-after=") || option.startsWith("--signal=") || /^-[ks].+/.test(option)) index += 1
        else if (["--preserve-status", "--foreground", "--verbose"].includes(option)) index += 1
        else if (option === "--") { index += 1; break }
        else return remainingLooksLikeGitMutation(tokens, index)
      }
      if (index < tokens.length) index += 1
      continue
    }
    if (wrapper !== "env") break
    index += 1
    while (index < tokens.length) {
      const option = tokens[index]!
      if (isAssignment(option)) { index += 1; continue }
      if (option === "--") { index += 1; break }
      const name = option.includes("=") ? option.slice(0, option.indexOf("=")) : option
      const splitAttached = option.startsWith("-S") && option.length > 2
        ? option.slice(2)
        : option.startsWith("--split-string=")
          ? option.slice("--split-string=".length)
          : undefined
      if (option === "-S" || option === "--split-string" || splitAttached !== undefined) {
        const splitValue = splitAttached ?? tokens[index + 1]
        if (splitValue === undefined || splitStringHasMutation(splitValue, depth)) return true
        index += splitAttached === undefined ? 2 : 1
        continue
      }
      if (ENV_NO_VALUE_OPTIONS.has(name)) { index += 1; continue }
      if (ENV_REQUIRED_VALUE_OPTIONS.has(name)) {
        if (option === name) index += 2
        else index += 1
        continue
      }
      if (["-u", "-C", "-S"].some((short) => option.startsWith(short) && option.length > short.length)) { index += 1; continue }
      if (option.startsWith("-") && option.length > 1) return remainingLooksLikeGitMutation(tokens, index)
      break
    }
  }
  const executable = tokens[index]
  if (!executable || !/(?:^|\/)git$/i.test(executable)) return false
  index += 1
  while (index < tokens.length) {
    const option = tokens[index]!
    if (option === "--") { index += 1; break }
    const equals = option.indexOf("=")
    const name = equals >= 0 ? option.slice(0, equals) : option
    if (GIT_NO_VALUE_OPTIONS.has(name)) { index += 1; continue }
    if (GIT_REQUIRED_VALUE_OPTIONS.has(name)) {
      if (equals < 0) index += 2
      else index += 1
      continue
    }
    const attached = [...GIT_REQUIRED_VALUE_OPTIONS].some((required) => required.length === 2 && option.startsWith(required) && option.length > required.length)
    if (attached) { index += 1; continue }
    if (option.startsWith("-") || option.startsWith("+")) return tokens.slice(index + 1).some((token) => token === "commit" || token === "push")
    return option === "commit" || option === "push"
  }
  return false
}

function remainingLooksLikeGitMutation(tokens: readonly string[], start: number): boolean {
  for (let index = start; index < tokens.length; index += 1) {
    if (!/(?:^|\/)git$/i.test(tokens[index]!)) continue
    return tokens.slice(index + 1).some((token) => token === "commit" || token === "push")
  }
  return false
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1).toLowerCase()
}

function inspectShellInterpreter(tokens: string[], index: number, depth: number): boolean {
  const executable = basename(tokens[index]!)
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const option = tokens[cursor]!
    if (["cmd"].includes(executable) && ["/c", "/k"].includes(option.toLowerCase())) {
      return tokens[cursor + 1] === undefined || splitStringHasMutation(tokens[cursor + 1]!, depth)
    }
    if (["powershell", "pwsh"].includes(executable) && ["-c", "-command"].includes(option.toLowerCase())) {
      return tokens[cursor + 1] === undefined || splitStringHasMutation(tokens[cursor + 1]!, depth)
    }
    if (["powershell", "pwsh"].includes(executable) && option.toLowerCase() === "-encodedcommand") return true
    if (["sh", "bash", "dash", "zsh", "fish"].includes(executable)) {
      if (option === "-c" || option === "-lc" || option === "-cl" || /^-[^-]*c/.test(option)) {
        const attached = option.replace(/^-.*?c/, "")
        const value = attached || tokens[cursor + 1]
        return value === undefined || splitStringHasMutation(value, depth)
      }
    }
  }
  return false
}

function splitStringHasMutation(value: string, depth: number): boolean {
  if (depth >= MAX_SPLIT_RECURSION || Buffer.byteLength(value, "utf8") > MAX_SPLIT_STRING_BYTES) return looksLikeDirectGitMutation(value)
  if (/[`$]/.test(value)) return true
  const lexed = lexShellCommand(value)
  if (!lexed.ok || lexed.segments.length > MAX_SHELL_SEGMENTS) return looksLikeDirectGitMutation(value)
  return lexed.segments.some((tokens) => isDirectGitMutation(tokens, depth + 1))
}

function looksLikeDirectGitMutation(command: string): boolean {
  return /(?:^|[;&|()\n]\s*)(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|command|env|--?\S+)\s+)*["']?(?:[^\s;&|()/'"]+\/)?git["']?[\s\S]*\b(?:commit|push)\b/i.test(command)
}

/** Return a display-only remote URL; callers must retain the raw URL for identity checks. */
export function redactRemoteUrl(raw: string): string {
  let safe = raw.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@]+@/g, "$1[redacted]@")
  safe = safe.replace(/(^|\s)[^\s/@?#]+@(?=(?:\[[^\]]+\]|[^:/\s]+):)/g, "$1[redacted]@")
  safe = safe.replace(/[?#].*$/, "")
  return safe
}

export function validateRemoteName(remote: unknown): string {
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(remote) || remote.includes("..") || remote.includes("@{") || remote.startsWith("/") || remote.endsWith("/")) fail("remote must be an explicit portable name without options, separators, or control forms")
  return remote
}

export type GateKind = "qa" | "documentation"
export type GateAction = "preview" | "apply"
export type GateProgressPhase = "checking" | "running" | "verifying" | "complete"
export type GateCommand = { file: string; args: string[] }
export type GateProgressUpdate = {
  phase: GateProgressPhase
  kind: GateKind
  action: GateAction
  command?: GateCommand
}
export type GateProgressReporter = (update: GateProgressUpdate) => void | Promise<void>

export type GateOptions = {
  qaCommand?: unknown
  documentationCommand?: unknown
  requiredPaths?: unknown
  timeoutMs?: unknown
  tokenTtlMs?: unknown
}

type Command = GateCommand
type RepoState = {
  root: string
  head: string
  branch: string
  branchRef: string
  upstream: string
  remotes: string
  indexTree: string
  staged: string
  stagedPaths: string[]
  worktree: string
  untracked: string
  untrackedDigest: string
  status: string
  config: string
  tree: string
  operation: string
  fingerprint: string
}
type PublicRepoState = {
  root: string
  head: string
  branch: string
  upstream: string
  remotes: string
  stagedPaths: string[]
  stagedScope: string
  stagedSha256: string
  indexTreeSha256: string
  worktreeSha256: string
  untrackedSha256: string
  statusSha256: string
  operation: string
  fingerprint: string
}
type Evidence = { kind: GateKind; state: PublicRepoState; command: Command; output: string; outputSha256: string }
type TokenRecord =
  | { kind: "gate"; phase: "preview" | "evidence"; expires: number; used: boolean; session: string; agent: string; intent: string; evidence: Evidence }
  | { kind: "commit"; expires: number; used: boolean; session: string; agent: string; root: string; state: RepoState; message: string; evidence: Evidence[] }
  | { kind: "push"; expires: number; used: boolean; session: string; agent: string; root: string; state: RepoState; remote: string; ref: string; url: string; advertised: string; remoteSha: string; outgoing: string[] }

export type GitRunner = (file: string, args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>

function fail(message: string): never {
  throw new Error(message)
}

export function validateGateCommand(value: unknown, label = "gateCommand"): Command {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string" || part.length === 0)) {
    fail(`${label} must be a non-empty argument array; no command is invented by default`)
  }
  const [file, ...args] = value as string[]
  if (SHELLS.has(file.split("/").pop()!.toLowerCase()) || args.some((arg) => arg === "-c" || arg === "/c" || arg === "-Command")) {
    fail(`${label} must invoke a program directly; shell interpreters are refused`)
  }
  return { file, args }
}

function timeoutFrom(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 900_000) {
    fail("timeoutMs must be an integer from 1000 through 900000")
  }
  return value
}

function tokenTtlFrom(value: unknown): number {
  if (value === undefined) return TOKEN_TTL_MS
  if (typeof value !== "number" || !Number.isInteger(value) || value < 30_000 || value > 15 * 60_000) fail("tokenTtlMs must be an integer from 30000 through 900000")
  return value
}

export function normalizeRequiredPaths(value: unknown): string[] {
  if (value === undefined) return ["HANDOFF.md", "ROADMAP.md"]
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((segment) => segment === ".." || segment === ""))) {
    fail("requiredPaths must be repository-relative non-empty paths without '..'")
  }
  if (value.length === 0) fail("requiredPaths must contain at least one path")
  return [...new Set((value as string[]).map((path) => path.split("/").filter((segment) => segment !== ".").join("/")))].sort()
}

function configuredCommand(options: GateOptions, kind: GateKind): Command {
  return validateGateCommand(kind === "qa" ? options.qaCommand : options.documentationCommand, `${kind}Command`)
}

function progressCommand(command: Command): GateCommand | undefined {
  const sensitive = /api[_-]?key|authorization|bearer|credential|password|passwd|private[_-]?key|secret|token/i
  const values = [command.file, ...command.args]
  if (values.some((value) => sensitive.test(value) || /:\/\/[^/\s@]+(?::[^/\s@]*)?@/.test(value))) return undefined
  if (command.args.some((arg) => /^(?:-c|--command|--eval|--execute|-e|\/c|\/k)(?:=|$)/i.test(arg))) return undefined
  return { file: command.file, args: [...command.args] }
}

export async function boundedExec(file: string, args: string[], cwd: string, timeout: number, extraEnv: Record<string, string> = {}, encoding: BufferEncoding = "utf8", maxOutputBytes = MAX_OUTPUT_BYTES): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, shell: false, detached: true, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let overflow = false
    let settled = false
    let timedOut = false
    let graceTimer: NodeJS.Timeout | undefined
    const terminateTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch { /* already exited */ }
    }
    const terminateAndReap = () => {
      terminateTree("SIGTERM")
      graceTimer = setTimeout(() => {
        if (!settled) terminateTree("SIGKILL")
      }, 100)
    }
    let totalBytes = 0
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (overflow) return
      totalBytes += chunk.length
      if (totalBytes > maxOutputBytes) {
        overflow = true
        terminateAndReap()
        return
      }
      if (target === "stdout") stdout += chunk.toString(encoding)
      else stderr += chunk.toString(encoding)
    }
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk))
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      terminateTree("SIGTERM")
      if (!graceTimer) graceTimer = setTimeout(() => {
        if (!settled) terminateTree("SIGKILL")
      }, 100)
    }, timeout)
    const finish = (error?: Error, output?: { stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (error) reject(error)
      else resolve(output!)
    }
    child.once("error", (error) => finish(error))
    child.once("close", (code, signal) => {
      if (timedOut) finish(new Error(`bounded process timed out after ${timeout}ms`))
      else if (overflow) finish(new Error(`bounded process output exceeded ${maxOutputBytes} bytes`))
      else if (code !== 0) finish(new Error(`bounded process exited ${code ?? signal}: ${stderr.trim()}`))
      else finish(undefined, { stdout, stderr })
    })
  })
}

async function defaultRunner(file: string, args: string[], cwd: string) {
  return boundedExec(file, args, cwd, DEFAULT_TIMEOUT_MS)
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function token(): string {
  return randomBytes(24).toString("base64url")
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseStrictJson(text: string): unknown {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { fail("invalid repository gate configuration JSON") }
  const whitespace = (index: number) => { while (index < text.length && /\s/.test(text[index]!)) index += 1; return index }
  const stringEnd = (start: number): number => {
    let escaped = false
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index]!
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') return index + 1
    }
    fail("invalid repository gate configuration JSON")
  }
  const valueEnd = (start: number): number => {
    let index = whitespace(start)
    const opening = text[index]
    if (opening === '"') return stringEnd(index)
    if (opening === "{") {
      index = whitespace(index + 1)
      const keys = new Set<string>()
      if (text[index] === "}") return index + 1
      while (index < text.length) {
        if (text[index] !== '"') fail("repository gate configuration object key must be a string")
        const end = stringEnd(index)
        const key = JSON.parse(text.slice(index, end)) as string
        if (keys.has(key)) fail(`duplicate repository gate configuration key: ${key}`)
        keys.add(key)
        index = whitespace(end)
        if (text[index] !== ":") fail("invalid repository gate configuration object")
        index = whitespace(valueEnd(index + 1))
        if (text[index] === "}") return index + 1
        if (text[index] !== ",") fail("invalid repository gate configuration object")
        index = whitespace(index + 1)
      }
      fail("invalid repository gate configuration object")
    }
    if (opening === "[") {
      index = whitespace(index + 1)
      if (text[index] === "]") return index + 1
      while (index < text.length) {
        index = whitespace(valueEnd(index))
        if (text[index] === "]") return index + 1
        if (text[index] !== ",") fail("invalid repository gate configuration array")
        index = whitespace(index + 1)
      }
      fail("invalid repository gate configuration array")
    }
    const end = text.slice(index).search(/[\s,}\]]/)
    const primitiveEnd = end < 0 ? text.length : index + end
    if (primitiveEnd === index) fail("invalid repository gate configuration value")
    try { JSON.parse(text.slice(index, primitiveEnd)) } catch { fail("invalid repository gate configuration value") }
    return primitiveEnd
  }
  if (whitespace(valueEnd(0)) !== text.length) fail("invalid repository gate configuration trailing content")
  return parsed
}

export function createGitGateManager(rawOptions: GateOptions = {}, runner: GitRunner = defaultRunner) {
  const options = rawOptions
  const timeout = timeoutFrom(options.timeoutMs)
  const tokens = new Map<string, TokenRecord>()

  function storeToken(key: string, record: TokenRecord): void {
    const now = Date.now()
    for (const [existingKey, existing] of tokens) {
      if (existing.used || existing.expires < now) tokens.delete(existingKey)
    }
    if (tokens.size >= MAX_TOKEN_RECORDS) fail("gate token capacity is full; wait for tokens to expire or be consumed")
    tokens.set(key, record)
  }

  const run = async (file: string, args: string[], cwd: string) => {
    if (runner === defaultRunner) return boundedExec(file, args, cwd, timeout, file === "git" ? { GIT_OPTIONAL_LOCKS: "0" } : {}, file === "git" ? "latin1" : "utf8", file === "git" ? MAX_GIT_OUTPUT_BYTES : MAX_OUTPUT_BYTES)
    return runner(file, args, cwd)
  }

  async function rootOf(repo: string): Promise<string> {
    if (typeof repo !== "string" || !repo.startsWith("/")) fail("repo must be an absolute repository path")
    const requested = await realpath(repo).catch(() => fail("repo does not exist or is not accessible"))
    const result = await run("git", ["rev-parse", "--show-toplevel"], requested).catch(() => fail("repo is not a Git worktree"))
    const root = await realpath(result.stdout.trim()).catch(() => fail("Git returned an invalid repository root"))
    if (root !== requested) fail("repo must be the repository root, not a subdirectory")
    return root
  }

  async function git(root: string, args: string[]): Promise<string> {
    return (await run("git", args, root)).stdout.trim()
  }

  async function repositoryOptions(root: string): Promise<GateOptions> {
    const path = `${root}/.opencode/rig-gates.json`
    const text = await readFile(path, "utf8").catch(() => fail(`missing repository gate configuration: ${path}`))
    const local = parseStrictJson(text)
    if (!local || typeof local !== "object" || Array.isArray(local)) fail("repository gate configuration must be a JSON object")
    const unsupported = Object.keys(local).filter((key) => !["qaCommand", "documentationCommand", "requiredPaths", "timeoutMs", "tokenTtlMs"].includes(key))
    if (unsupported.length) fail(`unsupported repository gate configuration keys: ${unsupported.join(", ")}`)
    const merged = { ...options, ...(local as GateOptions) }
    validateGateCommand(merged.qaCommand, "qaCommand")
    validateGateCommand(merged.documentationCommand, "documentationCommand")
    normalizeRequiredPaths(merged.requiredPaths)
    timeoutFrom(merged.timeoutMs)
    tokenTtlFrom(merged.tokenTtlMs)
    return merged
  }

  async function hashUntracked(root: string, rawPaths: string): Promise<string> {
    const paths = rawPaths.split("\0").filter(Boolean).sort()
    if (paths.length > MAX_UNTRACKED_ENTRIES) fail("untracked entry cap exceeded; refusing gate")
    let total = 0
    const hashes: string[] = []
    for (const relative of paths) {
      if (relative.includes("\0") || relative.startsWith("/") || relative.split("/").includes("..")) fail("invalid untracked path")
      const absolute = `${root}/${relative}`
      const before = await lstat(absolute).catch(() => fail(`untracked path disappeared: ${relative}`))
      let representation: string
      if (before.isFile()) {
        total += before.size
        if (total > MAX_UNTRACKED_BYTES) fail("untracked byte cap exceeded; refusing gate")
        const bytes = await readFile(absolute)
        const after = await lstat(absolute).catch(() => fail(`untracked path disappeared: ${relative}`))
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail(`untracked path changed while hashing: ${relative}`)
        representation = `file\0${Buffer.from(bytes).toString("base64")}`
      } else if (before.isSymbolicLink()) {
        const target = await readlink(absolute)
        const after = await lstat(absolute).catch(() => fail(`untracked path disappeared: ${relative}`))
        if (after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail(`untracked symlink changed while hashing: ${relative}`)
        representation = `symlink\0${target}`
      } else {
        fail(`unsupported untracked entry type: ${relative}`)
      }
      hashes.push(`${relative}\0${representation}`)
    }
    return digest(hashes.join("\0"))
  }

  async function operationState(root: string): Promise<string> {
    const names = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "BISECT_TERMS", "rebase-merge", "rebase-apply"]
    const found: string[] = []
    for (const name of names) {
      const path = await git(root, ["rev-parse", "--git-path", name]).catch(() => fail("cannot inspect Git operation state"))
      const absolute = path.startsWith("/") ? path : `${root}/${path}`
      if (await lstat(absolute).then(() => true).catch(() => false)) found.push(name)
    }
    return found.join(",")
  }

  async function state(repo: string, stateOptions: GateOptions = options): Promise<RepoState> {
    const root = await rootOf(repo)
    const [head, branch, branchRef, upstream, remotes, indexTree, tree, staged, stagedNames, worktree, untracked] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => fail("repository must have a committed HEAD")),
      git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
      git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
      git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => ""),
      git(root, ["remote", "-v"]),
      git(root, ["ls-files", "--stage", "-z"]),
      git(root, ["write-tree"]).catch(() => fail("index contains unresolved entries; refusing gate")),
      git(root, ["diff", "--cached", "--binary"]),
      git(root, ["diff", "--cached", "--name-only", "-z"]),
      git(root, ["diff", "--binary"]),
      git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ])
    const effectiveTokenTtl = tokenTtlFrom(stateOptions.tokenTtlMs)
    const operation = await operationState(root)
    const config = JSON.stringify({ qaCommand: stateOptions.qaCommand, documentationCommand: stateOptions.documentationCommand, requiredPaths: normalizeRequiredPaths(stateOptions.requiredPaths), timeoutMs: stateOptions.timeoutMs ?? timeout, tokenTtlMs: effectiveTokenTtl })
    const stagedPaths = stagedNames ? stagedNames.split("\0").filter(Boolean).sort() : []
    const status = await git(root, ["status", "--porcelain=v1", "-z"])
    const untrackedDigest = await hashUntracked(root, untracked)
    const byteDigests = { indexTree: digest(Buffer.from(indexTree, "latin1").toString("base64")), staged: digest(Buffer.from(staged, "latin1").toString("base64")), worktree: digest(Buffer.from(worktree, "latin1").toString("base64")), untracked: untrackedDigest, status: digest(Buffer.from(status, "latin1").toString("base64")) }
    const identity = { root, head, branch, branchRef, upstream, remotes, indexTree, tree, staged, stagedPaths, worktree, untracked, untrackedDigest, status, byteDigests, config, operation }
    return { ...identity, fingerprint: digest(JSON.stringify(identity)) }
  }

  function publicState(current: RepoState): PublicRepoState {
    const remotes = current.remotes.split("\n").map((line) => line.split(/\s+/).map((part) => redactRemoteUrl(part)).join(" ")).join("\n")
    return {
      root: current.root,
      head: current.head,
      branch: current.branch,
      upstream: current.upstream,
      remotes,
      stagedPaths: current.stagedPaths,
      stagedScope: current.staged.slice(0, MAX_EVIDENCE_OUTPUT),
      stagedSha256: digest(Buffer.from(current.staged, "latin1").toString("base64")),
      indexTreeSha256: digest(Buffer.from(current.indexTree, "latin1").toString("base64")),
      worktreeSha256: digest(Buffer.from(current.worktree, "latin1").toString("base64")),
      untrackedSha256: current.untrackedDigest,
      statusSha256: digest(Buffer.from(current.status, "latin1").toString("base64")),
      operation: current.operation,
      fingerprint: current.fingerprint,
    }
  }

  function effectiveTtl(stateOptions: GateOptions): number {
    return tokenTtlFrom(stateOptions.tokenTtlMs)
  }

  function live(record: TokenRecord | undefined, session: string, agent: string, intent: string, phase?: "preview" | "evidence" | "commit" | "push"): TokenRecord {
    if (!record || record.expires < Date.now()) fail("token is missing or expired; preview again")
    if (record.used || record.session !== session || record.agent !== agent || (record.kind === "gate" ? record.intent !== intent || (phase && record.phase !== phase) : false)) fail("token is already used or bound to another session/agent/intent/phase")
    return record
  }

  function result(record: TokenRecord, phase: "preview" | "evidence" | "applied", extra: Record<string, unknown> = {}) {
    return json({ phase, expiresInMs: Math.max(0, record.expires - Date.now()), ...extra })
  }

  async function runGate(repo: string, kind: GateKind, action: GateAction, expectToken?: string, session = "default", agent = "default", progress?: GateProgressReporter) {
    const report = async (phase: GateProgressPhase, command?: GateCommand) => {
      if (!progress) return
      const update: GateProgressUpdate = { phase, kind, action }
      if (command) {
        const safeCommand = progressCommand(command)
        if (safeCommand) update.command = safeCommand
      }
      try {
        await progress(update)
      } catch {
        // Progress is advisory and must not change the gate outcome.
      }
    }
    await report("checking")
    const root = await rootOf(repo)
    const repoOptions = await repositoryOptions(root)
    const repoRequiredPaths = normalizeRequiredPaths(repoOptions.requiredPaths)
    const repoTimeout = timeoutFrom(repoOptions.timeoutMs)
    const repoRun = (file: string, args: string[]) => runner === defaultRunner ? boundedExec(file, args, root, repoTimeout, file === "git" ? { GIT_OPTIONAL_LOCKS: "0" } : {}) : runner(file, args, root)
    let current: RepoState
    if (action === "apply") {
      if (!expectToken) fail("apply requires the gate preview token")
      const record = live(tokens.get(expectToken), session, agent, `${kind}:apply`, "preview")
      if (record.kind !== "gate" || record.evidence.kind !== kind) fail("token is not for this gate")
      current = await state(root, repoOptions)
      if (current.fingerprint !== record.evidence.state.fingerprint) fail("repository changed since gate preview; run the gate again")
      record.used = true
    } else {
      current = await state(root, repoOptions)
    }
    const command = configuredCommand(repoOptions, kind)
    if (kind === "documentation") {
      const missing = repoRequiredPaths.filter((path) => !current.stagedPaths.includes(path))
      if (missing.length) fail(`documentation gate requires staged paths: ${missing.join(", ")}`)
    }
    await report("running", command)
    const executed = await repoRun(command.file, command.args).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      fail(`${kind} gate failed to execute: ${detail}`)
    })
    await report("verifying", command)
    const after = await state(root, repoOptions)
    if (after.fingerprint !== current.fingerprint) fail(`${kind} gate changed repository state; refusing evidence`)
    const output = `${executed.stdout}${executed.stderr ? `\n${executed.stderr}` : ""}`.trim()
    const evidence: Evidence = { kind, state: publicState(current), command, output: output.slice(0, MAX_EVIDENCE_OUTPUT), outputSha256: digest(output) }
    const gateToken = token()
    const gatePhase = action === "apply" ? "evidence" : "preview"
    const record: TokenRecord = { kind: "gate", phase: gatePhase, expires: Date.now() + effectiveTtl(repoOptions), used: false, session, agent, intent: `${kind}:apply`, evidence }
    storeToken(gateToken, record)
    await report("complete", command)
    return result(record, gatePhase, { token: gateToken, kind, evidence, refreshed: action === "apply" })
  }

  async function commit(repo: string, message: string, qaToken: string, documentationToken: string, action: GateAction, expectToken?: string, approval = false, session = "default", agent = "default") {
    if (!message || message.includes("\0") || message.trim() !== message) fail("message must be non-empty and have no surrounding whitespace")
    const root = await rootOf(repo)
    const repoOptions = await repositoryOptions(root)
    const current = await state(root, repoOptions)
    if (current.operation) fail(`cannot commit while a Git operation is active: ${current.operation}`)
    if (!current.branchRef) fail("cannot commit with detached HEAD")
    if (action === "apply") {
      if (!approval) fail("commit apply requires separate explicit user approval")
      if (!expectToken) fail("commit apply requires the commit preview token")
      const record = live(tokens.get(expectToken), session, agent, "commit:apply")
      if (record.kind !== "commit" || record.state.fingerprint !== current.fingerprint || record.message !== message) fail("commit preview is stale or does not match this scope/message")
       const commit = await doCommit(current.root, message, current.head, current.branchRef, current.tree, current.staged)
       record.used = true
       return result(record, "applied", { operation: "commit", commit })
    }
    const evidence = [live(tokens.get(qaToken), session, agent, "qa:apply", "evidence"), live(tokens.get(documentationToken), session, agent, "documentation:apply", "evidence")]
    const gateEvidence = evidence.map((record) => (record as Extract<TokenRecord, { kind: "gate" }>).evidence)
    if (gateEvidence.some((item) => item.state.fingerprint !== current.fingerprint)) fail("QA/documentation evidence is stale; run both gates again")
    if (!current.staged) fail("no staged scope to commit")
    evidence.forEach((record) => { record.used = true })
    const commitToken = token()
    const record: TokenRecord = { kind: "commit", expires: Date.now() + effectiveTtl(repoOptions), used: false, session, agent, root: current.root, state: current, message, evidence: gateEvidence }
    storeToken(commitToken, record)
    return result(record, "preview", { token: commitToken, operation: "commit", message, stagedScope: current.staged.slice(0, MAX_EVIDENCE_OUTPUT), stagedScopeSha256: digest(Buffer.from(current.staged, "latin1").toString("base64")), evidence: gateEvidence })
  }

  async function doCommit(root: string, message: string, expectedParent: string, expectedBranchRef: string, expectedTree: string, expectedStaged: string) {
    const beforeHead = await git(root, ["rev-parse", "HEAD"])
    if (beforeHead !== expectedParent) fail("HEAD changed before commit candidate creation")
    const candidateTree = await git(root, ["write-tree"])
    if (candidateTree !== expectedTree) fail("index changed before commit candidate creation")
    const directory = await mkdtemp(join(tmpdir(), "rig-tools-commit-"))
    const messagePath = join(directory, "message")
    await writeFile(messagePath, message, "utf8")
    let candidate: string
    try {
      candidate = await git(root, ["commit-tree", candidateTree, "-p", expectedParent, "-F", messagePath])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    const [parents, committedTree, committedDiff, committedMessage] = await Promise.all([
      git(root, ["rev-list", "--parents", "-n", "1", candidate]),
      git(root, ["rev-parse", `${candidate}^{tree}`]),
      git(root, ["diff", "--binary", expectedParent, candidate]),
      git(root, ["log", "-1", "--format=%B", candidate]),
    ])
    const parentList = parents.split("\n")[0]?.split(" ") ?? []
    if (parentList.length !== 2 || parentList[1] !== expectedParent || committedTree !== expectedTree || committedDiff !== expectedStaged || committedMessage.trimEnd() !== message) fail("commit candidate did not match the reviewed parent/index tree/message")
    const [beforeBranch, beforeBranchHead] = await Promise.all([
      git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
      git(root, ["rev-parse", expectedBranchRef]),
    ])
    if (beforeBranch !== expectedBranchRef || beforeBranchHead !== expectedParent) fail("HEAD or branch ref changed before commit CAS")
    await git(root, ["update-ref", expectedBranchRef, candidate, expectedParent]).catch(() => fail("commit branch ref update lost its compare-and-swap race"))
    const [headRef, head, branch, tree, indexClean] = await Promise.all([
      git(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => ""),
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["rev-parse", expectedBranchRef]),
      git(root, ["write-tree"]),
      git(root, ["diff", "--cached", "--quiet"]).then(() => true).catch(() => false),
    ])
    if (headRef !== expectedBranchRef || head !== candidate || branch !== candidate || tree !== expectedTree || !indexClean) {
      const restored = await git(root, ["update-ref", expectedBranchRef, expectedParent, candidate]).then(() => true).catch(() => false)
      if (!restored) fail("commit postcondition changed and branch rollback lost its compare-and-swap race")
      fail("commit postcondition changed; reviewed branch ref was restored")
    }
    return candidate
  }

  async function pushTarget(root: string, remote: string, ref: string) {
    const configured = await git(root, ["remote", "get-url", "--push", "--all", remote]).catch(() => fail("remote does not exist or its push destination cannot be read"))
    const urls = configured.split("\n").filter(Boolean)
    if (urls.length !== 1) fail("remote must resolve to exactly one push destination")
    const url = urls[0]
    const advertised = await git(root, ["ls-remote", url]).catch(() => fail("cannot verify push destination/ref"))
    const lines = advertised ? advertised.split("\n").filter(Boolean) : []
    const matches = lines.filter((line) => line.split("\t")[1] === ref)
    if (matches.length > 1) fail("remote/ref matched multiple advertised objects; refusing ambiguous push")
    const remoteSha = matches.length === 1 ? matches[0].split("\t", 1)[0] ?? "" : ""
    if (remoteSha && !/^[0-9a-f]{40,64}$/.test(remoteSha)) fail("remote advertised an invalid object ID")
    const head = await git(root, ["rev-parse", "--verify", "HEAD"])
    if (remoteSha === head) fail("push target is already up to date; refusing a no-op push")
    if (remoteSha) {
      await git(root, ["merge-base", "--is-ancestor", remoteSha, head]).catch(() => fail("push would be non-fast-forward"))
    }
    const advertisedShas = lines.map((line) => line.split("\t", 1)[0]).filter((sha) => /^[0-9a-f]{40,64}$/.test(sha))
    const range = await git(root, ["rev-list", "--reverse", head, "--not", ...advertisedShas]).catch(() => fail("cannot compute exact outgoing commit set from advertised remote refs"))
    const outgoing = range.split("\n").filter(Boolean)
    if (!outgoing.length) fail("push has no outgoing commits")
    return { url, advertised, remoteSha, outgoing, head }
  }

  async function verifyPushedRef(root: string, url: string, ref: string, expected: string): Promise<string> {
    const output = await git(root, ["ls-remote", url, ref]).catch(() => fail("push completed but the target ref could not be verified"))
    const lines = output ? output.split("\n").filter(Boolean) : []
    const matches = lines.filter((line) => line.split("\t")[1] === ref)
    if (matches.length !== 1) fail(`push completed but exact target verification returned ${matches.length} results for ${ref}`)
    const sha = matches[0]?.split("\t", 1)[0] ?? ""
    if (!/^[0-9a-f]{40,64}$/.test(sha) || sha !== expected) fail(`push completed but ${ref} does not equal the reviewed local HEAD`)
    return sha
  }

  async function push(repo: string, remote: string, ref: string, action: GateAction, expectToken?: string, approval = false, session = "default", agent = "default") {
    validateRemoteName(remote)
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.endsWith("/")) fail("ref must be an explicit refs/heads/* target")
    const root = await rootOf(repo)
    await git(root, ["check-ref-format", ref]).catch(() => fail("ref is not a valid Git refs/heads target"))
    const repoOptions = await repositoryOptions(root)
    const current = await state(root, repoOptions)
    if (action === "apply") {
      if (!approval) fail("push apply requires separate explicit user approval")
      if (!expectToken) fail("push apply requires the push preview token")
      const record = live(tokens.get(expectToken), session, agent, "push:apply")
      const fresh = await pushTarget(current.root, remote, ref)
      if (record.kind !== "push" || record.state.fingerprint !== current.fingerprint || current.head !== fresh.head || record.remote !== remote || record.ref !== ref || record.url !== fresh.url || record.advertised !== fresh.advertised || record.remoteSha !== fresh.remoteSha || JSON.stringify(record.outgoing) !== JSON.stringify(fresh.outgoing)) fail("push preview is stale or destination/range changed")
      record.used = true
      await run("git", ["push", "--no-verify", `--force-with-lease=${ref}:${record.remoteSha}`, record.url, `${current.head}:${ref}`], current.root).catch(() => fail("push was refused; the destination changed or the lease was not accepted"))
      const verifiedSha = await verifyPushedRef(current.root, record.url, ref, current.head)
      return result(record, "applied", { operation: "push", remote, ref, url: redactRemoteUrl(record.url), head: current.head, remoteSha: record.remoteSha, outgoing: record.outgoing, verifiedSha, result: "pushed" })
    }
    const target = await pushTarget(current.root, remote, ref)
    const pushToken = token()
    const record: TokenRecord = { kind: "push", expires: Date.now() + effectiveTtl(repoOptions), used: false, session, agent, root: current.root, state: current, remote, ref, url: target.url, advertised: target.advertised, remoteSha: target.remoteSha, outgoing: target.outgoing }
    storeToken(pushToken, record)
    return result(record, "preview", { token: pushToken, operation: "push", remote, ref, url: redactRemoteUrl(target.url), head: current.head, remoteSha: target.remoteSha, outgoing: target.outgoing })
  }

  return { runGate, commit, push }
}
