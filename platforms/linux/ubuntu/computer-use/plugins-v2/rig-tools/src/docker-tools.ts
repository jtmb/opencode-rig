import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"

const MAX_OUTPUT_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 30_000
const MUTATION_TIMEOUT_MS = 15 * 60_000
const TOKEN_TTL_MS = 5 * 60_000
const MAX_TOKENS = 128
const MAX_COMMAND_ARGS = 64
const MAX_ARG_BYTES = 4096
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const IMAGE = /^(?:[A-Za-z0-9._-]+(?::[0-9]+)?\/)?[A-Za-z0-9._/-]+(?:[:@][A-Za-z0-9._:+-]+)?$/
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const MAX_PATH_BYTES = 4096
const MAX_CONFIG_SERVICES = 64
const HARD_PID_LIMIT = 256

export type DockerProcessResult = { stdout: string; stderr: string }
export type DockerRunner = (
  args: string[],
  options: { cwd: string; timeoutMs: number; sanitizedEnv?: boolean },
) => Promise<DockerProcessResult>

type DockerToolResult = {
  dryRun?: boolean
  expectToken?: string
  expiresAt?: number
  intent?: unknown
  stateDigest?: string
  services?: string[]
  resourceLimited?: string[]
  configSha256?: string
  memoryPolicy?: string
  stdout?: string
  stderr?: string
  output?: string
  untrusted?: boolean
  [key: string]: unknown
}

export type DockerEngineInput = {
  action: "version" | "ps" | "images" | "inspect" | "logs" | "pull" | "run" | "stop" | "remove"
  target?: string
  all?: boolean
  tail?: number
  image?: string
  name?: string
  command?: string[]
  network?: "none" | "bridge"
  memoryMiB?: number
  cpus?: number
  apply?: boolean
  expectToken?: string
}

export type DockerComposeInput = {
  action: "services" | "ps" | "logs" | "pull" | "up" | "down" | "start" | "stop" | "restart"
  directory?: string
  file?: string
  projectName?: string
  services?: string[]
  tail?: number
  apply?: boolean
  expectToken?: string
}

type EngineIntent =
  | { action: "pull"; image: string }
  | { action: "run"; image: string; name: string; command: string[]; network: "none" | "bridge"; memoryMiB: number; cpus: number }
  | { action: "stop" | "remove"; target: string }

type ComposeIntent = {
  action: "pull" | "up" | "down" | "start" | "stop" | "restart"
  directory: string
  file: string
  projectName?: string
  services: string[]
}

type Token = {
  token: string
  kind: "engine" | "compose"
  sessionID: string
  agent: string
  intentDigest: string
  stateDigest: string
  expiresAt: number
}

function clean(value: string, maximum = 4096) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, maximum)
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function boundedPath(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || value.includes("\0")) {
    throw new Error(`${label} must be a bounded path`)
  }
  return value
}

function boundedArgs(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_COMMAND_ARGS || value.some((part) => typeof part !== "string" || Buffer.byteLength(part, "utf8") > MAX_ARG_BYTES || part.includes("\0"))) {
    throw new Error(`command must contain at most ${MAX_COMMAND_ARGS} bounded strings`)
  }
  return [...value] as string[]
}

function named(value: unknown, label: string) {
  if (typeof value !== "string" || !NAME.test(value)) throw new Error(`${label} is missing or invalid`)
  return value
}

function imageRef(value: unknown) {
  if (typeof value !== "string" || value.length > 512 || !IMAGE.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new Error("image is missing or invalid")
  }
  return value
}

function network(value: unknown): "none" | "bridge" {
  if (value === undefined) return "none"
  if (value !== "none" && value !== "bridge") throw new Error("network must be none or bridge")
  return value
}

function parseRows(text: string, fields: string[]) {
  return text.split("\n").filter(Boolean).slice(0, 4096).map((line) => {
    const values = line.split("\t")
    return Object.fromEntries(fields.map((field, index) => [field, clean(values[index] ?? "", 2048)]))
  })
}

