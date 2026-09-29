/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"

import type { BrowserStatus } from "./manager.ts"
import { IntegratedBrowser } from "./rpc.ts"
import { consoleLines, parseViewport, sanitizePanelText, statusLine } from "./panel-model.ts"

export const INTEGRATED_BROWSER_PANEL_NAME = "opencode-rig.integrated-browser"
export const INTEGRATED_BROWSER_BIND = "ctrl+alt+b"

const EMPTY_STATUS: BrowserStatus = {
  sessionID: "ses_unknown",
  state: "stopped",
  tabs: [],
  viewport: { width: 1280, height: 720 },
}

function currentSessionID(context: ReturnType<typeof usePlugin>): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

function Control(props: { label: string; run: () => void; disabled?: boolean }) {
  const context = usePlugin()
  const activate = () => {
    if (!props.disabled) props.run()
  }
  return (
    <box
      focusable={!props.disabled}
      onMouseDown={(event) => {
        if (event.button === 0) {
          event.preventDefault()
          activate()
        }
      }}
      onKeyDown={(event) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault()
          activate()
        }
      }}
    >
      <text fg={props.disabled ? context.theme.text.subdued : context.theme.hue.accent[200]}>{props.label}{props.disabled ? " (disabled)" : ""}</text>
    </box>
  )
}

function BrowserPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const rpc = context.client.rpc(IntegratedBrowser)
  const rpcOptions = { location: context.location }
  const [status, setStatus] = createSignal<BrowserStatus>({ ...EMPTY_STATUS, sessionID: props.panel.sessionID })
  const [details, setDetails] = createSignal("")
  const [notice, setNotice] = createSignal("Loading browser status…")
  let disposed = false

  const refresh = async () => {
    if (disposed) return
    try {
      const next = await rpc.status({ sessionID: props.panel.sessionID }, rpcOptions) as BrowserStatus
      if (disposed) return
      setStatus(next)
      setNotice(next.error ?? (next.state === "stopped" ? "No headed Chromium session is running." : ""))
    } catch {
      if (!disposed) setNotice("Server browser plugin is unavailable; restart OpenCode after registration changes.")
    }
  }

  const call = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
      await refresh()
    } catch (error) {
      setNotice(sanitizePanelText(error instanceof Error ? error.message : error, 512))
    }
  }

  const promptURL = async (title: string, operation: (url: string) => Promise<unknown>) => {
    const value = await context.ui.dialog.prompt({ title, description: "Only http:// and https:// URLs are accepted.", placeholder: "https://example.com" })
    if (value !== undefined && value.trim()) await call(() => operation(value.trim()))
  }

  const launch = () => void promptURL("Launch headed Chromium", (url) => rpc.launch({ sessionID: props.panel.sessionID, url }, rpcOptions))
  const navigate = () => void promptURL("Navigate current tab", (url) => rpc.navigate({ sessionID: props.panel.sessionID, url, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions))
  const newTab = () => void promptURL("Open browser tab", (url) => rpc.newTab({ sessionID: props.panel.sessionID, url }, rpcOptions))
  const closeBrowser = async () => {
    const confirmed = await context.ui.dialog.confirm({ title: "Close headed Chromium", message: "Close this session's isolated browser window?" })
    if (confirmed) await call(() => rpc.close({ sessionID: props.panel.sessionID }, rpcOptions))
  }
  const selectTab = async () => {
    const tabs = status().tabs
    if (tabs.length === 0) return
    const selected = await context.ui.dialog.select({
      title: "Select browser tab",
      current: status().currentTabID,
      options: tabs.map((tab) => ({ title: `${tab.id} · ${sanitizePanelText(tab.title || tab.url, 120)}`, value: tab.id })),
    })
    if (selected) await call(() => rpc.selectTab({ sessionID: props.panel.sessionID, tabID: selected }, rpcOptions))
  }
  const closeTab = async () => {
    const tabID = status().currentTabID
    if (tabID) await call(() => rpc.closeTab({ sessionID: props.panel.sessionID, tabID }, rpcOptions))
  }
  const snapshot = async () => {
    try {
      const result = await rpc.snapshot({ sessionID: props.panel.sessionID, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions) as { text: string }
      setDetails(sanitizePanelText(result.text, 24_000))
      await refresh()
    } catch (error) {
      setNotice(sanitizePanelText(error instanceof Error ? error.message : error, 512))
    }
  }
  const showConsole = async () => {
    try {
      const result = await rpc.console({ sessionID: props.panel.sessionID, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions) as { entries: readonly { type: string; text: string }[] }
      setDetails(consoleLines(result.entries, 2_000))
      await refresh()
    } catch (error) {
      setNotice(sanitizePanelText(error instanceof Error ? error.message : error, 512))
    }
  }
  const screenshot = async () => {
    try {
      const result = await rpc.screenshot({ sessionID: props.panel.sessionID, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions) as { mimeType: string; data: string }
      setDetails(`Captured bounded ${result.mimeType} viewport screenshot (${Math.floor(result.data.length * 0.75)} bytes). The image is returned to the agent tool; this panel does not embed a browser surface.`)
      await refresh()
    } catch (error) {
      setNotice(sanitizePanelText(error instanceof Error ? error.message : error, 512))
    }
  }
  const viewport = async () => {
    const value = await context.ui.dialog.prompt({ title: "Set browser viewport", value: `${status().viewport.width}x${status().viewport.height}`, placeholder: "1280x720" })
    if (value === undefined) return
    try {
      const size = parseViewport(value)
      await call(() => rpc.viewport({ sessionID: props.panel.sessionID, ...size, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions))
    } catch (error) {
      setNotice(sanitizePanelText(error instanceof Error ? error.message : error, 512))
    }
  }

  useKeyboard((key) => {
    if (!props.panel.focused || key.name !== "escape") return
    key.preventDefault()
    key.stopPropagation()
    props.panel.close()
  })

  createEffect(() => {
    void props.panel.sessionID
    void refresh()
  })
  const timer = setInterval(() => void refresh(), 1_000)
  const stopEvents = rpc.events.on("changed", (event) => {
    if (event.data.sessionID === props.panel.sessionID) void refresh()
  })
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
    stopEvents()
  })

  return (
    <box
      focused
      focusable
      flexDirection="column"
      width="100%"
      height="100%"
      padding={1}
      borderStyle="single"
      borderColor={context.theme.hue.accent[200]}
    >
      <text fg={context.theme.hue.accent[200]}><b>Integrated browser</b></text>
      <text fg={context.theme.text.subdued}>External headed Chromium window · isolated per OpenCode session · Esc closes this control panel</text>
      <text fg={status().state === "error" ? context.theme.text.feedback.error.default : context.theme.text.default}>{statusLine(status())}</text>
      <Show when={status().error || notice()}>
        <text fg={status().error ? context.theme.text.feedback.error.default : context.theme.text.subdued}>{sanitizePanelText(status().error ?? notice(), 512)}</text>
      </Show>
      <box flexDirection="row" gap={1}>
        <Control label="launch" run={launch} disabled={status().state === "starting" || status().state === "ready"} />
        <Control label="navigate" run={navigate} disabled={status().state !== "ready"} />
        <Control label="new tab" run={newTab} disabled={status().state !== "ready"} />
        <Control label="select tab" run={() => void selectTab()} disabled={status().tabs.length === 0} />
        <Control label="close tab" run={() => void closeTab()} disabled={!status().currentTabID} />
        <Control label="close browser" run={() => void closeBrowser()} disabled={status().state === "stopped"} />
      </box>
      <box flexDirection="row" gap={1}>
        <Control label="back" run={() => void call(() => rpc.back({ sessionID: props.panel.sessionID, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions))} disabled={status().state !== "ready"} />
        <Control label="forward" run={() => void call(() => rpc.forward({ sessionID: props.panel.sessionID, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions))} disabled={status().state !== "ready"} />
        <Control label="reload" run={() => void call(() => rpc.reload({ sessionID: props.panel.sessionID, ...(status().currentTabID ? { tabID: status().currentTabID } : {}) }, rpcOptions))} disabled={status().state !== "ready"} />
        <Control label="viewport" run={() => void viewport()} disabled={status().state !== "ready"} />
        <Control label="snapshot" run={() => void snapshot()} disabled={status().state !== "ready"} />
        <Control label="console" run={() => void showConsole()} disabled={status().state !== "ready"} />
        <Control label="screenshot" run={() => void screenshot()} disabled={status().state !== "ready"} />
      </box>
      <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
        <Show when={status().tabs.length > 0} fallback={<text fg={context.theme.text.subdued}>Launch a URL to create the first tab.</text>}>
          <For each={status().tabs}>
            {(tab) => <text fg={tab.id === status().currentTabID ? context.theme.text.default : context.theme.text.subdued}>{tab.id} {tab.id === status().currentTabID ? "*" : " "} {sanitizePanelText(tab.title || tab.url, 240)}</text>}
          </For>
        </Show>
        <Show when={details()}>
          <text fg={context.theme.text.subdued}>{details()}</text>
        </Show>
      </scrollbox>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.integrated-browser",
  setup(context) {
    const openPanel = () => {
      if (!currentSessionID(context)) {
        void context.ui.dialog.alert({ title: "Integrated browser", message: "This panel requires an active session." }).catch(() => undefined)
        return
      }
      const opened = context.ui.panel.open(INTEGRATED_BROWSER_PANEL_NAME, { presentation: "fullscreen" })
      if (!opened) void context.ui.dialog.alert({ title: "Integrated browser", message: "This panel requires an active session." }).catch(() => undefined)
    }
    const stopPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => panel.name === INTEGRATED_BROWSER_PANEL_NAME ? <BrowserPanel panel={panel} /> : null,
    })
    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "opencode-rig.integrated-browser.open",
            title: "Integrated browser",
            description: "Open the bounded fullscreen control panel for the session-owned headed Chromium window.",
            group: "Open Rig",
            bind: INTEGRATED_BROWSER_BIND,
            palette: true,
            slash: { name: "browser" },
            run: openPanel,
          }],
        }))
        return null as never
      },
    })
    return () => {
      stopPanel()
      stopKeymap()
    }
  },
})
