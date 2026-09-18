# `source-control` TUI plugin

`source-control` adds a VS Code-style Source Control panel to the OpenCode
session sidebar. It shows local working-tree changes and, when available, the
pull request and check state for the current GitHub branch.

## Registration

Register the source entry in the user-owned `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/source-control/src/tui.tsx",
      { "github": true }
    ]
  ]
}
```

Or use the repository deployment script:

```bash
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --scope global --plugins source-control --verify-only
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --scope global --plugins source-control --apply
```

Restart OpenCode after changing the registration or plugin source.

## Behavior

- The panel is registered in `sidebar_content` at order `50` by default, above
  the built-in context panel (order `100`) and the file sidebar (order `500`),
  and above the separate single-winner path/branch footer. The
  `local.source-control.order` key overrides the order at the next restart; the
  `tui-settings` overlay writes it.
- The panel starts minimized. The header expands or collapses it and persists
  the state in `local.source-control.startCollapsed`; a one-time migration
  (`local.source-control.repositioned`) minimizes installs created before the
  reposition.
- The header shows the total local change count in the theme accent color with
  a muted `change`/`changes` label.
- Changed files are sorted by path, capped by `maxFiles` (default `8`), and
  activate the built-in `diff.open` viewer on Ctrl+click (or Enter/Space when
  focused); a plain click only selects the row.
- `/changes` opens details, and `Refresh Source Control` refreshes both local
  and GitHub data.
- GitHub is read-only and optional. The panel hides the GitHub row when the
  remote, pull request, credentials, or network is unavailable.
- Refresh errors keep the last successful data and never take down the TUI.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `refreshMs` | `15000` | Local refresh interval; values below `5000` are raised. |
| `githubRefreshMs` | `120000` | GitHub refresh interval; values below `30000` are raised. |
| `maxFiles` | `8` | Maximum local rows shown before `+N more`. |
| `startCollapsed` | `true` | Whether the panel starts minimized; the header toggle persists this value. |
| `whenEmpty` | `hide` | `hide` a clean repository or `show` an empty Git panel. |
| `github` | `true` | Enable the GitHub pull-request row. |
| `githubMcpCommand` | Repository wrapper | Override the wrapper command for tests or another checkout. |
| `remoteName` | `origin` | Git remote used to derive the GitHub repository. |

`refreshMs`, `githubRefreshMs`, `maxFiles`, and `startCollapsed` can also be
overridden at runtime through the TUI key-value store using
`local.source-control.<option>` keys (`local.source-control.refreshMs`,
`local.source-control.githubRefreshMs`, `local.source-control.maxFiles`,
`local.source-control.startCollapsed`). The plugin re-reads them on every
refresh tick, so changes apply without restarting OpenCode.
`local.source-control.order` is read only when the plugin loads, so an order
change applies after the next restart. `whenEmpty`, `github`,
`githubMcpCommand`, and `remoteName` are registration-only.

The GitHub MCP child is launched through an adaptive user cgroup budget based
on current host and cgroup memory availability when the user systemd manager is
available. Minimal environments use an adaptive `prlimit --as` fallback. If no
safe limiter or budget can be created, only the GitHub row is disabled; local
changes continue to work. The child transport discards informational stderr so
MCP diagnostics do not leak into the TUI.

## Checks

```bash
npm install
npm run check
```

Tests inject the GitHub tool caller and never spawn the real MCP server.
