/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { TextAttributes, type BoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { toolCatalogQuery } from "./tool-catalog.ts"
import { RigTools, type RigToolsOutput } from "./rpc.ts"
import { HermesHooksPanel, HERMES_HOOKS_PANEL_NAME } from "./hermes-hooks-panel.tsx"
import { ActiveSubagentRow, ActiveSubagentsHeading } from "./active-subagent-row.ts"
import { SubagentsHistory } from "./subagent-history-view.ts"
import { formatSubagentHistoryPage, querySubagentHistory, querySubagentHistoryEvents, recordSubagentObservations, subagentHistoryRoot, type SubagentHistoryEventRow } from "./subagent-history.ts"
import { sidebarPalette } from "./palette.ts"
import { activeSubagentRows, formatSubagentRow, MAX_SUBAGENT_ROWS, nextSubagentIndex, resolveSubagentRows, subagentAnimationsEnabled, subagentStatus, type SubagentStatus } from "./subagents.ts"

export const SUBAGENTS_PANEL_NAME = "opencode-rig.rig-tools.subagents"

const HISTORY_PAGE_SIZE = 8

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
      // Durable audit history: only changed observations are appended.
      void recordSubagentObservations(subagentHistoryRoot(), next, new Date().toISOString()).catch(() => undefined)
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
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [historyPage, setHistoryPage] = createSignal(0)
  const [historyRows, setHistoryRows] = createSignal<readonly SubagentHistoryEventRow[]>([])
  const [historyHasMore, setHistoryHasMore] = createSignal(false)
  const [historyTruncated, setHistoryTruncated] = createSignal(false)
  const [historyLoaded, setHistoryLoaded] = createSignal(false)
  let historyCursors: Array<number | undefined> = [undefined]

  const loadHistory = async (page: number): Promise<void> => {
    const beforeSeq = historyCursors[page]
    const result = await querySubagentHistoryEvents(subagentHistoryRoot(), {
      limit: HISTORY_PAGE_SIZE,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    }).catch(() => undefined)
    if (!result) return
    setHistoryRows(result.rows)
    setHistoryHasMore(result.hasMore)
    setHistoryTruncated(result.truncated)
    setHistoryLoaded(true)
    if (result.nextBeforeSeq !== undefined) historyCursors[page + 1] = result.nextBeforeSeq
    else historyCursors.length = page + 1
  }
  const toggleHistory = () => {
    const next = !historyOpen()
    setHistoryOpen(next)
    if (next) {
      historyCursors = [undefined]
      setHistoryPage(0)
      void loadHistory(0)
    }
  }
  const pageHistory = (delta: number) => {
    const next = Math.max(0, historyPage() + delta)
    if (next > 0 && historyCursors[next] === undefined) return
    setHistoryPage(next)
    void loadHistory(next)
  }

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
  onCleanup(() => {
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })

  useKeyboard((key) => {
    if (!props.panel.focused) return
    if (key.name === "escape") {
      key.preventDefault()
      key.stopPropagation()
      props.panel.close()
      return
    }
    if (key.name === "h") {
      key.preventDefault()
      key.stopPropagation()
      toggleHistory()
      return
    }
    if (!historyOpen()) return
    if (key.name === "n" || key.name === "]") {
      key.preventDefault()
      key.stopPropagation()
      pageHistory(1)
    } else if (key.name === "p" || key.name === "[") {
      key.preventDefault()
      key.stopPropagation()
      pageHistory(-1)
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
      <text fg={theme().hue.accent[200]}><b>Subagents</b></text>
      <text fg={theme().text.subdued}>Read-only child-session view · model and variant are resolved from the session or agent.</text>
      <scrollbox flexGrow={1} minHeight={0} overflow="hidden">
        <Show when={feed.rows().length > 0} fallback={<text fg={theme().text.subdued}>{feed.message()}</text>}>
          <For each={feed.rows()}>
            {(row) => (
              <text wrapMode="none" truncate fg={row.status === "running" ? theme().text.default : theme().text.subdued}>
                {formatSubagentRow(row, Math.max(1, props.panel.width - 4))}
              </text>
            )}
          </For>
        </Show>
        <Show when={historyOpen()}>
          <SubagentsHistory
            rows={historyRows()}
            page={historyPage()}
            hasMore={historyHasMore()}
            truncated={historyTruncated()}
            loaded={historyLoaded()}
            textColor={theme().text.default}
            subduedColor={theme().text.subdued}
            accentColor={theme().hue.accent[200]}
          />
        </Show>
      </scrollbox>
      <text fg={theme().text.subdued}>Esc closes · h history · n/p pages · refreshes on child-session events</text>
    </box>
  )
}

const ACTIVITY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export function ActiveSubagentsSidebar(props: { sessionID: string }) {
  const context = usePlugin()
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
  const palette = () => sidebarPalette(theme())
  const feed = createSubagentFeed(context, () => props.sessionID)
  const active = createMemo(() => activeSubagentRows(feed.rows()))
  const [collapsed, setCollapsed] = createSignal(false)
  const [selected, setSelected] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const rowRefs = new Map<string, BoxRenderable>()
  let headingRef: BoxRenderable | undefined
  const [focusedRow, setFocusedRow] = createSignal<string | undefined>()
  const animate = () => subagentAnimationsEnabled(context.options.subagentAnimations, context.renderer.width)

  createEffect(() => {
    const rows = active()
    setSelected((index) => Math.min(index, Math.max(0, rows.length - 1)))
    const current = new Set(rows.map((row) => row.sessionID))
    for (const sessionID of rowRefs.keys()) {
      if (!current.has(sessionID)) rowRefs.delete(sessionID)
    }
    const focused = focusedRow()
    if (focused && !current.has(focused)) {
      setFocusedRow(undefined)
      queueMicrotask(() => headingRef?.focus())
    }
  })

  const timer = setInterval(() => {
    if (active().length && animate()) setFrame((value) => (value + 1) % ACTIVITY_FRAMES.length)
  }, 120)
  onCleanup(() => {
    clearInterval(timer)
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })

  const focusRow = (current: number, delta: number) => {
    const rows = active()
    if (!rows.length) return
    const next = nextSubagentIndex(current, rows.length, delta)
    setSelected(next)
    setFocusedRow(rows[next]!.sessionID)
    queueMicrotask(() => rowRefs.get(rows[next]!.sessionID)?.focus())
  }
  const openChild = (sessionID: string) => context.ui.router.navigate({ type: "session", sessionID })
  const toggleCollapsed = () => {
    const next = !collapsed()
    setCollapsed(next)
    if (next) queueMicrotask(() => headingRef?.focus())
  }

  return (
    <box flexDirection="column" gap={0} marginTop={1} flexShrink={0}>
      <ActiveSubagentsHeading
        count={active().length}
        collapsed={collapsed()}
        textColor={theme().text.default}
        accentColor={palette().sectionCount}
        onRef={(value) => { headingRef = value }}
        onFocus={() => setFocusedRow(undefined)}
        onToggle={toggleCollapsed}
      />
      <Show when={!collapsed()}>
        <Show when={active().length > 0} fallback={
          <text fg={theme().text.subdued} attributes={TextAttributes.DIM}>{feed.message() || "No active subagents."}</text>
        }>
          <For each={active()}>
            {(row, index) => (
              <ActiveSubagentRow
                row={row}
                theme={theme()}
                focused={selected() === index()}
                activityFrame={animate() ? ACTIVITY_FRAMES[frame()] : undefined}
                onRef={(value) => rowRefs.set(row.sessionID, value)}
                onMouseOver={() => setSelected(index())}
                onFocus={() => {
                  setSelected(index())
                  setFocusedRow(row.sessionID)
                }}
                onOpen={() => openChild(row.sessionID)}
                onMove={(delta) => focusRow(index(), delta)}
              />
            )}
          </For>
          <text fg={theme().text.subdued} attributes={TextAttributes.DIM}>Click/Enter opens · ↑/↓ moves</text>
        </Show>
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
    const stopHermesPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => panel.name === HERMES_HOOKS_PANEL_NAME ? <HermesHooksPanel panel={panel} /> : null,
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
            {
              id: "opencode-rig.subagents-history",
              title: "Subagent history",
              description: "Search the durable read-only subagent history without exposing session IDs or prompts.",
              group: "Open Rig",
              palette: true,
              slash: { name: "subagents-history", arguments: true },
              run: (input) => void showCommandOutput(context, "Subagent history", async () =>
                formatSubagentHistoryPage(await querySubagentHistory(subagentHistoryRoot(), { text: input ?? "", limit: 25 })),
              ),
            },
            {
              id: "opencode-rig.hermes-hooks",
              title: "Hermes hooks pipeline",
              description: "Open the live, bounded Hermes observer-hook pipeline snapshot.",
              group: "Open Rig",
              palette: true,
              slash: { name: "hooks" },
              run: () => {
                if (!currentSessionID(context)) {
                  void context.ui.dialog.alert({ title: "Hermes hooks", message: "This panel requires an active session." }).catch(() => undefined)
                  return
                }
                const opened = context.ui.panel.open(HERMES_HOOKS_PANEL_NAME, { presentation: "fullscreen" })
                if (!opened) void context.ui.dialog.alert({ title: "Hermes hooks", message: "The fullscreen pipeline panel could not be opened." }).catch(() => undefined)
              },
            },
          ],
        }))
        return null as never
      },
    })
    return () => {
      stopPanel()
      stopHermesPanel()
      stopSidebar()
      stopKeymap()
    }
  },
})
