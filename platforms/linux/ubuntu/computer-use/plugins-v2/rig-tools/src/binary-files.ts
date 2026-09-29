import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  chmod,
  copyFile,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"

const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_PATTERN_BYTES = 64 * 1024
const MAX_EXTRACT_BYTES = 64 * 1024
const MAX_CONTEXT_BYTES = 4 * 1024
const MAX_MATCHES = 64
const MAX_REPLACE_MATCHES = 4096
const TOKEN_TTL_MS = 60_000
const MAX_TOKENS = 64

type Encoding = "utf8" | "base64"

export type BinaryInspectInput = {
  action: "stat" | "find" | "extract"
  path: string
  needle?: string
  encoding?: Encoding
  maxMatches?: number
  contextBytes?: number
  offset?: number
  length?: number
}

export type BinaryReplaceInput = {
  path: string
  search: string
  replacement: string
  encoding?: Encoding
  occurrence?: number
  apply?: boolean
  expectToken?: string
}

type Fingerprint = {
  path: string
  realpath: string
  size: number
  mode: number
  device: number
  inode: number
  modifiedMs: number
  sha256: string
}

export type BinaryStatResult = Fingerprint & { maximumFileBytes: number }
export type BinaryExtractResult = { path: string; offset: number; length: number; encoding: Encoding; data: string; fileSha256: string }
export type BinaryFindResult = {
  path: string
  encoding: Encoding
  needleBytes: number
  needleSha256: string
  fileSha256: string
  matches: Array<{ offset: number; before: string; match: string; after: string }>
  matchesTruncated: boolean
}

type ReplaceIntent = {
  path: string
  encoding: Encoding
  search: Buffer
  replacement: Buffer
  occurrence?: number
}

type ReplaceToken = {
  token: string
  sessionID: string
  agent: string
  intentDigest: string
  before: Fingerprint
  offset: number
  afterSha256: string
  expiresAt: number
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function checkedPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || !isAbsolute(value)) {
    throw new Error("path must be a bounded absolute path")
  }
  return value
}

function decode(value: unknown, encoding: Encoding, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  let result: Buffer
  if (encoding === "base64") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error(`${label} is not canonical base64`)
    }
    result = Buffer.from(value, "base64")
    if (result.toString("base64") !== value) throw new Error(`${label} is not canonical base64`)
  } else {
    result = Buffer.from(value, "utf8")
  }
  if (result.length === 0 || result.length > MAX_PATTERN_BYTES) {
    throw new Error(`${label} must decode to 1-${MAX_PATTERN_BYTES} bytes`)
  }
  return result
}

async function fileInfo(path: string) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("binary tools require a regular non-symlink file")
  if (info.size > MAX_FILE_BYTES) throw new Error(`file exceeds the ${MAX_FILE_BYTES}-byte limit`)
  return info
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", resolve)
  })
  return hash.digest("hex")
}

async function fingerprint(pathValue: unknown): Promise<Fingerprint> {
  const path = checkedPath(pathValue)
  const before = await fileInfo(path)
  const sha256 = await fileSha256(path)
  const after = await fileInfo(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("file changed while it was being inspected")
  }
  return {
    path,
    realpath: await realpath(path),
    size: after.size,
    mode: after.mode & 0o7777,
    device: after.dev,
    inode: after.ino,
    modifiedMs: after.mtimeMs,
    sha256,
  }
}

async function loadStable(pathValue: unknown): Promise<{ data: Buffer; fingerprint: Fingerprint }> {
  const path = checkedPath(pathValue)
  const before = await fileInfo(path)
  const data = await readFile(path)
  const after = await fileInfo(path)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length !== after.size) {
    throw new Error("file changed while it was being read")
  }
  return {
    data,
    fingerprint: {
      path,
      realpath: await realpath(path),
      size: after.size,
      mode: after.mode & 0o7777,
      device: after.dev,
      inode: after.ino,
      modifiedMs: after.mtimeMs,
      sha256: createHash("sha256").update(data).digest("hex"),
    },
  }
}

function matchingOffsets(data: Buffer, needle: Buffer, limit: number): { offsets: number[]; truncated: boolean } {
  const offsets: number[] = []
  let cursor = 0
  while (cursor <= data.length - needle.length) {
    const offset = data.indexOf(needle, cursor)
    if (offset < 0) break
    offsets.push(offset)
    if (offsets.length > limit) return { offsets: offsets.slice(0, limit), truncated: true }
    cursor = offset + 1
  }
  return { offsets, truncated: false }
}

