/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import { createSignal, For, onCleanup, Show } from "solid-js"

import {
  providerDetailParts,
  providerPanelDetail,
  providerStatusLabel,
  providerUsageSummary,
} from "./format.ts"
import { createUsageStore, type UsageState, type UsageStore } from "./store.ts"
import type { ProviderState } from "./providers.ts"
import { ProviderUsage, type ProviderUsageSnapshot } from "./server.ts"
import { providerPalette } from "./palette.ts"
import { tokenizeUsage, type UsageHealth } from "./usage-health.ts"

type Theme = Context["theme"]

const DEFAULT_REFRESH_MS = 60_000
const MIN_REFRESH_MS = 30_000

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function usageColor(health: UsageHealth, palette: ReturnType<typeof providerPalette>) {
  if (health === "healthy") return palette.healthy
  if (health === "warning") return palette.measurement
  if (health === "critical") return palette.critical
  return palette.neutral
}

function ProviderMeasurementText(props: {
  value: string
  provider: ProviderState
  palette: () => ReturnType<typeof providerPalette>
}) {
  const tokens = () => tokenizeUsage(props.value, {
    remainingRatio: props.provider.remainingRatio,
    status: props.provider.status,
  })
  return (
    <For each={tokens()}>
      {(token) => token.emphasized
        ? <span style={{ fg: usageColor(token.health, props.palette()) }}><b>{token.text}</b></span>
        : <span>{token.text}</span>}
    </For>
  )
}

export function ProviderRow(props: {
  provider: ProviderState
  theme: () => Theme
}) {
  const details = () => providerDetailParts(props.provider)
  const palette = () => providerPalette(props.theme())
  const statusColor = () => props.provider.status === "available" ? palette().ready : palette().offline
  return (
    <box flexDirection="column" width="100%" gap={0}>
      <box flexDirection="row" width="100%" height={1} overflow="hidden">
        <box flexDirection="row" flexShrink={1} minWidth={0} overflow="hidden">
          <text wrapMode="none" truncate fg={palette().primary} attributes={TextAttributes.BOLD}>{props.provider.label}</text>
        </box>
        <box flexGrow={1} />
        <text flexShrink={0} wrapMode="none" fg={statusColor()} attributes={TextAttributes.BOLD}>{providerStatusLabel(props.provider.status)}</text>
      </box>
      <box paddingLeft={2} width="100%">
        <text wrapMode="word" fg={palette().subdued} attributes={TextAttributes.DIM}>
          <ProviderMeasurementText value={details().detail} provider={props.provider} palette={palette} />
          <Show when={details().usage}>
            {(usage) => <>
              <span> · </span>
              <ProviderMeasurementText value={usage()} provider={props.provider} palette={palette} />
            </>}
          </Show>
        </text>
      </box>
    </box>
  )
}

function providerUpdatedLabel(snapshot: ProviderUsageSnapshot | undefined, now: number) {
  if (!snapshot) return ""
  const seconds = Math.max(0, Math.floor((now - snapshot.generated) / 1000))
  if (seconds < 10) return "Updated just now"
  if (seconds < 60) return `Updated ${seconds}s ago`
  return `Updated ${Math.floor(seconds / 60)}m ago`
}

function providerDetails(state: UsageState) {
  const rows = (state.providers ?? []).map((provider) => {
    const usage = provider.usage ? ` · ${provider.usage}` : ""
    return `${provider.label}: ${providerStatusLabel(provider.status)} — ${providerPanelDetail(provider)}${usage}`
  })
  const diagnostics = state.providerSnapshot?.diagnostics ?? []
  if (diagnostics.length > 0) rows.push("", "Diagnostics", ...diagnostics)
  return rows.length > 0 ? rows.join("\n") : "Provider usage is unavailable."
}

