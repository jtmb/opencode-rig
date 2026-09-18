/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"

import { leftTruncate, statusLetter, visibleChanges, type SourceControlChange } from "./changes.ts"
import type { GithubCheckState } from "./github.ts"
import { createGithubMcpClient } from "./mcp.ts"
import { applyRepositionDefault, KEYS, pluginOptions, readRegistrationOrder, readRuntimeOptions, type RuntimeOptions } from "./options.ts"
import { createSourceControlStore, type SourceControlState, type SourceControlStore } from "./store.ts"

const id = "local.source-control"
const REFRESH_DEBOUNCE_MS = 750

function statusColor(status: SourceControlChange["status"], theme: TuiThemeCurrent) {
  if (status === "added") return theme.diffAdded
  if (status === "deleted") return theme.diffRemoved
  return theme.warning
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

function openDiff(api: TuiPluginApi, sessionID: string) {
  try {
    const result = api.keymap.dispatchCommand("diff.open")
    if (result.ok) return
    api.route.navigate("diff", {
      mode: "git",
      sessionID,
      returnRoute: api.route.current,
    })
    api.ui.dialog.clear()
  } catch {
    api.ui.toast({ variant: "warning", title: "Source Control", message: "Unable to open the diff viewer." })
  }
}

function SourceControlPanel(props: {
  api: TuiPluginApi
  store: SourceControlStore
  sessionID: string
  runtime: () => RuntimeOptions
  setStartCollapsed: (value: boolean) => void
  whenEmpty: "hide" | "show"
}) {
  const [state, setState] = createSignal<SourceControlState>(props.store.getState())
  const stop = props.store.subscribe(setState)

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
          <text fg={props.api.theme.current.text}>
            <b>{collapsed() ? "+" : "-"} Source Control</b>
          </text>
          <text fg={props.api.theme.current.accent}>
            <b> {state().changes.length}</b>
          </text>
          <text fg={props.api.theme.current.textMuted}> {state().changes.length === 1 ? "change" : "changes"}</text>
        </box>

        <Show when={!collapsed()}>
          <For each={visibleChanges(state().changes, props.runtime().maxFiles)}>
            {(change) => (
              <box
                flexDirection="row"
                gap={1}
                focusable
                onMouseDown={(event) => {
                  if (!event.modifiers.ctrl) return
                  event.preventDefault()
                  openDiff(props.api, props.sessionID)
                }}
                onKeyDown={(event) => {
                  if (event.name === "return" || event.name === "space") {
                    event.preventDefault()
                    openDiff(props.api, props.sessionID)
                  }
                }}
              >
                <text fg={statusColor(change.status, props.api.theme.current)}>{statusLetter(change.status)}</text>
                <text fg={props.api.theme.current.text}>{leftTruncate(change.file, 34)}</text>
                <box flexGrow={1} />
                <text fg={props.api.theme.current.diffAdded}>+{change.additions}</text>
                <text fg={props.api.theme.current.diffRemoved}>-{change.deletions}</text>
              </box>
            )}
          </For>
          <Show when={state().changes.length > props.runtime().maxFiles}>
            <text fg={props.api.theme.current.textMuted}>
              +{state().changes.length - props.runtime().maxFiles} more
            </text>
          </Show>
          <Show when={state().pullRequest}>
            {(pullRequest) => (
              <text fg={props.api.theme.current.info}>
                PR #{pullRequest().number} - {pullRequest().state} - checks {checksLabel(pullRequest().checks)}
              </text>
            )}
          </Show>
          <Show when={state().error || state().githubError}>
            <text fg={props.api.theme.current.warning}>Refresh failed; showing saved values.</text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options = pluginOptions(rawOptions)
  const whenEmpty = options.whenEmpty ?? "hide"
  const githubEnabled = options.github !== false
  applyRepositionDefault(api.kv)
  const [runtime, setRuntime] = createSignal<RuntimeOptions>(readRuntimeOptions(api.kv, options))
  const reloadRuntime = () => {
    applyRepositionDefault(api.kv)
    const next = readRuntimeOptions(api.kv, options)
    const current = runtime()
    if (
      next.refreshMs !== current.refreshMs ||
      next.githubRefreshMs !== current.githubRefreshMs ||
      next.maxFiles !== current.maxFiles ||
      next.startCollapsed !== current.startCollapsed
    ) {
      setRuntime(next)
    }
    return next
  }
  const setStartCollapsed = (value: boolean) => {
    api.kv.set(KEYS.startCollapsed, value)
    reloadRuntime()
  }

  const mcp = githubEnabled ? createGithubMcpClient(options.githubMcpCommand) : undefined
  const store = createSourceControlStore({
    status: (parameters) => api.client.vcs.status(parameters),
    github: githubEnabled,
    remoteName: options.remoteName ?? "origin",
    githubToolCaller: mcp?.callTool,
  })

  api.lifecycle.onDispose(() => {
    store.dispose()
    return mcp?.dispose()
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
    directory = api.state.session.get(nextSessionID)?.directory ?? api.state.path.directory
    branch = api.state.vcs?.branch
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

  const stopSessionIdle = api.event.on("session.idle", (event) => {
    if (event.properties.sessionID === sessionID) scheduleRefresh(true)
  })
  const stopEdited = api.event.on("file.edited", () => scheduleRefresh())
  const stopWatcher = api.event.on("file.watcher.updated", () => scheduleRefresh())
  const stopBranch = api.event.on("vcs.branch.updated", (event) => {
    branch = event.properties.branch
    scheduleRefresh(true)
  })

  const scheduleLocalPoll = () => {
    if (stopped) return
    localTimer = setTimeout(async () => {
      localTimer = undefined
      try {
        reloadRuntime()
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
        reloadRuntime()
        await refresh(true)
      } finally {
        scheduleGithubPoll()
      }
    }, runtime().githubRefreshMs)
  }

  scheduleLocalPoll()
  scheduleGithubPoll()

  api.lifecycle.onDispose(() => {
    stopped = true
    if (refreshTimer) clearTimeout(refreshTimer)
    if (localTimer) clearTimeout(localTimer)
    if (githubTimer) clearTimeout(githubTimer)
    stopSessionIdle()
    stopEdited()
    stopWatcher()
    stopBranch()
  })

  const stopCommands = api.command?.register(() => [
    {
      title: "Refresh Source Control",
      value: "source-control.refresh",
      description: "Refresh local changes and the current branch pull request.",
      category: "Source Control",
      onSelect: async () => {
        await refresh(true)
        api.ui.toast({ variant: "success", title: "Source Control", message: "Source control refreshed." })
      },
    },
    {
      title: "Source Control details",
      value: "source-control.details",
      description: "Show local changes and GitHub pull request details.",
      category: "Source Control",
      slash: { name: "changes" },
      onSelect: () => {
        api.ui.dialog.replace(() =>
          api.ui.DialogAlert({
            title: "Source Control",
            message: details(store.getState()),
            onConfirm: () => api.ui.dialog.clear(),
          }),
        )
      },
    },
  ])
  if (stopCommands) api.lifecycle.onDispose(stopCommands)

  api.slots.register({
    order: readRegistrationOrder(api.kv),
    slots: {
      sidebar_content(_context, props) {
        if (updateContext(props.session_id)) {
          void refresh(true)
        }
        return (
          <SourceControlPanel
            api={api}
            store={store}
            sessionID={props.session_id}
            runtime={runtime}
            setStartCollapsed={setStartCollapsed}
            whenEmpty={whenEmpty}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
