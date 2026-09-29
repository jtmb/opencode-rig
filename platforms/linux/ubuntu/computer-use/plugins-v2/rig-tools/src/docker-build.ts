import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"

import type { DockerRunner } from "./docker-tools.ts"

const TOKEN_TTL_MS = 5 * 60_000
const MAX_TOKENS = 64
const MAX_FILES = 10_000
const MAX_CONTEXT_BYTES = 512 * 1024 * 1024
const MAX_DEPTH = 32
const MAX_DOCKERFILE_BYTES = 1024 * 1024
const HARD_PID_LIMIT = 256
const BUILD_TIMEOUT_MS = 15 * 60_000
const BUILD_OUTPUT_BYTES = 64 * 1024
const IMAGE = /^(?:[A-Za-z0-9._-]+(?::[0-9]+)?\/)?[A-Za-z0-9._/-]+(?:[:@][A-Za-z0-9._:+-]+)?$/
const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const PLATFORM = /^linux\/(?:amd64|arm64|arm\/v7|386|ppc64le|s390x)$/

export type DockerBuildInput = {
  backend?: "docker" | "buildx"
  context?: string
  dockerfile?: string
  tag: string
  target?: string
  platform?: string
  memoryMiB?: number
  cpus?: number
  pull?: boolean
  noCache?: boolean
  apply?: boolean
  expectToken?: string
}

type BuildIntent = {
  backend: "docker" | "buildx"
  context: string
  dockerfile: string
  tag: string
  target?: string
  platform?: string
  memoryMiB: number
  cpus: number
  pull: boolean
  noCache: boolean
}

type Token = {
  token: string
  sessionID: string
  agent: string
  intentDigest: string
  contextDigest: string
  imageDigest: string
  expiresAt: number
}

