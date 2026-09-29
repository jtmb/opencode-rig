/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { HermesHooks } from "./hermes-hooks-rpc.ts"
import { hermesPipelineStages, type HermesPipelineStage, type HermesPipelineStageStatus } from "./hermes-hooks-graph.ts"
import {
  emptyHermesHookSnapshot,
  HERMES_HOOK_EVENT_LIMIT,
  parseHermesHookSnapshot,
  type HermesHookEvent,
  type HermesHookSnapshot,
} from "./hermes-hooks-snapshot.ts"

export const HERMES_HOOKS_PANEL_NAME = "opencode-rig.rig-tools.hermes-hooks"

function stageColor(theme: Context["theme"], status: HermesPipelineStageStatus) {
  if (status === "active") return theme.hue.accent[200]
  if (status === "complete") return theme.text.feedback.success.default
  if (status === "error") return theme.text.feedback.error.default
  return theme.text.subdued
}

function stageGlyph(status: HermesPipelineStageStatus): string {
  if (status === "active") return "●"
  if (status === "complete") return "✓"
  if (status === "error") return "!"
  return "○"
}

function eventDetails(event: HermesHookEvent): string {
  const details = [event.tool, event.model, event.provider, event.auxTask].filter((value): value is string => Boolean(value))
  if (event.durationMs !== undefined) details.push(`${event.durationMs} ms`)
  return details.join(" · ")
}

function eventTime(value: string): string {
  const time = new Date(value)
  return Number.isFinite(time.getTime())
    ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : "--:--:--"
}

function PipelineNode(props: { stage: HermesPipelineStage; theme: () => Context["theme"] }) {
  const color = () => stageColor(props.theme(), props.stage.status)
  return (
    <box flexDirection="column" flexGrow={1} minWidth={8} padding={1} borderStyle="single" borderColor={color()}>
      <text wrapMode="none" truncate fg={color()}><b>{stageGlyph(props.stage.status)} {props.stage.label}</b></text>
      <text wrapMode="none" truncate fg={props.theme().text.subdued}>{props.stage.status} · {props.stage.count} hooks</text>
      <Show when={props.stage.detail}>
        <text wrapMode="none" truncate fg={props.theme().text.subdued}>{props.stage.detail}</text>
      </Show>
    </box>
  )
}

function PipelineGraph(props: { stages: HermesPipelineStage[]; width: number; theme: () => Context["theme"] }) {
  return (
    <Show when={props.width >= 104} fallback={
      <box flexDirection="column" flexShrink={0}>
        <For each={props.stages}>
          {(stage, index) => (
            <box flexDirection="column">
              <box flexDirection="row" gap={1}>
                <text fg={stageColor(props.theme(), stage.status)}>{stageGlyph(stage.status)}</text>
                <text fg={stageColor(props.theme(), stage.status)}><b>{stage.label}</b></text>
                <text fg={props.theme().text.subdued}>{stage.status} · {stage.count} hooks</text>
                <Show when={stage.detail}><text wrapMode="none" truncate fg={props.theme().text.subdued}>· {stage.detail}</text></Show>
              </box>
              <Show when={index() < props.stages.length - 1}><text fg={props.theme().text.subdued}>│</text></Show>
            </box>
          )}
        </For>
      </box>
    }>
      <box flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        <For each={props.stages}>
          {(stage, index) => (
            <>
              <PipelineNode stage={stage} theme={props.theme} />
              <Show when={index() < props.stages.length - 1}>
                <text fg={props.theme().text.subdued}>──▶</text>
              </Show>
            </>
          )}
        </For>
      </box>
    </Show>
  )
}

function HookEventRow(props: { event: HermesHookEvent; theme: () => Context["theme"] }) {
  const details = () => eventDetails(props.event)
  const outcome = props.event.status === "error" || props.event.status === "blocked" || props.event.status === "cancelled"
    ? props.theme().text.feedback.error.default
    : props.event.status === "started"
      ? props.theme().hue.accent[200]
      : props.theme().text.subdued
  return (
    <box flexDirection="row" width="100%" height={1} gap={1} overflow="hidden">
      <text flexShrink={0} wrapMode="none" fg={props.theme().text.subdued}>{eventTime(props.event.at)}</text>
      <text flexShrink={0} wrapMode="none" fg={outcome}>{props.event.hook}</text>
      <text flexShrink={0} wrapMode="none" fg={props.theme().text.subdued}>{props.event.status}</text>
      <Show when={details()}>
        <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={props.theme().text.default}>{details()}</text>
      </Show>
    </box>
  )
}

