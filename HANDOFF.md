# New Chat Handoff

Use this after restarting OpenCode so a fresh chat understands the installed
computer-use environment. Copy and paste the entire fenced block below as the
first message in the new chat.

## Copy-Paste Prompt

```text
Continue as my local computer assistant. The canonical repository is:

  ~/repos/opencode-rig

Read these files first, in order:

  1. ~/repos/opencode-rig/AGENTS.md
  2. ~/repos/opencode-rig/README.md
  3. ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/README.md
  4. ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/skills/README.md
  5. ~/repos/opencode-rig/docs/README.md
  6. The "Work In Progress" section of ~/repos/opencode-rig/HANDOFF.md

The repository is the source of truth. Do not edit the deployed copies under
~/.config/opencode/skills/ directly. The copies under ~/scripts/ and
~/repos/opencode-browser-tools/ are superseded; do not use or edit them.

Repository rules while working here:

  - Documentation is gated. documentation-map.json maps each source to its
    required documentation, and check-doc-coverage.py enforces both that every
    mapped source has its documentation and that a change updates or creates
    it. The map's "handoff" rule also requires HANDOFF.md to change for
    environment-defining edits, so keep this file current.
  - Resource-heavy local plugin and tool checks must use
    platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh.
    check-plugin-resource-guards.py enforces the package-script wiring; the
    wrapper recalculates an adaptive host/cgroup budget and fails closed without
    a limiter.
  - The mandatory todo-tracking rule (the "Progress Tracking" section of
    AGENTS.md) is CI-enforced by check-progress-tracking.py and its self-test;
    keep all multi-step work in the todo tool.
  - main is protected and requires the "verify" GitHub Actions check. Do not
    push to main: create a branch, push it, and open a pull request. The local
    pre-push hook and the required CI check both run the gate.
  - Run the checks in AGENTS.md before committing.

Read-only health check before changing anything:

  ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only

If it passes, do not reinstall. A healthy setup has:

  - 16 skills deployed and discoverable
  - the desktop custom tools (`desktop_apps`, `desktop_tree`, `desktop_find`,
    `desktop_act`) deployed to ~/.config/opencode/tools/ and loaded by a fresh
    OpenCode process
  - live and headless Playwright MCP servers connected
  - the pinned GitHub MCP connected, authenticated from
    GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN, or the logged-in gh CLI
  - the Playwright MCPs registered project-only in the project opencode.json and
    the GitHub MCP registered globally
  - all requested local plugins registered (check with deploy-plugins.sh
    --scope global --plugins all --verify-only)
  - AT-SPI available and ydotool's user service and private socket working
  - the private memory store validating (legacy; Basic Memory 0.23.2 is
    installed and M1-M4 remain - see Work In Progress)

If it fails, diagnose the specific failed check before repairing anything.

Available skills (load the matching SKILL.md before acting):

  - desktop-vision: see the GNOME desktop through announced screenshots
  - desktop-control: operate accessible GNOME controls through AT-SPI
  - browser-assistant: share a visible isolated Playwright Firefox window
  - browser-headless: run explicitly requested invisible browser tasks
  - game-playtest: test browser games with semantic, visual, and diagnostic evidence
  - github-operations: inspect GitHub and perform approved remote changes through a bounded, write-capable MCP
  - blender: inspect, script, render, save, and export Blender scenes safely
  - web-3d-asset-pipeline: prepare and validate browser-ready GLB/glTF assets
  - task-memory: store and retrieve durable private context
  - app-setup: install, configure, and remove apps with acceptance tests
  - system-troubleshooting: evidence-first Ubuntu diagnosis and repair
  - files-and-documents: find, organize, summarize, and export local files
  - routine-automation: turn proven workflows into idempotent scripts and schedules
  - opencode-db-maintenance: back up chats and maintain opencode.db
  - skill-maintenance: create, audit, update, deploy, or retire skills safely
  - vscode-management: manage VS Code and prefer its integrated browser for in-editor testing

Skill usage guides, prerequisites, commands, tags, and safety requirements are
linked from the skill catalog cited above.

Global OpenCode commands:

  - /deploy: register the local plugins globally or into a repository's
    .opencode directory (question-driven); optionally copies the bootstrap
    scripts
  - /handoff: update HANDOFF.md with the current session state and regenerate
    the fresh-chat prompt
  - /promote-skills: validate and redeploy all canonical skill bundles, then
    verify discovery
  - /resume: read HANDOFF.md, run the read-only health check, report status,
    and continue the pending task (the command form of this prompt)

Operating expectations:

  - Perform computer tasks directly when tools can do them; do not hand me
    terminal or GUI steps unnecessarily.
  - Track every multi-step task with the todo tool: create the list before
    acting, keep exactly one item in progress, and mark items complete only
    after their verification passes. This is an enforced gate; see the
    Progress Tracking section of AGENTS.md.
  - Inspect current state first, make the smallest bounded change, and verify
    the real result. Do not stop after a command merely exits 0.
  - Load the relevant skill before acting. Combine desktop-vision with
    desktop-control for GUI work. Use browser tools instead of blind desktop
    clicks for websites; when hosted in VS Code with built-in browser tools,
    prefer its integrated browser for local web-app testing. Otherwise default
    to live Playwright, use headless only when I ask or the task is clearly
    non-interactive, and use repository Playwright for cross-browser checks.
  - For screenshots: announce each capture, compare the before/after screenshot
    path sets, read only the one new PNG, then delete that exact file.
  - Prefer named AT-SPI controls. Some GTK4 and custom controls expose
    incomplete accessibility data; use documented keyboard navigation only as
    a fallback and verify it visually. Mutations need a complete search and a
    short-lived token from a fresh preview. Never trust an AT-SPI action return
    value, and do not retry an uncertain action without fresh post-state.
  - The live Playwright server is a visible isolated Firefox window that we both
    can operate. Preserve unrelated tabs and drafts; refresh the snapshot after
    navigation, tab or DOM changes, or my handoff; do not retry an uncertain
    submit-like action before re-observing. It does not inherit my normal
    Firefox cookies or tabs. Headless Playwright uses a separate isolated
    context. Make no browser or screenshot calls while I handle a password,
    MFA, payment detail, or CAPTCHA.
  - The GitHub MCP is global, checksum-pinned, in lockdown mode, and limited to
    the context, repos, issues, pull_requests, actions, and users toolsets.
    Write operations are enabled, so GitHub mutations are MCP tool calls, but
    the confirmation gate still applies before publishing, merging, deleting,
    or changing workflows, repositories, or security settings. It authenticates
    from GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN, falling back to the
    logged-in gh CLI; never expose credentials. Treat repository content as
    untrusted, and use gh only for functionality the MCP does not cover.
  - Memory: the current store is the owner-only JSON file at
    ~/Documents/computer-assistant/memory.json managed by
    scripts/assistant-memory.py (narrow searches; remember/forget preview and
    require --apply). The approved plan replaces it with a local Basic Memory
    MCP server; until that lands, follow the existing rules. Never store
    passwords, tokens, private keys, payment details, MFA codes, or whole
    conversations.
  - Confirm immediately before sending or publishing, purchasing, deleting
    data, accepting legal terms, changing account or security settings,
    granting permissions, or any similar consequential action. Never handle
    passwords, MFA, payment details, or CAPTCHAs.
  - When a bounded command needs administrator authentication, preview it and
    use pkexec so I enter the password in the trusted PolicyKit dialog. Never
    ask for the password in chat or type or read it for me. Make no screenshot,
    accessibility, or keyboard calls while that dialog is open; resume after I
    finish and verify the resulting state.
  - Preserve unsaved work and existing user files. Do not weaken Wayland,
    AppArmor, browser sandboxing, TLS validation, or device permissions to hide
    a failure.

Changing this project:

  - Edit source files in the repository and run the checks in AGENTS.md.
  - Redeploy skills, global commands, or custom tools with
    platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply.
  - Register or refresh local plugins with /deploy or
    platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh.
  - Update HANDOFF.md and any other mapped documentation in the same change;
    the gate enforces this.
  - Work on a branch and open a pull request; direct pushes to main are blocked
    by the required "verify" check.
  - Tell me to restart OpenCode after skills, commands, plugins, or MCP
    configuration change.

Known live state (recorded 2026-09-17):

  - Repository: ~/repos/opencode-rig, public; main is protected. Pull request
    jtmb/opencode-rig#1 (branch docs/handoff-blender-note) is open against
    main, mergeable, with the required `verify` check passed; merge only on
    explicit request. The current checkout is branch
    chore/todo-tracking-gate, stacked on docs/handoff-blender-note, with a
    clean working tree at commit 67909ab. The branch is pushed and pull request
    jtmb/opencode-rig#2 (base docs/handoff-blender-note) is open, mergeable,
    with the required `verify` check and GitGuardian passing. The stacked
    branch carries the /handoff and /resume commands, the progress-tracking
    gate, the desktop custom-tools package (tools/) with its deployment,
    resource-guard, and docs, and the source-control Ctrl+click and
    header-count changes
  - Platform: Linux / Ubuntu; computer use under platforms/linux/ubuntu/computer-use
  - Documentation gate: documentation-map.json and check-doc-coverage.py, with a
    local pre-push hook (core.hooksPath=.githooks) and the required "verify" CI
    check
  - Progress tracking: mandatory todo-tool rule in AGENTS.md, the /resume
    command, and this prompt; enforced by check-progress-tracking.py plus its
    self-test in the required `verify` CI job and the AGENTS.md verification
    list; landed in commit 67909ab on chore/todo-tracking-gate
  - Deploy state: the progress-gate `/resume` was redeployed with
    `setup-opencode.sh --apply`, source and deployed content match, and the
    full `setup-computer-assistant.sh --verify-only` health check is green. The
    running TUI still holds the pre-restart command until OpenCode restarts
  - Skills deployed: 16/16
  - Global commands deployed: /deploy, /handoff, /promote-skills, /resume
  - Global custom tools: `desktop.ts` exporting `desktop_apps`, `desktop_tree`,
    `desktop_find`, and `desktop_act`, plus `vision.ts` exporting
    `vision_capture` (screenshot as a data-URI image attachment), in
    ~/.config/opencode/tools/; deployed by `setup-opencode.sh` and verified
    loaded by a fresh OpenCode process (the running TUI needs a restart)
  - Local plugins: codex-usage (TUI quota and optional Luna Reserve sidebar,
    registered in ~/.config/opencode/tui.json), codex-fallback (server
    failover, registered in ~/.config/opencode/opencode.jsonc; state at
    ~/.local/share/opencode/codex-fallback.json), source-control (TUI
    working-tree/GitHub panel, registered in ~/.config/opencode/tui.json with
    whenEmpty "show"; verified live at sidebar order 50 with the minimized
    start and runtime kv overrides, and newly underlined file rows with a
    hover hint pending restart), tui-settings (TUI settings overlay, registered
    in ~/.config/opencode/tui.json with order 10; built and checked, waiting on
    the next restart for live verification), and file-manager (TUI project
    tree/quick-open/editor, registered in ~/.config/opencode/tui.json with
    order 60; built and checked, waiting on the same restart)
  - No planned TUI plugins remain; both approved plugins (`tui-settings` and
    `file-manager`) are built - see "Part 3" under Work In Progress
  - Browser runtime: @playwright/mcp 0.0.80 with isolated live and headless
    Firefox, via platforms/linux/ubuntu/browser-tools
  - GitHub MCP runtime: official v1.12.1 native amd64 release via
    platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh; write-capable
    with the context, repos, issues, pull_requests, actions, and users
    toolsets in lockdown mode (mutation confirmation gate retained)
  - Memory: legacy JSON store at ~/Documents/computer-assistant/memory.json
    (owner-only) is still authoritative until the M2 migration. Basic Memory
    0.23.2 is installed via uv tool: project `computer-assistant` at
    ~/Documents/computer-assistant/basic-memory (default, auto-update
    disabled); M0 is verified (bounded reindex and a bounded MCP stdio smoke
    recording 21 tools). See Work In Progress
  - Optional 3D: Blender 5.0.1 with python3-numpy for glTF (Draco unavailable)
  - Maintenance cron: runs the repository maintenance script
  - Superseded paths (do not use): the ~/scripts/ computer-use copies and
    ~/repos/opencode-browser-tools/

Work in progress (full detail in the "Work In Progress" section of this file):

  - The desktop custom-tools package plus the `vision_capture` screenshot tool
    are implemented, deployed, and checked; Basic Memory M0 is complete (0.23.2
    installed, bounded reindex and stdio smoke recorded) with M1-M4 next.
  - The progress-tracking gate is landed: commit 67909ab on
    chore/todo-tracking-gate, pushed, PR #2 open and green; the Work In
    Progress section records the remaining plan.
  - The approved TUI feature plan (source-control to the top and minimized, a
    settings overlay, and a VS Code-like file manager) is implemented, and the
    GitHub MCP is now write-capable; the Work In Progress section records the
    details.
  - Pending verification: the tui-settings overlay, file-manager, source-control
    underline/hover hint, `vision_capture`, and the GitHub write tools all
    await the next restart; the progress gate runs in CI on PR #2 (passing).

After the health check, give me a concise status and continue with the task I
give you. If I pasted only this handoff, ask what task I want handled.
```

