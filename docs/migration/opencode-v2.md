# Migration plan: OpenCode v1 (1.18.31) to v2 (2.0.x)

Status: cutover executed 2026-09-18. The default `opencode` now starts the v2
stack via a PATH shim; v1 remains installed and untouched for rollback. v2 work
continues on branch `migration/opencode-v2`.

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

## Phase 0 results (2026-09-17)

- Installed the standalone v2.0.7 linux-x64 binary to
  `~/.local/opt/opencode-v2/opencode`; v1 at `~/.opencode/bin/opencode` is
  untouched.
- Repeatable isolated launcher:
  `~/.local/opt/opencode-v2/opencode-pilot` sets `OPENCODE_CONFIG_DIR`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and
  `OPENCODE_DISABLE_AUTOUPDATE=1` under `~/.opencode-v2-pilot/`.
- `opencode debug paths` confirms every path (config, data, state, cache, db,
  log, repos) resolves under the pilot root. v1's `opencode.jsonc` and `tui.json`
  hashes are unchanged after the pilot runs, and v1's data directory gained no
  v2 files.
- v2 boots (`opencode v2.0.7`), reads only the pilot config, and connects MCP
  servers (github, playwright, playwright_headless) when they are configured.
- The pilot log shows v2 watching the configured skills directory
  (`.../computer-use/skills`), confirming the `skills` source is active.
- **MCP shape finding:** v2.0.7 accepted the v1 flat `mcp` map and did **not**
  register a server from the documented `mcp.servers` nesting. Phase 1 must
  confirm the exact shape against the installed build (the published docs may
  track a newer build than 2.0.7).
- `opencode service` has no `stop`; the background service was stopped by PID
  during cleanup. Use `--standalone` where possible to avoid a shared service.

## Phase 1 results (2026-09-17)

- Pilot config `~/.opencode-v2-pilot/config/opencode.jsonc` uses the flat `mcp`
  map with `github`, `playwright`, and `playwright_headless`; all three connect
  under v2. `opencode debug config` confirms only the pilot config is loaded.
- **MCP shape:** v2.0.7 uses the flat `mcp` map. Two blockers found:
  - the documented `mcp.servers` nesting registered no server in 2.0.7;
  - a numeric `"timeout": 30000` silently dropped the whole MCP block. The v2
    `timeout` is an object (`{ startup, catalog, execution }`), not a number.
- **Skills:** `opencode api skill.list` returned 19 entries: 2 built-in
  (`opencode`, `report`), the 16 repo skills, and an unintended `README` skill.
  v2 discovers root-level `*.md` files in a skills source, so pointing `skills`
  at the repo `skills/` directory also picks up `skills/README.md`. **Resolved
  in Phase 4:** the v2 config no longer points at the repo skills root; the
  config-dir `skills/` source holds one symlink per skill and discovers exactly
  the 16 skills (18 with the two built-ins). The v1 deployed
  `~/.config/opencode/skills/` is already README-free, so cutover needs no
  change there.
- **Commands:** `opencode api command.list` returned 8 entries: the 4 built-in
  plus `deploy`, `handoff`, `promote-skills`, and `resume` discovered from the
  pilot `commands/` directory. The bodies still reference v1 paths.
- `cli.json` was seeded from the v1 `kv.json`: `animations`, `session.sidebar`,
  `session.thinking`, `session.scrollbar`, and `diffs.wrap`. The v1 theme name
  `opencode` has no verified v2 equivalent, so `theme` was omitted pending
  validation. The v1 keys `timestamps`, `tool_details_visibility`,
  `assistant_metadata_visibility`, and `generic_tool_output_visibility` have no
  documented `cli.json` equivalent.
- Plugin registration is deferred to Phase 2: the v1 server plugin
  (`codex-fallback`) and TUI plugins do not load in v2.

## Phase 2 results (2026-09-18, in progress)