function encoded(value: Buffer, encoding: Encoding) {
  return value.toString(encoding)
}

export function inspectBinary(input: BinaryInspectInput & { action: "stat" }): Promise<BinaryStatResult>
export function inspectBinary(input: BinaryInspectInput & { action: "extract" }): Promise<BinaryExtractResult>
export function inspectBinary(input: BinaryInspectInput & { action: "find" }): Promise<BinaryFindResult>
export function inspectBinary(input: BinaryInspectInput): Promise<BinaryStatResult | BinaryExtractResult | BinaryFindResult>
export async function inspectBinary(input: BinaryInspectInput): Promise<BinaryStatResult | BinaryExtractResult | BinaryFindResult> {
  const path = checkedPath(input.path)
  if (input.action === "stat") return { ...(await fingerprint(path)), maximumFileBytes: MAX_FILE_BYTES }
  if (input.action === "extract") {
    const offset = integer(input.offset, 0, Number.MAX_SAFE_INTEGER, "offset")
    const length = integer(input.length, 1, MAX_EXTRACT_BYTES, "length")
    const encoding = input.encoding ?? "base64"
    const state = await fingerprint(path)
    if (offset + length > state.size) throw new Error("extract range exceeds the file size")
    const handle = await open(path, "r")
    try {
      const value = Buffer.alloc(length)
      const result = await handle.read(value, 0, length, offset)
      if (result.bytesRead !== length) throw new Error("file changed during extraction")
      if ((await fileSha256(path)) !== state.sha256) throw new Error("file changed during extraction")
      return { path, offset, length, encoding, data: encoded(value, encoding), fileSha256: state.sha256 }
    } finally {
      await handle.close()
    }
  }
  if (input.action !== "find") throw new Error("action must be stat, find, or extract")
  const encoding = input.encoding ?? "utf8"
  const needle = decode(input.needle, encoding, "needle")
  const maxMatches = input.maxMatches === undefined ? 16 : integer(input.maxMatches, 1, MAX_MATCHES, "maxMatches")
  const contextBytes = input.contextBytes === undefined ? 0 : integer(input.contextBytes, 0, MAX_CONTEXT_BYTES, "contextBytes")
  const loaded = await loadStable(path)
  const found = matchingOffsets(loaded.data, needle, maxMatches)
  return {
    path,
    encoding,
    needleBytes: needle.length,
    needleSha256: createHash("sha256").update(needle).digest("hex"),
    fileSha256: loaded.fingerprint.sha256,
    matches: found.offsets.map((offset) => ({
      offset,
      before: encoded(loaded.data.subarray(Math.max(0, offset - contextBytes), offset), encoding),
      match: encoded(loaded.data.subarray(offset, offset + needle.length), encoding),
      after: encoded(loaded.data.subarray(offset + needle.length, Math.min(loaded.data.length, offset + needle.length + contextBytes)), encoding),
    })),
    matchesTruncated: found.truncated,
  }
}

function normalizeReplace(input: BinaryReplaceInput): ReplaceIntent {
  const encoding = input.encoding ?? "utf8"
  if (encoding !== "utf8" && encoding !== "base64") throw new Error("encoding must be utf8 or base64")
  const search = decode(input.search, encoding, "search")
  const replacement = decode(input.replacement, encoding, "replacement")
  if (search.length !== replacement.length) throw new Error("search and replacement must have exactly the same byte length")
  if (search.equals(replacement)) throw new Error("search and replacement must differ")
  return {
    path: checkedPath(input.path),
    encoding,
    search,
    replacement,
    occurrence: input.occurrence === undefined ? undefined : integer(input.occurrence, 1, MAX_REPLACE_MATCHES, "occurrence"),
  }
}

function digestIntent(intent: ReplaceIntent) {
  return createHash("sha256")
    .update(intent.path).update("\0")
    .update(intent.encoding).update("\0")
    .update(intent.search).update("\0")
    .update(intent.replacement).update("\0")
    .update(String(intent.occurrence ?? "unique"))
    .digest("hex")
}

function afterDigest(data: Buffer, offset: number, replacement: Buffer) {
  return createHash("sha256")
    .update(data.subarray(0, offset))
    .update(replacement)
    .update(data.subarray(offset + replacement.length))
    .digest("hex")
}

function sameFingerprint(left: Fingerprint, right: Fingerprint) {
  return left.path === right.path && left.realpath === right.realpath && left.size === right.size &&
    left.mode === right.mode && left.device === right.device && left.inode === right.inode &&
    left.modifiedMs === right.modifiedMs && left.sha256 === right.sha256
}

