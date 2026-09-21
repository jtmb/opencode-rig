/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { createProcReader } from "./proc.ts"
import { createResourceMonitor, type ResourceSnapshot } from "./monitor.ts"
import { footerText, resourceTone } from "./format.ts"
import { dialogContentWidth, isPrimaryMouseButton, openPanelOrFallback, registerResourceFooterSlots } from "./registration.ts"
import { normalizeIntervalMs } from "./options.ts"
import { createSystemReader, type SystemSnapshot } from "./system.ts"
import { systemLines } from "./format.ts"

const PANEL_NAME = "opencode-rig.resource-monitor"
const SYSTEM_INTERVAL_MS = 1000

function Status(props: { snapshot: () => ResourceSnapshot; open: () => void }) {
  const context = usePlugin()
  const color = () => {
    const tone = resourceTone(props.snapshot())
    return tone === "error" ? context.theme.text.feedback.error.default : tone === "warning" ? context.theme.text.feedback.warning.default : context.theme.text.subdued
  }
  return <box focusable onMouseDown={(event) => {
    if (!isPrimaryMouseButton(event.button)) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget?.focus()
    props.open()
  }} onKeyDown={(event) => {
    if (event.name === "return" || event.name === "space") {
      event.preventDefault()
      props.open()
    }
  }}><text fg={color()}>{footerText(props.snapshot())}</text></box>
}

function SystemPanel(props: { panel: { width: number; focused: boolean; close: () => void } }) {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<SystemSnapshot>({ cpuModel: "Loading…", logicalCores: 0, filesystems: [] })
  const reader = createSystemReader()
  let disposed = false
  let running = false
  const refresh = async () => {
    if (disposed || running) return
    running = true
    try {
      const next = await reader.read()
      if (!disposed) setSnapshot(next)
    } catch {
      // Keep the last truthful sample when a bounded read fails.
    } finally {
      running = false
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), SYSTEM_INTERVAL_MS)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })

  useKeyboard((key) => {
    if (!props.panel.focused || key.name !== "escape") return
    key.preventDefault()
    key.stopPropagation()
    props.panel.close()
  })

  return <box focused focusable flexDirection="column" width="100%" height="100%" padding={1} borderStyle="single" borderColor={context.theme.hue.accent[200]}>
    <text fg={context.theme.hue.accent[200]}><b>System resources</b></text>
    <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
      <text fg={context.theme.text.subdued}>{systemLines(snapshot(), props.panel.width - 4).join("\n")}</text>
    </scrollbox>
    <text fg={context.theme.text.subdued}>Updates every second · Esc closes</text>
  </box>
}

export default Plugin.define({
  id: "opencode-rig.resource-monitor",
  setup(context) {
    const [snapshot, setSnapshot] = createSignal<ResourceSnapshot>({ rssBytes: Number.NaN, processCount: 0 })
    const interval = normalizeIntervalMs(context.options.intervalMs)
    let stopMonitor: (() => void) | undefined
    let disposed = false
    void createProcReader().then((reader) => {
      if (disposed) return
      stopMonitor = createResourceMonitor(reader, process.pid, interval, setSnapshot)
    }).catch(() => { /* /proc setup is best-effort; footer remains unavailable */ })
    const registerSlot = (claim: { append: "home.footer.status" | "prompt.footer.status"; render: () => unknown }) =>
      context.ui.slot(claim as never)
    const openResources = () => {
      openPanelOrFallback(
        () => context.ui.panel.open(PANEL_NAME, { presentation: "fullscreen" }),
        () => {
          context.ui.dialog.set({ size: "xlarge", centered: true })
          context.ui.dialog.show(() => <SystemPanel panel={{
            get width() { return dialogContentWidth(context.renderer.width) },
            focused: true,
            close: () => context.ui.dialog.clear(),
          }} />)
        },
      )
    }
    const stopSlots = registerResourceFooterSlots(registerSlot, () => <Status snapshot={snapshot} open={openResources} />)
    const stopPanel = context.ui.slot({ append: "session.panel", render: (panel) => panel.name === PANEL_NAME ? <SystemPanel panel={panel} /> : null })
    const stopKeymap = context.ui.slot({ append: "app", render: () => {
      context.keymap.layer(() => ({ mode: "global", commands: [{ id: "resource-monitor.open", title: "System resources", description: "Show host CPU, memory, swap, and storage usage.", group: "System", palette: true, slash: { name: "system-resources", aliases: ["resources"] }, run: openResources }] }))
      return null as never
    } })
    return () => { disposed = true; stopMonitor?.(); stopSlots(); stopPanel(); stopKeymap() }
  },
})