export const runDockerProcess: DockerRunner = (args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn("docker", args, {
    cwd: options.cwd,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
     env: options.sanitizedEnv
       ? { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
      : process.env,
  })
  let stdout = ""
  let stderr = ""
  let bytes = 0
  let settled = false
  let timedOut = false
  let overflow = false
  let grace: NodeJS.Timeout | undefined
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch { /* process already exited */ }
  }
  const stop = () => {
    killTree("SIGTERM")
    grace ??= setTimeout(() => { if (!settled) killTree("SIGKILL") }, 250)
  }
  const append = (target: "stdout" | "stderr", chunk: Buffer) => {
    if (overflow) return
    bytes += chunk.length
    if (bytes > MAX_OUTPUT_BYTES) {
      overflow = true
      stop()
      return
    }
    if (target === "stdout") stdout += chunk.toString("utf8")
    else stderr += chunk.toString("utf8")
  }
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk))
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk))
  const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs)
  const finish = (error?: Error, result?: DockerProcessResult) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (grace) clearTimeout(grace)
    if (error) reject(error)
    else resolvePromise(result!)
  }
  child.once("error", (error) => finish(error))
  child.once("close", (code, signal) => {
    if (timedOut) finish(new Error(`docker command timed out after ${options.timeoutMs}ms`))
    else if (overflow) finish(new Error(`docker command output exceeded ${MAX_OUTPUT_BYTES} bytes`))
    else if (code !== 0) finish(new Error(`docker command exited ${code ?? signal}: ${clean(stderr || stdout)}`))
    else finish(undefined, { stdout, stderr })
  })
})

function engineIntent(input: DockerEngineInput): EngineIntent {
  if (input.action === "pull") return { action: "pull", image: imageRef(input.image) }
  if (input.action === "run") {
    const cpus = input.cpus ?? 1
    if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 8) throw new Error("cpus must be from 0.1 through 8")
    return {
      action: "run",
      image: imageRef(input.image),
      name: named(input.name, "container name"),
      command: boundedArgs(input.command),
       network: network(input.network),
      memoryMiB: boundedInteger(input.memoryMiB, 512, 64, 8192, "memoryMiB"),
      cpus,
    }
  }
  if (input.action === "stop" || input.action === "remove") return { action: input.action, target: named(input.target, "container target") }
  throw new Error("action is not a Docker mutation")
}

function engineCommand(intent: EngineIntent): string[] {
  if (intent.action === "pull") return ["pull", "--", intent.image]
  if (intent.action === "stop") return ["stop", "--time", "10", "--", intent.target]
  if (intent.action === "remove") return ["rm", "--", intent.target]
  if (intent.action !== "run") throw new Error("unsupported Docker mutation")
  return [
    "run", "--detach", "--name", intent.name,
    "--network", intent.network,
    "--memory", `${intent.memoryMiB}m`,
    "--memory-swap", `${intent.memoryMiB}m`,
    "--cpus", String(intent.cpus),
    "--pids-limit", String(HARD_PID_LIMIT),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--", intent.image,
    ...intent.command,
  ]
}

async function engineState(intent: EngineIntent, root: string, runner: DockerRunner) {
  const inspect = async (kind: "image" | "container", target: string) => {
    try {
      const output = await runner([kind, "inspect", "--format", "{{json .}}", "--", target], {
        cwd: root,
        timeoutMs: READ_TIMEOUT_MS,
        sanitizedEnv: true,
      })
      return { exists: true, output: output.stdout }
    } catch (error) {
      if (!/\bNo such (?:image|object|container)\b/i.test(String(error))) throw error
      return { exists: false, kind, target }
    }
  }
  if (intent.action === "pull") return digest(await inspect("image", intent.image))
  if (intent.action === "run") {
    return digest({
      image: await inspect("image", intent.image),
      container: await inspect("container", intent.name),
    })
  }
  return digest(await inspect("container", intent.target))
}

