export const RESOURCE_FOOTER_SLOTS = ["home.footer.status", "prompt.footer.status"] as const

type Slot = (claim: { append: typeof RESOURCE_FOOTER_SLOTS[number]; render: () => unknown }) => () => void

export function registerResourceFooterSlots(slot: Slot, render: () => unknown): () => void {
  const stops = RESOURCE_FOOTER_SLOTS.map((append) => slot({ append, render }))
  return () => { for (const stop of stops) stop() }
}

export function isPrimaryMouseButton(button: number): boolean {
  return button === 0
}

export function openPanelOrFallback(openPanel: () => boolean, fallback: () => void): "panel" | "fallback" {
  if (openPanel()) return "panel"
  fallback()
  return "fallback"
}

export function dialogContentWidth(rendererWidth: number): number {
  if (!Number.isFinite(rendererWidth) || rendererWidth <= 0) return 20
  return Math.max(20, Math.floor(rendererWidth * 0.7))
}
