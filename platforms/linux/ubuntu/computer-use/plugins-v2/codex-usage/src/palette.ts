import { RGBA, type ColorInput } from "@opentui/core"

export type ProviderPalette = {
  readonly primary: ColorInput
  readonly subdued: ColorInput
  readonly sectionCount: ColorInput
  readonly ready: ColorInput
  readonly offline: ColorInput
  readonly healthy: ColorInput
  readonly critical: ColorInput
  readonly neutral: ColorInput
  /** Compatibility name for the warning/measurement semantic slot. */
  readonly measurement: ColorInput
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

export function providerPalette(theme: unknown): ProviderPalette {
  const primary = themeColor(theme, ["text", "default"], RGBA.defaultForeground())
  const subdued = themeColor(theme, ["text", "subdued"], primary)
  const healthy = themeColor(theme, ["hue", "green", 200], themeColor(theme, ["text", "feedback", "success", "default"], primary))
  const measurement = themeColor(theme, ["hue", "orange", 200], themeColor(theme, ["text", "feedback", "warning", "default"], subdued))
  const critical = themeColor(theme, ["hue", "red", 200], themeColor(theme, ["text", "feedback", "error", "default"], primary))
  return {
    primary,
    subdued,
    sectionCount: themeColor(theme, ["hue", "purple", 200], themeColor(theme, ["syntax", "keyword"], themeColor(theme, ["syntax", "type"], themeColor(theme, ["hue", "accent", 200], primary)))),
    ready: healthy,
    offline: subdued,
    healthy,
    critical,
    neutral: subdued,
    measurement,
  }
}
