import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PowerShellHostClient } from "../../../../../../windows/wsl2/ubuntu/computer-use/plugins-v2/wsl-interop/src/powershell-host.ts"

export const SCREENSHOT_DIR = path.join(os.homedir(), "Pictures", "Screenshots")
export const YDOTOOL_TIMEOUT_MS = 5_000
export const CAPTURE_WAIT_MS = 10_000
export const CAPTURE_POLL_MS = 250
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024
export const WSL_CAPTURE_OUTPUT_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 16_384

export type CaptureMode = "screen" | "window"

export const KEY_SEQUENCES: Record<CaptureMode, readonly string[]> = {
  screen: ["42:1", "99:1", "99:0", "42:0"],
  window: ["56:1", "99:1", "99:0", "56:0"],
}

export function keySequence(mode: CaptureMode): string[] {
  return [...KEY_SEQUENCES[mode]]
}

export function isScreenshotName(name: string): boolean {
  return name.toLowerCase().endsWith(".png")
}

export function newScreenshots(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before)
  return after.filter((name) => !known.has(name)).sort()
}

export function isAttachmentSize(bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_ATTACHMENT_BYTES
}

export function pngDataUri(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`
}

export function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const signature = bytes.subarray(0, 8)
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!signature.equals(expected)) return undefined
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

export type RetainedScreenshot = {
  readonly path: string
  readonly sha256: string
  readonly dimensions: { readonly width: number; readonly height: number }
}

type ScreenshotDirectoryHandle = Awaited<ReturnType<typeof open>>

// Keep each parent directory pinned so a symlink swap cannot redirect the write.
async function openScreenshotDirectory(root: string, relativeDirectory: string): Promise<ScreenshotDirectoryHandle> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  let directory = await open(root, flags)
  try {
    for (const part of relativeDirectory ? relativeDirectory.split(path.sep) : []) {
      const child = path.join(`/proc/self/fd/${directory.fd}`, part)
      try {
        const info = await lstat(child)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("screenshot path contains a non-directory or symlink")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await mkdir(child, { mode: 0o755 })
        const info = await lstat(child)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("screenshot path contains a non-directory or symlink")
      }
      const next = await open(child, flags)
      const previous = directory
      directory = next
      await previous.close()
    }
    return directory
  } catch (error) {
    await directory.close().catch(() => undefined)
    throw error
  }
}

export async function retainScreenshot(
  bytes: Buffer,
  savePath: string,
  workingDirectory = process.cwd(),
): Promise<RetainedScreenshot | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let directoryHandle: ScreenshotDirectoryHandle | undefined
  let temporaryPath: string | undefined
  let targetPath: string | undefined
  let destinationPath: string | undefined
  let published = false
  try {
    if (!isAttachmentSize(bytes.length) || typeof savePath !== "string" || savePath.length < 1 || savePath.length > 4096) {
      throw new Error("screenshot retention input is outside its bounds")
    }
    if (savePath.includes("\0") || savePath.includes("\\") || (path.win32.isAbsolute(savePath) && !path.isAbsolute(savePath)) || savePath.split(path.sep).includes("..")) {
      throw new Error("screenshot path must not contain traversal or platform-specific separators")
    }
    if (path.extname(savePath) !== ".png") throw new Error("screenshot path must end in .png")

    const root = await realpath(workingDirectory)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("working directory is not a regular directory")
    targetPath = path.resolve(root, savePath)
    const relativePath = path.relative(root, targetPath)
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error("screenshot path must resolve beneath the working directory")
    }

    const dimensions = pngDimensions(bytes)
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error("captured screenshot has no valid PNG dimensions")

    const relativeDirectory = path.dirname(relativePath)
    directoryHandle = await openScreenshotDirectory(root, relativeDirectory === "." ? "" : relativeDirectory)
    const directoryPath = `/proc/self/fd/${directoryHandle.fd}`
    destinationPath = path.join(directoryPath, path.basename(targetPath))
    const existing = await lstat(destinationPath).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    })
    if (existing) throw new Error("screenshot destination already exists")

    temporaryPath = path.join(directoryPath, `.${path.basename(targetPath)}.${randomUUID()}.tmp`)
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(bytes)
    await handle.chmod(0o644)
    await handle.sync()
    await handle.close()
    handle = undefined

    await link(temporaryPath, destinationPath)
    published = true
    await unlink(temporaryPath)
    temporaryPath = undefined

    return {
      path: targetPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dimensions,
    }
  } catch {
    await handle?.close().catch(() => undefined)
    if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
    if (published && destinationPath) await unlink(destinationPath).catch(() => undefined)
    return undefined
  } finally {
    await directoryHandle?.close().catch(() => undefined)
  }
}

export function isWslKernel(release: string): boolean {
  return /(?:microsoft|wsl)/iu.test(release)
}

export function decodeWindowsScreenshot(
  mode: CaptureMode,
  value: unknown,
): Extract<CaptureResult, { ok: true }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows screenshot host returned an invalid result")
  const source = value as Record<string, unknown>
  if (source.mimeType !== "image/png" || typeof source.data !== "string") throw new Error("Windows screenshot host did not return a PNG")
  if (!Number.isInteger(source.width) || Number(source.width) < 1 || Number(source.width) > 32_768) throw new Error("Windows screenshot width is invalid")
  if (!Number.isInteger(source.height) || Number(source.height) < 1 || Number(source.height) > 32_768) throw new Error("Windows screenshot height is invalid")
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source.data)) {
    throw new Error("Windows screenshot data is not canonical base64")
  }
  const bytes = Buffer.from(source.data, "base64")
  if (bytes.toString("base64") !== source.data || !isAttachmentSize(bytes.length)) throw new Error("Windows screenshot data exceeds the attachment boundary")
  if (source.bytes !== bytes.length) throw new Error("Windows screenshot byte count is invalid")
  const dimensions = pngDimensions(bytes)
  if (!dimensions || dimensions.width !== source.width || dimensions.height !== source.height) {
    throw new Error("Windows screenshot PNG dimensions do not match the host result")
  }
  return { ok: true, mode, bytes, dimensions }
}

export function socketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
  return runtime ? path.join(runtime, ".ydotool_socket") : ""
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listScreenshots(): Promise<string[]> {
  const entries = await readdir(SCREENSHOT_DIR)
  return entries.filter(isScreenshotName).sort()
}

function runYdotool(sequence: string[], socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ydotool",
      ["key", ...sequence],
      { timeout: YDOTOOL_TIMEOUT_MS, env: { ...process.env, YDOTOOL_SOCKET: socket } },
      (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      },
    )
  })
}

async function captureWindowsScreenshot(mode: CaptureMode): Promise<CaptureResult> {
  const client = new PowerShellHostClient(process.cwd(), {
    preferred: "auto",
    timeoutMs: 15_000,
    maxOutputBytes: 262_144,
  })
  try {
    const response = await client.request("auto", "windows.screenshot", { mode }, {
      timeoutMs: 15_000,
      maxOutputBytes: WSL_CAPTURE_OUTPUT_BYTES,
    })
    return decodeWindowsScreenshot(mode, response.result)
  } catch (error) {
    return { ok: false, message: `Windows screenshot capture failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export type CaptureResult =
  | { readonly ok: true; readonly mode: CaptureMode; readonly bytes: Buffer; readonly dimensions?: { width: number; height: number } }
  | { readonly ok: false; readonly message: string }

export async function captureScreenshot(mode: CaptureMode): Promise<CaptureResult> {
  const socket = socketPath()
  if (!socket || !existsSync(socket)) {
    let release = ""
    try {
      release = await readFile("/proc/sys/kernel/osrelease", "utf8")
    } catch {
      // The native error below remains accurate when the kernel cannot be identified.
    }
    if (isWslKernel(release)) return captureWindowsScreenshot(mode)
    return { ok: false, message: "ydotool's private socket is unavailable; ask the user to press PrintScreen (or Alt+PrintScreen) instead." }
  }
  if (!existsSync(SCREENSHOT_DIR)) {
    return { ok: false, message: `Screenshot directory not found: ${SCREENSHOT_DIR}. Ask the user to press PrintScreen once so GNOME creates it.` }
  }

  let before: string[]
  try {
    before = await listScreenshots()
  } catch (error) {
    return { ok: false, message: `Cannot read ${SCREENSHOT_DIR}: ${error instanceof Error ? error.message : String(error)}` }
  }

  try {
    await runYdotool(keySequence(mode), socket)
  } catch (error) {
    return { ok: false, message: `ydotool failed to send the screenshot shortcut: ${error instanceof Error ? error.message : String(error)}` }
  }

  const deadline = Date.now() + CAPTURE_WAIT_MS
  let created: string[] = []
  while (Date.now() < deadline) {
    await delay(CAPTURE_POLL_MS)
    let after: string[]
    try {
      after = await listScreenshots()
    } catch {
      continue
    }
    created = newScreenshots(before, after)
    if (created.length >= 1) break
  }

  if (created.length === 0) {
    return { ok: false, message: "No new screenshot appeared; verify the GNOME screenshot shortcut and that ydotool is active, or ask the user to press PrintScreen." }
  }
  if (created.length > 1) {
    return { ok: false, message: `More than one new screenshot appeared (${created.join(", ")}); refusing to guess which to inspect.` }
  }

  const filePath = path.join(SCREENSHOT_DIR, created[0])
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch (error) {
    await unlink(filePath).catch(() => undefined)
    return { ok: false, message: `Captured ${created[0]} but could not read it: ${error instanceof Error ? error.message : String(error)}` }
  }
  await unlink(filePath).catch(() => undefined)

  if (!isAttachmentSize(bytes.length)) {
    return { ok: false, message: `Captured ${created[0]} (${Math.round(bytes.length / 1024)} KiB) but it is too large to attach; the file was deleted.` }
  }

  const dimensions = pngDimensions(bytes)
  return dimensions ? { ok: true, mode, bytes, dimensions } : { ok: true, mode, bytes }
}
