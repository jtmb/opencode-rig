/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { TextAttributes, type MouseEvent } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { moreFilesPageSize, pagedChanges, statusLetter, visibleChanges, type SourceControlChange } from "./changes.ts"
import type { GithubCheckState } from "./github.ts"
import { createGithubMcpClient } from "./mcp.ts"
import {
  DEFAULT_START_COLLAPSED,
  KEYS,
  pluginOptions,
  readRuntimeOptions,
  type OptionsKV,
  type RuntimeOptions,
} from "./options.ts"
import { createSourceControlStore, type SourceControlState, type SourceControlStore } from "./store.ts"
import { sourceControlPalette, type SourceControlPalette } from "./palette.ts"

const REFRESH_DEBOUNCE_MS = 750

function statusColor(status: SourceControlChange["status"], palette: ReturnType<typeof sourceControlPalette>) {
  if (status === "added") return palette.action
  if (status === "deleted") return palette.removal
  return palette.subdued
}

type SidebarActionEvent = MouseEvent & {
  __rigHandled?: boolean
}

function SidebarAction(props: {
  id?: string
  label: string
  palette: () => SourceControlPalette
  onActivate: () => void
}) {
  const [hovered, setHovered] = createSignal(false)
  const activate = (event: SidebarActionEvent) => {
    if (event.__rigHandled) return
    event.__rigHandled = true
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault?.()
    event.stopPropagation?.()
    event.currentTarget?.focus?.()
    props.onActivate()
  }
  return (
    <box
      id={props.id}
      focusable
      flexShrink={0}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={activate}
      onKeyDown={(event) => {
        if (event.name !== "return" && event.name !== "space") return
        event.preventDefault()
        event.stopPropagation()
        props.onActivate()
      }}
    >
      <text
        wrapMode="none"
        truncate
        fg={props.palette().action}
        attributes={hovered() ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.UNDERLINE}
        onMouseDown={activate}
      >
        <u>{props.label}</u>
      </text>
    </box>
  )
}

function ChangeRow(props: {
  change: SourceControlChange
  palette: () => SourceControlPalette
  hovered: () => string | undefined
  onHover: (file: string) => void
  onLeave: (file: string) => void
  onActivate: (event: SidebarActionEvent) => void
  onOpen: () => void
}) {
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      overflow="hidden"
      paddingLeft={2}
      gap={1}
      focusable
      onMouseOver={() => props.onHover(props.change.file)}
      onMouseOut={() => props.onLeave(props.change.file)}
      onMouseDown={props.onActivate}
      onKeyDown={(event) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault()
          props.onOpen()
        }
      }}
    >
      <text
        flexShrink={0}
        wrapMode="none"
        fg={statusColor(props.change.status, props.palette())}
        attributes={TextAttributes.UNDERLINE}
        onMouseDown={props.onActivate}
      >
        {statusLetter(props.change.status)}
      </text>
      <box flexGrow={1} minWidth={0} flexShrink={1} overflow="hidden">
        <text
          wrapMode="none"
          truncate
          fg={props.hovered() === props.change.file ? props.palette().sectionCount : props.palette().primary}
          onMouseDown={props.onActivate}
        >
          <u>{props.change.file}</u>
        </text>
      </box>
      <text flexShrink={0} wrapMode="none" fg={props.palette().action} onMouseDown={props.onActivate}>
        +{props.change.additions}
      </text>
      <text flexShrink={0} wrapMode="none" fg={props.palette().removal} onMouseDown={props.onActivate}>
        -{props.change.deletions}
      </text>
    </box>
  )
}

function checksLabel(state: GithubCheckState): string {
  if (state === "passing") return "passing"
  if (state === "failing") return "failing"
  if (state === "pending") return "pending"
  return "unknown"
}

function details(state: SourceControlState): string {
  const lines = [
    `Branch: ${state.branch ?? "(detached or unavailable)"}`,
    state.remote ? `GitHub: ${state.remote.owner}/${state.remote.repo}` : "GitHub: unavailable",
    `Local changes: ${state.changes.length}`,
  ]
  if (state.pullRequest) {
    lines.push(`Pull request: #${state.pullRequest.number} - ${state.pullRequest.state}`)
    lines.push(`Checks: ${checksLabel(state.pullRequest.checks)}`)
    if (state.pullRequest.title) lines.push(`Title: ${state.pullRequest.title}`)
  } else {
    lines.push("Pull request: none found")
  }
  if (state.error) lines.push(`Local refresh: ${state.error}`)
  if (state.githubError) lines.push(`GitHub refresh: ${state.githubError}`)
  return lines.join("\n")
}

