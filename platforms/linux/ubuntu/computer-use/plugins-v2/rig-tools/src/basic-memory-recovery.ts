import { createHash } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type JsonRecord = Record<string, unknown>
export type HashSink = { update: (value: string | Uint8Array) => HashSink; digest: (encoding: "hex") => string }

export type RecoveryRuntimeApi = {
  targetDirectory: string
  locationDirectory: string
  projectID?: string
  mcpList: () => Promise<unknown>
  pluginList: () => Promise<unknown>
  /** Reload the whole MCP collection for the current location; not targeted Basic Memory connect. */
  reloadMcp?: () => Promise<void>
}

export type BasicMemoryRecoveryInput = {
  identifier: string
  project?: string
  directory?: string
  markerAction?: "preview" | "apply"
  preview?: NativeRuntimePreview
  approval?: boolean
}

export type BasicMemoryRecoveryPolicy = {
  maxRechecks: number
  retryDelayMs: number
  deadlineMs: number
  operationTimeoutMs: number
}

export type BasicMemoryRecoveryReport = {
  recovered: false
  status: string
  reason: string
  reconnectRequested: boolean
  statusChecks: number
  readNoteProof: "not-verified"
  markerRepair: string
  preview?: NativeRuntimePreview
  target: {
    profile: "native"
    server: "basic-memory"
    location: string
    project: string
  }
  ownership: "control-plane-only"
  qa: "not-run"
  screenFallback: "use-screen_terminal-with-preview-apply"
}

export type RecoveryDiagnostics = {
  mcp: {
    status: "ok" | "unavailable"
    servers: Array<{ name: string; status: string }>
    truncated?: boolean
  }
  plugins: {
    status: "ok" | "unavailable"
    plugins: Array<{ id: string; status: string }>
    truncated?: boolean
  }
  ownership: {
    status: "control-plane-only"
    next: "task_ownership_status"
    repair: "never-bypass"
  }
  qa: {
    status: "not-run"
    next: "repo_qa_gate"
    autoApprove: false
  }
  screenFallback: {
    status: "delegated"
    next: "screen_terminal"
    rawScreenCommands: false
  }
}

export type CallerReadNoteResultAssessment = "malformed-or-unmatched" | "structured-identity-match-unproven"

export const BASIC_MEMORY_RECOVERY_DEFAULTS: Readonly<BasicMemoryRecoveryPolicy> = {
  maxRechecks: 64,
  retryDelayMs: 2_000,
  deadlineMs: 90_000,
  operationTimeoutMs: 60_000,
}

export const BASIC_MEMORY_MCP_STARTUP_TIMEOUT_MS = 30_000
export const BASIC_MEMORY_RECOVERY_READY_STATUS = "connected-awaiting_read_note" as const

const MAX_RECHECKS = 128
const MAX_RETRY_DELAY_MS = 2_000
const MIN_DEADLINE_MS = BASIC_MEMORY_MCP_STARTUP_TIMEOUT_MS
const MAX_DEADLINE_MS = 180_000
const MAX_OPERATION_TIMEOUT_MS = 120_000
const MAX_IDENTIFIER_LENGTH = 512
const MAX_PROJECT_LENGTH = 128
const MAX_ITEMS = 128
const MAX_FINGERPRINT_BYTES = 4 * 1024 * 1024
const CANONICAL_RUNTIME_TARGET = "canonical-mcp-runtime-marker"
const CANONICAL_RUNTIME_PROFILE = "native"

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeText(value: unknown, fallback = "unknown", maximum = 256): string {
  if (typeof value !== "string") return fallback
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum)
  return result || fallback
}

