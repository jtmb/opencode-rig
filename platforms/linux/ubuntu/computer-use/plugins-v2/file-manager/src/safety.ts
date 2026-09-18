import { createHash, randomUUID } from "node:crypto"
import { open, readFile, realpath, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"
import type { Stats } from "node:fs"

export const MAX_READ_BYTES = 2 * 1024 * 1024
export const MAX_EDIT_BYTES = 512 * 1024
const MAX_EDITOR_PARTS = 32
const MAX_EDITOR_PART_LENGTH = 512

export class PathSafetyError extends Error {
  readonly code = "PATH_SAFETY"
}

export class DiskConflictError extends Error {
  readonly code = "DISK_CONFLICT"
}

export type SafePath = {
  relative: string
  absolute: string
  canonical: string
  info: Stats
}

export type SafeTextFile = SafePath & {
  content: string
  fingerprint: string
  mode: number
}

export type SaveSnapshot = {
  path: string
  content: string
  diskFingerprint: string
  mode: number
  revision: number
}

export type PathGuard = {
  readonly root: string
  normalize(value: unknown): string
  inspect(relative: unknown): Promise<SafePath>
  readText(relative: unknown): Promise<SafeTextFile>
  writeText(snapshot: SaveSnapshot): Promise<SafeTextFile>
}

function fail(message: string): never {
  throw new PathSafetyError(message)
}

function relativeParts(value: string): string[] {
  return value.split("/")
}

function hasGitComponent(relative: string): boolean {
  return relativeParts(relative).some((part) => part === ".git")
}

function canonicalRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/")
  return relative
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Validate a path before it is resolved against a project root. */
export function normalizeSafeRelative(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("path must be a non-empty string")
  if (value.includes("\0")) fail("path contains a NUL byte")

  const slashValue = value.replaceAll("\\", "/")
  if (
    slashValue.startsWith("/") ||
    slashValue.startsWith("//") ||
    path.posix.isAbsolute(slashValue) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail("absolute paths are not allowed")
  }

  const parts = relativeParts(slashValue)
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail("empty, current-directory, and traversal path components are not allowed")
  }
  if (parts.some((part) => part === ".git")) fail(".git paths are not allowed")
  return parts.join("/")
}

export function isLexicallySafeRelative(value: unknown): value is string {
  try {
    normalizeSafeRelative(value)
    return true
  } catch {
    return false
  }
}

function modeBits(info: Stats): number {
  return info.mode & 0o7777
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function fingerprint(info: Stats, bytes: Uint8Array): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, modeBits(info), hashBytes(bytes)].join(":")
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new PathSafetyError("file is not valid UTF-8")
  }
}

async function inspectPath(root: string, value: unknown): Promise<SafePath> {
  const relative = normalizeSafeRelative(value)
  const absolute = path.resolve(root, ...relativeParts(relative))
  if (!contained(root, absolute)) fail("path resolves outside the project")

  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch {
    throw new PathSafetyError(`path does not exist: ${relative}`)
  }
  if (!contained(root, canonical)) fail("symlink resolves outside the project")

  const canonicalPath = canonicalRelative(root, canonical)
  if (canonicalPath === "" || hasGitComponent(canonicalPath)) fail(".git paths are not allowed")

  let info: Stats
  try {
    info = await stat(canonical)
  } catch {
    throw new PathSafetyError(`cannot inspect path: ${relative}`)
  }
  return { relative, absolute, canonical, info }
}

async function readText(root: string, value: unknown): Promise<SafeTextFile> {
  const safe = await inspectPath(root, value)
  if (!safe.info.isFile()) fail("directories and special files cannot be edited")
  if (safe.info.size > MAX_READ_BYTES) fail(`file exceeds the ${MAX_READ_BYTES}-byte read limit`)

  let bytes: Buffer
  try {
    bytes = await readFile(safe.canonical)
  } catch {
    throw new PathSafetyError(`cannot read file: ${safe.relative}`)
  }
  if (bytes.length > MAX_READ_BYTES) fail(`file exceeds the ${MAX_READ_BYTES}-byte read limit`)
  if (bytes.includes(0)) fail("binary files cannot be edited")

  const content = decodeUtf8(bytes)
  const after = await stat(safe.canonical).catch(() => undefined)
  if (!after || !after.isFile()) fail("file changed while it was being read")
  if (
    after.dev !== safe.info.dev ||
    after.ino !== safe.info.ino ||
    after.size !== safe.info.size ||
    after.mtimeMs !== safe.info.mtimeMs
  ) {
    fail("file changed while it was being read")
  }
  if (after.size > MAX_READ_BYTES) fail(`file exceeds the ${MAX_READ_BYTES}-byte read limit`)

  return {
    ...safe,
    info: after,
    content,
    fingerprint: fingerprint(after, bytes),
    mode: modeBits(after),
  }
}

async function writeText(root: string, snapshot: SaveSnapshot): Promise<SafeTextFile> {
  const current = await readText(root, snapshot.path)
  if (current.fingerprint !== snapshot.diskFingerprint) {
    throw new DiskConflictError(`disk changed since ${snapshot.path} was opened`)
  }

  const encoded = new TextEncoder().encode(snapshot.content)
  if (encoded.length > MAX_EDIT_BYTES) fail(`file exceeds the ${MAX_EDIT_BYTES}-byte edit limit`)
  const temporary = path.join(
    path.dirname(current.canonical),
    `.${path.basename(current.canonical)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, "wx", snapshot.mode)
    await handle.writeFile(encoded)
    await handle.chmod(snapshot.mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, current.canonical)

    const written = await readText(root, snapshot.path)
    if (written.content !== snapshot.content) {
      throw new DiskConflictError(`disk changed while ${snapshot.path} was being saved`)
    }
    return written
  } finally {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

/** Canonicalize a project root once and expose all file operations through it. */
export async function createPathGuard(projectRoot: string): Promise<PathGuard> {
  let root: string
  try {
    root = await realpath(projectRoot)
  } catch {
    throw new PathSafetyError("project root does not exist")
  }
  if (hasGitComponent(root.split(path.sep).join("/"))) {
    throw new PathSafetyError("project root is inside .git")
  }
  const info = await stat(root)
  if (!info.isDirectory()) throw new PathSafetyError("project root is not a directory")

  return {
    root,
    normalize: normalizeSafeRelative,
    inspect: (relative) => inspectPath(root, relative),
    readText: (relative) => readText(root, relative),
    writeText: (snapshot) => writeText(root, snapshot),
  }
}

export type EditorCommand = {
  command: string
  args: string[]
}

/** Parse a bounded editor command without invoking a shell. */
export function parseEditorCommand(value: string): EditorCommand | undefined {
  if (!value || value.length > MAX_EDITOR_PART_LENGTH * MAX_EDITOR_PARTS) return undefined
  const parts: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  let started = false

  const push = () => {
    if (!started) return
    if (!current || current.length > MAX_EDITOR_PART_LENGTH) return undefined
    parts.push(current)
    current = ""
    started = false
    if (parts.length > MAX_EDITOR_PARTS) return undefined
    return true
  }

  for (const character of value.trim()) {
    if (escaped) {
      current += character
      escaped = false
      started = true
      continue
    }
    if (character === "\\" && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (character === quote) quote = undefined
      else current += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started && push() === undefined) return undefined
      continue
    }
    if (/[^\p{L}\p{N}\s._/+:=@%,-]/u.test(character)) return undefined
    current += character
    started = true
  }
  if (escaped || quote || push() === undefined || parts.length === 0) return undefined
  return { command: parts[0], args: parts.slice(1) }
}