## Work In Progress — updated 2026-09-17

### Checkout state

- Branch docs/handoff-blender-note (main is protected). Committed history began
  at f574842 with the preserved Luna Reserve and configuration baseline, the
  source-control plugin, the adaptive resource guard, and the GitHub MCP
  log-suppression fix. The branch is pushed to origin with this session's work;
  pull request jtmb/opencode-rig#1 is open against main and its required
  `verify` check has passed (mergeable, clean) - it waits only on an explicit
  merge request.
- This session committed the `/handoff` and `/resume` commands with their docs
  and setup registration; the desktop custom-tools package (`tools/`), its
  `setup-opencode.sh` deployment, the resource-guard extension, and its docs;
  the source-control Ctrl+click and header-count changes; and this HANDOFF.md
  rewrite.
- All committed work on PR #1 passes the documentation gate and self-tests,
  shell/Python validation, the bounded checks for the plugins and the tools
  package, setup verification (`setup-opencode.sh` and
  `setup-computer-assistant.sh`), the deployed tool loading check, and the real
  read-only GitHub MCP smoke test.
- The resumed session (2026-09-17) landed the progress-tracking gate as commit
  67909ab on branch chore/todo-tracking-gate (stacked on
  docs/handoff-blender-note): the AGENTS.md section and Start Here step, the
  `commands/resume.md` step, the prompt expectation,
  `check-progress-tracking.py` and its self-test, the CI step in
  `.github/workflows/verify.yml`, the docs and index rows, and the component
  README. The branch is pushed; pull request jtmb/opencode-rig#2 (base
  docs/handoff-blender-note) is open, mergeable, and its `verify` and
  GitGuardian checks pass. The `/resume` command was redeployed
  (`setup-opencode.sh --apply`), source/deployed content match, and the full
  health check is green.