async function fsyncDirectory(path: string) {
  const handle = await open(path, "r")
  try { await handle.sync() } finally { await handle.close() }
}

export function createBinaryReplaceManager(now: () => number = Date.now) {
  const tokens = new Map<string, ReplaceToken>()
  const prune = () => {
    for (const [key, value] of tokens) if (value.expiresAt <= now()) tokens.delete(key)
    if (tokens.size >= MAX_TOKENS) throw new Error("binary replacement preview capacity is full")
  }

  const invoke = async (input: BinaryReplaceInput, sessionID: string, agent: string): Promise<any> => {
    const intent = normalizeReplace(input)
    const intentDigest = digestIntent(intent)
    if (!input.apply) {
      if (input.expectToken) throw new Error("expectToken requires apply=true")
      const loaded = await loadStable(intent.path)
      const found = matchingOffsets(loaded.data, intent.search, MAX_REPLACE_MATCHES)
      if (found.truncated) throw new Error(`search matches more than the ${MAX_REPLACE_MATCHES}-match safety limit`)
      const selected = intent.occurrence === undefined
        ? found.offsets.length === 1 ? found.offsets[0] : undefined
        : found.offsets[intent.occurrence - 1]
      if (selected === undefined) {
        throw new Error(intent.occurrence === undefined
          ? `search must match exactly once; found ${found.offsets.length}`
          : `occurrence ${intent.occurrence} was not found; found ${found.offsets.length}`)
      }
      prune()
      const token = randomBytes(24).toString("base64url")
      const record: ReplaceToken = {
        token,
        sessionID,
        agent,
        intentDigest,
        before: loaded.fingerprint,
        offset: selected,
        afterSha256: afterDigest(loaded.data, selected, intent.replacement),
        expiresAt: now() + TOKEN_TTL_MS,
      }
      tokens.set(token, record)
      return {
        dryRun: true,
        path: intent.path,
        offset: selected,
        matchCount: found.offsets.length,
        occurrence: intent.occurrence ?? 1,
        bytes: intent.search.length,
        beforeSha256: record.before.sha256,
        afterSha256: record.afterSha256,
        expectToken: token,
        expiresAt: record.expiresAt,
        rollback: "A content-addressed hard-link backup is created before replacement.",
      }
    }

    const record = input.expectToken ? tokens.get(input.expectToken) : undefined
    if (!record || record.expiresAt <= now()) throw new Error("binary replacement preview token is missing or expired")
    tokens.delete(record.token)
    if (record.sessionID !== sessionID || record.agent !== agent || record.intentDigest !== intentDigest) {
      throw new Error("binary replacement token does not match this session, agent, and intent")
    }
    const loaded = await loadStable(intent.path)
    if (!sameFingerprint(record.before, loaded.fingerprint)) throw new Error("binary target changed after preview; preview again")
    if (!loaded.data.subarray(record.offset, record.offset + intent.search.length).equals(intent.search)) {
      throw new Error("binary search bytes changed after preview; preview again")
    }

    const directory = dirname(intent.path)
    const temporary = join(directory, `.${basename(intent.path)}.open-rig-${randomBytes(8).toString("hex")}.tmp`)
    const backup = `${intent.path}.open-rig-backup-${record.before.sha256.slice(0, 12)}`
    try {
      await copyFile(intent.path, temporary, 1)
      const handle = await open(temporary, "r+")
      try {
        const result = await handle.write(intent.replacement, 0, intent.replacement.length, record.offset)
        if (result.bytesWritten !== intent.replacement.length) throw new Error("short binary replacement write")
        await handle.sync()
      } finally {
        await handle.close()
      }
      await chmod(temporary, record.before.mode)
      if ((await fileSha256(temporary)) !== record.afterSha256) throw new Error("temporary replacement digest mismatch")
      try {
        await link(intent.path, backup)
      } catch (error) {
        const existing = await fingerprint(backup).catch(() => undefined)
        if (!existing || existing.sha256 !== record.before.sha256) throw error
      }
      if (!sameFingerprint(record.before, await fingerprint(intent.path))) throw new Error("binary target changed before atomic replacement")
      await rename(temporary, intent.path)
      await fsyncDirectory(directory)
      const final = await fingerprint(intent.path)
      if (final.sha256 !== record.afterSha256) throw new Error("binary replacement postcondition failed")
      return {
        dryRun: false,
        path: intent.path,
        offset: record.offset,
        bytes: intent.replacement.length,
        beforeSha256: record.before.sha256,
        afterSha256: final.sha256,
        backupPath: backup,
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  return { invoke }
}
