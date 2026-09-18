# OpenCode v2 Session Handoff

Use this to continue the v2 port **inside OpenCode v2 itself**, where the pilot
can load and exercise the plugins being ported.

## Open v2

Close the v1 OpenCode session first (it holds the 4 GB `opencode.db` and the
MCP child processes). Then open a terminal and run the one-command launcher:

```bash
oc2
```

`oc2` (`~/.local/bin/oc2`) cd's into the repository and starts the pilot with a
prompt that reads this handoff and begins the migration work.

The launcher runs the isolated pilot:

- binary `~/.local/opt/opencode-v2/opencode` (v2.0.7)
- config `~/.opencode-v2-pilot/config/` (`opencode.jsonc`, `cli.json`, `commands/`)
- data/state/cache/db under `~/.opencode-v2-pilot/`
- `OPENCODE_DISABLE_AUTOUPDATE=1`

Provider credentials: the pilot wrapper exports API-key credentials from the v1
store (`~/.local/share/opencode/auth.json`) as `<PROVIDER>_API_KEY`. DeepSeek
therefore works automatically and is the pilot's default model
(`deepseek/deepseek-v4-flash`), verified with a live call. The v1 OpenAI
credential is OAuth and is not mapped; connect it once in the v2 TUI with
`/connect` if OpenAI models are needed. The `oc2` launcher restarts the pilot
service so it inherits the exported keys.

To stop the pilot's background service after a session:

```bash
for pid in $(ps -eo pid,cmd | grep "\.local/opt/opencode-v2/opencode serve" | grep -v grep | awk '{print $1}'); do kill "$pid"; done
```

## Copy-paste prompt

```text
Continue the OpenCode v2 migration for the opencode-rig repository.

Repo: ~/repos/opencode-rig, branch migration/opencode-v2.
Read first: docs/migration/opencode-v2.md (plan plus the recorded Phase 0 and
Phase 1 results).

You are running inside the OpenCode v2 pilot, so v2 plugins can be loaded and
tested live. v1 is the production harness and must not be modified:
~/.config/opencode, ~/.local/share/opencode (a 4 GB opencode.db), and the v1
processes.

Memory is tight (about 7 GiB total). Rules:
- never run npm install, tsc, or tests outside
  platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh;
- do not start MCP servers that launch Firefox (keep the pilot MCP list to
  lightweight servers);
- stop the v2 background service when a run is done.

Current state:
- Phase 0: v2.0.7 installed at ~/.local/opt/opencode-v2/ with the
  opencode-pilot launcher; all state isolated under ~/.opencode-v2-pilot/;
  v1 untouched.
- Phase 1: pilot config translated - flat `mcp` map (v2.0.7 ignores the
  documented `mcp.servers` nesting and silently drops the whole MCP block on a
  numeric `timeout`; use an object), skills pointed at the repo skills, the
  four global commands copied in, `cli.json` seeded from v1 kv.
- Phase 2 (in progress): plugins-v2/ workspace exists with five package
  manifests (codex-fallback, codex-usage, source-control, file-manager,
  rig-tools), a shared tsconfig.base.json, and one installed node_modules at
  plugins-v2/ (391 packages). Plugin sources are not written yet.
- tui-settings is redundant in v2: the built-in `/settings`
  (`opencode.settings`) already covers theme, display, plugins, and keybinds.
  Retire it and fold its Source Control presets into the source-control plugin.

v2 API facts already verified:
- CLI plugin: `import { Plugin } from "@opencode/plugin/tui"` and
  `export default Plugin.define({ id, setup(context) })`; context has
  `ui.slot`, `ui.panel`, `ui.dialog`, `ui.router`, `ui.toast`, `keymap`,
  `storage`, `client`, `data`, `theme`, `renderer`.
- Slots: `sidebar.content` `{ sessionID }`, `session.panel` (PanelInput with
  `name`, `sessionID`, `width`, `presentation: "panel" | "fullscreen"`,
  `focused`, `focus`, `close`, `toggleFullscreen`), `app`, `prompt.footer*`,
  `session.composer.top`.
- Server plugin: `import { Plugin } from "@opencode/plugin"` with
  `ctx.tool.transform((editor) => editor.add({ name, description, input,
  execute }))`, `ctx.session.hook("context" | "retry" | ...)`, `ctx.storage`,
  `ctx.location`, `ctx.vcs`, `ctx.session`.
- Tool results: `{ content, output?, metadata? }`; images use
  `{ type: "file", uri: "data:...", mime }`.

Phase 2 order and goals:
1. rig-tools (server): register desktop_apps, desktop_tree, desktop_find,
   desktop_act, and vision_capture via `ctx.tool.transform`, wrapping
   scripts/desktop-control.py and the ydotool screenshot path from
   tools/vision.ts. Return screenshots as file content.
2. codex-fallback (server): port the failover chain to v2 session hooks and
   `ctx.session.switchModel` / `ctx.session.prompt`; follow
   https://opencode.ai/v2/docs/build/plugins/migrate-v1.
3. source-control (CLI): port the working-tree/PR panel to a `sidebar.content`
   slot using `client.vcs` / `data.location.vcs`.
4. codex-usage (CLI): port the weekly quota panel to a `sidebar.content` slot.
5. file-manager (CLI): port the tree/viewer/editor to a `session.panel`
   contribution opened with `ui.panel.open`, using `toggleFullscreen` for
   dock/undock.
6. Retire tui-settings; update cli.json and pilot config registration.

Then Phase 4 (scripts, health checks, docs, AGENTS, HANDOFF, documentation
map) and Phase 5 (verification and cutover with v1 rollback) from the plan.

Keep v1 as the default and untouched; commit only v2 work on the migration
branch; report what changed and what passed.
```

## Notes for the operator

- The pilot's `opencode.jsonc` currently configures only the lightweight
  `github` MCP; the playwright entries were removed to avoid Firefox memory
  spikes.
- `plugins-v2/node_modules/` is generated; it is excluded from Git.
- v1 and v2 cannot share `~/.config/opencode/opencode.jsonc` (incompatible
  schemas). Do not point v2 at the v1 config directory until cutover.