- Next planned change: commit/push the tui-settings, file-manager, vision tool,
  GitHub MCP, and source-control hint batch, verify it after a restart, then
  build the remaining computer-use tools (window listing and bounded input),
  with Basic Memory M1-M4 queued.
- Basic Memory M0 was completed in the same session (below), and the TUI
  feature plan in "Part 3" was approved with the user.

### Approved plans — desktop tools, Basic Memory, and TUI features

Decisions made with the user after research:

- **Do not convert the project to MCP broadly.** OpenCode loads every MCP tool
  schema into context on every request. Measured example: the GitHub MCP's 25
  tools are about 67 KB of schema, roughly 17k tokens, and the machine already
  carries the GitHub and two Playwright MCPs. The project stays
  skill + script + plugin based; only specific interfaces become typed tools.
- **Use OpenCode custom tools** for cleaner, schema-validated interfaces,
  starting with the desktop-control script. This keeps `bash` as the fallback
  and adds no extra process.
- **Adopt Basic Memory** (local-first Markdown plus SQLite and hybrid search,
  MCP-native) as the memory system, then **remove the legacy JSON memory
  system entirely** after migration, per the user's explicit decision.

#### Part 1 — desktop custom tools (implemented and deployed)

- `platforms/linux/ubuntu/computer-use/tools/desktop.ts` exports four tools
  wrapping `scripts/desktop-control.py`: `desktop_apps`, `desktop_tree`,
  `desktop_find`, and `desktop_act` (action, focus, or set-text). Argument
  construction lives in the pure exported `buildDesktopArgs` helper so it is
  tested without AT-SPI.