function validateIdentifier(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} must be non-empty and at most ${maximum} characters`)
  }
  if ([...value].some((character) => character < " " || character === "\u007f")) {
    throw new Error(`${label} must not contain control characters`)
  }
  return value
}

function normalizedDirectory(value: string): string {
  return resolve(value)
}

function targetIdentity(directory: string, projectID = "unknown"): BasicMemoryRecoveryReport["target"] {
  const location = createHash("sha256").update(normalizedDirectory(directory)).digest("hex").slice(0, 16)
  const project = projectID === "unknown" ? "unknown" : `sha256:${createHash("sha256").update(projectID).digest("hex").slice(0, 16)}`
  return { profile: "native", server: "basic-memory", location: `sha256:${location}`, project }
}

function dataValues(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.data) ? value.data : []
}

function statusForServer(value: unknown, name: string): string {
  const matches = dataValues(value).filter((item) => isRecord(item) && item.name === name)
  if (matches.length !== 1) return matches.length === 0 ? "missing" : "duplicate"
  const entry = matches[0]
  if (!isRecord(entry) || !isRecord(entry.status)) return "missing"
  return safeText(entry.status.status)
}

function summarizeCollection(value: unknown, key: "mcp" | "plugins") {
  const values = dataValues(value)
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return {
      status: "unavailable" as const,
      [key]: [] as Array<{ name: string; status: string } | { id: string; status: string }>,
    }
  }
  const items = values.slice(0, MAX_ITEMS).map((item) => {
    if (!isRecord(item)) return key === "mcp" ? { name: "unknown", status: "unknown" } : { id: "unknown", status: "unknown" }
    const state = isRecord(item.status) ? item.status.status : isRecord(item.state) ? item.state.status : undefined
    return key === "mcp"
      ? { name: safeText(item.name), status: safeText(state) }
      : { id: safeText(item.id), status: safeText(state) }
  })
  return { status: "ok" as const, [key]: items, truncated: values.length > MAX_ITEMS }
}

export function summarizeRecoveryDiagnostics(input: { mcp: unknown; plugins: unknown }): RecoveryDiagnostics {
  const mcp = summarizeCollection(input.mcp, "mcp") as RecoveryDiagnostics["mcp"]
  const plugins = summarizeCollection(input.plugins, "plugins") as RecoveryDiagnostics["plugins"]
  return {
    mcp,
    plugins,
    ownership: { status: "control-plane-only", next: "task_ownership_status", repair: "never-bypass" },
    qa: { status: "not-run", next: "repo_qa_gate", autoApprove: false },
    screenFallback: { status: "delegated", next: "screen_terminal", rawScreenCommands: false },
  }
}

function policy(input: Partial<BasicMemoryRecoveryPolicy>): BasicMemoryRecoveryPolicy {
  const result = { ...BASIC_MEMORY_RECOVERY_DEFAULTS, ...input }
  if (!Number.isFinite(result.retryDelayMs) || result.retryDelayMs <= 0 || result.retryDelayMs > MAX_RETRY_DELAY_MS) {
    throw new Error(`retryDelayMs must be in (0, ${MAX_RETRY_DELAY_MS}]`)
  }
  if (!Number.isFinite(result.deadlineMs) || result.deadlineMs < MIN_DEADLINE_MS || result.deadlineMs > MAX_DEADLINE_MS) {
    throw new Error(`deadlineMs must be between ${MIN_DEADLINE_MS} and ${MAX_DEADLINE_MS}`)
  }
  const requiredRechecks = Math.max(1, Math.floor(result.deadlineMs / result.retryDelayMs) + 1)
  if (!Number.isInteger(result.maxRechecks) || result.maxRechecks < requiredRechecks || result.maxRechecks > MAX_RECHECKS) {
    throw new Error(`maxRechecks must cover the full deadline (${requiredRechecks}) and be at most ${MAX_RECHECKS}`)
  }
  if (!Number.isFinite(result.operationTimeoutMs) || result.operationTimeoutMs <= 0 || result.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`operationTimeoutMs must be in (0, ${MAX_OPERATION_TIMEOUT_MS}]`)
  }
  return result
}

export class RecoveryTimeout extends Error {
  constructor(operation: string) {
    super(`${operation} timed out`)
    this.name = "RecoveryTimeout"
  }
}

export class RuntimeExecutionError extends Error {
  constructor() {
    super("canonical native runtime operation failed after bounded cleanup")
    this.name = "RuntimeExecutionError"
    this.code = "RUNTIME_EXECUTION_FAILED"
  }

  readonly code: "RUNTIME_EXECUTION_FAILED"
}

export class RuntimeCleanupError extends Error {
  constructor() {
    super("canonical native runtime child cleanup could not be confirmed within the cleanup deadline")
    this.name = "RuntimeCleanupError"
    this.code = "RUNTIME_CLEANUP_UNCONFIRMED"
  }

  readonly code: "RUNTIME_CLEANUP_UNCONFIRMED"
}

function errorCause(value: unknown): unknown {
  return value instanceof Error || isRecord(value) ? value.cause : undefined
}

export function isRuntimeExecutionError(value: unknown): value is RuntimeExecutionError {
  const seen = new Set<unknown>()
  let current = value
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof RuntimeExecutionError) return true
    if (isRecord(current) && (current.name === "RuntimeExecutionError" || current.code === "RUNTIME_EXECUTION_FAILED")) return true
    current = errorCause(current)
  }
  return false
}

export function isRuntimeCleanupError(value: unknown): value is RuntimeCleanupError {
  const seen = new Set<unknown>()
  let current = value
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof RuntimeCleanupError) return true
    if (isRecord(current) && (current.name === "RuntimeCleanupError" || current.code === "RUNTIME_CLEANUP_UNCONFIRMED")) return true
    current = errorCause(current)
  }
  return false
}

export function isTerminalRuntimeFailure(value: unknown): boolean {
  return isRuntimeExecutionError(value) || isRuntimeCleanupError(value)
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RecoveryTimeout(operation)), Math.max(1, milliseconds))
  })
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function monotonicNow(): number {
  return performance.now()
}

export function hashPath(
  digest: HashSink,
  path: string,
  label: string,
  budget: { remaining: number },
  lstatFn: typeof lstat = lstat,
): Promise<void> {
  return (async () => {
    digest.update(label)
    let metadata
    try {
      metadata = await lstatFn(path)
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        digest.update(":missing")
        return
      }
      throw new Error("approved fingerprint input could not be inspected safely")
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("approved fingerprint input is a symlink")
    }
    if (!metadata.isFile()) throw new Error("approved fingerprint input is not a regular file")
    if (metadata.size > budget.remaining || metadata.size > MAX_FINGERPRINT_BYTES) throw new Error("approved fingerprint input exceeds its bounded size")
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      throw new Error("approved fingerprint input could not be opened safely")
    }
    try {
      const opened = await handle.stat()
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size || !opened.isFile() || opened.size > budget.remaining) {
        throw new Error("approved fingerprint input changed before reading")
      }
      digest.update(":file:")
      const buffer = Buffer.alloc(65_536)
      let remaining = opened.size
      while (remaining > 0) {
        const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, remaining), opened.size - remaining)
        if (read.bytesRead <= 0) throw new Error("approved fingerprint input ended early")
        digest.update(buffer.subarray(0, read.bytesRead))
        remaining -= read.bytesRead
      }
      const final = await handle.stat()
      if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size) throw new Error("approved fingerprint input changed while reading")
      budget.remaining -= opened.size
    } finally {
      await handle.close()
    }
  })()
}

function monotonicDeadlineRemaining(deadline: number, now: () => number): number {
  return Math.max(0, deadline - now())
}

function runtimeWaitBudget(runtime: NativeRuntimeRepair, operationMs: number): number {
  const cleanupMs = typeof runtime.cleanupGraceMs === "number" && Number.isFinite(runtime.cleanupGraceMs)
    ? Math.max(0, runtime.cleanupGraceMs)
    : 0
  return Math.min(Number.MAX_SAFE_INTEGER, operationMs + cleanupMs)
}

function awaitRuntimeOperation<T>(
  runtime: NativeRuntimeRepair,
  promise: Promise<T>,
  operationMs: number,
  operation: string,
): Promise<T> {
  if (runtime.boundedSubprocess === true) return promise
  return withTimeout(promise, runtimeWaitBudget(runtime, operationMs), operation)
}

export async function nativeStateFingerprints(): Promise<{ policyDigest: string; stateDigest: string }> {
  const policyPath = fileURLToPath(new URL("../../../config/mcp-versions.json", import.meta.url))
  const nativeRoot = process.env.OPENCODE_MCP_NATIVE_ROOT ?? join(homedir(), ".local", "share", "opencode", "mcp")
  const policyHash = createHash("sha256") as unknown as HashSink
  await hashPath(policyHash, policyPath, "policy", { remaining: MAX_FINGERPRINT_BYTES })
  const stateHash = createHash("sha256") as unknown as HashSink
  const budget = { remaining: MAX_FINGERPRINT_BYTES }
  await hashPath(stateHash, join(nativeRoot, "provisioned.json"), "marker", budget)
  await hashPath(stateHash, join(nativeRoot, "basic-memory", "config", "config.json"), "basic-memory-config", budget)
  return { policyDigest: policyHash.digest("hex"), stateDigest: stateHash.digest("hex") }
}

export type NativeRuntimeRunner = ((arguments_: readonly string[], timeoutMs: number) => Promise<boolean>) & {
  /** The runner owns TERM/KILL and does not settle until child cleanup is observed. */
  boundedCleanup?: true
}

export type NativeRuntimePreview = {
  target: typeof CANONICAL_RUNTIME_TARGET
  profile: typeof CANONICAL_RUNTIME_PROFILE
  policyDigest: string
  stateDigest: string
}

export type NativeRuntimeApplyResult = "applied" | "already-verified" | "rejected"

export type NativeRuntimeRepair = {
  verify: (timeoutMs: number) => Promise<boolean>
  preview: () => Promise<NativeRuntimePreview>
  apply: (preview: NativeRuntimePreview | undefined, approval: boolean, timeoutMs: number) => Promise<NativeRuntimeApplyResult>
  /** Derived only from a runner carrying the bounded cleanup capability. */
  boundedSubprocess?: boolean
  cleanupGraceMs?: number
}

export const canonicalRuntimeScript = fileURLToPath(new URL("../../../scripts/mcp_runtime.py", import.meta.url))

export const NATIVE_RUNTIME_MAX_OUTPUT_BYTES = 256 * 1024
export const NATIVE_RUNTIME_TERMINATION_GRACE_MS = 250
export const NATIVE_RUNTIME_CLEANUP_DEADLINE_MS = 1_000
export const NATIVE_RUNTIME_FINGERPRINT_TIMEOUT_MS = 5_000

type RuntimeSpawn = (
  command: string,
  arguments_: string[],
  options: { shell: false; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess

export function createCanonicalRuntimeRunner(script = canonicalRuntimeScript): NativeRuntimeRunner {
  const launch = spawn as unknown as RuntimeSpawn
  let cleanupUnconfirmed = false

  const run: NativeRuntimeRunner = (arguments_, timeoutMs) => {
    if (cleanupUnconfirmed) return Promise.reject(new RuntimeCleanupError())
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(false)

    return new Promise<boolean>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = launch("python3", [script, ...arguments_], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch {
        reject(new RuntimeExecutionError())
        return
      }

      let settled = false
      let cleaning = false
      let failure: "timeout" | "overflow" | "process" | undefined
      let outputBytes = 0
      let operationTimer: ReturnType<typeof setTimeout> | undefined
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined

      const clearTimers = () => {
        if (operationTimer) clearTimeout(operationTimer)
        if (graceTimer) clearTimeout(graceTimer)
        if (cleanupTimer) clearTimeout(cleanupTimer)
      }

      const finish = (value?: boolean, error?: Error) => {
        if (settled) return
        settled = true
        clearTimers()
        if (error) reject(error)
        else resolve(value ?? false)
      }

      const cleanupFailure = () => {
        if (settled) return
        cleanupUnconfirmed = true
        finish(undefined, new RuntimeCleanupError())
      }

      const beginCleanup = (reason: "timeout" | "overflow" | "process") => {
        if (settled || cleaning) return
        cleaning = true
        failure = reason
        try {
          child.kill("SIGTERM")
        } catch {
          // The bounded cleanup timer below is authoritative.
        }
        graceTimer = setTimeout(() => {
          if (settled) return
          try {
            child.kill("SIGKILL")
          } catch {
            // The absolute cleanup deadline below remains authoritative.
          }
        }, NATIVE_RUNTIME_TERMINATION_GRACE_MS)
        cleanupTimer = setTimeout(cleanupFailure, NATIVE_RUNTIME_CLEANUP_DEADLINE_MS)
      }

      child.once("close", (code, signal) => {
        if (settled) return
        if (cleaning) {
          if (failure) finish(undefined, new RuntimeExecutionError())
          return
        }
        finish(code === 0 && signal === null)
      })
      child.once("error", () => {
        if (settled) return
        if (child.pid === undefined || child.pid === null) finish(undefined, new RuntimeExecutionError())
        else beginCleanup("process")
      })

      const observeOutput = (chunk: Buffer | string) => {
        if (settled) return
        outputBytes += Buffer.byteLength(chunk)
        if (outputBytes > NATIVE_RUNTIME_MAX_OUTPUT_BYTES) beginCleanup("overflow")
      }
      child.stdout?.on("data", observeOutput)
      child.stderr?.on("data", observeOutput)
      if (!child.stdout || !child.stderr) {
        beginCleanup("process")
        return
      }

      operationTimer = setTimeout(() => beginCleanup("timeout"), Math.max(1, timeoutMs))
    })
  }
  run.boundedCleanup = true
  return run
}

export function createNativeRuntimeRepair(
  runner: NativeRuntimeRunner = createCanonicalRuntimeRunner(),
  fingerprints: () => Promise<{ policyDigest: string; stateDigest: string }> = nativeStateFingerprints,
  now: () => number = monotonicNow,
  fingerprintTimeoutMs = NATIVE_RUNTIME_FINGERPRINT_TIMEOUT_MS,
): NativeRuntimeRepair {
  if (!Number.isFinite(fingerprintTimeoutMs) || fingerprintTimeoutMs <= 0 || fingerprintTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`fingerprintTimeoutMs must be in (0, ${MAX_OPERATION_TIMEOUT_MS}]`)
  }
  const boundedSubprocess = runner.boundedCleanup === true
  const verify = (timeoutMs: number) => runner(["mcp-runtime", "--profile", CANONICAL_RUNTIME_PROFILE, "--quiet"], timeoutMs)
  const fingerprintSnapshot = async (timeoutMs: number) => {
    const budget = Math.min(timeoutMs, fingerprintTimeoutMs)
    if (budget <= 0) throw new RecoveryTimeout("canonical native marker fingerprint")
    const deadline = now() + budget
    const result = await withTimeout(fingerprints(), budget, "canonical native marker fingerprint")
    if (monotonicDeadlineRemaining(deadline, now) <= 0) throw new RecoveryTimeout("canonical native marker fingerprint")
    return result
  }
  const preview = async (): Promise<NativeRuntimePreview> => {
    const { policyDigest, stateDigest } = await fingerprintSnapshot(fingerprintTimeoutMs)
    return { target: CANONICAL_RUNTIME_TARGET, profile: CANONICAL_RUNTIME_PROFILE, policyDigest, stateDigest }
  }
  const apply = async (expected: NativeRuntimePreview | undefined, approval: boolean, timeoutMs: number): Promise<NativeRuntimeApplyResult> => {
    const deadline = now() + Math.max(0, timeoutMs)
    const remaining = () => monotonicDeadlineRemaining(deadline, now)
    if (!approval || !expected) return "rejected"
    if (expected.target !== CANONICAL_RUNTIME_TARGET || expected.profile !== CANONICAL_RUNTIME_PROFILE) return "rejected"
    if (remaining() <= 0) return "rejected"
    const current = await fingerprintSnapshot(remaining())
    if (remaining() <= 0) return "rejected"
    if (expected.policyDigest !== current.policyDigest || expected.stateDigest !== current.stateDigest) return "rejected"
    const verifyTimeout = remaining()
    if (verifyTimeout <= 0) return "rejected"
    const verifiedImmediatelyBeforeApply = await verify(verifyTimeout)
    if (remaining() <= 0) return "rejected"
    if (verifiedImmediatelyBeforeApply) return "already-verified"
    const applyTimeout = remaining()
    if (applyTimeout <= 0) return "rejected"
    const applied = await runner(["mcp-runtime", "--profile", CANONICAL_RUNTIME_PROFILE, "--apply", "--quiet"], applyTimeout)
    return applied && remaining() > 0 ? "applied" : "rejected"
  }
  return {
    verify,
    preview,
    apply,
    boundedSubprocess,
    ...(boundedSubprocess ? { cleanupGraceMs: NATIVE_RUNTIME_CLEANUP_DEADLINE_MS } : {}),
  }
}

export function classifyCallerReadNoteResult(value: unknown, identifier: string): CallerReadNoteResultAssessment {
  if (!isRecord(value) || value.isError === true) return "malformed-or-unmatched"
  const structured = isRecord(value.structuredContent) ? value.structuredContent : undefined
  if (!structured) return "malformed-or-unmatched"
  const note = isRecord(structured.note) ? structured.note : structured
  const identity = [note.identifier, note.permalink, note.memory_url, note.uri, note.title].some((candidate) => candidate === identifier)
  if (!identity || typeof note.content !== "string" || note.content.trim().length === 0) return "malformed-or-unmatched"
  if (!Array.isArray(value.content) || !value.content.some((item) => isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0)) {
    return "malformed-or-unmatched"
  }
  return "structured-identity-match-unproven"
}

export function createBasicMemoryRecoveryManager(
  api: RecoveryRuntimeApi,
  runtime: NativeRuntimeRepair = createNativeRuntimeRepair(),
  now: () => number = monotonicNow,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  const recover = async (
    input: BasicMemoryRecoveryInput,
    overrides: Partial<BasicMemoryRecoveryPolicy> = {},
  ): Promise<BasicMemoryRecoveryReport> => {
    validateIdentifier(input.identifier, "note identifier", MAX_IDENTIFIER_LENGTH)
    validateIdentifier(input.project ?? "computer-assistant", "project", MAX_PROJECT_LENGTH)
    const limits = policy(overrides)
    const action = input.markerAction ?? "preview"
    const requestedDirectory = input.directory ?? api.targetDirectory
    const target = targetIdentity(api.targetDirectory, api.projectID)
    const started = now()
    const deadline = started + limits.deadlineMs
    const remaining = () => Math.max(0, deadline - now())
    const report = (
      status: string,
      reason: string,
      statusChecks: number,
      reconnectRequested = false,
      markerRepair = "not-run",
      preview?: NativeRuntimePreview,
    ): BasicMemoryRecoveryReport => ({
      recovered: false,
      status,
      reason,
      reconnectRequested,
      statusChecks,
      readNoteProof: "not-verified",
      markerRepair,
      target,
      ...(preview ? { preview } : {}),
      ownership: "control-plane-only",
      qa: "not-run",
      screenFallback: "use-screen_terminal-with-preview-apply",
    })

    if (normalizedDirectory(requestedDirectory) !== normalizedDirectory(api.targetDirectory) || normalizedDirectory(api.locationDirectory) !== normalizedDirectory(api.targetDirectory)) {
      return report("target-location-mismatch", "requested-directory-does-not-match-current-plugin-location", 0)
    }
    if (remaining() <= 0) return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-marker-verification", 0)

    let markerVerified = false
    try {
      const verifyTimeout = Math.min(limits.operationTimeoutMs, remaining())
      if (verifyTimeout <= 0) return report("marker-verification-timeout", "canonical-marker-verification-budget-expired", 0, false, "verification-timeout")
      markerVerified = await awaitRuntimeOperation(runtime, runtime.verify(verifyTimeout), verifyTimeout, "canonical native marker verification")
    } catch (error) {
      if (isTerminalRuntimeFailure(error)) throw error
      if (error instanceof RecoveryTimeout) return report("marker-verification-timeout", "canonical-marker-verification-did-not-settle-within-its-bounded-budget", 0, false, "verification-timeout")
      throw error
    }
    if (remaining() <= 0) return report("marker-verification-timeout", "canonical-marker-verification-exceeded-recovery-deadline", 0, false, "verification-timeout")
    if (!markerVerified) {
      if (remaining() <= 0) return report("marker-verification-timeout", "canonical-marker-verification-budget-expired", 0, false, "verification-timeout")
      if (action !== "apply") {
        try {
          const previewTimeout = Math.min(limits.operationTimeoutMs, remaining())
          if (previewTimeout <= 0) return report("marker-repair-failed", "canonical-marker-preview-budget-expired", 0, false, "preview-timeout")
          const preview = await withTimeout(runtime.preview(), previewTimeout, "canonical native marker preview")
          if (remaining() <= 0) return report("marker-repair-failed", "canonical-marker-preview-exceeded-recovery-deadline", 0, false, "preview-timeout")
          return report("marker-repair-required", "explicit-marker-repair-preview-required", 0, false, "preview-required", preview)
        } catch (error) {
          if (isTerminalRuntimeFailure(error)) throw error
          if (error instanceof RecoveryTimeout) return report("marker-repair-failed", "canonical-marker-preview-did-not-settle-within-its-bounded-budget", 0, false, "preview-timeout")
          return report("marker-repair-unavailable", "canonical-marker-verification-failed", 0, false, "preview-failed")
        }
      }
      if (!input.approval || !input.preview) return report("marker-repair-approval-required", "explicit-apply-approval-and-preview-state-required", 0, false, "approval-required")
      if (remaining() <= 0) return report("marker-repair-failed", "canonical-marker-apply-budget-expired", 0, false, "apply-timeout")
      try {
        const applyTimeout = Math.min(limits.operationTimeoutMs, remaining())
        if (applyTimeout <= 0) return report("marker-repair-failed", "canonical-marker-apply-budget-expired", 0, false, "apply-timeout")
        const applied = await awaitRuntimeOperation(runtime, runtime.apply(input.preview, input.approval, applyTimeout), applyTimeout, "canonical native marker apply")
        if (applied === "rejected") return report("marker-repair-rejected", "preview-state-stale-or-canonical-apply-failed", 0, false, "apply-rejected")
        if (remaining() <= 0) return report("marker-repair-failed", "canonical-marker-apply-exceeded-recovery-deadline", 0, false, "apply-timeout")
        const postcheckTimeout = Math.min(limits.operationTimeoutMs, remaining())
        if (postcheckTimeout <= 0) return report("marker-repair-failed", "post-apply-marker-verification-budget-expired", 0, false, "post-apply-verify-timeout")
        markerVerified = await awaitRuntimeOperation(runtime, runtime.verify(postcheckTimeout), postcheckTimeout, "canonical native marker post-apply verification")
      } catch (error) {
        if (isTerminalRuntimeFailure(error)) throw error
        markerVerified = false
      }
      if (remaining() <= 0) return report("marker-repair-failed", "post-apply-marker-verification-exceeded-recovery-deadline", 0, false, "post-apply-verify-timeout")
      if (!markerVerified) return report("marker-repair-failed", "post-apply-marker-verification-failed", 0, false, "post-apply-verify-failed")
    }

    if (remaining() <= 0) return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-status-check", 0, false, "verified")
    let statusChecks = 0
    let configuredStatus: string
    try {
      const statusTimeout = Math.min(limits.operationTimeoutMs, remaining())
      if (statusTimeout <= 0) return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-status-check", statusChecks, false, "verified")
      configuredStatus = statusForServer(await withTimeout(api.mcpList(), statusTimeout, "Basic Memory configuration status"), "basic-memory")
    } catch {
      return report("configured-entry-unavailable", "configured-basic-memory-entry-could-not-be-verified", statusChecks, false, "verified")
    }
    statusChecks += 1
    if (remaining() <= 0) return report("startup-deadline-exceeded", "recovery-deadline-exceeded-after-status-check", statusChecks, false, "verified")
    if (configuredStatus === "connected") return report(BASIC_MEMORY_RECOVERY_READY_STATUS, "caller-must-verify-selected-location-read_note-if-available", statusChecks, false, "verified")
    if (["missing", "disabled", "unavailable", "unknown"].includes(configuredStatus)) {
      return report(configuredStatus, "configured-basic-memory-entry-is-not-connectable", statusChecks, false, "verified")
    }
    if (!api.reloadMcp) return report("reconnect-api-unavailable", "ctx-mcp-collection-reload-is-unavailable", statusChecks, false, "verified")
    if (remaining() <= 0) return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-reconnect", statusChecks, false, "verified")
    try {
      const reloadTimeout = Math.min(limits.operationTimeoutMs, remaining())
      if (reloadTimeout <= 0) return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-reconnect", statusChecks, false, "verified")
      await withTimeout(api.reloadMcp(), reloadTimeout, "ctx.mcp.reload")
    } catch (error) {
      if (isTerminalRuntimeFailure(error)) throw error
      if (!(error instanceof RecoveryTimeout)) return report("reconnect-failed", "ctx-mcp-collection-reload-failed", statusChecks, true, "verified")
    }

    let lastStatus = "unavailable"
    let rechecks = 0
    while (rechecks < limits.maxRechecks && remaining() > 0) {
      try {
        const statusTimeout = Math.min(limits.operationTimeoutMs, remaining())
        if (statusTimeout <= 0) break
        lastStatus = statusForServer(await withTimeout(api.mcpList(), statusTimeout, "Basic Memory readiness status"), "basic-memory")
      } catch {
        lastStatus = "unavailable"
      }
      statusChecks += 1
      rechecks += 1
      if (remaining() <= 0) {
        if (lastStatus === "connected") lastStatus = "startup-deadline-exceeded"
        break
      }
      if (lastStatus === "connected") return report(BASIC_MEMORY_RECOVERY_READY_STATUS, "caller-must-verify-selected-location-read_note-if-available", statusChecks, true, "verified")
      const left = remaining()
      if (left <= 0) break
      await wait(Math.min(limits.retryDelayMs, left))
    }
    return report(lastStatus, "status-recheck-timeout-without-direct-read_note", statusChecks, true, "verified")
  }

  const diagnose = async (overrides: Partial<BasicMemoryRecoveryPolicy> = {}): Promise<RecoveryDiagnostics> => {
    const limits = policy(overrides)
    const [mcp, plugins] = await Promise.allSettled([
      withTimeout(api.mcpList(), limits.operationTimeoutMs, "MCP diagnostics"),
      withTimeout(api.pluginList(), limits.operationTimeoutMs, "plugin diagnostics"),
    ])
    return summarizeRecoveryDiagnostics({
      mcp: mcp.status === "fulfilled" ? mcp.value : undefined,
      plugins: plugins.status === "fulfilled" ? plugins.value : undefined,
    })
  }

  return { recover, diagnose }
}