function within(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

async function composeLocation(root: string, input: DockerComposeInput) {
  const directoryValue = input.directory ?? root
  if (typeof directoryValue !== "string" || !isAbsolute(directoryValue)) throw new Error("Compose directory must be absolute")
  const directory = await realpath(directoryValue)
  if (!within(root, directory)) throw new Error("Compose directory must stay inside the current project")
  const fileValue = input.file === undefined ? undefined : boundedPath(input.file, "Compose file")
  const candidates = fileValue
    ? [resolve(directory, fileValue)]
    : ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].map((name) => resolve(directory, name))
  let file: string | undefined
  for (const candidate of candidates) {
    if (!within(directory, candidate)) throw new Error("Compose file must stay inside the selected directory")
    if (!within(root, candidate)) throw new Error("Compose file must stay inside the current project")
    const info = await lstat(candidate).catch(() => undefined)
    if (info?.isFile() && !info.isSymbolicLink()) { file = await realpath(candidate); break }
  }
  if (!file || !within(root, file)) throw new Error("Compose file is missing, not regular, or outside the current project")
  return { directory, file }
}

function composePrefix(location: { directory: string; file: string }, projectName?: string) {
  const args = ["compose", "--project-directory", location.directory, "--file", location.file]
  if (projectName !== undefined) args.push("--project-name", named(projectName, "Compose project name"))
  return args
}

function projectPath(root: string, value: unknown, label: string) {
  if (value === undefined) return
  const path = resolve(root, boundedPath(value, label))
  if (!within(root, path)) throw new Error(`${label} must stay inside the current project`)
  return path
}

async function validateExistingProjectPath(root: string, value: unknown, label: string) {
  const path = projectPath(root, value, label)
  if (!path) return
  let candidate = path
  let canonical: string | undefined
  while (!canonical) {
    canonical = await realpath(candidate).catch(() => undefined)
    const parent = dirname(candidate)
    if (parent === candidate) break
    if (!canonical) candidate = parent
  }
  if (canonical && !within(root, canonical)) throw new Error(`${label} must stay inside the current project`)
}

function nonEmpty(value: unknown) {
  if (value === true) return true
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0
  return false
}

function namespaceEscape(value: unknown) {
  return typeof value === "string" && (
    value === "host" || value.startsWith("container:") || value.startsWith("service:")
  )
}

function memoryBytes(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib|t|tb|tib)?$/i.exec(value.trim())
  if (!match) return undefined
  const multiplier = ({ b: 1, k: 1024, kb: 1000, kib: 1024, m: 1024 ** 2, mb: 1000 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1000 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1000 ** 4, tib: 1024 ** 4 } as Record<string, number>)[(match[2] ?? "b").toLowerCase()]
  const result = Number(match[1]) * multiplier
  return Number.isFinite(result) ? result : undefined
}

function cpuValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim() !== "") {
    const result = Number(value)
    return Number.isFinite(result) ? result : undefined
  }
  return undefined
}

function pidValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value)
  return undefined
}

function volumeSource(value: string) {
  const source = value.split(":", 1)[0] ?? ""
  return source
}