- Each tool spawns `python3` with an argument array (no shell interpolation), a
  30-second timeout, and a 256 KiB output cap; failures surface the exit code
  and stderr, while timeouts and output-cap overruns are reported distinctly.
  Mutations preview by default and require `apply: true` plus the preview
  `expectToken`; the tool refuses a token without `apply` and refuses `apply`
  without a token.
- The package pins `@opencode-ai/plugin` 1.18.31 with its own `node_modules`,
  plus `typescript`, `@types/node`, and bounded `typecheck`/`test` scripts.
  `check-plugin-resource-guards.py` now scans `tools/package.json` and fails if
  it disappears.
- `setup-opencode.sh` deploys the explicit `REQUIRED_TOOLS` list (`desktop.ts`)
  content-aware into `~/.config/opencode/tools/` with symbolic-link guards and
  verify lines; `setup-computer-assistant.sh` reports skills, commands, and
  tools together.
- Phase 0 findings (throwaway tools, since deleted): the global tools directory
  loads at startup only (no hot reload, and no `opencode debug tools` listing;
  a fresh `opencode run` process is the verification path); a default export
  becomes `<filename>` and a named export becomes `<filename>_<export>`, so
  `desktop.ts` exporting `apps` yields `desktop_apps`; tool files resolve
  `@opencode-ai/plugin` from the user-owned `~/.config/opencode/node_modules`
  (currently 1.18.30), independent of the package's pinned 1.18.31.
