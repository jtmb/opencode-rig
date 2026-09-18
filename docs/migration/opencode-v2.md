# Migration plan: OpenCode v1 (1.18.31) to v2 (2.0.x)

Status: planning. This document is the tracking plan for moving `opencode-rig`
from the v1 CLI to the v2 CLI. It is not yet executed; v1 remains the default
until the v2 stack passes the same health checks.

## Why

- v2 is the supported line and adds the dockable `session.panel` surface the
  `file-manager` Explorer needs. In v1 a plugin route is full-screen, so opening
  the Explorer replaces the session view; v2 panels are host-sized, focusable,
  resizable, and can toggle full screen.
- A left dock does not exist in either version. v2's panel shares the right dock
  with the sidebar, so the Explorer docks on the right.

## Verified facts (2026-09-17 research)

- v2 is released: `curl -fsSL https://opencode.ai/v2/install | bash`,
  `npm install -g @opencode/cli`, and standalone binaries under
  `https://opencode.ai/files/bin/2.0.6/`. Inspected `@opencode/plugin@2.0.7` and
  the `2.0.6` linux-x64 binary.
- CLI settings move to `~/.config/opencode/cli.json` (or
  `$XDG_CONFIG_HOME/opencode/cli.json`); server and project settings stay in
  `opencode.json(c)`.
- Config schema changes:
  - MCP: flat `mcp` map -> nested `mcp.servers.<name>` with `type`, `command`,
    `environment`, `cwd`, `disabled`, `timeout`, `codemode`, `protocol`.
  - Plugins: `plugin` array -> `plugins` array in `opencode.json(c)`, plus a
    CLI-only `plugins` array in `cli.json`.
  - New top-level `skills`, `commands`, `agents`, `permissions`, `providers`,
    `references`, `compaction`, `warming`, `worktree`, `update`.
- Skills still auto-discover from `~/.config/opencode/skills` and project
  `.opencode/skills` (also `.claude/skills`, `.agents/skills`). The 16 skills
  carry over; `category`/`tags` metadata is accepted but ignored.
- Commands still discover from `~/.config/opencode/commands/*.md` and project
  `.opencode/commands/`. The four global commands carry over, but their bodies
  reference v1 script paths and must be updated.
- Custom tools: v1's `~/.config/opencode/tools/*.ts` has no v2 equivalent.
  v2 registers tools from a server plugin with
  `ctx.tool.transform((editor) => editor.add({ name, description, input, execute }))`;
  image results use `Tool.FileContent`.
- Plugin APIs:
  - TUI: `@opencode/plugin/tui`, `Plugin.define({ id, setup(context) })`,
    `context.ui.slot({ append: "sidebar.content" })`,
    `context.ui.panel.open(name, { presentation })`, `context.keymap.layer`,
    `context.storage`, `context.ui.dialog`, `context.ui.router`.
  - Server: `@opencode/plugin`, transforms and hooks (`ctx.session.hook("context")`,
    `ctx.session.hook("retry")`, `ctx.session.hook("http.request")`, etc.).
  - Official migration guides: `/build/plugins/migrate-v1` and
    `/build/plugins/cli`.
- `PanelPresentation = "panel" | "fullscreen"`; `PanelInput` exposes `name`,
  `sessionID`, `width`, `presentation`, `focused`, `focus`, `close`,
  `toggleFullscreen`. The panel splits only when the terminal is wider than 80
  columns.

## Surface inventory

| Surface | v1 location | v2 target | Action |
| --- | --- | --- | --- |
| Server/project config | `~/.config/opencode/opencode.jsonc`, project `opencode.json` | same paths, new schema | rewrite |
| CLI settings | `~/.config/opencode/tui.json` + kv | `~/.config/opencode/cli.json` | rewrite |
| Skills | `~/.config/opencode/skills/<id>/SKILL.md` | same discovery | carry over, re-verify |
| Commands | `~/.config/opencode/commands/*.md` | same discovery | update bodies |
| Custom tools | `~/.config/opencode/tools/{desktop,vision}.ts` | server plugin `ctx.tool.transform` | reimplement |
| `codex-fallback` | server plugin (`@opencode-ai/plugin`) | server plugin (`@opencode/plugin`) | rewrite |
| `codex-usage` | TUI plugin (`sidebar_content`) | TUI plugin (`context.ui.slot`) | rewrite |
| `source-control` | TUI plugin (`sidebar_content`) | TUI plugin (`context.ui.slot`) | rewrite |
| `tui-settings` | TUI plugin (custom overlay) | TUI plugin (`keymap.layer`, `ui.dialog`) | rewrite |
| `file-manager` | TUI plugin (full-screen route) | TUI plugin (`session.panel`) | rewrite (payoff) |
| MCP wrappers | `scripts/playwright*.sh`, `github-mcp.sh` | reusable | re-register under `mcp.servers` |
| Setup/verify scripts | `scripts/setup-*.sh`, `deploy-plugins.sh` | v2 paths/health checks | update |
| Docs, `AGENTS.md`, `HANDOFF.md` | v1 references | v2 references | update |

