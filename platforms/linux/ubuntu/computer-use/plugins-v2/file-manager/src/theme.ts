import { RGBA, type ColorInput } from "@opentui/core"

export type ExplorerTheme = {
  hue: { accent: { 200: ColorInput } }
  sectionCount: ColorInput
  text: {
    default: ColorInput
    subdued: ColorInput
    action: { primary: { default: ColorInput; hovered: ColorInput } }
    feedback: {
      error: { default: ColorInput }
      warning: { default: ColorInput }
    }
  }
  background: {
    default: ColorInput
    surface: { offset: ColorInput }
    action: { primary: { default: ColorInput; hovered: ColorInput } }
  }
  border: { default: ColorInput }
  diff: {
    text: { added: ColorInput; removed: ColorInput }
    background: { added: ColorInput; removed: ColorInput; context: ColorInput }
    highlight: { added: ColorInput; removed: ColorInput }
    lineNumber: { text: ColorInput; background: { added: ColorInput; removed: ColorInput } }
  }
  syntax: {
    comment: ColorInput
    keyword: ColorInput
    string: ColorInput
    number: ColorInput
    function: ColorInput
    variable: ColorInput
    type: ColorInput
    operator: ColorInput
    punctuation: ColorInput
  }
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

/** Resolve the small theme surface used by the panel. Theme definitions may
 * omit any optional token before the host resolves them, so the plugin must
 * not assume nested objects such as background.surface exist at runtime. */
export function normalizeExplorerTheme(theme: unknown): ExplorerTheme {
  const foreground = RGBA.defaultForeground()
  const background = RGBA.defaultBackground()
  const text = themeColor(theme, ["text", "default"], foreground)
  const subdued = themeColor(theme, ["text", "subdued"], text)
  const accent = themeColor(theme, ["hue", "accent", 200], text)
  const sectionCount = themeColor(theme, ["hue", "purple", 200], accent)
  const selected = themeColor(theme, ["background", "surface", "offset"], background)
  const actionTextDefault = themeColor(theme, ["text", "action", "primary", "default"], text)
  const actionTextHovered = themeColor(theme, ["text", "action", "primary", "hovered"], actionTextDefault)
  const actionBackgroundDefault = themeColor(theme, ["background", "action", "primary", "default"], background)
  const actionBackgroundHovered = themeColor(theme, ["background", "action", "primary", "hovered"], actionBackgroundDefault)
  const border = themeColor(theme, ["border", "default"], subdued)
  const error = themeColor(theme, ["text", "feedback", "error", "default"], text)
  const warning = themeColor(theme, ["text", "feedback", "warning", "default"], text)
  const added = themeColor(theme, ["diff", "text", "added"], text)
  const removed = themeColor(theme, ["diff", "text", "removed"], text)
  const addedBackground = themeColor(theme, ["diff", "background", "added"], background)
  const removedBackground = themeColor(theme, ["diff", "background", "removed"], background)
  const contextBackground = themeColor(theme, ["diff", "background", "context"], background)
  const addedHighlight = themeColor(theme, ["diff", "highlight", "added"], added)
  const removedHighlight = themeColor(theme, ["diff", "highlight", "removed"], removed)
  const lineNumberText = themeColor(theme, ["diff", "lineNumber", "text"], subdued)
  const addedLineNumberBackground = themeColor(theme, ["diff", "lineNumber", "background", "added"], addedBackground)
  const removedLineNumberBackground = themeColor(theme, ["diff", "lineNumber", "background", "removed"], removedBackground)

  return {
    hue: { accent: { 200: accent } },
    sectionCount,
    text: {
      default: text,
      subdued,
      action: { primary: { default: actionTextDefault, hovered: actionTextHovered } },
      feedback: { error: { default: error }, warning: { default: warning } },
    },
    background: {
      default: background,
      surface: { offset: selected },
      action: { primary: { default: actionBackgroundDefault, hovered: actionBackgroundHovered } },
    },
    border: { default: border },
    diff: {
      text: { added, removed },
      background: { added: addedBackground, removed: removedBackground, context: contextBackground },
      highlight: { added: addedHighlight, removed: removedHighlight },
      lineNumber: { text: lineNumberText, background: { added: addedLineNumberBackground, removed: removedLineNumberBackground } },
    },
    syntax: {
      comment: themeColor(theme, ["syntax", "comment"], subdued),
      keyword: themeColor(theme, ["syntax", "keyword"], accent),
      string: themeColor(theme, ["syntax", "string"], text),
      number: themeColor(theme, ["syntax", "number"], text),
      function: themeColor(theme, ["syntax", "function"], text),
      variable: themeColor(theme, ["syntax", "variable"], text),
      type: themeColor(theme, ["syntax", "type"], accent),
      operator: themeColor(theme, ["syntax", "operator"], subdued),
      punctuation: themeColor(theme, ["syntax", "punctuation"], subdued),
    },
  }
}