async function validateComposeConfig(config: unknown, root: string) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("Docker Compose config is not an object")
  const object = config as Record<string, unknown>
  const services = object.services
  if (typeof services !== "object" || services === null || Array.isArray(services)) throw new Error("Docker Compose config has no services object")
  const entries = Object.entries(services as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_CONFIG_SERVICES) throw new Error(`Docker Compose config must contain 1-${MAX_CONFIG_SERVICES} services`)
  const resourceLimited = new Set<string>()
  const dependencies: Record<string, string[]> = {}
  const serviceNames = new Set(entries.map(([name]) => name))
  for (const [name, raw] of entries) {
    if (!SERVICE.test(name) || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Docker Compose service is malformed")
    const service = raw as Record<string, unknown>
    const dependsOn = service.depends_on
    const dependencyNames = Array.isArray(dependsOn)
      ? dependsOn
      : typeof dependsOn === "object" && dependsOn !== null
        ? Object.keys(dependsOn)
        : dependsOn === undefined
          ? []
          : undefined
    if (!dependencyNames || dependencyNames.some((dependency) => typeof dependency !== "string" || !SERVICE.test(dependency) || !serviceNames.has(dependency))) {
      throw new Error(`Compose service ${name} has malformed or unknown dependencies`)
    }
    dependencies[name] = [...new Set(dependencyNames as string[])]
    for (const key of ["privileged", "devices", "device_cgroup_rules", "cap_add", "volumes_from", "cgroup_parent", "storage_opt"]) {
      if (nonEmpty(service[key])) throw new Error(`Compose service ${name} uses forbidden ${key}`)
    }
    for (const key of ["pid", "ipc", "uts", "userns_mode", "cgroup", "cgroupns"]) {
      const value = service[key]
      if (namespaceEscape(value)) throw new Error(`Compose service ${name} uses a host/container namespace`)
    }
    const networkMode = service.network_mode
    if (namespaceEscape(networkMode)) throw new Error(`Compose service ${name} uses a forbidden network_mode`)
    const securityOptions = service.security_opt
    if (securityOptions !== undefined && !Array.isArray(securityOptions)) throw new Error(`Compose service ${name} has malformed security_opt`)
    if (Array.isArray(securityOptions) && securityOptions.some((value) => value !== "no-new-privileges" && value !== "no-new-privileges:true")) {
      throw new Error(`Compose service ${name} uses a forbidden security_opt`)
    }
    const volumes = service.volumes
    if (volumes !== undefined && !Array.isArray(volumes)) throw new Error(`Compose service ${name} has malformed volumes`)
    if (Array.isArray(volumes)) for (const volume of volumes) {
      if (typeof volume === "object" && volume !== null && !Array.isArray(volume)) {
        const value = volume as Record<string, unknown>
        if (value.type === "bind") throw new Error(`Compose service ${name} uses a forbidden bind mount`)
        if (value.type === "volume" && value.source !== undefined && (typeof value.source !== "string" || !NAME.test(value.source))) {
          throw new Error(`Compose service ${name} uses an invalid named volume`)
        }
        if (value.type !== "volume" && value.type !== "tmpfs") throw new Error(`Compose service ${name} uses an unsupported volume type`)
      } else if (typeof volume === "string") {
        const source = volumeSource(volume)
        if (!NAME.test(source) || source.startsWith(".") || source.startsWith("/") || source.includes("/") || source.includes("\\")) throw new Error(`Compose service ${name} uses a forbidden bind mount`)
      } else {
        throw new Error(`Compose service ${name} has a malformed volume`)
      }
    }
    const envFiles = service.env_file
    if (typeof envFiles === "string") await validateExistingProjectPath(root, envFiles, `Compose service ${name} env_file`)
    if (Array.isArray(envFiles)) for (const value of envFiles) {
      if (typeof value === "string") await validateExistingProjectPath(root, value, `Compose service ${name} env_file`)
      else if (typeof value === "object" && value !== null && !Array.isArray(value)) await validateExistingProjectPath(root, (value as Record<string, unknown>).path, `Compose service ${name} env_file`)
      else throw new Error(`Compose service ${name} env_file is malformed`)
    }
    const extendsValue = service.extends
    if (typeof extendsValue === "object" && extendsValue !== null && !Array.isArray(extendsValue)) {
      await validateExistingProjectPath(root, (extendsValue as Record<string, unknown>).file, `Compose service ${name} extends file`)
    }
    const build = service.build
    if (typeof build === "string") await validateExistingProjectPath(root, build, `Compose service ${name} build context`)
    if (typeof build === "object" && build !== null && !Array.isArray(build)) {
      const value = build as Record<string, unknown>
      if (typeof value.context !== "string") throw new Error(`Compose service ${name} build context is missing`)
      await validateExistingProjectPath(root, value.context, `Compose service ${name} build context`)
      if (value.dockerfile !== undefined && typeof value.context === "string") {
        const context = projectPath(root, value.context, `Compose service ${name} build context`)
        if (context) await validateExistingProjectPath(context, value.dockerfile, `Compose service ${name} Dockerfile`)
      }
      for (const key of ["privileged", "entitlements", "ssh", "secrets", "additional_contexts", "extra_hosts"]) {
        if (nonEmpty(value[key])) throw new Error(`Compose service ${name} build uses forbidden ${key}`)
      }
      if (value.network === "host") throw new Error(`Compose service ${name} build uses a host network`)
    } else if (build !== undefined) {
      throw new Error(`Compose service ${name} build is malformed`)
    }
    const deploy = typeof service.deploy === "object" && service.deploy !== null && !Array.isArray(service.deploy)
      ? service.deploy as Record<string, unknown>
      : undefined
    const resources = typeof deploy?.resources === "object" && deploy.resources !== null && !Array.isArray(deploy.resources)
      ? deploy.resources as Record<string, unknown>
      : undefined
    const limits = typeof resources?.limits === "object" && resources.limits !== null && !Array.isArray(resources.limits)
      ? resources.limits as Record<string, unknown>
      : undefined
    const memory = memoryBytes(service.mem_limit ?? limits?.memory)
    const cpus = cpuValue(service.cpus ?? limits?.cpus)
    const pids = pidValue(service.pids_limit ?? limits?.pids)
    if (memory !== undefined && memory >= 64 * 1024 * 1024 && memory <= 8 * 1024 * 1024 * 1024 &&
      cpus !== undefined && cpus >= 0.1 && cpus <= 8 &&
      pids !== undefined && pids >= 16 && pids <= 512) {
      resourceLimited.add(name)
    }
  }
  for (const section of ["configs", "secrets"]) {
    const values = object[section]
    if (typeof values !== "object" || values === null || Array.isArray(values)) continue
    for (const value of Object.values(values as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Compose ${section} entry is malformed`)
      const entry = value as Record<string, unknown>
      if (nonEmpty(entry.external) || entry.name !== undefined) throw new Error(`Compose ${section} must stay inside the current project`)
      await validateExistingProjectPath(root, entry.file, `Compose ${section} file`)
    }
  }
  for (const section of ["volumes", "networks"]) {
    const values = object[section]
    if (typeof values !== "object" || values === null || Array.isArray(values)) continue
    for (const value of Object.values(values as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Compose ${section} entry is malformed`)
      const entry = value as Record<string, unknown>
      if (nonEmpty(entry.external) || nonEmpty(entry.driver_opts) || (entry.driver !== undefined && entry.driver !== "local")) {
        throw new Error(`Compose ${section} must stay inside the current project`)
      }
    }
  }
  return { services: entries.map(([name]) => name).sort(), resourceLimited, dependencies }
}

