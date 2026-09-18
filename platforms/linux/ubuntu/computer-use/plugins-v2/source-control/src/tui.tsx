/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

import { leftTruncate, statusLetter, visibleChanges, type SourceControlChange } from "./changes.ts"
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

const REFRESH_DEBOUNCE_MS = 750

type Theme = Context["theme"]

function statusColor(status: SourceControlChange["status"], theme: Theme) {
  if (status === "added") return theme.diff.text.added
  if (status === "deleted") return theme.diff.text.removed
  return theme.text.feedback.warning.default
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

function SourceControlPanel(props: {
  store: SourceControlStore
  runtime: () => RuntimeOptions
  setStartCollapsed: (value: boolean) => void
  whenEmpty: "hide" | "show"
}) {
  const context = usePlugin()
  const [state, setState] = createSignal<SourceControlState>(props.store.getState())
  const [hovered, setHovered] = createSignal<string | undefined>(undefined)
  const stop = props.store.subscribe(setState)
  const theme = () => context.theme

  onCleanup(stop)

  const collapsed = () => props.runtime().startCollapsed
  const toggle = () => props.setStartCollapsed(!collapsed())

  const visible = () => {
    const current = state()
    if (!current.isGit) return false
    if (props.whenEmpty === "show") return true
    return current.changes.length > 0 || current.pullRequest !== undefined
  }

  return (
    <Show when={visible()}>
      <box flexDirection="column" gap={0}>
        <box
          flexDirection="row"
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
            <b>{collapsed() ? "+" : "-"} Source Control</b>
          </text>
          <text fg={theme().text.action.primary.default}>
            <b> {state().changes.length}</b>
          </text>
          <text fg={theme().text.subdued}> {state().changes.length === 1 ? "change" : "changes"}</text>
        </box>

        <Show when={!collapsed()}>
          <For each={visibleChanges(state().changes, props.runtime().maxFiles)}>
            {(change) => (
              <box
                flexDirection="row"
                gap={1}
                focusable
                onMouseOver={() => setHovered(change.file)}
                onMouseOut={() => setHovered((current) => (current === change.file ? undefined : current))}
                onMouseDown={(event) => {
                  if (!event.modifiers.ctrl) return
                  event.preventDefault()
                  openDiff(context)
                }}
                onKeyDown={(event) => {
                  if (event.name === "return" || event.name === "space") {
                    event.preventDefault()
                    openDiff(context)
                  }
                }}
              >
                <text fg={statusColor(change.status, theme())}>{statusLetter(change.status)}</text>
                <text fg={hovered() === change.file ? theme().text.action.primary.default : theme().text.default}>
                  <u>{leftTruncate(change.file, 34)}</u>
                </text>
                <box flexGrow={1} />
                <text fg={theme().diff.text.added}>+{change.additions}</text>
                <text fg={theme().diff.text.removed}>-{change.deletions}</text>
              </box>
            )}
          </For>
          <Show when={hovered()}>
            <text fg={theme().text.feedback.info.default}>ctrl+click to open the diff</text>
          </Show>
          <Show when={state().changes.length > props.runtime().maxFiles}>
            <text fg={theme().text.subdued}>
              +{state().changes.length - props.runtime().maxFiles} more
            </text>
          </Show>
          <Show when={state().pullRequest}>
            {(pullRequest) => (
              <text fg={theme().text.feedback.info.default}>
                PR #{pullRequest().number} - {pullRequest().state} - checks {checksLabel(pullRequest().checks)}
              </text>
            )}
          </Show>
          <Show when={state().error || state().githubError}>
            <text fg={theme().text.feedback.warning.default}>Refresh failed; showing saved values.</text>
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

    context.ui.slot({
      append: "sidebar.content",
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
      stopSessionIdle()
      stopFiles()
      stopBranch()
      store.dispose()
      return mcp?.dispose()
    }
  },
})
