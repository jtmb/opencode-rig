/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, Show } from "solid-js"

import {
  compactReset,
  formatDetails,
  percent,
  providerPanelDetail,
  providerStatusLabel,
  usageUpdatedLabel,
} from "./format.ts"
import { createUsageStore, type UsageState, type UsageStore } from "./store.ts"
import { lunaReserveWindow, overallWeeklyWindow, type CodexUsageWindow } from "./usage.ts"
import type { ProviderState } from "./providers.ts"

type Theme = Context["theme"]

const DEFAULT_REFRESH_MS = 60_000
const MIN_REFRESH_MS = 30_000

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usageColor(leftPercent: number, theme: Theme) {
  if (leftPercent <= 10) return theme.text.feedback.error.default
  if (leftPercent <= 20) return theme.text.feedback.warning.default
  return theme.text.feedback.success.default
}

function WindowRow(props: {
  label: string
  window: CodexUsageWindow
  theme: () => Theme
  now: () => number
}) {
  return (
    <box flexDirection="row" paddingLeft={1}>
      <text fg={props.theme().text.subdued}>{props.label}</text>
      <text fg={usageColor(props.window.leftPercent, props.theme())}>
        <b> {percent(props.window.leftPercent)} left</b>
      </text>
      <text fg={props.theme().text.subdued}> · {compactReset(props.window.resetsAt, props.now())}</text>
    </box>
  )
}

function ProviderRow(props: {
  provider: ProviderState
  snapshot: UsageState["snapshot"]
  theme: () => Theme
  now: () => number
}) {
  const color = () => props.provider.status === "available"
    ? props.theme().text.feedback.success.default
    : props.provider.status === "quota-exhausted"
      ? props.theme().text.feedback.error.default
      : props.provider.status === "cooling" || props.provider.status === "usage-unavailable" || props.provider.status === "stale"
      ? props.theme().text.feedback.warning.default
      : props.theme().text.subdued
  const weekly = () => props.provider.id === "codex" && props.snapshot
    ? overallWeeklyWindow(props.snapshot)
    : undefined
  const reserve = () => props.provider.id === "codex" && props.snapshot
    ? lunaReserveWindow(props.snapshot)
    : undefined
  const showDetail = () => props.provider.id !== "codex" || weekly() === undefined
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row">
        <text fg={props.theme().text.default}><b>{props.provider.label}</b></text>
        <box flexGrow={1} />
        <text fg={color()}><b>{providerStatusLabel(props.provider.status)}</b></text>
      </box>
      <Show when={weekly()}>{(window) => <WindowRow label="Weekly" window={window()} theme={props.theme} now={props.now} />}</Show>
      <Show when={reserve()}>{(window) => <WindowRow label="Reserve" window={window()} theme={props.theme} now={props.now} />}</Show>
      <Show when={showDetail()}>
        <box paddingLeft={1}>
          <text fg={props.theme().text.subdued}>{providerPanelDetail(props.provider)}</text>
        </box>
      </Show>
    </box>
  )
}

function UsagePanel(props: { store: UsageStore; sessionID: string; refreshMs: number; syncProviders: () => Promise<void> }) {
  const context = usePlugin()
  const [state, setState] = createSignal<UsageState>(props.store.getState())
  const [settings, updateSettings] = context.storage.store("settings", { initial: { collapsed: false } })
  const [now, setNow] = createSignal(Date.now())
  const theme = () => context.theme
  const stop = props.store.subscribe(setState)
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  const poll = setInterval(() => {
    void props.syncProviders().then(() => props.store.refresh())
  }, props.refreshMs)

  void props.syncProviders().then(() => props.store.refresh())

  const stopIdle = context.data.on("session.idle", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    void props.syncProviders().then(() => props.store.refresh(true))
  })

  onCleanup(() => {
    stop()
    clearInterval(clock)
    clearInterval(poll)
    stopIdle()
  })

  const collapsed = () => settings.collapsed
  const toggle = () => {
    void updateSettings((draft) => {
      draft.collapsed = !draft.collapsed
    })
  }

  const visible = () => {
    return (state().providers?.length ?? 0) > 0
  }

  return (
    <Show when={visible()}>
      <box flexDirection="column" gap={0}>
        <box
          focusable
          onMouseDown={toggle}
          onKeyDown={(event) => {
            if (event.name === "return" || event.name === "space") {
              event.preventDefault()
              toggle()
            }
          }}
        >
          <text fg={theme().text.default}>
            <b>{collapsed() ? "+" : "-"} Provider Usage</b>
          </text>
        </box>

        <Show when={!collapsed()}>
          <For each={state().providers ?? []}>
            {(provider) => <ProviderRow provider={provider} snapshot={state().snapshot} theme={theme} now={now} />}
          </For>
          <Show when={state().status === "error" && state().message}>
            <text fg={theme().text.feedback.warning.default}>Refresh failed; saved values retained.</text>
          </Show>
          <Show when={state().snapshot || state().deepSeekBalance}>
            <text fg={theme().text.subdued}>
              {usageUpdatedLabel(state(), now())}
            </text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-rig.codex-usage",
  setup(context) {
    const refreshMs = Math.max(MIN_REFRESH_MS, Math.floor(positiveNumber(context.options.refreshMs) ?? DEFAULT_REFRESH_MS))
    const store = createUsageStore({
      timeoutMs: positiveNumber(context.options.timeoutMs),
      supportsLunaReserve: true,
      deepSeekEndpoint:
        typeof context.options.deepSeekEndpoint === "string" ? context.options.deepSeekEndpoint : undefined,
    })
    const syncProviders = async () => {
      try {
        const result = await context.client.provider.list({ location: context.location ?? context.data.location.default() })
        store.updateProviders(result.data)
      } catch {
        store.updateProviders(undefined)
      }
    }

    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "codex-usage.refresh",
              title: "Refresh provider usage",
              description: "Refresh Codex quota, DeepSeek balance, and provider status.",
              group: "Providers",
              palette: true,
              run: async (input) => {
                await syncProviders()
                const state = await store.refresh(true)
                context.ui.toast.show({
                  variant: state.status === "ready" ? "success" : "warning",
                  title: "Provider usage",
                  message:
                    state.status === "ready"
                      ? "Usage limits refreshed."
                      : (state.message ?? "Refresh failed."),
                })
                void input
              },
            },
            {
              id: "codex-usage.details",
              title: "Provider usage details",
              description: "Show verified Codex limits, DeepSeek balance, and provider statuses.",
              group: "Providers",
              palette: true,
              slash: { name: "provider-usage", aliases: ["codex-usage", "usage-left"] },
              run: async () => {
                await syncProviders()
                await context.ui.dialog.alert({
                  title: "Provider usage",
                  message: formatDetails(store.getState()),
                })
              },
            },
          ],
        }))
        return null as never
      },
    })

    const stopSlot = context.ui.slot({
      append: "sidebar.footer",
      render: ({ sessionID }) => <UsagePanel store={store} sessionID={sessionID} refreshMs={refreshMs} syncProviders={syncProviders} />,
    })

    return () => {
      stopKeymap()
      stopSlot()
      store.dispose()
    }
  },
})