## Phases

### Phase 0 - Isolated pilot (no cutover)

1. Install the v2 binary to a separate prefix (for example
   `~/.local/opt/opencode-v2/`); leave `~/.opencode/bin/opencode` (v1) untouched.
2. Run v2 with isolated config and data directories so it never reads or writes
   v1's `~/.config/opencode/` config, `~/.local/share/opencode/` database, or kv.
   Determine the supported isolation variables (`XDG_CONFIG_HOME`,
   `XDG_DATA_HOME`, or an `OPENCODE_CONFIG_DIR` equivalent) before the first run.
3. Verify: v2 `--version` is 2.0.x; v2 boots; skills are discovered; one MCP
   server connects; `cli.json` is created only in the isolated directory; v1's
   config, database, and kv are unchanged (compare hashes before and after).

Exit criteria: a repeatable isolated v2 launch with v1 provably untouched.

### Phase 1 - Config translation

1. Generate an isolated v2 `opencode.jsonc`: translate flat `mcp` to
   `mcp.servers`, `plugin` to `plugins`, and add `skills`, `commands`, `agents`,
   and `permissions` as needed. Keep secrets in `{env:...}`.
2. Generate `cli.json` from the current `tui.json` and kv (theme, `session.*`
   display toggles, keybinds).
3. Verify `opencode mcp list` shows every server connected, and that skills and
   commands are listed.

Exit criteria: v2 exposes the same MCP servers, skills, and commands as v1.

### Phase 2 - Plugin rewrites (largest)

1. `codex-fallback`: port the v1 server hooks to v2 session hooks (`context`,
   `retry`, `http.request`/`http.response`) and `ctx.session.switchModel` /
   `ctx.session.prompt` / revert. Follow `/build/plugins/migrate-v1`.
2. `codex-usage`, `source-control`, `tui-settings`: port to the TUI API
   (`Plugin.define`, `context.ui.slot`, `context.storage`, `context.client`,
   `context.keymap.layer`, `context.ui.dialog`).
3. `file-manager`: implement the tree/viewer/editor as a `session.panel`
   contribution opened with `context.ui.panel.open`, with `toggleFullscreen` for
   dock/undock; keep a full-screen `context.ui.router` route for editing if
   needed.
4. Register server plugins in `opencode.json(c)` `plugins`, and CLI-only plugins
   in `cli.json` `plugins`.

Exit criteria: each plugin loads and behaves correctly in the isolated v2
instance, with bounded checks per package.

### Phase 3 - Custom tools

1. New v2 plugin registering `desktop_apps`, `desktop_tree`, `desktop_find`,
   `desktop_act`, and `vision_capture` via `ctx.tool.transform`, reusing the
   existing Python wrappers and the preview/apply token flow.
2. Return screenshots as `Tool.FileContent`; confirm the model receives the
   image attachment.

Exit criteria: the tools load in v2 and a live `vision_capture` returns an
attachment.

### Phase 4 - Harness plumbing

1. Update or add setup/verify scripts and `deploy-plugins.sh` for v2 paths and
   `cli.json` registration.
2. Update health checks for the v2 config layout.
3. Update `AGENTS.md`, `HANDOFF.md`, `documentation-map.json`, and every README
   and doc that references v1 paths, plugin registration, or settings.

Exit criteria: the documentation gate and all required checks pass for v2.

### Phase 5 - Verification and cutover

1. Run the full `AGENTS.md` verification against v2.
2. Live-verify each plugin and the docked Explorer panel.
3. Switch the default `opencode` on `PATH` to v2; keep v1 installed for
   rollback until the v2 stack is proven.

Exit criteria: v2 passes the same health check as v1, and rollback is documented.

## Risks

- New major with pre-stable plugin and hook surfaces; names and shapes can
  change between minor releases.
- Config-path overlap: v2 and v1 both use `~/.config/opencode/opencode.jsonc`
  with incompatible schemas. Isolation in Phase 0 is mandatory; the final
  cutover is a one-time translation, not a coexistence.
- MCP Code Mode is on by default in v2, which regroups tool exposure and adds
  schema context; verify the GitHub and Playwright servers behave the same.
- Custom-tool attachment support in v2 needs a spike.
- Large surface: five plugins, the tools package, setup scripts, and docs.
- No left dock exists in v1 or v2; the Explorer docks right.

## Rollback

v1 stays installed and configured throughout. The cutover is a `PATH` change and
the v2 config lives in an isolated directory until the final step, so reverting
is restoring the previous `PATH` and config directory.