Workspace: `platforms/linux/ubuntu/computer-use/plugins-v2/` holds one package per
plugin (`rig-tools`, `codex-fallback`, `codex-usage`, `file-manager`,
`source-control`), a shared `tsconfig.base.json`, and one hoisted
`node_modules`. Each package declares `exports["./server"]` or
`exports["./tui"]` plus a root `server.ts` or `tui.tsx` shim.

Registration finding: v2 registers **server** plugins from the `plugins` array
in `opencode.jsonc` and **CLI** plugins from the `plugins` array in `cli.json`.
A bare string is treated as an npm package and v2 tries to install it from the
registry, so local packages use the object form
`{ "package": "<absolute directory>", "options": {} }`; the loader resolves
`<dir>/server.ts` and `<dir>/tui.tsx`, which is why the root shims exist.

Ported and verified in the v2.0.7 pilot:

- **rig-tools** (server): registers `desktop_apps`, `desktop_tree`,
  `desktop_find`, `desktop_act`, and `vision_capture` through
  `ctx.tool.transform`. The desktop tools wrap `scripts/desktop-control.py`;
  `vision_capture` returns the PNG as `{ type: "file", uri: "data:..." }`.
  Typecheck plus 20 tests pass, and the five tools appear live in the v2
  session's tool list.
- **codex-fallback** (server): routes requests through
  `ctx.session.hook("context")` and `ctx.session.hook("retry")`, reusing the v1
  chain, failure detector, state store, and quota checker. Because v2 exposes
  no raw config, per-agent `codexFallback` overrides move to the plugin options
  `agents` map, and server plugins have no TUI toast, so routing is logged.
  Typecheck plus 27 tests pass; the plugin loads with its stable id.
- **codex-usage** (CLI): `sidebar.content` quota panel plus
  `refresh`/`details` keymap commands, using `ctx.storage.store` for the
  collapsed flag and `ctx.data.session.message`/events for the active model.
  Typecheck plus 8 tests pass; the plugin loads.
- **file-manager** (CLI): a docked `session.panel` tree/viewer/editor opened
  with `ctx.ui.panel.open`, `toggleFullscreen` on `f`, an Explorer
  `sidebar.content` row, and a `ctrl+shift+e` / `/files` command. v2's
  `file.list`/`file.find` return `{ path, type }` only, so the node name and
  absolute path are derived and the v1 `ignored` flag is unavailable.
  Typecheck plus 11 tests pass; the plugin loads.
- **tui-settings**: retired. v2's built-in `/settings`
  (`opencode.settings`) already covers theme, display, plugins, and keybinds,
  so only the v1 harness-specific Source Control presets remain to be folded
  into the v2 source-control plugin.
- **CLI keymap gotcha:** v2.0.7 throws `Keymap.Provider is missing` when a CLI
  plugin calls `context.keymap.layer(...)` directly in `setup`. Register the
  layer inside a slot render instead (for example an `append: "app"` slot that
  returns `null`), which runs under the host's keymap provider. Without this,
  the whole plugin setup fails and its sidebar panel and commands silently
  disappear.

Remaining in Phase 2: none. `source-control` landed as the last port, and the
per-plugin test totals are rig-tools 20, codex-fallback 27, source-control 20,
codex-usage 8, file-manager 11 (86 total), all through the bounded resource
guard. Phase 4 has begun: `check-plugin-resource-guards.py` also scans
`plugins-v2/`, and `documentation-map.json` maps the v2 workspace to
`plugins-v2/README.md`.

Still to do in Phase 4: v2 deploy tooling (`deploy-plugins.sh` v2 mode and/or
`setup-opencode-v2.sh`), the `verify-opencode-v2.sh` health check, rewriting the
four global command bodies for v2, the `AGENTS.md` v2 section, and CI coverage
for `plugins-v2`. The tui-settings presets are folded into v2 `source-control`
(`plugins-v2/source-control/README.md`), the stray `README` skill is resolved
via the config-dir symlink source, and the `rig-todo` plugin restores
`todowrite`/`todoread`. Phase 5 (full health check and PATH cutover with v1
rollback) stays pending explicit approval; v1 remains the default.

