/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"

import { formatDetails, percent, relativeTime, updatedAgo } from "./format.ts"
import { isCodexSubscriptionModel, latestSessionModel, type SessionModel } from "./model.ts"
import { createUsageStore, type UsageState, type UsageStore } from "./store.ts"
import { lunaReserveWindow, overallWeeklyWindow, type CodexUsageWindow } from "./usage.ts"

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
  compact?: boolean
}) {
  if (props.compact) {
    return (
      <box flexDirection="row" gap={1}>
        <text fg={props.theme().text.subdued}>{props.label}</text>
        <text fg={usageColor(props.window.leftPercent, props.theme())}>
          <b>{percent(props.window.leftPercent)} left</b>
        </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" gap={0}>
      <text fg={props.theme().text.subdued}>{props.label}</text>
      <text fg={usageColor(props.window.leftPercent, props.theme())}>
        <b>{percent(props.window.leftPercent)} remaining</b>
      </text>
      <text fg={props.theme().text.subdued}>{relativeTime(props.window.resetsAt, props.now())}</text>
    </box>
  )
}

function UsagePanel(props: { store: UsageStore; sessionID: string; refreshMs: number }) {
  const context = usePlugin()
  const [state, setState] = createSignal<UsageState>(props.store.getState())
  const [settings, updateSettings] = context.storage.store("settings", { initial: { collapsed: false } })
  const [now, setNow] = createSignal(Date.now())
  const [activeModel, setActiveModel] = createSignal<SessionModel | undefined>(undefined)
  const theme = () => context.theme
  const stop = props.store.subscribe(setState)
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  const poll = setInterval(() => {
    if (isCodexSubscriptionModel(activeModel())) void props.store.refresh()
  }, props.refreshMs)

  const syncModel = async () => {
    try {
      await context.data.session.message.sync(props.sessionID)
      setActiveModel(latestSessionModel(context.data.session.message.list(props.sessionID)))
    } catch {
      // A session without synced messages keeps the last known model.
    }
  }
  void syncModel()

  const stopModelSwitch = context.data.on("session.model.selected", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    setActiveModel({ providerID: event.data.model.providerID, modelID: event.data.model.id })
  })
  const stopIdle = context.data.on("session.idle", (event) => {
    if (event.data.sessionID !== props.sessionID) return
    void syncModel()
    if (isCodexSubscriptionModel(activeModel())) void props.store.refresh(true)
  })

  createEffect(() => {
    if (isCodexSubscriptionModel(activeModel())) void props.store.refresh()
  })

  onCleanup(() => {
    stop()
    clearInterval(clock)
    clearInterval(poll)
    stopModelSwitch()
    stopIdle()
  })

  const collapsed = () => settings.collapsed
  const toggle = () => {
    void updateSettings((draft) => {
      draft.collapsed = !draft.collapsed
    })
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
          <text fg={theme().text.default}>
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
                  <text fg={theme().text.feedback.warning.default}>Last refresh failed; showing saved values.</text>
                </Show>
                <text fg={theme().text.subdued}>{updatedAgo(snapshot().fetchedAt, now())}</text>
              </box>
            )}
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
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "codex-usage.refresh",
          title: "Refresh Codex usage",
          description: "Refresh ChatGPT Codex subscription limits.",
          group: "Codex",
          palette: true,
          run: async (input) => {
            const state = await store.refresh(true)
            context.ui.toast.show({
              variant: state.status === "ready" ? "success" : "warning",
              title: "Codex usage",
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
          title: "Codex usage details",
          description: "Show exact Codex limits and reset times.",
          group: "Codex",
          palette: true,
          slash: { name: "codex-usage", aliases: ["usage-left"] },
          run: async () => {
            await context.ui.dialog.alert({
              title: "Codex usage",
              message: formatDetails(store.getState()),
            })
          },
        },
      ],
    }))

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <UsagePanel store={store} sessionID={sessionID} refreshMs={refreshMs} />,
    })

    return () => {
      stopSlot()
      store.dispose()
    }
  },
})