export function HermesHooksPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const client = context.client.rpc(HermesHooks)
  const rpcOptions = { location: context.location }
  const [snapshot, setSnapshot] = createSignal(emptyHermesHookSnapshot())
  const [loading, setLoading] = createSignal(true)
  const [requestError, setRequestError] = createSignal(false)
  const [themeVersion, setThemeVersion] = createSignal(0)
  const refreshTheme = () => setThemeVersion((value) => value + 1)
  let disposed = false
  let revision = 0

  if (typeof context.renderer.on === "function") {
    context.renderer.on("palette", refreshTheme)
    context.renderer.on("theme_mode", refreshTheme)
  }
  const theme = () => {
    themeVersion()
    return context.theme
  }

  const applySnapshot = (next: HermesHookSnapshot) => {
    revision++
    setSnapshot(next)
    setRequestError(false)
    setLoading(false)
  }
  const unsubscribe = client.events.on("updated", (event) => applySnapshot(parseHermesHookSnapshot(event.data)))
  const refresh = async () => {
    const observedRevision = revision
    try {
      const result = await client.snapshot({ limit: HERMES_HOOK_EVENT_LIMIT }, rpcOptions)
      if (!disposed && revision === observedRevision) applySnapshot(parseHermesHookSnapshot(result))
    } catch {
      if (!disposed) {
        setRequestError(true)
        setLoading(false)
      }
    }
  }

  onMount(() => void refresh())
  onCleanup(() => {
    disposed = true
    unsubscribe()
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })

  const stages = createMemo(() => hermesPipelineStages(snapshot()))
  const events = createMemo(() => snapshot().events.slice().reverse().slice(0, 48))
  const snapshotLabel = () => {
    if (loading()) return "Loading snapshot…"
    if (requestError()) return "RPC unavailable"
    if (snapshot().state === "ready") return `${snapshot().events.length} retained hooks · updated ${eventTime(snapshot().updatedAt)}`
    if (snapshot().state === "invalid") return "Snapshot rejected · invalid or over limit"
    if (snapshot().state === "unavailable") return "Snapshot unavailable · check the shared telemetry path"
    return "Waiting for Hermes observer events"
  }

  useKeyboard((key) => {
    if (!props.panel.focused) return
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      props.panel.close()
    } else if (key.name === "r") {
      key.preventDefault()
      key.stopPropagation()
      setLoading(true)
      void refresh()
    }
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
      borderColor={theme().hue.accent[200]}
    >
      <box flexDirection="row" gap={1} flexShrink={0}>
        <text fg={theme().hue.accent[200]}><b>Hermes /hooks</b></text>
        <box flexGrow={1} />
        <text wrapMode="none" truncate fg={theme().text.subdued}>{snapshotLabel()}</text>
      </box>
      <text flexShrink={0} fg={theme().text.subdued}>Observer-only pipeline · metadata snapshot · no prompts or tool contents</text>
      <PipelineGraph stages={stages()} width={props.panel.width} theme={theme} />
      <box flexDirection="row" flexShrink={0} marginTop={1} gap={1}>
        <text fg={theme().text.default}><b>Recent hook events</b></text>
        <text fg={theme().text.subdued}>· {events().length} shown</text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
        <Show
          when={!loading() && events().length > 0}
          fallback={
            <text fg={theme().text.subdued}>
              {loading()
                ? "Hydrating persisted Hermes hook telemetry…"
                : requestError()
                  ? "The server snapshot RPC is unavailable. Confirm the rig-tools server role is loaded."
                  : snapshot().state === "invalid"
                    ? "The persisted snapshot failed validation or exceeded its size limit."
                    : snapshot().state === "unavailable"
                      ? "The snapshot could not be read. Check file permissions and the configured profile path."
                      : "No Hermes observer events yet. Enable the opt-in Hermes plugin to populate this panel."}
            </text>
          }
        >
          <For each={events()}>{(event) => <HookEventRow event={event} theme={theme} />}</For>
        </Show>
      </scrollbox>
      <text flexShrink={0} fg={theme().text.subdued}>Esc closes · r refreshes the snapshot · updates stream from the server</text>
    </box>
  )
}
