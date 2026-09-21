/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type { BoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { toolCatalogQuery } from "./tool-catalog.ts"
import { RigTools, type RigToolsOutput } from "./rpc.ts"
import { activeSubagentRows, formatSubagentRow, MAX_SUBAGENT_ROWS, nextSubagentIndex, resolveSubagentRows, subagentActivityLabel, subagentAnimationsEnabled, subagentStatus, type SubagentStatus } from "./subagents.ts"

export const SUBAGENTS_PANEL_NAME = "opencode-rig.rig-tools.subagents"

function currentSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

async function showCommandOutput(
  context: Context,
  title: string,
  run: () => Promise<string>,
): Promise<void> {
  let message: string
  try {
    message = await run()
  } catch {
    await context.ui.dialog.alert({ title, message: "The command failed. Restart OpenCode if the server plugin is not loaded." }).catch(() => undefined)
    return
  }
  await context.ui.dialog.alert({ title, message }).catch(() => undefined)
}

function createSubagentFeed(context: Context, sessionID: () => string) {
  const [rows, setRows] = createSignal<ReturnType<typeof resolveSubagentRows>>([])
  const [message, setMessage] = createSignal("Loading child sessions…")
  const requests = new AbortController()
  let disposed = false
  let refreshing = false
  let queued = false

  const refresh = async () => {
    if (disposed) return
    if (refreshing) {
      queued = true
      return
    }
    refreshing = true
    const target = sessionID()
    try {
      const requestOptions = { signal: requests.signal }
      const parent = await context.client.session.get({ sessionID: target }, requestOptions)
      const [children, agents, active] = await Promise.all([
        context.client.session.list({
          parentID: parent.id,
          project: parent.projectID,
          directory: parent.location.directory,
          order: "desc",
          limit: MAX_SUBAGENT_ROWS,
        }, requestOptions),
        context.client.agent.list(undefined, requestOptions),
        context.client.session.active(requestOptions),
      ])
      const statuses = new Map<string, SubagentStatus>()
      for (const child of children.data.slice(0, MAX_SUBAGENT_ROWS)) {
        statuses.set(child.id, subagentStatus(child, active[child.id]?.type === "running"))
      }
      const next = resolveSubagentRows(children.data, agents.data, statuses, parent)
      if (disposed || target !== sessionID()) return
      setRows(next)
      setMessage(next.length ? "" : "No direct child sessions.")
    } catch {
      if (!disposed) {
        setRows([])
        setMessage("Unable to read child sessions.")
      }
    } finally {
      refreshing = false
      if (queued && !disposed) {
        queued = false
        void refresh()
      }
    }
  }

  createEffect(() => {
    void sessionID()
    setRows([])
    setMessage("Loading child sessions…")
    void refresh()
  })

  const stopCreated = context.data.on("session.created", (event) => {
    if (event.data.parentID === sessionID()) void refresh()
  })
  const stopStatus = context.data.on("session.status", () => {
    void refresh()
  })
  const stopDeleted = context.data.on("session.deleted", (event) => {
    if (rows().some((row) => row.sessionID === event.data.sessionID)) void refresh()
  })
  const timer = setInterval(() => void refresh(), 1_000)
  onCleanup(() => {
    disposed = true
    requests.abort()
    clearInterval(timer)
    stopCreated()
    stopStatus()
    stopDeleted()
  })

  return { rows, message }
}

function SubagentsPanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const feed = createSubagentFeed(context, () => props.panel.sessionID)

  useKeyboard((key) => {
    if (!props.panel.focused || key.name !== "escape") return
    key.preventDefault()
    key.stopPropagation()
    props.panel.close()
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
      <text fg={context.theme.hue.accent[200]}><b>Subagents</b></text>
      <text fg={context.theme.text.subdued}>Read-only child-session view · model and variant are resolved from the session or agent.</text>
      <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
        <Show when={feed.rows().length > 0} fallback={<text fg={context.theme.text.subdued}>{feed.message()}</text>}>
          <For each={feed.rows()}>
            {(row) => (
              <text wrapMode="none" truncate fg={row.status === "running" ? context.theme.text.default : context.theme.text.subdued}>
                {formatSubagentRow(row, Math.max(1, props.panel.width - 4))}
              </text>
            )}
          </For>
        </Show>
      </scrollbox>
      <text fg={context.theme.text.subdued}>Esc closes · refreshes on child-session events</text>
    </box>
  )
}

const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

function ActiveSubagentsSidebar(props: { sessionID: string }) {
  const context = usePlugin()
  const feed = createSubagentFeed(context, () => props.sessionID)
  const active = createMemo(() => activeSubagentRows(feed.rows()))
  const [selected, setSelected] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const rowRefs = new Map<string, BoxRenderable>()
  const animate = () => subagentAnimationsEnabled(context.options.subagentAnimations, context.renderer.width)

  createEffect(() => {
    const rows = active()
    setSelected((index) => Math.min(index, Math.max(0, rows.length - 1)))
    const current = new Set(rows.map((row) => row.sessionID))
    for (const sessionID of rowRefs.keys()) {
      if (!current.has(sessionID)) rowRefs.delete(sessionID)
    }
  })

  const timer = setInterval(() => {
    if (active().length && animate()) setFrame((value) => (value + 1) % ACTIVITY_FRAMES.length)
  }, 120)
  onCleanup(() => clearInterval(timer))

  const focusRow = (current: number, delta: number) => {
    const rows = active()
    if (!rows.length) return
    const next = nextSubagentIndex(current, rows.length, delta)
    setSelected(next)
    queueMicrotask(() => rowRefs.get(rows[next]!.sessionID)?.focus())
  }
  const openChild = (sessionID: string) => context.ui.router.navigate({ type: "session", sessionID })

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row">
        <text fg={context.theme.text.default}><b>Active subagents</b></text>
        <text fg={context.theme.hue.accent[200]}> {active().length}</text>
      </box>
      <Show when={active().length > 0} fallback={<text fg={context.theme.text.subdued}>{feed.message() || "No active subagents."}</text>}>
        <For each={active()}>
          {(row, index) => (
            <box
              ref={(value) => rowRefs.set(row.sessionID, value)}
              flexDirection="column"
              focusable
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={selected() === index() ? context.theme.background.surface.offset : undefined}
              onMouseOver={() => setSelected(index())}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget?.focus()
                setSelected(index())
                openChild(row.sessionID)
              }}
              onKeyDown={(event) => {
                setSelected(index())
                if (event.name === "return" || event.name === "space") {
                  event.preventDefault()
                  event.stopPropagation()
                  openChild(row.sessionID)
                  return
                }
                if (event.name === "up" || event.name === "k" || event.name === "down" || event.name === "j") {
                  event.preventDefault()
                  event.stopPropagation()
                  focusRow(index(), event.name === "up" || event.name === "k" ? -1 : 1)
                }
              }}
            >
              <text wrapMode="none" truncate fg={context.theme.hue.accent[200]}>{subagentActivityLabel(animate() ? ACTIVITY_FRAMES[frame()] : undefined)} · {row.agent}</text>
              <text wrapMode="none" truncate fg={context.theme.text.default}>Model · {row.model}</text>
              <text wrapMode="none" truncate fg={context.theme.text.subdued}>Task · {row.title}</text>
            </box>
          )}
        </For>
        <text fg={context.theme.text.subdued}>Click/Enter opens · ↑/↓ moves</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-rig.rig-tools",
  setup(context) {
    const rpc = context.client.rpc(RigTools)
    const rpcOptions = { location: context.location }
    const stopPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => panel.name === SUBAGENTS_PANEL_NAME ? <SubagentsPanel panel={panel} /> : null,
    })
    const stopSidebar = context.ui.slot({
      after: "sidebar.content",
      render: ({ sessionID }) => <ActiveSubagentsSidebar sessionID={sessionID} />,
    })
    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode-rig.tools",
              title: "Open Rig tools",
              description: "Show bounded Open Rig tool usage without a model turn.",
              group: "Open Rig",
              palette: true,
              slash: { name: "tools", arguments: true },
              run: (input) => void showCommandOutput(context, "Open Rig tools", async () => (await rpc.catalog({ query: toolCatalogQuery(input ?? "") }, rpcOptions) as RigToolsOutput).text),
            },
            {
              id: "opencode-rig.session-context",
              title: "Session context",
              description: "Show a bounded read-only snapshot of another project session.",
              group: "Open Rig",
              palette: true,
              slash: { name: "session-context", arguments: true },
              run: (input) => {
                const sessionID = currentSessionID(context)
                if (!sessionID) {
                  void context.ui.dialog.alert({ title: "Session context", message: "This command requires an active session." }).catch(() => undefined)
                  return
                }
                void showCommandOutput(context, "Session context", async () => (await rpc.sessionContext({ sessionID, command: input ?? "" }, rpcOptions) as RigToolsOutput).text)
              },
            },
            {
              id: "opencode-rig.subagents",
              title: "Subagents",
              description: "Open the bounded read-only child-session view with resolved models and variants.",
              group: "Open Rig",
              palette: true,
              slash: { name: "subagents" },
              run: () => {
                const opened = context.ui.panel.open(SUBAGENTS_PANEL_NAME, { presentation: "fullscreen" })
                if (!opened) void context.ui.dialog.alert({ title: "Subagents", message: "This view requires an active session." }).catch(() => undefined)
              },
            },
          ],
        }))
        return null as never
      },
    })
    return () => {
      stopPanel()
      stopSidebar()
      stopKeymap()
    }
  },
})
