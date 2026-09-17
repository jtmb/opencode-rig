/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"

import { formatDetails, percent, relativeTime, updatedAgo } from "./format.ts"
import { isCodexSubscriptionModel, latestSessionModel, messageModel, type SessionModel } from "./model.ts"
import { createUsageStore, type UsageState, type UsageStore, type UsageStoreOptions } from "./store.ts"
import { lunaReserveWindow, overallWeeklyWindow, type CodexUsageWindow } from "./usage.ts"

type PluginOptions = Pick<UsageStoreOptions, "timeoutMs"> & { refreshMs?: number }

const id = "local.codex-usage"
const COLLAPSED_KEY = "local.codex-usage.collapsed"
const DEFAULT_REFRESH_MS = 60_000
const MIN_REFRESH_MS = 30_000

function pluginOptions(value: unknown): PluginOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const options = value as Record<string, unknown>
  return {
    ...(typeof options.refreshMs === "number" && Number.isFinite(options.refreshMs)
      ? { refreshMs: options.refreshMs }
      : {}),
    ...(typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? { timeoutMs: options.timeoutMs }
      : {}),
  }
}

function usageColor(leftPercent: number, theme: TuiThemeCurrent) {
  if (leftPercent <= 10) return theme.error
  if (leftPercent <= 20) return theme.warning
  return theme.success
}

function WindowRow(props: {
  label: string
  window: CodexUsageWindow
  theme: () => TuiThemeCurrent
  now: () => number
  compact?: boolean
}) {
  if (props.compact) {
    return (
      <box flexDirection="row" gap={1}>
        <text fg={props.theme().textMuted}>{props.label}</text>
        <text fg={usageColor(props.window.leftPercent, props.theme())}>
          <b>{percent(props.window.leftPercent)} left</b>
        </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" gap={0}>
      <text fg={props.theme().textMuted}>{props.label}</text>
      <text fg={usageColor(props.window.leftPercent, props.theme())}>
        <b>{percent(props.window.leftPercent)} remaining</b>
      </text>
      <text fg={props.theme().textMuted}>{relativeTime(props.window.resetsAt, props.now())}</text>
    </box>
  )
}

function UsagePanel(props: {
  api: Parameters<TuiPlugin>[0]
  store: UsageStore
  sessionID: string
  refreshMs: number
}) {
  const [state, setState] = createSignal<UsageState>(props.store.getState())
  const [collapsed, setCollapsed] = createSignal(props.api.kv.get(COLLAPSED_KEY, false))
  const [now, setNow] = createSignal(Date.now())
  const [activeModel, setActiveModel] = createSignal<SessionModel | undefined>(
    latestSessionModel(props.api.state.session.messages(props.sessionID)),
  )
  const theme = () => props.api.theme.current
  const stop = props.store.subscribe(setState)
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  const poll = setInterval(() => {
    if (isCodexSubscriptionModel(activeModel())) void props.store.refresh()
  }, props.refreshMs)
  const stopModelSwitch = props.api.event.on("session.next.model.switched", (event) => {
    if (event.properties.sessionID === props.sessionID) {
      setActiveModel({
        providerID: event.properties.model.providerID,
        modelID: event.properties.model.id,
      })
    }
  })
  const stopMessage = props.api.event.on("message.updated", (event) => {
    if (event.properties.sessionID !== props.sessionID) return
    const model = messageModel(event.properties.info)
    if (model) setActiveModel(model)
  })
  const stopIdle = props.api.event.on("session.idle", (event) => {
    if (event.properties.sessionID === props.sessionID && isCodexSubscriptionModel(activeModel())) {
      void props.store.refresh(true)
    }
  })

  createEffect(() => {
    if (isCodexSubscriptionModel(activeModel())) void props.store.refresh()
  })

  onCleanup(() => {
    stop()
    clearInterval(clock)
    clearInterval(poll)
    stopModelSwitch()
    stopMessage()
    stopIdle()
  })

  const toggle = () => {
    const next = !collapsed()
    setCollapsed(next)
    props.api.kv.set(COLLAPSED_KEY, next)
  }

  const visible = () => {
    const snapshot = state().snapshot
    return isCodexSubscriptionModel(activeModel()) && snapshot !== undefined && overallWeeklyWindow(snapshot) !== undefined
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
          <text fg={theme().text}>
            <b>{collapsed() ? "+" : "-"} Codex Usage</b>
          </text>
        </box>

        <Show when={!collapsed()}>
          <Show when={state().snapshot}>
            {(snapshot) => (
              <box flexDirection="column" gap={0}>
                <Show when={overallWeeklyWindow(snapshot())}>
                  {(window) => <WindowRow label="Weekly limit" window={window()} theme={theme} now={now} />}
                </Show>
                <Show when={lunaReserveWindow(snapshot())}>
                  {(window) => <WindowRow label="Luna Reserve" compact window={window()} theme={theme} now={now} />}
                </Show>
                <Show when={state().status === "error" && state().message}>
                  <text fg={theme().warning}>Last refresh failed; showing saved values.</text>
                </Show>
                <text fg={theme().textMuted}>{updatedAgo(snapshot().fetchedAt, now())}</text>
              </box>
            )}
          </Show>
        </Show>
      </box>
    </Show>
  )
}

function showDetails(api: Parameters<TuiPlugin>[0], store: UsageStore) {
  api.ui.dialog.replace(() =>
    api.ui.DialogAlert({
      title: "Codex usage",
      message: formatDetails(store.getState()),
      onConfirm: () => api.ui.dialog.clear(),
    }),
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = pluginOptions(rawOptions)
  const refreshMs = Math.max(MIN_REFRESH_MS, Math.floor(options.refreshMs ?? DEFAULT_REFRESH_MS))
  const store = createUsageStore({ timeoutMs: options.timeoutMs, supportsLunaReserve: true })

  api.lifecycle.onDispose(() => store.dispose())

  const stopCommands = api.command?.register(() => [
    {
      title: "Refresh Codex usage",
      value: "codex-usage.refresh",
      description: "Refresh ChatGPT Codex subscription limits.",
      category: "Codex",
      onSelect: async () => {
        const state = await store.refresh(true)
        api.ui.toast({
          variant: state.status === "ready" ? "success" : "warning",
          title: "Codex usage",
          message: state.status === "ready" ? "Usage limits refreshed." : (state.message ?? "Refresh failed."),
        })
      },
    },
    {
      title: "Codex usage details",
      value: "codex-usage.details",
      description: "Show exact Codex limits and reset times.",
      category: "Codex",
      slash: { name: "codex-usage", aliases: ["usage-left"] },
      onSelect: () => showDetails(api, store),
    },
  ])
  if (stopCommands) api.lifecycle.onDispose(stopCommands)

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_context, props) {
        return <UsagePanel api={api} store={store} sessionID={props.session_id} refreshMs={refreshMs} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
