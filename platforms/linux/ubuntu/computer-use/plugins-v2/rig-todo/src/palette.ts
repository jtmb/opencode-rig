import { RGBA, type ColorInput } from "@opentui/core"

export type TodoPalette = {
  readonly primary: ColorInput
  readonly subdued: ColorInput
  readonly sectionCount: ColorInput
  readonly ready: ColorInput
  readonly action: ColorInput
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

export function todoPalette(theme: unknown): TodoPalette {
  const primary = themeColor(theme, ["text", "default"], RGBA.defaultForeground())
  const subdued = themeColor(theme, ["text", "subdued"], primary)
  return {
    primary,
    subdued,
    sectionCount: themeColor(theme, ["hue", "purple", 200], themeColor(theme, ["syntax", "keyword"], themeColor(theme, ["syntax", "type"], themeColor(theme, ["hue", "accent", 200], primary)))),
    ready: themeColor(theme, ["hue", "green", 200], themeColor(theme, ["text", "feedback", "success", "default"], themeColor(theme, ["diff", "text", "added"], primary))),
    action: themeColor(theme, ["hue", "cyan", 200], themeColor(theme, ["text", "feedback", "info", "default"], primary)),
  }
}