function openDiff(context: Context) {
  try {
    context.keymap.dispatch("diff.open")
    context.ui.dialog.clear()
  } catch {
    context.ui.toast.show({ variant: "warning", title: "Source Control", message: "Unable to open the diff viewer." })
  }
}

export function SourceControlPanel(props: {
  store: SourceControlStore
  runtime: () => RuntimeOptions
  setStartCollapsed: (value: boolean) => void
  whenEmpty: "hide" | "show"
}) {
  const context = usePlugin()
  const [state, setState] = createSignal<SourceControlState>(props.store.getState())
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const [moreExpanded, setMoreExpanded] = createSignal(false)
  const [morePage, setMorePage] = createSignal(0)
  const [viewportHeight, setViewportHeight] = createSignal(context.renderer.height)
  const stop = props.store.subscribe(setState)
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
  const palette = () => sourceControlPalette(theme())

  const resize = () => setViewportHeight(context.renderer.height)
  if (typeof context.renderer.on === "function") context.renderer.on("resize", resize)

  onCleanup(() => {
    stop()
    if (typeof context.renderer.off === "function") context.renderer.off("resize", resize)
    if (typeof context.renderer.off === "function") {
      context.renderer.off("palette", refreshTheme)
      context.renderer.off("theme_mode", refreshTheme)
    }
  })

  const collapsed = () => props.runtime().startCollapsed
  const visibleLimit = () => props.runtime().maxFiles
  const omitted = () => state().changes.slice(Math.max(1, Math.trunc(visibleLimit())))
  const paginationOverhead = () => visibleChanges(state().changes, visibleLimit()).length +
    (state().pullRequest ? 1 : 0) +
    (state().error || state().githubError ? 1 : 0)
  const pageSize = () => moreFilesPageSize(viewportHeight(), paginationOverhead())
  const page = () => pagedChanges(omitted(), morePage(), pageSize())
  const toggle = () => {
    const next = !collapsed()
    props.setStartCollapsed(next)
    if (next) {
      setMoreExpanded(false)
      setMorePage(0)
    }
  }
  const closeMore = () => {
    setMoreExpanded(false)
    setMorePage(0)
  }

  let previousChangeSignature: string | undefined
  let previousPageSize: number | undefined
  createEffect(() => {
    const signature = `${visibleLimit()}\u0000${state().changes.map((change) => `${change.file}\u0000${change.status}\u0000${change.additions}\u0000${change.deletions}`).join("\u0001")}`
    const size = pageSize()
    if (signature !== previousChangeSignature || size !== previousPageSize) {
      previousChangeSignature = signature
      previousPageSize = size
      setMorePage(0)
    }
    const current = page().range.page
    if (current !== morePage()) setMorePage(current)
    if (omitted().length === 0 && moreExpanded()) setMoreExpanded(false)
  })

  // The row can be hit-tested to the container or to a text child; mark the
  // event so the first handler to see it opens the diff exactly once.
  const activateDiff = (event: { button?: number; preventDefault?: () => void; __rigHandled?: boolean }) => {
    if (event.__rigHandled) return
    event.__rigHandled = true
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault?.()
    openDiff(context)
  }

  const activateMore = () => {
    if (omitted().length === 0) return
    setMorePage(0)
    setMoreExpanded(true)
  }

  const visible = () => {
    const current = state()
    if (!current.isGit) return false
    if (props.whenEmpty === "show") return true
    return current.changes.length > 0 || current.pullRequest !== undefined
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
          <text fg={palette().primary} attributes={TextAttributes.BOLD}>
            {collapsed() ? "+ Source Control" : "- Source Control"}
          </text>
          <text fg={palette().sectionCount} attributes={TextAttributes.BOLD}>
            {` ${state().changes.length}`}
          </text>
          <text fg={palette().subdued} attributes={TextAttributes.DIM}>
            {` ${state().changes.length === 1 ? "change" : "changes"}`}
          </text>
        </box>

        <Show when={!collapsed()}>
          <For each={visibleChanges(state().changes, props.runtime().maxFiles)}>
            {(change) => <ChangeRow
              change={change}
              palette={palette}
              hovered={hovered}
              onHover={setHovered}
              onLeave={(file) => setHovered((current) => (current === file ? undefined : current))}
              onActivate={activateDiff}
              onOpen={() => openDiff(context)}
            />}
          </For>
          <Show when={state().changes.length > 0}>
            <box paddingLeft={2} height={1} overflow="hidden">
              <SidebarAction label="click to open the diff viewer" palette={palette} onActivate={() => openDiff(context)} />
            </box>
          </Show>
          <Show when={omitted().length > 0 && !moreExpanded()}>
            <box paddingLeft={2} height={1} overflow="hidden">
              <SidebarAction label={`+${omitted().length} more files`} palette={palette} onActivate={activateMore} />
            </box>
          </Show>
          <Show when={moreExpanded() && omitted().length > 0}>
            <box paddingLeft={2} height={1} overflow="hidden">
              <text wrapMode="none" truncate fg={palette().subdued} attributes={TextAttributes.DIM}>
                {`More files ${visibleLimit() + page().range.start + 1}-${visibleLimit() + page().range.end} of ${state().changes.length}`}
              </text>
            </box>
            <box flexDirection="row" paddingLeft={2} gap={1} height={1} overflow="hidden">
              <Show when={page().range.page > 0}>
                <SidebarAction id="opencode-rig.source-control.more.previous" label="< prev" palette={palette} onActivate={() => setMorePage((current) => Math.max(0, current - 1))} />
              </Show>
              <Show when={page().range.page + 1 < page().range.pageCount}>
                <SidebarAction id="opencode-rig.source-control.more.next" label="next >" palette={palette} onActivate={() => setMorePage((current) => current + 1)} />
              </Show>
              <SidebarAction id="opencode-rig.source-control.more.close" label="close" palette={palette} onActivate={closeMore} />
            </box>
            <For each={page().items}>
              {(change) => <ChangeRow
                change={change}
                palette={palette}
                hovered={hovered}
                onHover={setHovered}
                onLeave={(file) => setHovered((current) => (current === file ? undefined : current))}
                onActivate={activateDiff}
                onOpen={() => openDiff(context)}
              />}
            </For>
          </Show>
          <Show when={state().pullRequest}>
            {(pullRequest) => (
              <box paddingLeft={2} height={1} overflow="hidden">
                <text wrapMode="none" truncate fg={palette().action}>
                  PR #{pullRequest().number} - {pullRequest().state} - checks {checksLabel(pullRequest().checks)}
                </text>
              </box>
            )}
          </Show>
          <Show when={state().error || state().githubError}>
            <box paddingLeft={2} height={1} overflow="hidden">
              <text wrapMode="none" truncate fg={palette().measurement}>Refresh failed; showing saved values.</text>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-rig.source-control",
  setup(context) {
    const options = pluginOptions(context.options)
    const whenEmpty = options.whenEmpty ?? "hide"
    const githubEnabled = options.github !== false

    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { startCollapsed: options.startCollapsed ?? DEFAULT_START_COLLAPSED },
    })

    const kv: OptionsKV = {
      ready: true,
      get: (key, fallback) => (key === KEYS.startCollapsed ? (settings.startCollapsed as never) : (fallback as never)),
      set: (key, value) => {
        if (key === KEYS.startCollapsed) {
          void updateSettings((draft) => {
            draft.startCollapsed = Boolean(value)
          })
        }
      },
    }

    const runtime = createMemo(() => readRuntimeOptions(kv, options))
    const setStartCollapsed = (value: boolean) => {
      void updateSettings((draft) => {
        draft.startCollapsed = value
      })
    }

    const mcp = githubEnabled ? createGithubMcpClient(options.githubMcpCommand) : undefined
    const store = createSourceControlStore({
      status: (parameters) => context.client.vcs.status({ location: { directory: parameters.directory } }),
      github: githubEnabled,
      remoteName: options.remoteName ?? "origin",
      githubToolCaller: mcp?.callTool,
    })

    let sessionID = ""
    let directory: string | undefined
    let branch: string | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let localTimer: ReturnType<typeof setTimeout> | undefined
    let githubTimer: ReturnType<typeof setTimeout> | undefined
    let refreshGithub = false
    let localInFlight: Promise<void> | undefined
    let githubInFlight: Promise<void> | undefined
    let stopped = false

    const updateContext = (nextSessionID: string) => {
      if (sessionID === nextSessionID) return false
      sessionID = nextSessionID
      const location = context.data.session.get(nextSessionID)?.location
      directory = location?.directory ?? context.location?.directory ?? context.data.location.default().directory
      branch = context.data.location.vcs.info(location)?.branch.current
      void context.data.location.vcs.sync(location)
      return true
    }

    const refreshLocal = async () => {
      if (!directory || localInFlight) return localInFlight
      const currentDirectory = directory
      const currentBranch = branch
      localInFlight = store.refreshLocal(currentDirectory, currentBranch).finally(() => {
        localInFlight = undefined
      })
      return localInFlight
    }

    const refreshGithubNow = async () => {
      if (!directory || !githubEnabled || githubInFlight) return githubInFlight
      const currentDirectory = directory
      const currentBranch = branch
      githubInFlight = store.refreshGithub(currentDirectory, currentBranch).finally(() => {
        githubInFlight = undefined
      })
      return githubInFlight
    }

    const refresh = async (forceGithub = false) => {
      refreshGithub ||= forceGithub
      await refreshLocal()
      if (refreshGithub) {
        refreshGithub = false
        await refreshGithubNow()
      }
    }

    const scheduleRefresh = (forceGithub = false) => {
      refreshGithub ||= forceGithub
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        void refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    const stopSessionIdle = context.data.on("session.idle", (event) => {
      if (event.data.sessionID === sessionID) scheduleRefresh(true)
    })
    const stopFiles = context.data.on("filesystem.changed", () => scheduleRefresh())
    const stopBranch = context.data.on("vcs.branch.updated", (event) => {
      branch = event.data.branch
      scheduleRefresh(true)
    })

    const scheduleLocalPoll = () => {
      if (stopped) return
      localTimer = setTimeout(async () => {
        localTimer = undefined
        try {
          await refresh()
        } finally {
          scheduleLocalPoll()
        }
      }, runtime().refreshMs)
    }

    const scheduleGithubPoll = () => {
      if (stopped || !githubEnabled) return
      githubTimer = setTimeout(async () => {
        githubTimer = undefined
        try {
          await refresh(true)
        } finally {
          scheduleGithubPoll()
        }
      }, runtime().githubRefreshMs)
    }

    scheduleLocalPoll()
    scheduleGithubPoll()

    const stopKeymap = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
        {
          id: "source-control.refresh",
          title: "Refresh Source Control",
          description: "Refresh local changes and the current branch pull request.",
          group: "Source Control",
          palette: true,
          run: async () => {
            await refresh(true)
            context.ui.toast.show({ variant: "success", title: "Source Control", message: "Source control refreshed." })
          },
        },
        {
          id: "source-control.details",
          title: "Source Control details",
          description: "Show local changes and GitHub pull request details.",
          group: "Source Control",
          palette: true,
          slash: { name: "changes" },
          run: async () => {
            await context.ui.dialog.alert({ title: "Source Control", message: details(store.getState()) })
          },
        },
      ],
    }))
        return null as never
      },
    })

    const stopSidebar = context.ui.slot({
      before: "sidebar.footer",
      render: ({ sessionID: nextSessionID }) => {
        if (updateContext(nextSessionID)) void refresh(true)
        return (
          <SourceControlPanel
            store={store}
            runtime={runtime}
            setStartCollapsed={setStartCollapsed}
            whenEmpty={whenEmpty}
          />
        )
      },
    })

    return () => {
      stopped = true
      if (refreshTimer) clearTimeout(refreshTimer)
      if (localTimer) clearTimeout(localTimer)
      if (githubTimer) clearTimeout(githubTimer)
      stopKeymap()
      stopSidebar()
      stopSessionIdle()
      stopFiles()
      stopBranch()
      store.dispose()
      return mcp?.dispose()
    }
  },
})
