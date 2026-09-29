import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path"

import { OFFLINE_RECENCY_MS, type ProviderActivity } from "./state.ts"

export const MAX_PERSISTED_ACTIVITY_ENTRIES = 512
export const MAX_PERSISTED_ACTIVITY_BYTES = 64 * 1024
const MAX_PROVIDER_ID_LENGTH = 128

type ActivityState = {
  activities: ProviderActivity[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizedProviderID(value: unknown) {
  if (typeof value !== "string") return undefined
  const result = value.trim().toLowerCase()
  if (!result || result.length > MAX_PROVIDER_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(result)) return undefined
  return result
}

function activityTimestamp(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}

function stateEntries(entries: readonly ProviderActivity[], now: number, windowMs: number) {
  const cutoff = now - windowMs
  const latest = new Map<string, number>()
  for (const entry of entries) {
    const providerID = normalizedProviderID(entry.providerID)
    const at = activityTimestamp(entry.at)
    if (!providerID || at === undefined || at < cutoff || at > now) continue
    const previous = latest.get(providerID)
    if (previous === undefined || at > previous) latest.set(providerID, at)
  }
  return [...latest]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_PERSISTED_ACTIVITY_ENTRIES)
    .map(([providerID, at]) => ({ providerID, at }))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys.slice().sort()[index])
}

/** The only on-disk representation: normalized provider IDs and timestamps. */
export function serializeActivityState(
  entries: readonly ProviderActivity[],
  now = Date.now(),
  windowMs = OFFLINE_RECENCY_MS,
) {
  const state: ActivityState = { activities: stateEntries(entries, now, windowMs) }
  return `${JSON.stringify(state)}\n`
}

function parseActivityStateStrict(
  text: string,
  now = Date.now(),
  windowMs = OFFLINE_RECENCY_MS,
): ProviderActivity[] | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_PERSISTED_ACTIVITY_BYTES) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ["activities"]) || !Array.isArray(parsed.activities)) return undefined
  if (parsed.activities.length > MAX_PERSISTED_ACTIVITY_ENTRIES) return undefined

  const entries: ProviderActivity[] = []
  const seen = new Set<string>()
  for (const value of parsed.activities) {
    if (!isRecord(value) || !exactKeys(value, ["at", "providerID"])) return undefined
    const providerID = normalizedProviderID(value.providerID)
    const at = activityTimestamp(value.at)
    if (!providerID || providerID !== value.providerID || at === undefined || at > now || seen.has(providerID)) return undefined
    seen.add(providerID)
    entries.push({ providerID, at })
  }
  return stateEntries(entries, now, windowMs)
}

/** Strict, fail-closed parser for the bounded activity state file. */
export function parseActivityState(
  text: string,
  now = Date.now(),
  windowMs = OFFLINE_RECENCY_MS,
): ProviderActivity[] {
  return parseActivityStateStrict(text, now, windowMs) ?? []
}

function xdgHome(value: string | undefined, fallback: string) {
  const candidate = value?.trim()
  return candidate && isAbsolute(candidate) ? candidate : fallback
}

/** Profile-owned state path; XDG state is preferred, with the repository's data fallback. */
export function defaultActivityStatePath(env: NodeJS.ProcessEnv = process.env) {
  const dataHome = join(homedir(), ".local", "share")
  const base = xdgHome(env.XDG_STATE_HOME, xdgHome(env.XDG_DATA_HOME, dataHome))
  return join(base, "opencode", "codex-usage", "activity.json")
}

async function ensureSafeDirectory(directory: string) {
  const target = resolve(directory)
  const root = parse(target).root
  let current = root
  const parts = target.slice(root.length).split(sep).filter(Boolean)

  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("activity state directory is unsafe")

  let firstMissing = parts.length
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("activity state directory is unsafe")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      firstMissing = index
      break
    }
  }

  current = join(root, ...parts.slice(0, firstMissing))
  for (const part of parts.slice(firstMissing)) {
    current = join(current, part)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("activity state directory is unsafe")
  }
  await chmod(target, 0o700)
}

async function existingDirectoryIsSafe(directory: string) {
  const target = resolve(directory)
  const root = parse(target).root
  let current = root
  for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) return false
    } catch {
      return false
    }
  }
  return true
}

async function readBoundedFile(path: string) {
  if (!(await existingDirectoryIsSafe(dirname(path)))) return undefined
  let initial
  try {
    initial = await lstat(path)
  } catch {
    return undefined
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_PERSISTED_ACTIVITY_BYTES) return undefined

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PERSISTED_ACTIVITY_BYTES) return undefined
    const bytes = Buffer.alloc(MAX_PERSISTED_ACTIVITY_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > MAX_PERSISTED_ACTIVITY_BYTES) return undefined
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function loadActivityState(
  path = defaultActivityStatePath(),
  now = Date.now(),
  windowMs = OFFLINE_RECENCY_MS,
): Promise<ProviderActivity[]> {
  const raw = await readBoundedFile(path)
  if (raw === undefined) return []
  const parsed = parseActivityStateStrict(raw, now, windowMs)
  if (parsed === undefined) return []
  if (raw !== serializeActivityState(parsed, now, windowMs)) await persistActivityState(path, parsed, now, windowMs)
  return parsed
}

async function existingTargetIsSafe(path: string) {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() && info.size <= MAX_PERSISTED_ACTIVITY_BYTES
  } catch {
    return true
  }
}

/** Persist atomically and fail closed; callers never receive path or credential data in errors. */
export async function persistActivityState(
  path = defaultActivityStatePath(),
  entries: readonly ProviderActivity[] = [],
  now = Date.now(),
  windowMs = OFFLINE_RECENCY_MS,
): Promise<void> {
  const serialized = serializeActivityState(entries, now, windowMs)
  if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_ACTIVITY_BYTES) return

  const directory = dirname(path)
  let temporary: string | undefined
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await ensureSafeDirectory(directory)
    if (!(await existingTargetIsSafe(path))) return
    temporary = join(directory, `.${parse(path).name}.${process.pid}.${randomUUID()}.tmp`)
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(serialized, "utf8")
    await handle.chmod(0o600)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    temporary = undefined
  } catch {
    // Persistence is best effort. An unsafe, corrupt, or unavailable state file
    // must never affect provider readiness or expose filesystem details.
  } finally {
    await handle?.close().catch(() => undefined)
    if (temporary) await unlink(temporary).catch(() => undefined)
  }
}
