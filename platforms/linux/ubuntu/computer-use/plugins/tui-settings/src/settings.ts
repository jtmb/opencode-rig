import type { TuiKV } from "@opencode-ai/plugin/tui"

export type SettingsSectionId = "appearance" | "display" | "plugins" | "source-control" | "sidebar" | "about"

export type SettingsSection = {
  id: SettingsSectionId
  title: string
  description: string
}

export const SECTIONS: readonly SettingsSection[] = [
  { id: "appearance", title: "Appearance", description: "Theme and dark/light mode" },
  { id: "display", title: "Display", description: "Timestamps, thinking, tool details, scrollbar, animations, diffs" },
  { id: "plugins", title: "Plugins", description: "Loaded plugins and the plugin manager" },
  { id: "source-control", title: "Source Control", description: "Refresh intervals, visible rows, and start state" },
  { id: "sidebar", title: "Sidebar", description: "Visibility and panel positioning" },
  { id: "about", title: "About", description: "Versions, paths, and terminal size" },
]

export const KEYS = {
  sidebar: "sidebar",
  gearOrder: "local.tui-settings.order",
  sourceControlOrder: "local.source-control.order",
  sourceControlRefreshMs: "local.source-control.refreshMs",
  sourceControlGithubRefreshMs: "local.source-control.githubRefreshMs",
  sourceControlMaxFiles: "local.source-control.maxFiles",
  sourceControlStartCollapsed: "local.source-control.startCollapsed",
} as const

export const SIDEBAR_AUTO_MIN_WIDTH = 120
export const COMPACT_LAYOUT_WIDTH = 96
export const DEFAULT_GEAR_ORDER = 10
export const MIN_SIDEBAR_ORDER = 1
export const MAX_SIDEBAR_ORDER = 999

export function isCompactLayout(width: number): boolean {
  return width < COMPACT_LAYOUT_WIDTH
}

export function dialogSizeFor(width: number): "medium" | "large" {
  return isCompactLayout(width) ? "medium" : "large"
}

export type SidebarVisibility = "auto" | "hide"

export function readSidebarVisibility(kv: TuiKV): SidebarVisibility {
  return kv.get(KEYS.sidebar) === "hide" ? "hide" : "auto"
}

export function writeSidebarVisibility(kv: TuiKV, value: SidebarVisibility): void {
  kv.set(KEYS.sidebar, value)
}

export function sidebarAutoVisible(width: number): boolean {
  return width > SIDEBAR_AUTO_MIN_WIDTH
}

export function sidebarVisibilityLabel(visibility: SidebarVisibility, width: number): string {
  if (visibility === "hide") return "hidden"
  return sidebarAutoVisible(width) ? "auto (visible)" : "auto (hidden: terminal too narrow)"
}

export type DisplayKind = "boolean" | "hide-show" | "enum"

export type DisplaySetting = {
  key: string
  title: string
  kind: DisplayKind
  defaultValue: boolean | string
  options?: readonly string[]
}

export const DISPLAY_SETTINGS: readonly DisplaySetting[] = [
  { key: "timestamps", title: "Timestamps", kind: "hide-show", defaultValue: "hide" },
  { key: "thinking_mode", title: "Thinking", kind: "hide-show", defaultValue: "hide" },
  { key: "tool_details_visibility", title: "Tool details", kind: "boolean", defaultValue: true },
  { key: "assistant_metadata_visibility", title: "Assistant metadata", kind: "boolean", defaultValue: true },
  { key: "scrollbar_visible", title: "Scrollbar", kind: "boolean", defaultValue: false },
  { key: "animations_enabled", title: "Animations", kind: "boolean", defaultValue: true },
  { key: "generic_tool_output_visibility", title: "Generic tool output", kind: "boolean", defaultValue: false },
  { key: "diff_wrap_mode", title: "Diff wrap", kind: "enum", defaultValue: "word", options: ["word", "none"] },
]

export function readDisplaySetting(kv: TuiKV, setting: DisplaySetting): boolean | string {
  const raw = kv.get(setting.key)
  if (setting.kind === "boolean") return typeof raw === "boolean" ? raw : (setting.defaultValue as boolean)
  if (setting.kind === "hide-show") {
    if (raw === "show" || raw === "hide") return raw
    return setting.defaultValue as string
  }
  return typeof raw === "string" && setting.options?.includes(raw) ? raw : (setting.defaultValue as string)
}

export function displayLabel(setting: DisplaySetting, value: boolean | string): string {
  if (setting.kind === "boolean") return value ? "on" : "off"
  return String(value)
}

