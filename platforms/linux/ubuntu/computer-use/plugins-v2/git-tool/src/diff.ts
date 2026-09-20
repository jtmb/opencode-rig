export const DEFAULT_CONTEXT = 3
export const DEFAULT_MAX_BYTES = 120_000
export const MAX_CONTEXT = 20
export const MAX_MAX_BYTES = 250_000
export const MAX_PATH_LENGTH = 1_024
export const MAX_BASE_LENGTH = 256

export type DiffMode = "working" | "branch" | "committed"

export interface GitDiffInput {
  readonly mode: DiffMode
  readonly base?: string
  readonly context: number
  readonly path?: string
  readonly maxBytes: number
}

export interface DiffFile {
  readonly file: string
  readonly patch: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

export interface VcsDiffRequest {
  readonly mode: DiffMode
  readonly base?: string
  readonly context: number
}

export interface VcsDiffResponse {
  readonly data: readonly DiffFile[]
}

export type VcsDiffReader = (request: VcsDiffRequest) => Promise<VcsDiffResponse>

const INPUT_KEYS = new Set(["mode", "base", "context", "path", "maxBytes"])
const SAFE_BASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("git_diff input must be an object")
  }
  return value as Record<string, unknown>
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function safeBase(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE_LENGTH || !SAFE_BASE.test(value)) {
    throw new Error("base must be a safe Git ref or object ID")
  }
  if (value.includes("..") || value.includes("//") || value.includes("@{") || value.includes("/.")) {
    throw new Error("base contains an unsupported Git ref")
  }
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) {
    throw new Error("base contains an unsupported Git ref")
  }
  return value
}

function safePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new Error("path must be a non-empty repository-relative path")
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes("\\") || value.startsWith("/") || value.startsWith("~")) {
    throw new Error("path must be repository-relative")
  }
  const parts = value.split("/")
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error("path must not contain empty, dot, or parent components")
  }
  return value
}

export function parseGitDiffInput(raw: unknown): GitDiffInput {
  const input = record(raw)
  for (const key of Object.keys(input)) {
    if (!INPUT_KEYS.has(key)) throw new Error(`unsupported git_diff input: ${key}`)
  }

  const mode = input.mode === undefined ? "working" : input.mode
  if (mode !== "working" && mode !== "branch" && mode !== "committed") {
    throw new Error("mode must be working, branch, or committed")
  }

  return {
    mode,
    ...(input.base === undefined ? {} : { base: safeBase(input.base) }),
    context: input.context === undefined ? DEFAULT_CONTEXT : integer(input.context, "context", 0, MAX_CONTEXT),
    ...(input.path === undefined ? {} : { path: safePath(input.path) }),
    maxBytes: input.maxBytes === undefined ? DEFAULT_MAX_BYTES : integer(input.maxBytes, "maxBytes", 1_024, MAX_MAX_BYTES),
  }
}

export function filterDiffFiles(files: readonly DiffFile[], path?: string): readonly DiffFile[] {
  if (path === undefined) return files
  return files.filter((file) => file.file === path || file.file.startsWith(`${path}/`))
}

export function renderDiff(files: readonly DiffFile[], maxBytes: number): string {
  const patches: string[] = []
  let bytes = 0
  for (const file of files) {
    if (typeof file.patch !== "string") throw new Error("VCS returned an invalid diff patch")
    const separator = patches.length === 0 ? "" : "\n"
    const nextBytes = bytes + Buffer.byteLength(separator + file.patch, "utf8")
    if (nextBytes > maxBytes) {
      throw new Error(`diff exceeds the ${maxBytes}-byte output bound; narrow path or increase maxBytes`)
    }
    patches.push(file.patch)
    bytes = nextBytes
  }
  return patches.length === 0 ? "No changes." : patches.join("\n")
}

export async function executeGitDiff(raw: unknown, read: VcsDiffReader): Promise<string> {
  const input = parseGitDiffInput(raw)
  const result = await read({ mode: input.mode, ...(input.base === undefined ? {} : { base: input.base }), context: input.context })
  return renderDiff(filterDiffFiles(result.data, input.path), input.maxBytes)
}
