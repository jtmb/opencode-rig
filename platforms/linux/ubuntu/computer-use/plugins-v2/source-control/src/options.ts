import type { GithubMcpCommand } from "./mcp.ts"

export interface OptionsKV {
  readonly ready?: boolean
  get<Value = unknown>(key: string, fallback?: Value): Value | undefined
  set(key: string, value: unknown): void
}

export type PluginOptions = {
  refreshMs?: number
  githubRefreshMs?: number
  maxFiles?: number
  startCollapsed?: boolean
  whenEmpty?: "hide" | "show"
  github?: boolean
  githubMcpCommand?: GithubMcpCommand
  remoteName?: string
}

export type RuntimeOptions = {
  refreshMs: number
  githubRefreshMs: number
  maxFiles: number
  startCollapsed: boolean
}

export const KEYS = {
  collapsed: "local.source-control.collapsed",
  repositioned: "local.source-control.repositioned",
  order: "local.source-control.order",
  refreshMs: "local.source-control.refreshMs",
  githubRefreshMs: "local.source-control.githubRefreshMs",
  maxFiles: "local.source-control.maxFiles",
  startCollapsed: "local.source-control.startCollapsed",
} as const

export const DEFAULT_REFRESH_MS = 15_000
export const MIN_REFRESH_MS = 5_000
export const DEFAULT_GITHUB_REFRESH_MS = 120_000
export const MIN_GITHUB_REFRESH_MS = 30_000
export const DEFAULT_MAX_FILES = 8
export const DEFAULT_START_COLLAPSED = true
export const DEFAULT_ORDER = 50
export const MIN_ORDER = 1
export const MAX_ORDER = 999

export function pluginOptions(value: unknown): PluginOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const options = value as Record<string, unknown>
  const githubMcpCommand = options.githubMcpCommand
  return {
    ...(typeof options.refreshMs === "number" && Number.isFinite(options.refreshMs)
      ? { refreshMs: options.refreshMs }
      : {}),
    ...(typeof options.githubRefreshMs === "number" && Number.isFinite(options.githubRefreshMs)
      ? { githubRefreshMs: options.githubRefreshMs }
      : {}),
    ...(typeof options.maxFiles === "number" && Number.isFinite(options.maxFiles)
      ? { maxFiles: options.maxFiles }
      : {}),
    ...(typeof options.startCollapsed === "boolean" ? { startCollapsed: options.startCollapsed } : {}),
    ...(options.whenEmpty === "hide" || options.whenEmpty === "show" ? { whenEmpty: options.whenEmpty } : {}),
    ...(typeof options.github === "boolean" ? { github: options.github } : {}),
    ...(typeof githubMcpCommand === "string" ||
    (Array.isArray(githubMcpCommand) && githubMcpCommand.every((part) => typeof part === "string"))
      ? { githubMcpCommand: githubMcpCommand as GithubMcpCommand }
      : {}),
    ...(typeof options.remoteName === "string" && options.remoteName.trim()
      ? { remoteName: options.remoteName.trim() }
      : {}),
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bounded(value: unknown, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.floor(finiteNumber(value) ?? fallback))
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

export function readRuntimeOptions(kv: OptionsKV, options: PluginOptions): RuntimeOptions {
  return {
    refreshMs: bounded(
      kv.get(KEYS.refreshMs, options.refreshMs),
      options.refreshMs ?? DEFAULT_REFRESH_MS,
      MIN_REFRESH_MS,
    ),
    githubRefreshMs: bounded(
      kv.get(KEYS.githubRefreshMs, options.githubRefreshMs),
      options.githubRefreshMs ?? DEFAULT_GITHUB_REFRESH_MS,
      MIN_GITHUB_REFRESH_MS,
    ),
    maxFiles: bounded(kv.get(KEYS.maxFiles, options.maxFiles), options.maxFiles ?? DEFAULT_MAX_FILES, 1),
    startCollapsed: booleanValue(
      kv.get(KEYS.startCollapsed),
      options.startCollapsed ?? DEFAULT_START_COLLAPSED,
    ),
  }
}

export function applyRepositionDefault(kv: OptionsKV): boolean {
  if (!kv.ready) return false
  if (kv.get<boolean>(KEYS.repositioned, false) === true) return false
  kv.set(KEYS.collapsed, true)
  kv.set(KEYS.repositioned, true)
  return true
}

export function readRegistrationOrder(kv: OptionsKV, fallback = DEFAULT_ORDER): number {
  const value = kv.get(KEYS.order)
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(MAX_ORDER, Math.max(MIN_ORDER, number))
}