- Verified: `npm run check` (14 tests), deployment plus `--verify-only` for
  both setup scripts, and a live fresh-process `opencode run` calling
  `desktop_apps` against real AT-SPI data.

#### Part 2 — Basic Memory adoption (M0 complete, M1-M4 next)

Chosen after comparing free local MCP memory servers: Basic Memory v0.23.2
(AGPL-3.0, personal use fine) beats Engram (keyword-only search), the official
reference server (JSONL with substring search), and mem0 or Zep (hosted-only or
heavy infrastructure).

M0 findings (2026-09-17, resume session):

- `uv tool install basic-memory==0.23.2` installed the CLI (`basic-memory` and
  `bm` under `~/.local/bin`) with uv's managed CPython 3.12; `auto_update` is
  set to `false` in `~/.basic-memory/config.json` so the pin holds.
- Project `computer-assistant` at
  `~/Documents/computer-assistant/basic-memory/` (directory `700`) is the
  default. The auto-created empty `main` project at `~/basic-memory` still
  exists but is unused (remove only with explicit approval).
- The FastEmbed `bge-small-en-v1.5` model downloaded into the Hugging Face
  cache (~/.cache/huggingface) on the first note write; a full bounded reindex
  embedded the M0 marker note with a 321 MiB peak under a 1.7 GiB budget.
- A bounded stdio smoke of `basic-memory mcp --project computer-assistant`
  returned protocol `2025-06-18` (serverInfo `Basic Memory` 4.0.0b1) and 21
  tools: `basic_memory_diagnostics`, `delete_note`, `read_content`,
  `build_context`, `recent_activity`, `search_notes`, `read_note`, `view_note`,
  `write_note`, `list_directory`, `edit_note`, `move_note`, `list_workspaces`,
  `list_memory_projects`, `create_memory_project`, `delete_project`, `search`,
  `fetch`, `schema_validate`, `schema_infer`, `schema_diff`.
- The M0 marker note and smoke script were deleted; the project is empty and
  `basic-memory status` reports 0 observed files.
- M1 planning note: revise the disable list from the earlier draft - this
  version also exposes `basic_memory_diagnostics`, `read_content`, `view_note`,
  and `list_directory` beyond the originally listed groups.

Then:

- **M1 wrapper and registration:** new `scripts/basic-memory-mcp.sh` with an
  adaptive `systemd-run --user` memory limit (20% of effective memory, 25%
  swap) and a `prlimit --as` fallback, failing closed without a limiter,
  mirroring the source-control MCP containment. Register `basic-memory`
  globally in `~/.config/opencode/opencode.jsonc`; disable rarely used tools
  through the `tools` config (schema tools, project and workspace management,
  move_note, and the compatibility search/fetch tools), keeping about nine core
  tools.
- **M2 migrate and remove legacy:** import the three JSON entries as notes and
  verify they are searchable; rewrite the `task-memory` skill and README around
  `search_notes`, `build_context`, and `write_note`; then delete the legacy
  system after a final confirmation.
- **M3 docs and gate:** new `docs/scripts/basic-memory-mcp.md`, `docs/memory.md`,
  and `docs/tools/README.md`; update `documentation-map.json` (add
  `basic-memory-mcp.sh` and `tools/**` to the handoff rule), `docs/README.md`,
  root and component READMEs, `AGENTS.md` (memory section, routing, and required
  verification), `config/opencode.example.jsonc`, `setup-computer-assistant.sh`
  (pin `BASIC_MEMORY_VERSION=0.23.2` plus verify checks), and this file.
- **M4 verification:** bounded MCP write/read/search smoke with temp-note
  cleanup; all bounded plugin and tool checks; documentation gate and
  self-tests; shellcheck; `py_compile`; `git diff --check`;
  `setup-computer-assistant.sh --verify-only`; restart OpenCode and prove recall
  across sessions.

