import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, readdir, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const SCREENSHOT_DIR = path.join(os.homedir(), "Pictures", "Screenshots")
export const YDOTOOL_TIMEOUT_MS = 5_000
export const CAPTURE_WAIT_MS = 10_000
export const CAPTURE_POLL_MS = 250
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024

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

export type CaptureResult =
  | { readonly ok: true; readonly mode: CaptureMode; readonly bytes: Buffer; readonly dimensions?: { width: number; height: number } }
  | { readonly ok: false; readonly message: string }

export async function captureScreenshot(mode: CaptureMode): Promise<CaptureResult> {
  const socket = socketPath()
  if (!socket || !existsSync(socket)) {
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