export function UsagePanel(props: { store: UsageStore; refreshMs: number }) {
  const context = usePlugin()
  const [state, setState] = createSignal<UsageState>(props.store.getState())
  const [settings, updateSettings] = context.storage.store("provider-usage-settings-v2", { initial: { collapsed: true } })
  const [now, setNow] = createSignal(Date.now())
  const [themeVersion, setThemeVersion] = createSignal(0)
  const refreshTheme = () => setThemeVersion((value) => value + 1)
  if (typeof context.renderer.on === "function") {
    context.renderer.on("palette", refreshTheme)
    context.renderer.on("theme_mode", refreshTheme)
  }
  const theme = () => {
    themeVersion()
    return context.theme
  }
  const palette = () => providerPalette(theme())
  const stop = props.store.subscribe(setState)
  const clock = setInterval(() => setNow(Date.now()), 30_000)
  const poll = setInterval(() => void props.store.refresh(), props.refreshMs)

  void props.store.refresh()

  const refreshOnEvent = () => void props.store.refresh(true)
  const stopCredentialUpdated = context.data.on("credential.updated", refreshOnEvent)
  const stopCredentialSwitched = context.data.on("credential.switched", refreshOnEvent)
  const stopIntegrationUpdated = context.data.on("integration.updated", refreshOnEvent)
  const stopProviderUpdated = context.data.on("provider.updated", refreshOnEvent)

  onCleanup(() => {
    stop()
    clearInterval(clock)
    clearInterval(poll)
    stopCredentialUpdated()
    stopCredentialSwitched()
    stopIntegrationUpdated()
    stopProviderUpdated()
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })

  const collapsed = () => settings.collapsed
  const summary = () => providerUsageSummary(state().providers ?? [])
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
      <box flexDirection="column" gap={0} marginTop={1} flexShrink={0}>
        <box
          flexDirection="row"
          width="100%"
          focusable
          onMouseDown={toggle}
          onKeyDown={(event) => {
            if (event.name === "return" || event.name === "space") {
              event.preventDefault()
              toggle()
            }
          }}
        >
            <text wrapMode="none" fg={palette().primary} attributes={TextAttributes.BOLD}>
            {collapsed() ? "+ Provider Usage" : "- Provider Usage"}
          </text>
          <box flexGrow={1} />
          <Show when={collapsed() ? summary() : ""}>
            {(value) => <text wrapMode="none" fg={palette().subdued}>{value()}</text>}
          </Show>
          <text fg={palette().sectionCount} attributes={TextAttributes.BOLD}>{` ${(state().providers ?? []).length}`}</text>
        </box>

        <Show when={!collapsed()}>
          <For each={state().providers ?? []}>
            {(provider) => <ProviderRow provider={provider} theme={theme} />}
          </For>
          <Show when={state().providerSnapshot}>
            <box paddingLeft={2} height={1} overflow="hidden">
              <text wrapMode="none" truncate fg={palette().subdued} attributes={TextAttributes.DIM}>
                {providerUpdatedLabel(state().providerSnapshot, now())}
              </text>
            </box>
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
    const rpc = context.client.rpc(ProviderUsage)
    const store = createUsageStore({
      timeoutMs: positiveNumber(context.options.timeoutMs),
      fetchSnapshot: async (signal) => await rpc.snapshot({}, { location: context.location, signal }) as ProviderUsageSnapshot,
    })
    void store.refresh(true)

    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "codex-usage.refresh",
              title: "Refresh provider usage",
              description: "Refresh Codex quota, DeepSeek balance, Anthropic rate limits, and provider status.",
              group: "Providers",
              palette: true,
              run: async (input) => {
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
              description: "Show verified Codex limits, DeepSeek balance, Anthropic rate limits, and provider statuses.",
              group: "Providers",
              palette: true,
              slash: { name: "provider-usage", aliases: ["codex-usage", "usage-left"] },
              run: async () => {
                await context.ui.dialog.alert({
                  title: "Provider usage",
                  message: providerDetails(store.getState()),
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
      render: () => <UsagePanel store={store} refreshMs={refreshMs} />,
    })

    return () => {
      stopKeymap()
      stopSlot()
      store.dispose()
    }
  },
})
