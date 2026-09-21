# `source-control` v2 CLI plugin

`source-control` adds a VS Code-style Source Control panel to the OpenCode
session sidebar footer. It shows local working-tree changes and, when available, the
pull request and check state for the current GitHub branch.

This is the OpenCode v2 port. It registers a `sidebar.footer` slot and uses
`ctx.client.vcs` plus reactive `ctx.data` events.

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

- The panel is an additive `sidebar.footer` contribution, independent of the
  native and plugin-owned `sidebar.content` sections.
- The panel starts minimized. The header expands or collapses it and persists
  the state in plugin storage (`ctx.storage`).
- The header shows the total local change count in the theme accent color with
  a muted `change`/`changes` label.
- Changed files are sorted by path, capped by `maxFiles` (default `8`), and
  dispatch the supported host `diff.open` command on a left click (or
  Enter/Space when focused). The canonical CLI config starts that viewer in
  **Uncommitted** mode with `diffs.source: "working"`; an in-view choice made
  with `d` lasts until the TUI exits. File paths are underlined to show they are interactive, hovering a
  row highlights the path and shows a `click to open the diff viewer` hint,
  and the built-in viewer's own mouse file tree selects the individual file.
  Click handlers require terminal mouse capture (`"mouse": true` in
  `cli.json`).
- `/changes` opens details, and the `source-control.refresh` command refreshes
  both local and GitHub data.
- GitHub is read-only and optional. The panel hides the GitHub row when the
  remote, pull request, credentials, or network is unavailable.
- Refresh errors keep the last successful data and never take down the TUI.
- Source Control presets (`refreshMs`, `githubRefreshMs`, `maxFiles`,
  `startCollapsed`, `whenEmpty`, `github`, `remoteName`) are plugin options;
  sidebar visibility and position are handled by built-in `/settings` and the
  fixed slot model.

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

These are plugin options rather than live `kv` keys; only `startCollapsed`
changes at runtime through the header toggle and storage.

The GitHub MCP child is launched through an adaptive user cgroup budget based
on current host and cgroup memory availability when the user systemd manager is
available. Minimal environments use an adaptive `prlimit --as` fallback. If no
safe limiter or budget can be created, only the GitHub row is disabled; local
changes continue to work. The child transport discards informational stderr so
MCP diagnostics do not leak into the TUI. v2 has no plugin-facing MCP tool-call
API, so this package keeps the bounded stdio client.

## Theme parity

The built-in `opencode` palette differs from Aura. To use the Aura palette, set
`cli.json`:

```json
{ "theme": { "name": "aura", "mode": "dark" } }
```

With `aura`, the tokens resolve to these values: text
`#edecee`, subdued `#6d6d6d`, warning `#ffca85`, info/accent `#a277ff`,
added `#61ffca`, removed `#ff6767`, border `#2d2d2d`, background `#0f0f0f`,
background element `#15141b`. The plugin uses `theme.hue.accent[200]` for the
accent (header count, hovered paths, titles), because v2's
`text.action.primary.default` is a high-contrast foreground rather than the
accent hue.

## Checks

```bash
npm run check
```

Tests inject the GitHub tool caller and never spawn the real MCP server.