## Phase 4 results (2026-09-18)

- `rig-todo` added as the sixth v2 package: `todowrite`/`todoread` are live in
  the pilot (v2.0.7 ships neither), with session-scoped storage and the
  one-in-progress invariant.
- CLI keymap fix: `context.keymap.layer(...)` is registered inside an
  `append: "app"` slot render in `source-control`, `codex-usage`, and
  `file-manager`; direct calls threw `Keymap.Provider is missing` in 2.0.7 and
  aborted the whole plugin setup.
- Skills: the v2 source is the config-dir `skills/` symlink farm (16 links), so
  discovery returns exactly the 16 skills plus the 2 built-ins, with no stray
  `README` skill. The v1 deployed `~/.config/opencode/skills/` is already
  README-free.
- `cli.json` adds `prompt.paste: "full"` and `session.image_preview: true`.
  `theme` stays at the v2 default (the v1 `opencode` theme has no v2
  equivalent); `timestamps`, `tool_details_visibility`,
  `assistant_metadata_visibility`, and `generic_tool_output_visibility` remain
  unmappable.
- tui-settings presets are folded into v2 `source-control` as plugin options;
  the v1 slot-order override is retired (v2 has no per-slot `order`).
- **Visual parity confirmed by resolved tokens.** v1's default `opencode` theme
  is the Aura palette; v2's built-in `opencode` theme is different (accent
  white, not purple). Setting `cli.json` `theme.name = "aura"` makes the v2
  tokens equal the v1 values: text `#edecee`, subdued `#6d6d6d`, warning
  `#ffca85`, info `#a277ff`, added `#61ffca`, removed `#ff6767`, border
  `#2d2d2d`, background `#0f0f0f`. v1's `accent` (`#a277ff`) maps to
  `theme.hue.accent[200]` because v2's `text.action.primary.default` is a
  high-contrast foreground; `source-control` and `file-manager` now use it.
- v2 config examples added at
  `config/v2-opencode.example.jsonc` and `config/v2-cli.example.json`.
  **Playwright is one MCP in v2**: only the live visible
  `playwright-mcp.sh` is registered; headless-only work runs through the
  repository Playwright runtime from the shell. The repo project config keeps
  the two v1 MCPs until cutover.
- `verify-opencode-v2.sh` adds a read-only v2 health check (binary, config, 16
  skills, commands, six plugins, single-Playwright assertion, aura theme) that
  never connects an MCP.
- A1 restart verification: the fresh v2.0.7 start produced no
  `Keymap.Provider is missing` errors, `plugin list` shows all six local
  plugins, and the command catalog includes `deploy`, `handoff`,
  `promote-skills`, and `resume`.
- A8 CI coverage: `.github/workflows/verify.yml` installs the `plugins-v2`
  workspace with `npm ci --ignore-scripts` and runs the six bounded package
  checks. `rig-todo` was added to the workspace list and lockfile so CI and
  local checks cover the same six packages.
- A7 deploy tooling: `setup-opencode-v2.sh` links the 16 skill bundles,
  deploys the four commands, seeds `opencode.jsonc`/`cli.json` only when
  missing, refuses the v1 config directory without an explicit override, and
  delegates the pilot health check to `verify-opencode-v2.sh`.
  `deploy-plugins.sh --v2` registers `all`, `server`, `cli`, `both`, or one of
  the six packages as object entries in the v2 config (server plugins in
  `opencode.jsonc`, CLI plugins in `cli.json`), preserves existing options,
  and rejects `--scope project`/`--bootstrap`. Both were exercised against a
  disposable config directory (seed, link, register, idempotent re-run).
