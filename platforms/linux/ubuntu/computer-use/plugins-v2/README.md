# OpenCode v2 plugins

OpenCode v2 (2.0.x) ports of the harness plugins, kept beside the v1 packages
under `plugins/` so v1 stays the default until the cutover. The workspace is
isolated: one `node_modules` at this directory, a shared
[`tsconfig.base.json`](tsconfig.base.json), and one package per plugin.

## Packages

| Package | Kind | Surfaces |
| --- | --- | --- |
| [`rig-tools`](rig-tools/README.md) | server | `desktop_apps`, `desktop_tree`, `desktop_find`, `desktop_act`, `vision_capture` |
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

## Checks

Each package follows the same adaptive resource guard as v1: `npm run check`
runs `typecheck` then `test`, and both route through
`scripts/run-bounded-command.sh`. `check-plugin-resource-guards.py` enforces
that wiring for this directory too.

```bash
cd platforms/linux/ubuntu/computer-use/plugins-v2/<package>
npm run check
```

## Status

All five packages typecheck, pass their ported tests, and load in the v2.0.7
pilot. `rig-tools` is verified live (its tools appear in a v2 session).
`file-manager` is the reason for the migration: v2's `session.panel` is a
host-sized, focusable, resizable dock that replaces the v1 full-screen route.