function dependencyClosure(selected: readonly string[], dependencies: Readonly<Record<string, readonly string[]>>) {
  const required = new Set(selected)
  const pending = [...selected]
  while (pending.length > 0) {
    const service = pending.pop()!
    for (const dependency of dependencies[service] ?? []) {
      if (required.has(dependency)) continue
      required.add(dependency)
      pending.push(dependency)
    }
  }
  return [...required]
}

async function resolvedCompose(root: string, input: DockerComposeInput, runner: DockerRunner) {
  const location = await composeLocation(root, input)
  const prefix = composePrefix(location, input.projectName)
  const output = await runner([...prefix, "config", "--format", "json"], {
    cwd: location.directory,
    timeoutMs: READ_TIMEOUT_MS,
    sanitizedEnv: true,
  })
  let config: unknown
  try { config = JSON.parse(output.stdout) } catch { throw new Error("Docker Compose config did not return valid JSON") }
  const validated = await validateComposeConfig(config, root)
  const availableServices = validated.services
  const services = input.services ?? []
  if (!Array.isArray(services) || services.length > 64 || services.some((service) => typeof service !== "string" || !SERVICE.test(service) || !availableServices.includes(service))) {
    throw new Error("services must be bounded names present in the Compose config")
  }
  return {
    location,
    prefix,
    configSha256: digest(config),
    availableServices,
    resourceLimited: validated.resourceLimited,
    dependencies: validated.dependencies,
    services: [...new Set(services)],
  }
}