- A6 commands: the four global commands are stack-aware - they detect the v2
  pilot and use `verify-opencode-v2.sh`, `setup-opencode-v2.sh`, and
  `deploy-plugins.sh --v2`, falling back to the v1 paths otherwise.
- Still remaining: the `AGENTS.md` v2 section, then Phase 5 cutover. After
  cutover, the queued pre-migration work (desktop window/input tools and
  Basic Memory M1-M4).

## Phase 5 results (2026-09-18, partial)

C1-C3 passed in the live pilot: both v2 health checks are green; all six
plugins load; the four commands and the 16 repo skills (plus 2 built-ins) are
discovered; both todo tools, `desktop_apps`, and `vision_capture` were
exercised (the capture attachment arrived and its PNG was deleted); the docked
Files panel, the Source Control row with real worktree data, the connected
`github` MCP row, and the `Explorer` row were confirmed by screenshot; and a
GitHub MCP read plus one approved write (PR #2 comment 5725307311) succeeded.
OpenAI OAuth is not mapped in the pilot. B2's remaining pieces (the single
Playwright MCP registration and the `browser-headless` text) landed with the
cutover, which is recorded below.

## Cutover executed (2026-09-18)

- Shim: `~/.local/opt/opencode-v2/bin/opencode` execs `opencode-pilot`, so v2
  starts with the isolated config/data/state/cache under `~/.opencode-v2-pilot/`.
- PATH: a managed block appended to `~/.bashrc`
  (`export PATH="$HOME/.local/opt/opencode-v2/bin:$PATH"`) after the existing
  `~/.opencode/bin` entry, so new login shells resolve v2 first.
- Config: the pilot `opencode.jsonc` gained the single live `playwright` MCP;
  the running service reconciled it without a restart, and `opencode mcp list`
  shows `github` and `playwright` connected (no `playwright_headless`).
- Smoke test through a new login shell: `opencode --version` reports v2.0.7;
  18 skills (16 repo + 2 built-ins); the four global commands; both MCPs. The
  v1 binary and config hashes are unchanged and recorded at
  `~/.opencode-v2-pilot/cutover-v1-hashes.txt`.
- The repo project `opencode.json` is still v1-shaped and is not read by v2
  (`opencode-pilot` sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`); translating it
  is post-cutover tidy (C5).

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

v1 stays installed and configured throughout, so rollback never depends on
rebuilding anything.

Cutover (Phase 5, explicit approval only):

1. Confirm the v2 health check and live plugin verification pass.
2. Keep the v1 binary (`~/.opencode/bin/opencode`) and the v1 config directory
   (`~/.config/opencode/`) exactly as they are. Record their current hashes.
3. Point the default `opencode` on `PATH` at the v2 binary (for example, a
   `~/.local/bin/opencode` shim or a `PATH` entry ahead of `~/.opencode/bin`),
   and start v2 with its own config directory. v2 must not read the v1 config
   until the config is translated and the operator accepts the one-time
   translation.
4. Smoke test: version, skills (16), commands (4), six plugins, both todo tools,
   the desktop/vision tools, and one MCP read.

Revert (any time, minutes):

1. Remove the marked `opencode v2 cutover` PATH block from `~/.bashrc` (or
   remove the shim at `~/.local/opt/opencode-v2/bin/opencode`); new shells then
   resolve `~/.opencode/bin/opencode` (v1) first again.
2. v1's binary and config were never moved or changed; compare them against
   `~/.opencode-v2-pilot/cutover-v1-hashes.txt` to confirm.
3. Open a new shell and verify: `opencode --version` reports 1.18.31, then run
   `setup-computer-assistant.sh --verify-only`.
4. Optionally remove the added `playwright` entry from the pilot config; v1
   never reads that directory.

The v2 config lives in an isolated directory until the final step, and v1's
config, database, and kv are never modified by migration work, so the revert is
a `PATH` change plus an optional config restore.
