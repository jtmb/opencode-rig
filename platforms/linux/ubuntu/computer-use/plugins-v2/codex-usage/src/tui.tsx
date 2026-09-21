/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, Show } from "solid-js"

import {
  formatDetails,
  providerCompactParts,
  providerUsageSummary,
  usageUpdatedLabel,
} from "./format.ts"
import { createUsageStore, type UsageState, type UsageStore } from "./store.ts"
import type { ProviderState } from "./providers.ts"

type Theme = Context["theme"]

const DEFAULT_REFRESH_MS = 60_000
const MIN_REFRESH_MS = 30_000

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function ProviderRow(props: {
  provider: ProviderState
  snapshot: UsageState["snapshot"]
  theme: () => Theme
}) {
  const color = () => props.provider.status === "available"
    ? props.theme().text.feedback.success.default
    : props.provider.status === "quota-exhausted"
      ? props.theme().text.feedback.error.default
      : props.provider.status === "cooling" || props.provider.status === "usage-unavailable" || props.provider.status === "stale"
      ? props.theme().text.feedback.warning.default
      : props.theme().text.subdued
  const parts = () => providerCompactParts(props.provider, props.snapshot)
  return (
    <box flexDirection="row" width="100%">
      <text fg={props.theme().text.default}><b>{parts().label}</b> </text>
      <text fg={color()}><b>{parts().status}</b></text>
      <Show when={parts().measurements.length > 0}>
        <text fg={props.theme().text.subdued}> · {parts().measurements.join(" · ")}</text>
      </Show>
    </box>
  )
}

function UsagePanel(props: { store: UsageStore; sessionID: string; refreshMs: number; syncProviders: () => Promise<void> }) {
  const context = usePlugin()
  const [state, setState] = createSignal<UsageState>(props.store.getState())
  const [settings, updateSettings] = context.storage.store("provider-usage-settings-v2", { initial: { collapsed: true } })
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
            <Show when={collapsed()}>
              <span style={{ fg: theme().text.subdued }}> · {providerUsageSummary(state().providers ?? [])}</span>
            </Show>
          </text>
        </box>

        <Show when={!collapsed()}>
          <For each={state().providers ?? []}>
            {(provider) => <ProviderRow provider={provider} snapshot={state().snapshot} theme={theme} />}
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
      before: "sidebar.footer",
      render: ({ sessionID }) => <UsagePanel store={store} sessionID={sessionID} refreshMs={refreshMs} syncProviders={syncProviders} />,
    })

    return () => {
      stopKeymap()
      stopSlot()
      store.dispose()
    }
  },
})
