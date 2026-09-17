/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"

import { leftTruncate, statusLetter, visibleChanges, type SourceControlChange } from "./changes.ts"
import type { GithubCheckState } from "./github.ts"
import { createGithubMcpClient, type GithubMcpCommand } from "./mcp.ts"
import { createSourceControlStore, type SourceControlState, type SourceControlStore } from "./store.ts"

type PluginOptions = {
  refreshMs?: number
  githubRefreshMs?: number
  maxFiles?: number
  whenEmpty?: "hide" | "show"
  github?: boolean
  githubMcpCommand?: GithubMcpCommand
  remoteName?: string
}

const id = "local.source-control"
const COLLAPSED_KEY = "local.source-control.collapsed"
const DEFAULT_REFRESH_MS = 15_000
const MIN_REFRESH_MS = 5_000
const DEFAULT_GITHUB_REFRESH_MS = 120_000
const MIN_GITHUB_REFRESH_MS = 30_000
const DEFAULT_MAX_FILES = 8
const REFRESH_DEBOUNCE_MS = 750

function pluginOptions(value: unknown): PluginOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const options = value as Record<string, unknown>
  const githubMcpCommand = options.githubMcpCommand
  return {
    ...(typeof options.refreshMs === "number" && Number.isFinite(options.refreshMs)
      ? { refreshMs: options.refreshMs }
      : {}),
    ...(typeof options.githubRefreshMs === "number" && Number.isFinite(options.githubRefreshMs)
      ? { githubRefreshMs: options.githubRefreshMs }
      : {}),
    ...(typeof options.maxFiles === "number" && Number.isFinite(options.maxFiles)
      ? { maxFiles: options.maxFiles }
      : {}),
    ...(options.whenEmpty === "hide" || options.whenEmpty === "show" ? { whenEmpty: options.whenEmpty } : {}),
    ...(typeof options.github === "boolean" ? { github: options.github } : {}),
    ...(typeof githubMcpCommand === "string" ||
    (Array.isArray(githubMcpCommand) && githubMcpCommand.every((part) => typeof part === "string"))
      ? { githubMcpCommand: githubMcpCommand as GithubMcpCommand }
      : {}),
    ...(typeof options.remoteName === "string" && options.remoteName.trim()
      ? { remoteName: options.remoteName.trim() }
      : {}),
  }
}

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
  maxFiles: number
  whenEmpty: "hide" | "show"
}) {
  const [state, setState] = createSignal<SourceControlState>(props.store.getState())
  const [collapsed, setCollapsed] = createSignal(props.api.kv.get(COLLAPSED_KEY, false))
  const stop = props.store.subscribe(setState)

  onCleanup(stop)

  const toggle = () => {
    const next = !collapsed()
    setCollapsed(next)
    props.api.kv.set(COLLAPSED_KEY, next)
  }

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
            <b>{collapsed() ? "+" : "-"} Source Control {state().changes.length}</b>
          </text>
        </box>

        <Show when={!collapsed()}>
          <For each={visibleChanges(state().changes, props.maxFiles)}>
            {(change) => (
              <box
                flexDirection="row"
                gap={1}
                focusable
                onMouseDown={() => openDiff(props.api, props.sessionID)}
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
          <Show when={state().changes.length > props.maxFiles}>
            <text fg={props.api.theme.current.textMuted}>+{state().changes.length - props.maxFiles} more</text>
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
  const refreshMs = Math.max(MIN_REFRESH_MS, Math.floor(options.refreshMs ?? DEFAULT_REFRESH_MS))
  const githubRefreshMs = Math.max(
    MIN_GITHUB_REFRESH_MS,
    Math.floor(options.githubRefreshMs ?? DEFAULT_GITHUB_REFRESH_MS),
  )
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES))
  const whenEmpty = options.whenEmpty ?? "hide"
  const githubEnabled = options.github !== false
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
  let localRefreshInterval: ReturnType<typeof setInterval> | undefined
  let githubRefreshInterval: ReturnType<typeof setInterval> | undefined
  let refreshGithub = false
  let localInFlight: Promise<void> | undefined
  let githubInFlight: Promise<void> | undefined

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

  localRefreshInterval = setInterval(() => void refresh(), refreshMs)
  if (githubEnabled) {
    githubRefreshInterval = setInterval(() => void refresh(true), githubRefreshMs)
  }

  api.lifecycle.onDispose(() => {
    if (refreshTimer) clearTimeout(refreshTimer)
    if (localRefreshInterval) clearInterval(localRefreshInterval)
    if (githubRefreshInterval) clearInterval(githubRefreshInterval)
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
    order: 600,
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
            maxFiles={maxFiles}
            whenEmpty={whenEmpty}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