export function toggleDisplaySetting(kv: TuiKV, setting: DisplaySetting): boolean | string {
  const current = readDisplaySetting(kv, setting)
  let next: boolean | string
  if (setting.kind === "boolean") {
    next = !current
  } else if (setting.kind === "hide-show") {
    next = current === "show" ? "hide" : "show"
  } else {
    const options = setting.options ?? []
    const index = options.indexOf(String(current))
    next = options.length > 0 ? options[(index + 1) % options.length] : String(current)
  }
  kv.set(setting.key, next)
  return next
}

export type SidebarPanelId = "tui-settings" | "source-control"

export type SidebarAnchorId =
  | "top"
  | "before-context"
  | "after-context"
  | "after-mcp"
  | "after-lsp"
  | "after-todo"
  | "after-files"

export type SidebarAnchor = {
  id: SidebarAnchorId
  title: string
  order: number
}

export const SIDEBAR_ANCHORS: readonly SidebarAnchor[] = [
  { id: "top", title: "Top of sidebar", order: 10 },
  { id: "before-context", title: "Above Context", order: 50 },
  { id: "after-context", title: "Below Context", order: 150 },
  { id: "after-mcp", title: "Below MCP", order: 250 },
  { id: "after-lsp", title: "Below LSP", order: 350 },
  { id: "after-todo", title: "Below Todo", order: 450 },
  { id: "after-files", title: "Below Files", order: 550 },
]

export type SidebarPanel = {
  id: SidebarPanelId
  title: string
  orderKey: string
  defaultOrder: number
}

export const SIDEBAR_PANELS: readonly SidebarPanel[] = [
  { id: "tui-settings", title: "Settings gear", orderKey: KEYS.gearOrder, defaultOrder: DEFAULT_GEAR_ORDER },
  { id: "source-control", title: "Source Control", orderKey: KEYS.sourceControlOrder, defaultOrder: 50 },
]

export function clampSidebarOrder(value: unknown, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(MAX_SIDEBAR_ORDER, Math.max(MIN_SIDEBAR_ORDER, number))
}

export function readSidebarPanelOrder(kv: TuiKV, panel: SidebarPanel): number {
  return clampSidebarOrder(kv.get(panel.orderKey), panel.defaultOrder)
}

export function anchorForOrder(order: number): SidebarAnchor {
  let best = SIDEBAR_ANCHORS[0]
  for (const anchor of SIDEBAR_ANCHORS) {
    if (anchor.order <= order) best = anchor
  }
  return best
}

export function writeSidebarPanelAnchor(kv: TuiKV, panel: SidebarPanel, anchorId: SidebarAnchorId): number {
  const anchor = SIDEBAR_ANCHORS.find((candidate) => candidate.id === anchorId) ?? SIDEBAR_ANCHORS[0]
  kv.set(panel.orderKey, anchor.order)
  return anchor.order
}

export type SourceControlNumberKey = "refreshMs" | "githubRefreshMs" | "maxFiles"

export type SourceControlPreset = {
  key: SourceControlNumberKey
  kvKey: string
  title: string
  fallback: number
  values: readonly number[]
}

export const SOURCE_CONTROL_PRESETS: readonly SourceControlPreset[] = [
  {
    key: "refreshMs",
    kvKey: KEYS.sourceControlRefreshMs,
    title: "Local refresh",
    fallback: 15_000,
    values: [5_000, 15_000, 30_000, 60_000],
  },
  {
    key: "githubRefreshMs",
    kvKey: KEYS.sourceControlGithubRefreshMs,
    title: "GitHub refresh",
    fallback: 120_000,
    values: [30_000, 60_000, 120_000, 300_000],
  },
  {
    key: "maxFiles",
    kvKey: KEYS.sourceControlMaxFiles,
    title: "Visible files",
    fallback: 8,
    values: [5, 8, 12, 20],
  },
]

export function readSourceControlNumber(kv: TuiKV, preset: SourceControlPreset): number {
  const value = kv.get(preset.kvKey)
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : preset.fallback
}

export function writeSourceControlNumber(kv: TuiKV, preset: SourceControlPreset, value: number): void {
  kv.set(preset.kvKey, value)
}

export function readSourceControlStartCollapsed(kv: TuiKV): boolean {
  const value = kv.get(KEYS.sourceControlStartCollapsed)
  return typeof value === "boolean" ? value : true
}

export function toggleSourceControlStartCollapsed(kv: TuiKV): boolean {
  const next = !readSourceControlStartCollapsed(kv)
  kv.set(KEYS.sourceControlStartCollapsed, next)
  return next
}

export function formatInterval(value: number): string {
  if (value >= 60_000 && value % 60_000 === 0) return `${value / 60_000}m`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}s`
  return String(value)
}
