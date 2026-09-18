# `tui-settings`

`tui-settings` is a local OpenCode TUI plugin that adds a `Settings` entry to
the session sidebar and a drill-down settings overlay. It edits host display
preferences, dispatches the built-in theme and plugin managers, adjusts the
`source-control` runtime options, and positions the harness sidebar panels.

## Registration and placement

The plugin is registered in the user-owned `~/.config/opencode/tui.json`, or in
a project's `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/tui-settings/src/tui.tsx",
      { "order": 10 }
    ]
  ]
}
```

`deploy-plugins.sh --plugins tui-settings` writes the equivalent tuple without
disturbing existing entries. TUI plugins load at startup, so OpenCode must
restart after registration or source changes.

The `Settings` row registers in the additive `sidebar_content` slot. Its order
is `local.tui-settings.order` when present, otherwise the `order` registration
option, otherwise `10` (the top of the sidebar). It renders right-aligned as a
slim single-line row. `sidebar_title` and `sidebar_footer` are single-winner
slots and are deliberately not used.

## Overlay model

The row and the `/settings` command open the overlay through
`api.ui.dialog.replace`, and the overlay is a drill-down of host
`DialogSelect` lists. Each selection either opens the next list, applies a
change and re-renders the current list, or returns to the section list. The
plugin chooses `api.ui.dialog.setSize` from the terminal width, so the overlay
is `medium` below 96 columns and `large` above. `About` uses `DialogAlert`.

Because the overlay is built from host dialog components, navigation, filtering,
and focus stay with OpenCode rather than being reimplemented.

## Sections

| Section | Contents |
|---------|----------|
| Appearance | Current theme name; opens the built-in theme picker (`theme.switch`) and dark/light switch (`theme.switch_mode`). |
| Display | Toggles for the host display keys listed below. |
| Plugins | Read-only list from `api.plugins.list()` and a row that dispatches the built-in plugin manager (`plugins.list`). |
| Source Control | Preset values for `refreshMs`, `githubRefreshMs`, and `maxFiles`, plus the `startCollapsed` state; all write the live `local.source-control.*` keys. |
| Sidebar | Sidebar visibility and the position of the harness panels. |
| About | OpenCode version, terminal size, sidebar visibility, loaded-plugin count, and config paths. |

Display toggles write the host-consumed keys `timestamps`, `thinking_mode`,
`tool_details_visibility`, `assistant_metadata_visibility`, `scrollbar_visible`,
`animations_enabled`, `generic_tool_output_visibility`, and `diff_wrap_mode`.
Boolean keys flip on/off, `timestamps` and `thinking_mode` flip
`show`/`hide`, and `diff_wrap_mode` cycles `word`/`none`.

## Sidebar positioning

The v1 TUI plugin API registers each sidebar panel at a fixed order
(`api.slots.register({ order })`) and exposes no runtime reorder; the built-in
panels cannot be moved by a plugin. `tui-settings` therefore provides:

- **Visibility** through the host `sidebar` key: `Auto` matches the host rule
  (visible only when the terminal is wider than 120 columns) and `Hidden` always
  hides the sidebar. Both apply immediately.
- **Position** for the panels the harness owns (`Settings gear`,
  `Source Control`): an anchor chosen relative to the built-in panels (Top,
  Above Context, Below Context, Below MCP, Below LSP, Below Todo, Below Files).
  The numeric order is written to `local.tui-settings.order` or
  `local.source-control.order`; because order is fixed at registration, the
  change applies after the next OpenCode restart. The overlay labels this.

## Key-value keys

| Key | Writer | Applied |
|-----|--------|---------|
| `sidebar` | Sidebar visibility | Immediately |
| `local.tui-settings.order` | Sidebar position (gear) | Next restart |
| `local.source-control.order` | Sidebar position (source control) | Next restart |
| `local.source-control.refreshMs` | Source Control presets | Next refresh tick |
| `local.source-control.githubRefreshMs` | Source Control presets | Next refresh tick |
| `local.source-control.maxFiles` | Source Control presets | Next refresh tick |
| `local.source-control.startCollapsed` | Source Control start state | Next refresh tick |
| `timestamps`, `thinking_mode`, `tool_details_visibility`, `assistant_metadata_visibility`, `scrollbar_visible`, `animations_enabled`, `generic_tool_output_visibility`, `diff_wrap_mode` | Display toggles | Immediately |

The plugin writes only these keys and never rewrites `tui.json`.

## Package checks

The package pins OpenCode `1.18.31`, OpenTUI `0.5.11`, and Solid `1.9.12`. Its
`typecheck` and `test` scripts use `run-bounded-command.sh`, which calculates a
fresh budget from current memory, serializes checks, applies a timeout, and
refuses to run without a limiter.

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins/tui-settings install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/tui-settings run check
```

`src/settings.ts` is the pure model (visibility, display toggles, order anchors,
source-control presets, responsive sizing) and is covered by `node:test`. The
row, overlay, and dispatch behavior are verified live after a restart.
