import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { isRecord } from "./model.ts"

export type CooldownRecord = {
  until: number
  reason: string
  setAt: number
}

export type SessionRecord = {
  agent?: string
  source?: string
  sourceVariant?: string
  active?: string
  activeVariant?: string
  tier?: string
  tierVariant?: string
  updatedAt: number
}

export type PersistedState = {
  version: 1
  cooldowns: Record<string, CooldownRecord>
  sessions: Record<string, SessionRecord>
}

export type StateStore = {
  load(): Promise<void>
  cooling(key: string): boolean
  cooldownUntil(key: string): number | undefined
  setCooldown(key: string, until: number, reason: string): void
  clearCooldown(key: string): void
  session(sessionID: string): SessionRecord | undefined
  setSession(sessionID: string, patch: Partial<Omit<SessionRecord, "updatedAt">>): void
  deleteSession(sessionID: string): void
  flush(): Promise<void>
  snapshot(): PersistedState
}

export type StateStoreOptions = {
  now?: () => number
  debounceMs?: number
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const COOLDOWN_GRACE_MS = 60 * 60 * 1000
const SAVE_DEBOUNCE_MS = 250
const MAX_STATE_BYTES = 1_048_576
const MAX_COOLDOWNS = 512
const MAX_SESSIONS = 512
const MAX_STRING_LENGTH = 512

function emptyState(): PersistedState {
  return { version: 1, cooldowns: {}, sessions: {} }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value && value.length <= MAX_STRING_LENGTH ? value : undefined
}

function parseState(raw: unknown): PersistedState {
  const state = emptyState()
  if (!isRecord(raw)) return state

  if (isRecord(raw.cooldowns)) {
    for (const [key, value] of Object.entries(raw.cooldowns).slice(0, MAX_COOLDOWNS)) {
      if (!key || key.length > MAX_STRING_LENGTH) continue
      if (!isRecord(value)) continue
      if (typeof value.until !== "number" || !Number.isFinite(value.until)) continue
      state.cooldowns[key] = {
        until: value.until,
        reason: stringValue(value.reason) ?? "unknown",
        setAt:
          typeof value.setAt === "number" && Number.isFinite(value.setAt) ? value.setAt : value.until,
      }
    }
  }

  if (isRecord(raw.sessions)) {
    for (const [key, value] of Object.entries(raw.sessions).slice(0, MAX_SESSIONS)) {
      if (!key || key.length > MAX_STRING_LENGTH) continue
      if (!isRecord(value)) continue
      const updatedAt =
        typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
      state.sessions[key] = {
        agent: stringValue(value.agent),
        source: stringValue(value.source),
        sourceVariant: stringValue(value.sourceVariant),
        active: stringValue(value.active),
        activeVariant: stringValue(value.activeVariant),
        tier: stringValue(value.tier),
        tierVariant: stringValue(value.tierVariant),
        updatedAt,
      }
    }
  }

  return state
}

function prune(state: PersistedState, now: number) {
  for (const [key, record] of Object.entries(state.cooldowns)) {
    if (record.until < now - COOLDOWN_GRACE_MS) delete state.cooldowns[key]
  }
  for (const [key, record] of Object.entries(state.sessions)) {
    if (record.updatedAt < now - SESSION_TTL_MS) delete state.sessions[key]
  }
}

export function createStateStore(path: string, options: StateStoreOptions = {}): StateStore {
  const now = options.now ?? Date.now
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS
  let state = emptyState()
  let timer: ReturnType<typeof setTimeout> | undefined
  let writes: Promise<void> = Promise.resolve()
  let tmpCounter = 0

  const write = async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${(tmpCounter += 1)}.tmp`
    const encoded = JSON.stringify(state, null, 2)
    if (Buffer.byteLength(encoded, "utf8") > MAX_STATE_BYTES) {
      throw new Error("fallback state exceeds the maximum size")
    }
    try {
      await writeFile(tmp, encoded, { mode: 0o600 })
      await rename(tmp, path)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    writes = writes.then(write)
    return writes
  }

  const scheduleSave = () => {
    if (debounceMs <= 0) {
      void flush().catch(() => {})
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush().catch(() => {})
    }, debounceMs)
    const unref = (timer as { unref?: () => void }).unref
    if (typeof unref === "function") unref.call(timer)
  }

  return {
    async load() {
      try {
        const raw = await readFile(path, "utf8")
        if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw new Error("fallback state is too large")
        state = parseState(JSON.parse(raw))
      } catch {
        state = emptyState()
      }
      prune(state, now())
    },
    cooling(key) {
      const record = state.cooldowns[key]
      return !!record && record.until > now()
    },
    cooldownUntil(key) {
      const record = state.cooldowns[key]
      return record && record.until > now() ? record.until : undefined
    },
    setCooldown(key, until, reason) {
      if (!key || key.length > MAX_STRING_LENGTH || !Number.isFinite(until)) return
      if (!(key in state.cooldowns) && Object.keys(state.cooldowns).length >= MAX_COOLDOWNS) {
        const oldest = Object.entries(state.cooldowns).sort((left, right) => left[1].setAt - right[1].setAt)[0]
        if (oldest) delete state.cooldowns[oldest[0]]
      }
      state.cooldowns[key] = { until, reason, setAt: now() }
      scheduleSave()
    },
    clearCooldown(key) {
      if (!(key in state.cooldowns)) return
      delete state.cooldowns[key]
      scheduleSave()
    },
    session(sessionID) {
      return state.sessions[sessionID]
    },
    setSession(sessionID, patch) {
      if (!sessionID || sessionID.length > MAX_STRING_LENGTH) return
      if (!(sessionID in state.sessions) && Object.keys(state.sessions).length >= MAX_SESSIONS) {
        const oldest = Object.entries(state.sessions).sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]
        if (oldest) delete state.sessions[oldest[0]]
      }
      const existing = state.sessions[sessionID]
      state.sessions[sessionID] = {
        ...existing,
        ...patch,
        updatedAt: now(),
      }
      scheduleSave()
    },
    deleteSession(sessionID) {
      if (!(sessionID in state.sessions)) return
      delete state.sessions[sessionID]
      scheduleSave()
    },
    flush,
    snapshot() {
      return state
    },
  }
}
