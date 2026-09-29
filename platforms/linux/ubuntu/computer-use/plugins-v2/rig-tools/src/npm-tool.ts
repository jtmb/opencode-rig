import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { accessSync, constants, realpathSync } from "node:fs"
import { lstat, readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const BOUNDED_RUNNER = fileURLToPath(new URL("../../../scripts/run-bounded-command.sh", import.meta.url))
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_PACKAGES = 64
const MAX_ARGS = 64
const TOKEN_TTL_MS = 5 * 60_000
const MAX_TOKENS = 128
const PACKAGE_SPEC = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._+:-]*)?$/
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

function executable(name: string) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    try {
      const candidate = realpathSync(resolve(directory, name))
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep searching */ }
  }
  throw new Error(`${name} executable is unavailable`)
}

const NPM_EXECUTABLE = executable("npm")
const NODE_EXECUTABLE = executable("node")
const NPM_CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode-rig", "npm")

export function isolatedNpmCommand(args: string[], npm = NPM_EXECUTABLE, node = NODE_EXECUTABLE, cache = NPM_CACHE) {
  void node
  void cache
  return [npm, ...args]
}

export function isolatedNpmEnvironment(node = NODE_EXECUTABLE, cache = NPM_CACHE, source: NodeJS.ProcessEnv = process.env) {
  return {
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    npm_config_cache: cache,
    npm_config_userconfig: "/nonexistent/.npmrc",
    npm_config_globalconfig: "/dev/null",
    ...(source.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR } : {}),
    ...(source.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS } : {}),
  }
}

export type NpmInput = {
  action: "version" | "scripts" | "list" | "audit" | "outdated" | "install" | "ci" | "run" | "test"
  directory?: string
  depth?: number
  packages?: string[]
  save?: "none" | "prod" | "dev" | "optional"
  script?: string
  args?: string[]
  apply?: boolean
  expectToken?: string
}

export type NpmProcessResult = { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export type NpmRunner = (args: string[], cwd: string) => Promise<NpmProcessResult>

type NpmIntent = { directory: string; args: string[]; action: "install" | "ci" | "run" | "test" }
type NpmToken = { token: string; sessionID: string; agent: string; intentDigest: string; stateDigest: string; expiresAt: number }

function within(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

function clean(value: string, maximum = 64 * 1024) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, maximum)
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function boundedArgs(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ARGS || value.some((item) => typeof item !== "string" || Buffer.byteLength(item, "utf8") > 4096 || item.includes("\0"))) {
    throw new Error(`args must contain at most ${MAX_ARGS} bounded strings`)
  }
  return [...value] as string[]
}

export const runNpmProcess: NpmRunner = (args, cwd) => new Promise((resolvePromise, reject) => {
  const child = spawn(BOUNDED_RUNNER, [
    "--memory-fraction", "30",
    "--swap-fraction", "10",
    "--node-heap-fraction", "65",
    "--timeout", "15m",
    "--lock-timeout", "30",
    "--",
    ...isolatedNpmCommand(args),
  ], { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: isolatedNpmEnvironment() })
  let stdout = ""
  let stderr = ""
  let bytes = 0
  let overflow = false
  let settled = false
  let grace: NodeJS.Timeout | undefined
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch { /* process already exited */ }
  }
  const append = (target: "stdout" | "stderr", chunk: Buffer) => {
    if (overflow) return
    bytes += chunk.length
    if (bytes > MAX_OUTPUT_BYTES) {
      overflow = true
      killTree("SIGTERM")
      grace = setTimeout(() => { if (!settled) killTree("SIGKILL") }, 250)
      return
    }
    if (target === "stdout") stdout += chunk.toString("utf8")
    else stderr += chunk.toString("utf8")
  }
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk))
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk))
  child.once("error", reject)
  child.once("close", (exitCode, signal) => {
    settled = true
    if (grace) clearTimeout(grace)
    if (overflow) reject(new Error(`npm output exceeded ${MAX_OUTPUT_BYTES} bytes`))
    else resolvePromise({ exitCode, signal, stdout, stderr })
  })
})

async function npmDirectory(root: string, value: unknown) {
  const requested = value ?? root
  if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("npm directory must be absolute")
  const directory = await realpath(requested)
  if (!within(root, directory)) throw new Error("npm directory must stay inside the current project")
  const manifestPath = resolve(directory, "package.json")
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error("package.json must be a bounded regular non-symlink file")
  const text = await readFile(manifestPath, "utf8")
  let manifest: Record<string, unknown>
  try { manifest = JSON.parse(text) as Record<string, unknown> } catch { throw new Error("package.json is not valid JSON") }
  return { directory, manifestPath, manifest, text }
}

