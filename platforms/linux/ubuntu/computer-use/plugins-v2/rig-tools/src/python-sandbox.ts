import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const BWRAP = "/usr/bin/bwrap"
const PYTHON = "/usr/bin/python3"
const PRLIMIT = "/usr/bin/prlimit"
const BOUNDED_RUNNER = fileURLToPath(new URL("../../../scripts/run-bounded-command.sh", import.meta.url))
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000
const MAX_CODE_BYTES = 64 * 1024
const MAX_STDIN_BYTES = 128 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_ARGS = 32
const MAX_ARG_BYTES = 4 * 1024
const MAX_ARGS_BYTES = 32 * 1024
const RUNNER_TIMEOUT_GRACE_MS = 2_000

export type PythonSandboxInput = {
  code: string
  stdin?: string
  args?: string[]
  timeoutMs?: number
}

export type PythonSandboxProcessResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
}

export type PythonSandboxRunner = (
  file: string,
  args: string[],
  options: { stdin: string; timeoutMs: number },
) => Promise<PythonSandboxProcessResult>

type NormalizedPythonInput = {
  code: string
  stdin: string
  args: string[]
  timeoutMs: number
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8")
}

export function normalizePythonSandboxInput(input: PythonSandboxInput): NormalizedPythonInput {
  if (typeof input.code !== "string" || input.code.length === 0) throw new Error("code must be a non-empty string")
  if (byteLength(input.code) > MAX_CODE_BYTES) throw new Error(`code exceeds the ${MAX_CODE_BYTES}-byte limit`)
  const stdin = input.stdin ?? ""
  if (typeof stdin !== "string" || byteLength(stdin) > MAX_STDIN_BYTES) {
    throw new Error(`stdin must be a string no larger than ${MAX_STDIN_BYTES} bytes`)
  }
  const args = input.args ?? []
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || byteLength(arg) > MAX_ARG_BYTES)) {
    throw new Error(`args must contain at most ${MAX_ARGS} strings of at most ${MAX_ARG_BYTES} bytes each`)
  }
  if (args.reduce((total, arg) => total + byteLength(arg), 0) > MAX_ARGS_BYTES) {
    throw new Error(`combined args exceed the ${MAX_ARGS_BYTES}-byte limit`)
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 100 through ${MAX_TIMEOUT_MS}`)
  }
  return { code: input.code, stdin, args: [...args], timeoutMs }
}

export function buildPythonSandboxArgs(projectRoot: string, input: NormalizedPythonInput): string[] {
  const mounts = ["/usr", "/bin", "/lib", "/lib64"]
    .filter((path) => existsSync(path))
    .flatMap((path) => ["--ro-bind", path, path])
  const etc = existsSync("/etc/ld.so.cache")
    ? ["--dir", "/etc", "--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    : []
  const cpuSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1000) + 1)
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...mounts,
    ...etc,
    "--proc", "/proc",
    "--dev", "/dev",
    "--size", `${16 * 1024 * 1024}`,
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--dir", "/workspace",
    "--ro-bind", projectRoot, "/workspace",
    "--chdir", "/workspace",
    "--clearenv",
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    PRLIMIT,
    `--as=${512 * 1024 * 1024}`,
    `--cpu=${cpuSeconds}`,
    "--nofile=128",
    `--fsize=${8 * 1024 * 1024}`,
    "--",
    PYTHON,
    "-I",
    "-S",
    "-B",
    "-c",
    input.code,
    ...input.args,
  ]
}

export function pythonSandboxRunnerEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return {
    PATH: "/usr/bin:/bin",
    HOME: source.HOME ?? "/nonexistent",
    ...(source.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR } : {}),
    ...(source.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: source.DBUS_SESSION_BUS_ADDRESS } : {}),
  }
}

export const runPythonSandboxProcess: PythonSandboxRunner = (file, args, options) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: pythonSandboxRunnerEnvironment(),
  })
  let stdout = ""
  let stderr = ""
  let stdoutBytes = 0
  let stderrBytes = 0
  let settled = false
  let overflow = false
  let timedOut = false
  let grace: NodeJS.Timeout | undefined
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch { /* process already exited */ }
  }
  const stop = () => {
    killTree("SIGTERM")
    grace ??= setTimeout(() => { if (!settled) killTree("SIGKILL") }, 100)
  }
  const append = (target: "stdout" | "stderr", chunk: Buffer) => {
    if (overflow) return
    if (target === "stdout") stdoutBytes += chunk.length
    else stderrBytes += chunk.length
    if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
      overflow = true
      stop()
      return
    }
    if (target === "stdout") stdout += chunk.toString("utf8")
    else stderr += chunk.toString("utf8")
  }
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk))
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk))
  child.stdin.on("error", () => { /* child may exit before consuming input */ })
  child.stdin.end(options.stdin)
  const timer = setTimeout(() => {
    if (settled) return
    timedOut = true
    stop()
  }, options.timeoutMs)
  const finish = (error?: Error, result?: PythonSandboxProcessResult) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (grace) clearTimeout(grace)
    if (error) reject(error)
    else resolve(result!)
  }
  child.once("error", (error) => finish(error))
  child.once("close", (exitCode, signal) => {
    if (timedOut) finish(new Error(`sandboxed Python timed out after ${options.timeoutMs}ms`))
    else if (overflow) finish(new Error(`sandboxed Python output exceeded ${MAX_OUTPUT_BYTES} bytes`))
    else finish(undefined, { exitCode, signal, stdout, stderr, stdoutBytes, stderrBytes })
  })
})

export function createPythonSandbox(projectDirectory: string, runner: PythonSandboxRunner = runPythonSandboxProcess) {
  return async (raw: PythonSandboxInput) => {
    const input = normalizePythonSandboxInput(raw)
    if (!existsSync(BWRAP) || !existsSync(PYTHON) || !existsSync(PRLIMIT) || !existsSync(BOUNDED_RUNNER)) {
      throw new Error("sandboxed Python requires bwrap, Python, prlimit, and the bounded command runner")
    }
    const root = await realpath(projectDirectory)
    const info = await stat(root)
    if (!info.isDirectory()) throw new Error("project directory is unavailable")
    const result = await runner(BOUNDED_RUNNER, [
      "--require-cgroup",
      "--memory-fraction", "10",
      "--swap-fraction", "5",
      "--timeout", `${input.timeoutMs}ms`,
      "--lock-timeout", "5",
      "--",
      BWRAP,
      ...buildPythonSandboxArgs(root, input),
    ], {
      stdin: input.stdin,
      timeoutMs: input.timeoutMs + RUNNER_TIMEOUT_GRACE_MS,
    })
    return {
      ...result,
      codeSha256: createHash("sha256").update(input.code).digest("hex"),
      sandbox: {
        project: "read-only",
        temporaryStorage: "ephemeral",
        network: "disabled",
        environment: "cleared",
        userSite: "disabled",
        resources: "aggregate-cgroup",
      },
      untrusted: true,
    }
  }
}