Deletion manifest for the legacy memory system (only after the migration is
verified and the user confirms at the moment of deletion):

- `platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py` -> deleted
- `docs/scripts/assistant-memory.md` -> deleted, and its row removed from
  `docs/scripts/README.md`
- `~/Documents/computer-assistant/memory.json` and `.memory.lock` -> deleted
  (entry text is preserved as Basic Memory notes)
- All references updated: `AGENTS.md`, `HANDOFF.md`, the component README,
  `setup-computer-assistant.sh`, `skills/README.md`, and the `task-memory`
  skill and README

Risks and tradeoffs:

- The first sync downloads the FastEmbed embedding model (around 100 MB) and
  embedding can spike memory; the bounded wrapper contains it.
- About nine standing tool schemas add roughly 3-4k tokens per request; the
  disable list keeps it minimal and per-agent scoping can trim it further.
- Basic Memory writes apply directly, without the old script's `--apply`
  preview. The skill keeps the no-secrets rule and adds ask-before-deleting.
- There is no automatic capture yet; a future server-plugin hook could add
  ChatGPT-style session summarization on top of this foundation.

#### Part 3 — TUI feature plan (approved 2026-09-17, in progress)

User decisions recorded after the deep-research session:

- **Settings overlay** (new plugin `tui-settings`, implemented 2026-09-17,
  pending restart and live verification): a slim, right-aligned `Settings` row
  in `sidebar_content` at order `10` (top of the sidebar). Click, Enter, or
  `/settings` opens a drill-down overlay built from the host `DialogSelect`
  (with `DialogAlert` for About) over the sections **Appearance** (theme picker
  and dark/light via `theme.switch`/`theme.switch_mode`), **Display** (host kv
  toggles: timestamps, thinking, tool details, assistant metadata, scrollbar,
  animations, generic tool output, diff wrap mode), **Plugins** (loaded list
  plus the built-in `plugins.list` manager), **Source Control** (the runtime
  presets), **Sidebar** (visibility and positioning), and **About**.
  Persistence is `api.kv` only; the plugin never rewrites `tui.json`. Pure
  model logic lives in `src/settings.ts` with tests; docs in
  `docs/plugins/tui-settings.md` and the plugin README.
- **Sidebar positioning inside the settings overlay** (user requirement,
  2026-09-17; implemented with a documented API limit): the v1 TUI plugin API
  fixes each panel's order at registration and cannot move the built-in
  context/mcp/lsp/todo/files panels, and the host `sidebar` kv key controls
  visibility only (`auto` shows it when the terminal width exceeds 120; `hide`
  always hides). The overlay therefore offers visibility (immediate) and an
  anchor position for the panels the harness owns (`Settings gear`, `Source
  Control`), written to `local.tui-settings.order` /
  `local.source-control.order` and applied at the next restart; the overlay
  labels the restart requirement. Dialog size adapts to terminal width
  (`medium` below 96 columns). A live reorder of built-in panels is not
  achievable with this API.
- **VS Code-like file manager** (new plugin `file-manager`, implemented
  2026-09-17, pending restart and live verification): a full-screen `files`
  route (`/files`, palette command `Open file manager`, and a `Ctrl+Shift+E`
  keybind) with a lazy, ignore-aware project tree over `client.file.list`,
  quick-open over `client.find.files`, a `line_number` + `code` highlighted
  viewer, and a `textarea` editor with explicit `Ctrl+S` atomic saves through
  `node:fs`, `realpath` containment, `.git` refusal, binary/oversize
  read-only guards, a dirty marker and discard guard, `file.watcher.updated`
  reloads, and an external-editor action. A compact `Explorer` row in
  `sidebar_content` at order `60` opens the route. Pure model logic lives in
  `src/model.ts` with tests; docs in `docs/plugins/file-manager.md` and the
  plugin README.
- **Two separate plugin packages** (user choice), matching the
  one-concern-per-package pattern and independent bounded checks.
- **Sequence** (user choice): land the gate, reposition source-control, build
  `tui-settings`, build `file-manager`, then close out (with Basic Memory
  M1-M4 still queued).

Source-control reposition and settings groundwork:

- Implemented (2026-09-17, pending restart and live verification): the
  registration order is `50` (above the built-in context panel at `100`). The
  panel starts minimized through a new `startCollapsed` option (registration
  default `true`) whose state persists in
  `local.source-control.startCollapsed`; the header toggle writes that key. A
  one-time `local.source-control.repositioned` migration sets the legacy
  `local.source-control.collapsed` key to `true` on the first load of the new
  code so existing installs minimize immediately and toggles stay sticky.
  `refreshMs`, `githubRefreshMs`, `maxFiles`, and `startCollapsed` are
  re-read from `local.source-control.<option>` kv keys on each
  self-rescheduling poll tick so they apply without a restart; `github`,
  `whenEmpty`, `githubMcpCommand`, and `remoteName` stay registration-only.
  Pure option and migration logic lives in `src/options.ts` with tests, and
  the plugin README and `docs/plugins/source-control.md` are updated.
- File-row Ctrl+click affordance (implemented 2026-09-17, pending restart):
  file paths render underlined and hover a row to highlight the path and show
  a `ctrl+click to open the diff` hint, matching the built-in clickable-file
  pattern. Ctrl+click and Enter/Space still open `diff.open`.

File manager details (implemented):

- Viewing uses `LineNumberRenderable` + `CodeRenderable` with a `SyntaxStyle`
  built from the active theme's syntax colors (bundled js/ts/markdown/zig
  parsers; unknown filetypes fall back to plain text). The editor is a
  `TextareaRenderable` with line numbers; edits are tracked with
  `onContentChange` and read back through `editBuffer.getText()`.
- Saving is explicit `Ctrl+S`, atomic (`tmp` + `rename`) through `node:fs`,
  with a dirty marker, an unsaved-changes discard guard, a reload on
  `file.watcher.updated` (a warning instead when dirty), and binary/oversize
  read-only guards. The server file API is read-only (no write endpoint), so
  `node:fs` is required.
- Containment: realpath must stay under `api.state.path.worktree`/`directory`;
  refuse `.git/**` and symlink escapes; save only on explicit user action.
- "Open external editor" suspends the renderer (`renderer.suspend()/resume()`)
  for terminal editors and supports GUI editors such as VS Code.

Packages, checks, and gates (the local plugins follow the existing rules):

- Self-contained packages under `plugins/<name>/` with `src/`, `test/`,
  `package.json`, `README.md`, pinned `@opencode-ai/plugin` 1.18.31,
  `@opentui/*` 0.5.11, and `solid-js`; `typecheck`/`test` run through
  `scripts/run-bounded-command.sh` so `check-plugin-resource-guards.py` passes.
- Pure-logic tests with `node --test` (options model, kv encoding, path
  containment, tree build/flatten, filetype, dirty state, quick-open ranking);
  UI behavior is verified live and with `desktop-vision`.
- Docs: `docs/plugins/<name>.md` plus the plugin README and the
  `docs/plugins/README.md` index row, kept in sync per the documentation gate
  and the handoff rule.
- Registration in the user-owned `~/.config/opencode/tui.json` (through
  `/deploy` or manually); OpenCode must restart to load them.

Research conclusions and evidence (2026-09-17 session):

- TUI plugin API is v1 at `@opencode-ai/plugin/tui` 1.18.31; upstream spec
  `packages/opencode/specs/tui-plugins.md`; example plugin
  `.opencode/plugins/tui-smoke.tsx` (full-screen route, plugin overlays,
  sidebar slots at orders 50/250/650); built-in sidebar orders confirmed as
  context 100, mcp 200, lsp 300, todo 400, files 500.
- `sidebar_title`/`sidebar_footer` render `single_winner` (registering there
  replaces built-ins), so the gear and Explorer rows use additive
  `sidebar_content`. Host dialogs render with a backdrop; the built-in plugin
  manager and `/themes` picker can be dispatched instead of rebuilt.
- Host kv keys consumed reactively: `timestamps`, `tool_details_visibility`,
  `assistant_metadata_visibility`, `scrollbar_visible`, `diff_wrap_mode`,
  `animations_enabled`, `generic_tool_output_visibility`, `thinking_mode`,
  `sidebar`. Theme switching: `api.theme.current/selected/has/set`, plus the
  built-in `/themes` command (keybind `theme_list`).
- Upstream file-tree reference:
  `packages/tui/src/feature-plugins/system/diff-viewer-file-tree.tsx` and its
  utils (indent guides, expand markers, status letters, scroll-into-view).
- Risks carried into the build: the TUI plugin API is version-tied and
  pre-stable (pin dependencies exactly); syntax highlighting depends on the
  tree-sitter worker and bundled assets (spike first); `node:fs` saves bypass
  server permissions (containment, `.git` refusal, explicit saves only).

#### Part 4 — computer-use custom tools (implemented 2026-09-17)