async function composeState(resolved: Awaited<ReturnType<typeof resolvedCompose>>, runner: DockerRunner) {
  const output = await runner([...resolved.prefix, "ps", "--all", "--format", "json"], {
    cwd: resolved.location.directory,
    timeoutMs: READ_TIMEOUT_MS,
    sanitizedEnv: true,
  })
  return digest({ config: resolved.configSha256, ps: output.stdout })
}

function composeIntent(input: DockerComposeInput, resolved: Awaited<ReturnType<typeof resolvedCompose>>): ComposeIntent {
  if (!["pull", "up", "down", "start", "stop", "restart"].includes(input.action)) throw new Error("action is not a Docker Compose mutation")
  if (input.action === "down" && resolved.services.length > 0) throw new Error("down always targets the whole Compose project; omit services")
  if (["start", "stop", "restart"].includes(input.action) && resolved.services.length === 0) throw new Error(`${input.action} requires at least one service`)
  if (["up", "start", "restart"].includes(input.action)) {
    const selected = resolved.services.length
      ? dependencyClosure(resolved.services, resolved.dependencies)
      : resolved.availableServices
    const missing = selected.filter((service) => !resolved.resourceLimited.has(service))
    if (missing.length) throw new Error(`Compose services require explicit memory, CPU, and PID limits: ${missing.join(", ")}`)
  }
  return {
    action: input.action as ComposeIntent["action"],
    directory: resolved.location.directory,
    file: resolved.location.file,
    projectName: input.projectName,
    services: resolved.services,
  }
}

function composeCommand(prefix: string[], intent: ComposeIntent) {
  if (intent.action === "up") return [...prefix, "up", "--detach", "--remove-orphans", "--no-build", ...intent.services]
  if (intent.action === "down") return [...prefix, "down", "--remove-orphans"]
  return [...prefix, intent.action, ...intent.services]
}

