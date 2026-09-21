import type { BrowserStatus, ConsoleEntry } from "./manager.ts"

export function sanitizePanelText(value: unknown, maximum: number): string {
  const text = typeof value === "string" ? value : String(value ?? "")
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, maximum)
}

export function parseViewport(value: string): { width: number; height: number } {
  const match = /^\s*(\d+)\s*x\s*(\d+)\s*$/.exec(value)
  if (!match) throw new Error("viewport must use WIDTHxHEIGHT, for example 1280x720")
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isInteger(width) || width < 320 || width > 1_920 || !Number.isInteger(height) || height < 240 || height > 1_080) {
    throw new Error("viewport must be between 320x240 and 1920x1080")
  }
  return { width, height }
}

export function statusLine(status: BrowserStatus): string {
  const tabs = `${status.tabs.length} tab${status.tabs.length === 1 ? "" : "s"}`
  const current = status.currentTabID ? ` · ${status.currentTabID}` : ""
  return `${status.state} · ${tabs}${current} · viewport ${status.viewport.width}x${status.viewport.height}`
}

export function consoleLines(entries: readonly ConsoleEntry[], maximum: number): string {
  if (entries.length === 0) return "No console messages captured."
  return entries.map((entry) => `[${sanitizePanelText(entry.type, 32)}] ${sanitizePanelText(entry.text, maximum)}`).join("\n")
}
