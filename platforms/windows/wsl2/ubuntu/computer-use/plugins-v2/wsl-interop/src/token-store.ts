import { createHash, randomBytes } from "node:crypto"

export interface RawIntent {
  sessionID: string
  agent: string
  script: string
  executable: string
  executableIdentity: string
  workingDirectory: string
  fingerprint: string
  timeoutMs: number
}

interface RawTokenRecord extends RawIntent {
  digest: string
  expiresAt: number
  used: boolean
}

export interface RawPreview {
  expectToken: string
  scriptSha256: string
  expiresAt: number
}

export class RawTokenStore {
  readonly #tokens = new Map<string, RawTokenRecord>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #random: () => string
  readonly #maxRecords: number

  constructor(
    ttlMs: number,
    now: () => number = Date.now,
    random: () => string = () => randomBytes(24).toString("base64url"),
    maxRecords = 128,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("token TTL must be a positive integer")
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_024) throw new Error("token capacity must be 1..1024")
    this.#ttlMs = ttlMs
    this.#maxRecords = maxRecords
    this.#now = now
    this.#random = random
  }

  preview(intent: RawIntent): RawPreview {
    this.#prune()
    if (this.#tokens.size >= this.#maxRecords) throw new Error("preview token capacity is exhausted")
    const token = this.#random()
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) throw new Error("preview token generator returned an invalid token")
    if (this.#tokens.has(token)) throw new Error("preview token generator returned a duplicate token")
    const digest = intentDigest(intent)
    const expiresAt = this.#now() + this.#ttlMs
    this.#tokens.set(token, { ...intent, digest, expiresAt, used: false })
    return { expectToken: token, scriptSha256: scriptDigest(intent.script), expiresAt }
  }

  consume(token: string, intent: RawIntent): void {
    if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) throw new Error("preview token is invalid")
    this.#prune()
    const record = this.#tokens.get(token)
    if (!record || record.used || record.expiresAt <= this.#now()) throw new Error("preview token is missing, expired, or already used")
    if (record.digest !== intentDigest(intent)) {
      this.#tokens.delete(token)
      throw new Error("previewed state changed; preview the exact operation again")
    }
    record.used = true
    this.#tokens.delete(token)
  }

  #prune(): void {
    const now = this.#now()
    for (const [token, record] of this.#tokens) {
      if (record.used || record.expiresAt <= now) this.#tokens.delete(token)
    }
  }
}

export function scriptDigest(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex")
}

function intentDigest(intent: RawIntent): string {
  return createHash("sha256").update(JSON.stringify({
    sessionID: intent.sessionID,
    agent: intent.agent,
    scriptSha256: scriptDigest(intent.script),
    executable: intent.executable,
    executableIdentity: intent.executableIdentity,
    workingDirectory: intent.workingDirectory,
    fingerprint: intent.fingerprint,
    timeoutMs: intent.timeoutMs,
  })).digest("hex")
}
