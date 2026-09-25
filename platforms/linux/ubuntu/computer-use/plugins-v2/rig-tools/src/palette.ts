import { RGBA, type ColorInput } from "@opentui/core"

export type SidebarPalette = {
  readonly primary: ColorInput
  readonly subdued: ColorInput
  readonly sectionCount: ColorInput
  readonly ready: ColorInput
  readonly offline: ColorInput
  readonly measurement: ColorInput
  readonly action: ColorInput
  readonly removal: ColorInput
}

function isColorInput(value: unknown): value is ColorInput {
  if (typeof value === "string") return true
  return typeof value === "object" && value !== null && "buffer" in value && (value as { buffer?: unknown }).buffer instanceof Uint16Array
}

function themeColor(theme: unknown, path: readonly (string | number)[], fallback: ColorInput): ColorInput {
  let value: unknown = theme
  for (const segment of path) {
    if (typeof value !== "object" || value === null) return fallback
    value = (value as Record<string, unknown>)[String(segment)]
  }
  return isColorInput(value) ? value : fallback
}

export function sidebarPalette(theme: unknown): SidebarPalette {
  const primary = themeColor(theme, ["text", "default"], RGBA.defaultForeground())
  const subdued = themeColor(theme, ["text", "subdued"], primary)
  const sectionCount = themeColor(
    theme,
    ["hue", "purple", 200],
    themeColor(theme, ["syntax", "keyword"], themeColor(theme, ["syntax", "type"], themeColor(theme, ["hue", "accent", 200], primary))),
  )
  const ready = themeColor(theme, ["hue", "green", 200], themeColor(theme, ["text", "feedback", "success", "default"], themeColor(theme, ["diff", "text", "added"], primary)))
  const action = themeColor(theme, ["hue", "cyan", 200], themeColor(theme, ["text", "feedback", "info", "default"], primary))
  const removal = themeColor(theme, ["hue", "red", 200], themeColor(theme, ["text", "feedback", "error", "default"], themeColor(theme, ["diff", "text", "removed"], primary)))
  return {
    primary,
    subdued,
    sectionCount,
    ready,
    offline: subdued,
    measurement: themeColor(theme, ["hue", "yellow", 200], themeColor(theme, ["text", "feedback", "warning", "default"], subdued)),
    action,
    removal,
  }
}