export function createDockerTools(projectDirectory: string, runner: DockerRunner = runDockerProcess, now: () => number = Date.now) {
  const tokens = new Map<string, Token>()
  const rootPromise = realpath(projectDirectory)
  const preview = (kind: Token["kind"], intent: unknown, stateDigest: string, sessionID: string, agent: string) => {
    for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key)
    if (tokens.size >= MAX_TOKENS) throw new Error("Docker preview capacity is full")
    const token = randomBytes(24).toString("base64url")
    const record: Token = { token, kind, sessionID, agent, intentDigest: digest(intent), stateDigest, expiresAt: now() + TOKEN_TTL_MS }
    tokens.set(token, record)
    return { dryRun: true, intent, stateDigest, expectToken: token, expiresAt: record.expiresAt }
  }
  const consume = (input: { expectToken?: string }, kind: Token["kind"], intent: unknown, sessionID: string, agent: string) => {
    const record = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!record || record.expiresAt <= now()) throw new Error("Docker preview token is missing or expired")
    tokens.delete(record.token)
    if (record.kind !== kind || record.sessionID !== sessionID || record.agent !== agent || record.intentDigest !== digest(intent)) {
      throw new Error("Docker preview token does not match this session, agent, and intent")
    }
    return record
  }

  const engine = async (input: DockerEngineInput, sessionID: string, agent: string): Promise<DockerToolResult> => {
    const root = await rootPromise
    if (input.action === "version") {
      const result = await runner(["version", "--format", "{{json .}}"], { cwd: root, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      let version: Record<string, any>
      try { version = JSON.parse(result.stdout) as Record<string, any> } catch { throw new Error("Docker version returned invalid JSON") }
      return {
        client: clean(String(version.Client?.Version ?? "")),
        server: clean(String(version.Server?.Version ?? "")),
        os: clean(String(version.Server?.Os ?? "")),
        arch: clean(String(version.Server?.Arch ?? "")),
      }
    }
    if (input.action === "ps") {
      const args = ["ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"]
      if (input.all) args.splice(1, 0, "--all")
      const result = await runner(args, { cwd: root, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      return { containers: parseRows(result.stdout, ["id", "name", "image", "state", "status", "ports"]), untrusted: true }
    }
    if (input.action === "images") {
      const result = await runner(["image", "ls", "--no-trunc", "--format", "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.CreatedSince}}\t{{.Size}}"], { cwd: root, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      return { images: parseRows(result.stdout, ["id", "repository", "tag", "digest", "created", "size"]), untrusted: true }
    }
    if (input.action === "inspect") {
      const target = named(input.target, "inspect target")
      const result = await runner(["inspect", "--format", "{{.Id}}\t{{.Name}}\t{{.Config.Image}}\t{{.State.Status}}\t{{.State.Running}}\t{{.Created}}", "--", target], { cwd: root, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      return { target, records: parseRows(result.stdout, ["id", "name", "image", "status", "running", "created"]), untrusted: true }
    }
    if (input.action === "logs") {
      const target = named(input.target, "logs target")
      const tail = boundedInteger(input.tail, 200, 1, 5000, "tail")
      const result = await runner(["logs", "--tail", String(tail), "--", target], { cwd: root, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      return { target, tail, stdout: clean(result.stdout, MAX_OUTPUT_BYTES), stderr: clean(result.stderr, MAX_OUTPUT_BYTES), untrusted: true }
    }
    const intent = engineIntent(input)
    const state = await engineState(intent, root, runner)
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      return preview("engine", intent, state, sessionID, agent)
    }
    const record = consume(input, "engine", intent, sessionID, agent)
    if (state !== record.stateDigest) throw new Error("Docker target state changed after preview; preview again")
    const result = await runner(engineCommand(intent), { cwd: root, timeoutMs: MUTATION_TIMEOUT_MS, sanitizedEnv: true })
    return { dryRun: false, intent, stdout: clean(result.stdout, 64 * 1024), stderr: clean(result.stderr, 64 * 1024), stateDigest: await engineState(intent, root, runner), untrusted: true }
  }

  const compose = async (input: DockerComposeInput, sessionID: string, agent: string): Promise<DockerToolResult> => {
    const root = await rootPromise
    const resolved = await resolvedCompose(root, input, runner)
    if (input.action === "services") {
      return {
        services: resolved.availableServices,
        resourceLimited: resolved.availableServices.filter((service) => resolved.resourceLimited.has(service)),
        configSha256: resolved.configSha256,
      }
    }
    if (input.action === "ps") {
      const result = await runner([...resolved.prefix, "ps", "--all", "--format", "json"], { cwd: resolved.location.directory, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      return { output: clean(result.stdout, MAX_OUTPUT_BYTES), configSha256: resolved.configSha256, untrusted: true }
    }
    if (input.action === "logs") {
      const tail = boundedInteger(input.tail, 200, 1, 5000, "tail")
      const result = await runner([...resolved.prefix, "logs", "--no-color", "--tail", String(tail), ...resolved.services], { cwd: resolved.location.directory, timeoutMs: READ_TIMEOUT_MS, sanitizedEnv: true })
      return { stdout: clean(result.stdout, MAX_OUTPUT_BYTES), stderr: clean(result.stderr, MAX_OUTPUT_BYTES), tail, services: resolved.services, configSha256: resolved.configSha256, untrusted: true }
    }
    const intent = composeIntent(input, resolved)
    const state = await composeState(resolved, runner)
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      return preview("compose", intent, state, sessionID, agent)
    }
    const record = consume(input, "compose", intent, sessionID, agent)
    if (state !== record.stateDigest) throw new Error("Docker Compose state changed after preview; preview again")
    const result = await runner(composeCommand(resolved.prefix, intent), { cwd: resolved.location.directory, timeoutMs: MUTATION_TIMEOUT_MS, sanitizedEnv: true })
    const fresh = await resolvedCompose(root, input, runner)
    return { dryRun: false, intent, stdout: clean(result.stdout, 64 * 1024), stderr: clean(result.stderr, 64 * 1024), stateDigest: await composeState(fresh, runner), untrusted: true }
  }

  return { engine, compose }
}