async function packageState(location: Awaited<ReturnType<typeof npmDirectory>>) {
  const hash = createHash("sha256").update("package.json\0").update(location.text)
  for (const name of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const path = resolve(location.directory, name)
    const info = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (!info) { hash.update(`${name}\0missing\0`); continue }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error(`${name} must be a bounded regular non-symlink file`)
    hash.update(`${name}\0`).update(await readFile(path))
  }
  return hash.digest("hex")
}

function npmIntent(input: NpmInput, location: Awaited<ReturnType<typeof npmDirectory>>): NpmIntent {
  if (input.action === "ci") return { action: "ci", directory: location.directory, args: ["ci"] }
  if (input.action === "install") {
    const packages = input.packages ?? []
    if (!Array.isArray(packages) || packages.length > MAX_PACKAGES || packages.some((value) => typeof value !== "string" || !PACKAGE_SPEC.test(value) || value.includes("..") || value.startsWith("-"))) {
      throw new Error(`packages must contain at most ${MAX_PACKAGES} registry package specifications`)
    }
    const args = ["install"]
    if (input.save === "none") args.push("--no-save")
    else if (input.save === "dev") args.push("--save-dev")
    else if (input.save === "optional") args.push("--save-optional")
    else if (input.save === "prod") args.push("--save-prod")
    args.push("--", ...packages)
    return { action: "install", directory: location.directory, args }
  }
  if (input.action === "run" || input.action === "test") {
    const script = input.action === "test" ? "test" : input.script
    if (typeof script !== "string" || !SCRIPT_NAME.test(script)) throw new Error("script is missing or invalid")
    const scripts = location.manifest.scripts
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts) || typeof (scripts as Record<string, unknown>)[script] !== "string") {
      throw new Error(`npm script is not defined: ${script}`)
    }
    const extra = boundedArgs(input.args)
    return { action: input.action, directory: location.directory, args: ["run", script, ...(extra.length ? ["--", ...extra] : [])] }
  }
  throw new Error("action is not an npm mutation")
}

export function createNpmTool(projectDirectory: string, runner: NpmRunner = runNpmProcess, now: () => number = Date.now) {
  const rootPromise = realpath(projectDirectory)
  const tokens = new Map<string, NpmToken>()
  return async (input: NpmInput, sessionID: string, agent: string) => {
    const root = await rootPromise
    const location = await npmDirectory(root, input.directory)
    if (input.action === "version") {
      const result = await runner(["--version"], location.directory)
      return { ...result, stdout: clean(result.stdout), stderr: clean(result.stderr), memoryPolicy: "adaptive-cgroup-or-fail-closed" }
    }
    if (input.action === "scripts") {
      const scripts = location.manifest.scripts
      return {
        scripts: typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
          ? Object.keys(scripts).filter((name) => Buffer.byteLength(name, "utf8") <= 128).sort().slice(0, 256)
          : [],
      }
    }
    if (input.action === "list" || input.action === "audit" || input.action === "outdated") {
      const depth = input.depth === undefined ? 0 : Number.isSafeInteger(input.depth) && input.depth >= 0 && input.depth <= 10 ? input.depth : NaN
      if (!Number.isFinite(depth)) throw new Error("depth must be an integer from 0 through 10")
      const args = input.action === "list" ? ["list", "--json", "--depth", String(depth)] : [input.action, "--json"]
      const result = await runner(args, location.directory)
      return { ...result, stdout: clean(result.stdout), stderr: clean(result.stderr), memoryPolicy: "adaptive-cgroup-or-fail-closed", untrusted: true }
    }

    const intent = npmIntent(input, location)
    const stateDigest = await packageState(location)
    const intentDigest = digest(intent)
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key)
      if (tokens.size >= MAX_TOKENS) throw new Error("npm preview capacity is full")
      const token = randomBytes(24).toString("base64url")
      const record = { token, sessionID, agent, intentDigest, stateDigest, expiresAt: now() + TOKEN_TTL_MS }
      tokens.set(token, record)
      return { dryRun: true, intent, stateDigest, expectToken: token, expiresAt: record.expiresAt, memoryPolicy: "adaptive-cgroup-or-fail-closed" }
    }
    const record = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!record || record.expiresAt <= now()) throw new Error("npm preview token is missing or expired")
    tokens.delete(record.token)
    if (record.sessionID !== sessionID || record.agent !== agent || record.intentDigest !== intentDigest) throw new Error("npm preview token does not match this session, agent, and intent")
    if (record.stateDigest !== stateDigest) throw new Error("npm package state changed after preview; preview again")
    const result = await runner(intent.args, intent.directory)
    const fresh = await npmDirectory(root, intent.directory)
    return {
      dryRun: false,
      intent,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: clean(result.stdout),
      stderr: clean(result.stderr),
      stateDigest: await packageState(fresh),
      memoryPolicy: "adaptive-cgroup-or-fail-closed",
      untrusted: true,
    }
  }
}