function within(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function imageRef(value: unknown) {
  if (typeof value !== "string" || value.length > 512 || !IMAGE.test(value) || value.startsWith("-") || value.includes("..")) throw new Error("tag is missing or invalid")
  return value
}

function boundedPath(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded path`)
  }
  return value
}

function boundedOutput(value: string) {
  return Buffer.from(value, "utf8").subarray(0, BUILD_OUTPUT_BYTES).toString("utf8")
}

async function buildIntent(root: string, input: DockerBuildInput): Promise<BuildIntent> {
  const contextValue = input.context ?? root
  if (typeof contextValue !== "string" || !isAbsolute(contextValue)) throw new Error("build context must be absolute")
  const context = await realpath(contextValue)
  if (!within(root, context)) throw new Error("build context must stay inside the current project")
  const contextInfo = await lstat(context)
  if (!contextInfo.isDirectory() || contextInfo.isSymbolicLink()) throw new Error("build context must be a regular directory")
  const dockerfileValue = resolve(context, boundedPath(input.dockerfile ?? "Dockerfile", "Dockerfile"))
  if (!within(context, dockerfileValue)) throw new Error("Dockerfile must stay inside the build context")
  const dockerfile = await realpath(dockerfileValue)
  const dockerfileInfo = await lstat(dockerfile)
  if (!dockerfileInfo.isFile() || dockerfileInfo.isSymbolicLink() || !within(context, dockerfile)) throw new Error("Dockerfile must be a regular non-symlink file inside the context")
  if (dockerfileInfo.size > MAX_DOCKERFILE_BYTES) throw new Error(`Dockerfile exceeds the ${MAX_DOCKERFILE_BYTES}-byte limit`)
  const memoryMiB = input.memoryMiB ?? 1024
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 256 || memoryMiB > 8192) throw new Error("memoryMiB must be an integer from 256 through 8192")
  const cpus = input.cpus ?? 1
  if (typeof cpus !== "number" || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 8) throw new Error("cpus must be from 0.1 through 8")
  if (input.target !== undefined && (typeof input.target !== "string" || !TARGET.test(input.target))) throw new Error("target is invalid")
  if (input.platform !== undefined && (typeof input.platform !== "string" || !PLATFORM.test(input.platform))) throw new Error("platform is unsupported or invalid")
  if (input.backend !== undefined && input.backend !== "docker" && input.backend !== "buildx") throw new Error("backend must be docker or buildx")
  const dockerfileText = await readFile(dockerfile, "utf8")
  if (Buffer.byteLength(dockerfileText, "utf8") > MAX_DOCKERFILE_BYTES) throw new Error(`Dockerfile exceeds the ${MAX_DOCKERFILE_BYTES}-byte limit`)
  if (/^\s*(?:RUN\s+)?--mount=[^\n]*\b(?:type=(?:bind|ssh|secret)|source=\/|target=\/proc|target=\/sys)/im.test(dockerfileText) || /^\s*RUN\s+--security=insecure\b/im.test(dockerfileText) || /^\s*RUN\s+--network=host\b/im.test(dockerfileText)) {
    throw new Error("Dockerfile requests a forbidden host, bind, secret, SSH, or insecure build feature")
  }
  return {
    backend: input.backend ?? "docker",
    context,
    dockerfile,
    tag: imageRef(input.tag),
    target: input.target,
    platform: input.platform,
    memoryMiB,
    cpus,
    pull: input.pull === true,
    noCache: input.noCache === true,
  }
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>) {
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolvePromise)
  })
}

/** Hash the exact bounded context without loading it into process memory. */
export async function fingerprintBuildContext(root: string) {
  const hash = createHash("sha256")
  let files = 0
  let bytes = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) throw new Error(`build context exceeds the ${MAX_DEPTH}-level depth limit`)
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const name = relative(root, path)
      if (entry.isSymbolicLink()) throw new Error(`build context symlinks are refused: ${name}`)
      if (entry.isDirectory()) {
        hash.update(`d\0${name}\0`)
        await visit(path, depth + 1)
        continue
      }
      if (!entry.isFile()) throw new Error(`build context special files are refused: ${name}`)
      const info = await lstat(path)
      files += 1
      bytes += info.size
      if (files > MAX_FILES) throw new Error(`build context exceeds the ${MAX_FILES}-file limit`)
      if (bytes > MAX_CONTEXT_BYTES) throw new Error(`build context exceeds the ${MAX_CONTEXT_BYTES}-byte limit`)
      hash.update(`f\0${name}\0${info.mode & 0o7777}\0${info.size}\0`)
      await hashFile(path, hash)
      hash.update("\0")
    }
  }
  await visit(root, 0)
  return { sha256: hash.digest("hex"), files, bytes }
}

async function imageState(intent: BuildIntent, runner: DockerRunner) {
  try {
    const result = await runner(["image", "inspect", "--format", "{{json .RepoDigests}}", "--", intent.tag], { cwd: intent.context, timeoutMs: 30_000, sanitizedEnv: true })
    return digest({ exists: true, output: result.stdout })
  } catch {
    return digest({ exists: false, tag: intent.tag })
  }
}

function buildFlags(intent: BuildIntent) {
  const flags = ["--file", intent.dockerfile, "--tag", intent.tag, "--network", "none"]
  if (intent.target) flags.push("--target", intent.target)
  if (intent.platform) flags.push("--platform", intent.platform)
  if (intent.pull) flags.push("--pull")
  if (intent.noCache) flags.push("--no-cache")
  return flags
}

function classicCommand(intent: BuildIntent) {
  const quota = Math.max(1, Math.floor(intent.cpus * 100_000))
  return [
    "build",
    "--memory", `${intent.memoryMiB}m`,
    "--memory-swap", `${intent.memoryMiB}m`,
    "--cpu-period", "100000",
    "--cpu-quota", String(quota),
    "--ulimit", `nproc=${HARD_PID_LIMIT}:${HARD_PID_LIMIT}`,
    "--security-opt", "no-new-privileges",
    ...buildFlags(intent),
    "--",
    intent.context,
  ]
}

export function createDockerBuildTool(projectDirectory: string, runner: DockerRunner, now: () => number = Date.now) {
  const rootPromise = realpath(projectDirectory)
  const tokens = new Map<string, Token>()
  return async (input: DockerBuildInput, sessionID: string, agent: string) => {
    const root = await rootPromise
    const intent = await buildIntent(root, input)
    const context = await fingerprintBuildContext(intent.context)
    const currentImage = await imageState(intent, runner)
    const intentDigest = digest(intent)
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key)
      if (tokens.size >= MAX_TOKENS) throw new Error("Docker build preview capacity is full")
      const token = randomBytes(24).toString("base64url")
      const record: Token = { token, sessionID, agent, intentDigest, contextDigest: context.sha256, imageDigest: currentImage, expiresAt: now() + TOKEN_TTL_MS }
      tokens.set(token, record)
      return { dryRun: true, intent, context, imageDigest: currentImage, expectToken: token, expiresAt: record.expiresAt, memoryPolicy: "explicit-hard-limit" }
    }
    const record = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!record || record.expiresAt <= now()) throw new Error("Docker build preview token is missing or expired")
    tokens.delete(record.token)
    if (record.sessionID !== sessionID || record.agent !== agent || record.intentDigest !== intentDigest) throw new Error("Docker build token does not match this session, agent, and intent")
    if (record.contextDigest !== context.sha256 || record.imageDigest !== currentImage) throw new Error("Docker build context or target image changed after preview; preview again")

    let result: Awaited<ReturnType<DockerRunner>>
    if (intent.backend === "docker") {
      result = await runner(classicCommand(intent), { cwd: intent.context, timeoutMs: BUILD_TIMEOUT_MS, sanitizedEnv: true })
    } else {
      const builder = `open-rig-${randomBytes(8).toString("hex")}`
      const quota = Math.max(1, Math.floor(intent.cpus * 100_000))
      await runner([
        "buildx", "create", "--name", builder, "--driver", "docker-container", "--bootstrap",
        "--driver-opt", `memory=${intent.memoryMiB}m`,
        "--driver-opt", `memory-swap=${intent.memoryMiB}m`,
        "--driver-opt", "cpu-period=100000",
        "--driver-opt", `cpu-quota=${quota}`,
      ], { cwd: intent.context, timeoutMs: 60_000, sanitizedEnv: true })
      try {
        await runner([
          "container", "update",
          "--memory", `${intent.memoryMiB}m`,
          "--memory-swap", `${intent.memoryMiB}m`,
          "--cpu-period", "100000",
          "--cpu-quota", String(quota),
          "--pids-limit", String(HARD_PID_LIMIT),
          "--", `buildx_buildkit_${builder}0`,
        ], { cwd: intent.context, timeoutMs: 60_000, sanitizedEnv: true })
        result = await runner(["buildx", "build", "--builder", builder, "--load", ...buildFlags(intent), "--", intent.context], { cwd: intent.context, timeoutMs: BUILD_TIMEOUT_MS, sanitizedEnv: true })
      } finally {
        await runner(["buildx", "rm", "--force", builder], { cwd: intent.context, timeoutMs: 60_000, sanitizedEnv: true })
      }
    }
    return {
      dryRun: false,
      intent,
      context,
      stdout: boundedOutput(result.stdout),
      stderr: boundedOutput(result.stderr),
      imageDigest: await imageState(intent, runner),
      memoryPolicy: "explicit-hard-limit",
      untrusted: true,
    }
  }
}
