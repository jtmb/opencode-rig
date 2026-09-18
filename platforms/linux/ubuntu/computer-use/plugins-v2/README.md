# OpenCode v2 plugins

OpenCode v2 (2.0.x) ports of the harness plugins, kept beside the v1 packages
under `plugins/` so v1 stays the default until the cutover. The workspace is
isolated: one `node_modules` at this directory, a shared
[`tsconfig.base.json`](tsconfig.base.json), and one package per plugin.

## Packages

| Package | Kind | Surfaces |
| --- | --- | --- |
| [`rig-tools`](rig-tools/README.md) | server | `desktop_apps`, `desktop_tree`, `desktop_find`, `desktop_windows`, `desktop_act`, `desktop_input`, `vision_capture` |
| [`rig-todo`](rig-todo/README.md) | server + CLI | `todowrite`, `todoread`, plus a `sidebar.content` todo panel |
| [`codex-fallback`](codex-fallback/README.md) | server | `session.context` and `session.retry` model routing |
| [`source-control`](source-control/README.md) | CLI | working-tree and pull-request `sidebar.content` panel |
| [`codex-usage`](codex-usage/README.md) | CLI | weekly Codex quota `sidebar.content` panel |
| [`file-manager`](file-manager/README.md) | CLI | docked `session.panel` tree, quick-open, and editor |

`tui-settings` is not ported: v2's built-in `/settings` already covers its
appearance, display, plugins, and keybind sections, and only its Source Control
presets remain, folded into the source-control plugin.

## Registration

v2 registers **server** plugins from the `plugins` array in `opencode.jsonc`
and **CLI** plugins from the `plugins` array in `cli.json`. A bare string is an
npm package name and v2 will try to install it, so a local package uses the
object form and a root entry shim:

```jsonc
// opencode.jsonc (server) or cli.json (CLI)
{
  "plugins": [
    { "package": "/abs/path/to/plugins-v2/rig-tools", "options": {} }
  ]
}
```

The loader resolves `<package>/server` and `<package>/tui`, which is why each
package has a root `server.ts` or `tui.tsx` that re-exports `src/`.

CLI plugins must register keymap layers from inside a slot render, not directly
in `setup`: on 2.0.7 a direct `context.keymap.layer(...)` throws
`Keymap.Provider is missing` and aborts the whole plugin. The packages here use
an `append: "app"` slot that calls `context.keymap.layer(...)` and returns
`null`.

## Checks

Each package follows the same adaptive resource guard as v1: `npm run check`
runs `typecheck` then `test`, and both route through
`scripts/run-bounded-command.sh`. `check-plugin-resource-guards.py` enforces
that wiring for this directory too.

The `verify` GitHub Actions job installs this workspace with
`npm ci --ignore-scripts` and runs all six package checks, so CI exercises the
same commands as a local run. Workspace membership lives in `package.json`;
add a package there and refresh `package-lock.json` through the bounded
wrapper when introducing one.

```bash
cd platforms/linux/ubuntu/computer-use/plugins-v2/<package>
npm run check
```

## Status

All six packages typecheck, pass their ported tests, and load in the v2.0.7
pilot. `rig-tools` and `rig-todo` are verified live (their tools appear in a v2
session). `file-manager` is the reason for the migration: v2's `session.panel`
is a host-sized, focusable, resizable dock that replaces the v1 full-screen
route.

The file-manager now has the Phase 1 editor core: a persistent per-session tab
strip, dirty baselines, save/save-all, guarded close and reopen, status-bar
`L:C`/filetype reporting, go-to-line, and bounded editor click-to-position
mapping. It opens with `ctrl+shift+e`, `/explorer`, `/editor`, or `/files`.
Its keyboard controls are `ctrl+s`, `ctrl+shift+s`, `alt+left/right`,
`alt+w`, `alt+t`, and `ctrl+g`; the package check covers 39 tests. Parser
highlighting remains fail-soft and uses the Phase 0 shared tree-sitter client
foundation while the pinned multi-language asset fetch is deferred to Phase 2.