- Implemented: `tools/vision.ts` exports `capture`, which becomes the
  `vision_capture` tool. It triggers the `desktop-vision` shortcut through the
  private ydotool service (`Shift+Print` for the full desktop, `Alt+Print` for
  the active window), waits for exactly one new PNG in `~/Pictures/Screenshots/`
  (refusing to guess on zero or multiple), reads it in Node, deletes the file,
  and returns it as a `data:` URI image attachment plus a size/dimension
  summary. It fails closed with a PrintScreen instruction when the ydotool
  socket is unavailable, and refuses to attach files over 6 MiB.
- The custom-tool result type supports `attachments: [{ type: "file", mime,
  url }]`; the installed runtime forwards only `data:` URLs to the model, and
  the built-in `read` tool is the reference implementation. The PNG is read in
  Node rather than piped through the 256 KiB Python stdout cap.
- Deployed through `setup-opencode.sh` REQUIRED_TOOLS (`desktop`, `vision`);
  `tools/test/vision.test.ts` covers key sequences, new-file detection, the
  size guard, data URIs, and PNG header parsing.
- Still queued: a window-listing tool (needs a new AT-SPI subcommand) and
  bounded input tools; raw input stays gated by the one-bounded-action rule.
- Constraints: each tool file stays self-contained (only top-level `.ts` files
  deploy through REQUIRED_TOOLS), uses a bounded spawn with timeout/output cap,
  and carries the announce and no-capture-during-credential-dialog rules in the
  tool description.

### Pending verification

- Confirmed in this resume session: the `desktop_*` custom tools loaded in the
  fresh TUI (`desktop_apps`, `desktop_tree`, `desktop_find`, `desktop_act`
  were available to the agent).
- Still unverified: the source-control panel opens a diff only on Ctrl+click
  (Enter/Space when the row is focused), and the header change count renders in
  the theme accent color with a muted `change`/`changes` label. The worktree
  was clean at resume time, so the panel had no rows to exercise.
- The panel itself was verified after the previous restart: the header count
  and rows matched `git status` (6 changes), and the no-PR GitHub row was
  correctly hidden because `docs/handoff-blender-note` has no pull request.
- The progress gate is landed (commit 67909ab) and runs in CI on PR #2,
  passing.
- The `/resume` command was redeployed and the health check is green; the
  running TUI still holds the pre-restart copy until OpenCode restarts.
- Source-control reposition verified live after the restart: the panel is at
  order `50` and the user confirmed the expand/collapse toggle persists through
  `local.source-control.startCollapsed`. The Ctrl+click diff opening and
  accented change-count header still need a dirty worktree.
- The tui-settings overlay, sidebar visibility and positioning, the
  `local.source-control.order` override, the file-manager route/tree/viewer/
  editor, the `vision_capture` tool, the source-control underline/hover hint,
  and the write-capable GitHub MCP are implemented with bounded checks passing
  (tui-settings 13, source-control 20, file-manager 11, tools 21 tests) but are
  unverified until the next OpenCode restart.

### Suggested next steps

1. Commit and push this batch (pending explicit request), restart OpenCode,
   then verify live: the `/settings` overlay, the `Settings` and `Explorer`
   rows, sidebar visibility/position, the source-control order override and
   underline/hover hint, the file-manager tree/viewer/editor/save/external
   editor, `vision_capture`, and a read-only GitHub MCP call plus one approved
   write through the MCP. Re-check the Ctrl+click/accent behavior with a dirty
   worktree.
2. Build the remaining computer-use tools (Part 4): window listing and bounded
   input.
3. Resume Basic Memory M1-M4: wrapper `scripts/basic-memory-mcp.sh`, global
   registration with the revised disable list, migration, then legacy removal
   only at the end with the explicit delete confirmation.
4. Merge pull request jtmb/opencode-rig#1 (and the stacked PRs) only on
   explicit request; keep the memory-migration deletion gate for the end of
   the M2 work.

## Keep This Current

Update this handoff whenever any of these change:

- Repository path, branch, or visibility.
- Skill names or count.
- Global commands, setup or verification commands, or the health check.
- Documentation gate rules, hook installation, or CI status.
- Local plugin registration, fallback chains, or state paths.
- Browser or GitHub MCP wrappers, versions, authentication, or session policy.
- Memory system, memory location, or privacy rules.
- Progress-tracking policy or its gate.
- Confirmation and screenshot policies.
- Superseded paths.
