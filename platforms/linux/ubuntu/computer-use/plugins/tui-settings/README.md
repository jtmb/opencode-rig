# `tui-settings` TUI plugin

> **v1 / rollback only.** Retired in the OpenCode v2 stack, where the built-in
> `/settings` replaces it; retained while v1 is available for rollback. The
> harness-specific Source Control presets were folded into
> [`plugins-v2/source-control`](../../plugins-v2/source-control/README.md).

`tui-settings` adds a slim, right-aligned `Settings` row to the OpenCode
session sidebar and a settings overlay that edits the host's display
preferences, opens the built-in theme and plugin managers, tunes the
`source-control` runtime options, and positions the harness sidebar panels.

## Registration

Register the source entry in the user-owned `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/tui-settings/src/tui.tsx",
      { "order": 10 }
    ]
  ]
}
```

Or use the repository deployment script:

```bash
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --scope global --plugins tui-settings --verify-only
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --scope global --plugins tui-settings --apply
```

Restart OpenCode after changing the registration or plugin source.

## Behavior

- The `Settings` row registers in the additive `sidebar_content` slot at order
  `10` (the top of the sidebar), right-aligned. Click it, or focus it and press
  Enter/Space, to open the overlay.
- `/settings` and the command palette entry `Open settings` open the same
  overlay.
- The overlay is a drill-down list built from the host `DialogSelect`: choose a
  section, change a value, and return. Dialog size adapts to the terminal width
  (`medium` below 96 columns, `large` above).
- Sections: **Appearance** (theme picker and dark/light mode), **Display**
  (timestamps, thinking, tool details, assistant metadata, scrollbar,
  animations, generic tool output, diff wrap), **Plugins** (loaded plugins and
  the built-in manager), **Source Control** (refresh intervals, visible rows,
  start state), **Sidebar** (visibility and panel position), and **About**.
- All persistence is `api.kv`; the plugin never rewrites `tui.json`.

## Sidebar positioning

OpenCode's v1 TUI plugin API fixes each panel's order when it registers and does
not expose a runtime reorder, and the built-in panels (Context, MCP, LSP, Todo,
Files) cannot be moved by a plugin. `tui-settings` therefore offers what the API
supports honestly:

- **Visibility** (`sidebar` key): `Auto` shows the sidebar only when the
  terminal is wider than 120 columns, matching the host rule; `Hidden` always
  hides it. This applies immediately.
- **Panel position**: the harness panels it owns (`Settings gear`, `Source
  Control`) can be moved to an anchor relative to the built-in panels - Top,
  Above Context, Below Context, Below MCP, Below LSP, Below Todo, or Below
  Files. The anchor is written as a numeric order to the plugin's key and
  applies after the next OpenCode restart.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `order` | `10` | Sidebar order for the `Settings` row when no kv override exists. |

The row also honors `local.tui-settings.order` from the TUI key-value store,
which the Sidebar section writes; like all sidebar orders it applies at the next
restart.

## Checks

```bash
npm install
npm run check
```

The pure settings model in `src/settings.ts` (visibility, display toggles,
order anchors, source-control presets, responsive sizing) is covered by
`node:test`; the overlay and sidebar row are verified live after a restart.
