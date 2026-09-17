# `source-control`

`source-control` is a local OpenCode TUI plugin that adds a VS Code-style
working-tree panel to the session sidebar. It combines OpenCode's local VCS
status API with an optional read-only GitHub pull-request row.

## Registration and placement

The plugin is registered in the user-owned `~/.config/opencode/tui.json` file,
or in a project's `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/source-control/src/tui.tsx",
      { "github": true }
    ]
  ]
}
```

`deploy-plugins.sh --plugins source-control` writes the equivalent tuple
without disturbing existing entries. OpenCode must restart after registration
or source changes because TUI plugins are loaded at startup.

The panel registers in `sidebar_content` at order `600`. The built-in file
sidebar uses order `500`, while the built-in path/branch footer occupies the
separate single-winner `sidebar_footer` slot. The plugin deliberately does not
claim the footer.

## Local working-tree state

The panel obtains the current session directory from
`api.state.session.get(sessionID)?.directory`, falling back to the TUI project
directory. It calls `api.client.vcs.status({ directory })`, which returns
`VcsFileStatus` values:

```text
{ file, additions, deletions, status: added | deleted | modified }
```

The pure change layer validates the response, clamps invalid counts to zero,
sorts by path, maps statuses to `A`, `D`, and `M`, and left-truncates long paths
for the narrow sidebar. The header displays the total count even when only the
first `maxFiles` rows are rendered. The default is eight rows followed by a
`+N more` line.

The header toggles `local.source-control.collapsed` in the TUI key-value store.
Each visible file row opens the built-in `diff.open` command. If the command is
not registered, the plugin falls back to the built-in `diff` route with `mode:
git`, the current session ID, and the previous route for return navigation.

The panel is hidden for non-git projects and, by default, for clean projects
with no pull-request row. `whenEmpty: "show"` keeps a clean git panel visible.

## GitHub pull-request state

GitHub support is enabled by default but is optional. The plugin reads the
configured remote with:

```text
git remote get-url <remoteName>
```

Only `github.com` remotes are accepted. The current branch and `owner/repo`
are used for two read-only MCP calls:

1. `list_pull_requests` with `owner`, `repo`, `state: "open"`, and
   `head: "owner:branch"`.
2. `pull_request_read` with `method: "get_status"` for the selected pull
   request.

The row is formatted as `PR #57 - open - checks passing`. Check results are
classified conservatively as `passing`, `failing`, `pending`, or `unknown`.
No pull request, non-GitHub remote, missing authentication, network failure, or
MCP failure hides only this row. The last good GitHub result is retained during
transient refresh errors.

## Adaptive MCP containment

The TUI plugin itself runs inside OpenCode and cannot safely impose a new
memory limit on its host process. The external GitHub MCP child is therefore
launched through `systemd-run --user --pipe --collect` with a transient cgroup
when the user systemd manager is available. Minimal environments use the
adaptive `prlimit --as` fallback; if neither limiter is available, the child is
not started.

The budget is recalculated on each launch from the lower of:

- Linux `MemAvailable`;
- the remaining memory in the active cgroup, when available; and
- available swap and cgroup swap for the swap portion.

The GitHub child receives approximately twenty percent of effective available
memory and up to twenty-five percent of that child budget as swap. There is no
machine-specific byte ceiling. If the system cannot create a safe adaptive
budget, the MCP child is not started and local source control remains active.

The wrapper still resolves GitHub credentials itself from
`GITHUB_PERSONAL_ACCESS_TOKEN`, `GH_TOKEN`, or the logged-in `gh` CLI. The
plugin never reads, logs, or stores credentials. The MCP server remains the
repository's pinned read-only and lockdown-protected wrapper.
Its informational stderr is discarded at the stdio transport boundary so server
diagnostics cannot corrupt the OpenCode TUI; connection and call failures still
surface through the plugin's saved error state.

## Refresh and lifecycle

Local data refreshes on mount and after `session.idle`, `file.edited`,
`file.watcher.updated`, and `vcs.branch.updated`. File and watcher events are
debounced for 750 ms. Local polling defaults to 15 seconds with a five-second
minimum. GitHub polling defaults to 120 seconds with a thirty-second minimum.
Local and GitHub refreshes deduplicate in-flight calls independently.

The plugin disposes event listeners, timers, the store, and the transient MCP
transport during TUI lifecycle cleanup. The GitHub caller is injectable in
tests, so unit tests never spawn a real MCP process.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `refreshMs` | `15000` | Local refresh interval; minimum `5000`. |
| `githubRefreshMs` | `120000` | GitHub refresh interval; minimum `30000`. |
| `maxFiles` | `8` | Visible local rows. |
| `whenEmpty` | `hide` | Hide or show a clean git panel. |
| `github` | `true` | Enable GitHub lookup. |
| `githubMcpCommand` | Derived wrapper | Override the command for tests or another checkout. |
| `remoteName` | `origin` | Git remote to inspect. |

## Package checks

The package pins OpenCode `1.18.31`, OpenTUI `0.5.11`, Solid `1.9.12`, and
`@modelcontextprotocol/sdk` `1.30.0`. Its `typecheck` and `test` scripts use
`run-bounded-command.sh`, which calculates a fresh budget from current memory,
serializes checks, applies a timeout, and refuses to run without a limiter.

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins/source-control install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/source-control run check
```
