import { spawn } from "node:child_process"

export interface ProcessResult {
  stdout: Buffer
  stderr: Buffer
  exitCode: number
}

export interface ProcessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
  terminationGraceMs?: number
}

export function decodeProcessOutput(bytes: Buffer): string {
  let encoding: "utf-8" | "utf-16le" = "utf-8"
  let payload = bytes
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le"
    payload = bytes.subarray(2)
  } else {
    let nulls = 0
    const sample = Math.min(bytes.length, 512)
    for (let index = 1; index < sample; index += 2) {
      if (bytes[index] === 0) nulls += 1
    }
    if (sample >= 4 && nulls > sample / 8) encoding = "utf-16le"
  }
  if (encoding === "utf-16le" && payload.length % 2 !== 0) {
    throw new Error("PowerShell output contains malformed UTF-16LE bytes")
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(payload).replace(/^\uFEFF/u, "")
  } catch (error) {
    throw new Error(`PowerShell output contains malformed ${encoding.toUpperCase()} bytes`, { cause: error })
  }
}

export function runBoundedProcess(
  file: string,
  args: string[],
  stdin: string,
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (!file.startsWith("/")) return Promise.reject(new Error("bounded process executable must be absolute"))
  if (options.signal?.aborted) return Promise.reject(new Error("process request was cancelled"))
  return new Promise((resolve, reject) => {
    const hasInput = Buffer.byteLength(stdin, "utf8") > 0
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let terminating: Error | undefined
    let timer: NodeJS.Timeout | undefined
    let terminationTimer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (terminationTimer) clearTimeout(terminationTimer)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const settleError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const terminate = (error: Error) => {
      if (settled || terminating) return
      terminating = error
      if (timer) clearTimeout(timer)
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      } else {
        child.kill("SIGKILL")
      }
      terminationTimer = setTimeout(() => {
        settleError(new Error(`${error.message}; process termination was not confirmed`))
      }, options.terminationGraceMs ?? 2_000)
    }
    const onAbort = () => terminate(new Error("process request was cancelled"))
    const collect = (target: Buffer[], value: Buffer) => {
      if (settled || terminating) return
      outputBytes += value.length
      if (outputBytes > options.maxOutputBytes) {
        terminate(new Error(`process output exceeded ${options.maxOutputBytes} bytes`))
        return
      }
      target.push(value)
    }
    child.stdout!.on("data", (value: Buffer) => collect(stdout, value))
    child.stderr!.on("data", (value: Buffer) => collect(stderr, value))
    child.on("error", settleError)
    child.on("close", (code) => {
      if (settled) return
      if (terminating) {
        settleError(new Error(`${terminating.message}; process group exited`))
        return
      }
      settled = true
      cleanup()
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? -1 })
    })
    options.signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(
      () => terminate(new Error(`process timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    )
    if (hasInput && child.stdin) {
      child.stdin.on("error", (error) => {
        if (!terminating) terminate(error)
      })
      child.stdin.end(stdin, "utf8")
    }
  })
}
