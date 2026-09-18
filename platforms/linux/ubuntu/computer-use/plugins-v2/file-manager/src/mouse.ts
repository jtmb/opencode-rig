/**
 * Mouse events can be hit-tested to a row container or to one of its text
 * children depending on the terminal renderable, and they bubble up the tree.
 * Mark the first activation so exactly one handler acts per physical click.
 */
export interface MouseActivation {
  button?: number
  preventDefault?: () => void
  __rigHandled?: boolean
}

/** Returns true for the first left-button activation of an event, false otherwise. */
export function consumeMouseActivation(event: MouseActivation): boolean {
  if (event.__rigHandled) return false
  event.__rigHandled = true
  return event.button === undefined || event.button === 0
}

export interface EditorMouseEvent {
  x: number
  y: number
  button?: number
}

export interface EditorMouseLayout {
  x: number
  y: number
  scrollY: number
  lineCount: number
  lines: readonly string[]
}

export interface EditorCursorPosition {
  row: number
  column: number
}

/** Convert a primary-button editor click into a bounded logical cursor point. */
export function editorCursorPosition(
  event: EditorMouseEvent,
  layout: EditorMouseLayout,
): EditorCursorPosition | undefined {
  if (event.button !== undefined && event.button !== 0) return undefined
  const lastRow = Math.max(0, layout.lineCount - 1)
  const row = Math.max(0, Math.min(lastRow, Math.trunc(layout.scrollY + event.y - layout.y)))
  const line = layout.lines[row] ?? ""
  const column = Math.max(0, Math.min(line.length, Math.trunc(event.x - layout.x)))
  return { row, column }
}
