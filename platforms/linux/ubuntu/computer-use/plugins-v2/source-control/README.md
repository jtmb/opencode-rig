# `source-control` v2 CLI plugin

`source-control` adds a VS Code-style Source Control panel to the OpenCode
session sidebar. It shows local working-tree changes and, when available, the
pull request and check state for the current GitHub branch.

This is the OpenCode v2 port. It registers a `sidebar.content` slot and uses
`ctx.client.vcs` plus reactive `ctx.data` events; the v1 package under
`plugins/source-control/` remains for the v1 harness.

## Registration

Register the package in the CLI-only `cli.json` `plugins` array:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/abs/path/to/plugins-v2/source-control",
      "options": { "github": true }
    }
  ]
}
```

The package needs a root `tui.tsx` shim (present) and the shared
`plugins-v2/node_modules`. Restart OpenCode after changing the registration or
plugin source.

## Behavior

- The panel is an additive `sidebar.content` contribution. v2 orders
  contributions by plugin enable order and has no per-slot `order` option, so
  the v1 `local.source-control.order` override is retired.
- The panel starts minimized. The header expands or collapses it and persists
  the state in plugin storage (`ctx.storage`), replacing the v1
  `local.source-control.startCollapsed` kv key.
- The header shows the total local change count in the theme accent color with
  a muted `change`/`changes` label.
- Changed files are sorted by path, capped by `maxFiles` (default `8`), and
  activate the host `diff.open` command on Ctrl+click (or Enter/Space when
  focused); a plain click only selects the row. File paths are underlined to
  show they are interactive, and hovering a row highlights the path and shows a
  `ctrl+click to open the diff` hint.
- `/changes` opens details, and the `source-control.refresh` command refreshes
  both local and GitHub data.
- GitHub is read-only and optional. The panel hides the GitHub row when the
  remote, pull request, credentials, or network is unavailable.
- Refresh errors keep the last successful data and never take down the TUI.
- **Retired from v1 `tui-settings`:** the Source Control presets
  (`refreshMs`, `githubRefreshMs`, `maxFiles`, `startCollapsed`, `whenEmpty`,
  `github`, `remoteName`) now live as plugin options here, and the sidebar
  visibility/position options are handled by the built-in `/settings` plus the
  fixed slot model. The `tui-settings` plugin is not ported.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `refreshMs` | `15000` | Local refresh interval; values below `5000` are raised. |
| `githubRefreshMs` | `120000` | GitHub refresh interval; values below `30000` are raised. |
| `maxFiles` | `8` | Maximum local rows shown before `+N more`. |
| `startCollapsed` | `true` | Whether the panel starts minimized; the header toggle persists this in plugin storage. |
| `whenEmpty` | `hide` | `hide` a clean repository or `show` an empty Git panel. |
| `github` | `true` | Enable the GitHub pull-request row. |
| `githubMcpCommand` | Repository wrapper | Override the wrapper command for tests or another checkout. |
| `remoteName` | `origin` | Git remote used to derive the GitHub repository. |

Unlike v1, these are plugin options rather than live `kv` keys; only
`startCollapsed` changes at runtime (through the header toggle and storage).

The GitHub MCP child is launched through an adaptive user cgroup budget based
on current host and cgroup memory availability when the user systemd manager is
available. Minimal environments use an adaptive `prlimit --as` fallback. If no
safe limiter or budget can be created, only the GitHub row is disabled; local
changes continue to work. The child transport discards informational stderr so
MCP diagnostics do not leak into the TUI. v2 has no plugin-facing MCP tool-call
API, so this package keeps the bounded stdio client.

## Checks

```bash
npm run check
```

Tests inject the GitHub tool caller and never spawn the real MCP server.
