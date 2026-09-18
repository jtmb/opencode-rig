# Computer Use for Linux Ubuntu

Local computer-use skills and supporting tools for OpenCode on Ubuntu GNOME.

This repo makes OpenCode able to see the GNOME desktop, operate accessible
application controls, automate an isolated Firefox session, inspect GitHub,
work with Blender and browser-ready 3D assets, playtest browser games, remember
durable preferences and pending work, and install, diagnose, organize, and
automate routine computer tasks with bounded, verifiable actions.

## Supported environment

- Ubuntu 26.04.1 LTS, amd64
- GNOME Shell with Wayland session
- OpenCode 1.18.31+
- Node via fnm default alias (`~/.local/share/fnm/aliases/default/bin`)
- System packages: `python3-pyatspi`, `ydotool`, `wl-clipboard`
- Optional 3D packages: Ubuntu `blender` 5.0.1 plus `python3-numpy` for
  glTF import/export; the distribution build lacks optional Draco compression

## Monorepo Layout

```text
platforms/linux/ubuntu/
├── README.md
├── browser-tools/
│   ├── README.md
│   ├── package.json
│   └── package-lock.json
├── github-tools/
│   └── README.md
└── computer-use/
    ├── README.md
    ├── commands/
    ├── config/
    ├── plugins/
    │   ├── codex-fallback/
    │   ├── codex-usage/
    │   ├── file-manager/
    │   ├── source-control/
    │   └── tui-settings/
    ├── scripts/
    ├── skills/
    └── tools/
```

This component owns the skills, scripts, plugins, and configuration. The
sibling `../browser-tools/` component owns the pinned Playwright package and
generated Firefox runtime. `../github-tools/` documents and holds the generated
pinned GitHub MCP executable.

Generated and local-only paths (never committed):

- `../browser-tools/node_modules/`, `../browser-tools/browsers/`
- `../github-tools/bin/`
- `scripts/__pycache__/`
- `plugins/codex-usage/node_modules/`, `plugins/codex-fallback/node_modules/`
- `plugins/source-control/node_modules/`
- `plugins/tui-settings/node_modules/`
- `plugins/file-manager/node_modules/`
- `tools/node_modules/`
- `~/Documents/computer-assistant/basic-memory/` (owner-only memory project data)
- `/tmp/opencode/playwright*/` (transient MCP output)
- `~/Pictures/Screenshots/*.png` (viewed once, then deleted)

## Install

From a checkout at `~/repos/opencode-rig`:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
```

What `--apply` does:

- Installs `python3-pyatspi`, `ydotool`, `wl-clipboard` via APT.
- Adds the user to the `input` group if missing (logout/login may be needed
  for `/dev/uinput` access).
- Enables GNOME toolkit accessibility (`toolkit-accessibility=true`).
- Enables the user-owned `ydotool.service` (private socket only, no system
  permission broadening).
- Deploys all sixteen complete skill bundles to `~/.config/opencode/skills/`.
- Deploys the repository-managed `/deploy`, `/handoff`, `/promote-skills`, and
  `/resume` commands to `~/.config/opencode/commands/`.
- Deploys the typed desktop custom tools (`tools/desktop.ts`) and the
  screenshot tool (`tools/vision.ts`) to
  `~/.config/opencode/tools/` for global discovery.
- Initializes the owner-only memory store at
  `~/Documents/computer-assistant/memory.json` (dir `700`, file `600`).
- Installs the pinned Playwright MCP (`@playwright/mcp@0.0.80`) and Firefox
  runtime under the sibling `../browser-tools/` component, and registers live
  visible and isolated headless MCP wrappers in the project `opencode.json`
  (project-only, never global).
- Downloads the official GitHub MCP Server `v1.12.1` amd64 archive, verifies its
  published SHA-256, installs the native executable under `../github-tools/`,
  and registers a global wrapper limited to read-only, lockdown-protected
  repository, issue, and pull request tools. Credentials are not stored.

Read-only checks:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py apps
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py validate
opencode mcp list
opencode debug skill
```

Restart OpenCode after deploying skills, changing MCP configuration, or
changing plugin registration/TUI configuration. Running sessions do not
hot-reload them.

After restart, `/promote-skills` validates the canonical skill documentation,
deploys every complete bundle through `setup-opencode.sh --apply` (v1) or
`setup-opencode-v2.sh --apply` (v2 pilot), and verifies source parity plus
discovery. `/deploy` registers the local plugins globally or into a
repository's `.opencode/` directory (and optionally copies the bootstrap
scripts) through `scripts/deploy-plugins.sh`, and with `--v2` registers the
six `plugins-v2` packages into a v2 config directory. `/handoff` refreshes
`HANDOFF.md` with the current session state and regenerates the prompt block
for a fresh chat. `/resume` reads `HANDOFF.md`, runs the read-only health check
for the running stack, reports status, and continues the pending task with
progress tracked in the todo list.

[`plugins/codex-usage/`](plugins/codex-usage/README.md) is a local OpenCode TUI
sidebar for the weekly Codex quota and optional Luna Reserve usage.
[`plugins/codex-fallback/`](plugins/codex-fallback/README.md) is a server plugin that fails over from the Codex subscription to a
configurable chain of any OpenCode providers, with per-agent overrides and
automatic return to Codex when the quota resets.
[`plugins/source-control/`](plugins/source-control/README.md) is a local TUI
sidebar for working-tree changes and the current branch's GitHub pull request.
[`plugins/tui-settings/`](plugins/tui-settings/README.md) is a local TUI
settings overlay for appearance, display, plugins, source control, and sidebar
positioning (v1 only; retired in v2 in favor of the built-in `/settings`).
[`plugins/file-manager/`](plugins/file-manager/README.md) is a local TUI
project tree, quick-open, and editor with atomic saves.

All five are user-registered local packages, not setup-script deployments:
codex-usage loads from `~/.config/opencode/tui.json`, codex-fallback from the
`plugin` array in `~/.config/opencode/opencode.jsonc`, and source-control,
tui-settings, and file-manager from the TUI config. Register them with
`/deploy` or `scripts/deploy-plugins.sh`; their runtime and verification
commands live in their READMEs.

## New Chat Handoff

After restarting OpenCode, copy the prompt in the root
[`HANDOFF.md`](../../../../HANDOFF.md) into
the first message of a new chat. It tells the model which files to read, runs a
read-only health check, records the current skill/MCP/runtime state, and sets
the desktop, browser, memory, privacy, and confirmation boundaries.

## Skills

See [`skills/README.md`](skills/README.md) for the full catalog, trigger
phrases, example requests, and how the skills combine.

| Skill | Usage guide | Purpose |
|-------|-------------|---------|
| `desktop-vision` | [Usage guide](skills/desktop-vision/README.md) | See the GNOME desktop via a trusted screenshot shortcut, view once, delete immediately |
| `desktop-control` | [Usage guide](skills/desktop-control/README.md) | Operate named GNOME controls through AT-SPI with screenshot verification |
| `browser-assistant` | [Usage guide](skills/browser-assistant/README.md) | Share a visible isolated Playwright Firefox window with the user |
| `browser-headless` | [Usage guide](skills/browser-headless/README.md) | Run explicitly requested non-interactive tasks in isolated headless Firefox |
| `game-playtest` | [Usage guide](skills/game-playtest/README.md) | Test browser games with bounded input plus semantic, visual, console, and network evidence |
| `github-operations` | [Usage guide](skills/github-operations/README.md) | Inspect GitHub through a bounded write-capable MCP and perform approved remote operations |
| `blender` | [Usage guide](skills/blender/README.md) | Inspect, script, render, save, reopen, and export Blender scenes safely |
| `web-3d-asset-pipeline` | [Usage guide](skills/web-3d-asset-pipeline/README.md) | Prepare and validate GLB/glTF assets for browser runtimes |
| `task-memory` | [Usage guide](skills/task-memory/README.md) | Store and retrieve private preferences, facts, decisions, and pending work |
| `app-setup` | [Usage guide](skills/app-setup/README.md) | Install, configure, update, verify, and safely remove applications |
| `system-troubleshooting` | [Usage guide](skills/system-troubleshooting/README.md) | Diagnose Ubuntu failures evidence-first and apply bounded repairs |
| `files-and-documents` | [Usage guide](skills/files-and-documents/README.md) | Find, organize, summarize, and export files while preserving originals |
| `routine-automation` | [Usage guide](skills/routine-automation/README.md) | Turn proven workflows into idempotent scripts and safe schedules |
| `opencode-db-maintenance` | [Usage guide](skills/opencode-db-maintenance/README.md) | Diagnose and reclaim `opencode.db` growth, back up chats, manage weekly maintenance |
| `skill-maintenance` | [Usage guide](skills/skill-maintenance/README.md) | Create, update, audit, catalog, deploy, rename, or retire OpenCode skills safely |
| `vscode-management` | [Usage guide](skills/vscode-management/README.md) | Install, configure, and troubleshoot VS Code; prefer its integrated browser for in-editor web testing |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup-computer-assistant.sh` | Provision and verify the full assistant stack (`--verify-only` default, `--apply` to change the system) |
| `scripts/run-bounded-command.sh` | Run plugin checks in a serialized, adaptive memory and timeout budget |
| `scripts/check-plugin-resource-guards.py` | Enforce bounded typecheck and test scripts for every local plugin |
| `scripts/check-plugin-resource-guards-self-test.py` | Verify a bounded child can terminate without taking down its parent |
| `scripts/setup-live-dictation.sh` | Reproduce and verify local incremental Vosk dictation on `Alt+X` without login autostart |
| `scripts/setup-opencode.sh` | Verify by default; with `--apply`, persist `OPENCODE_ENABLE_EXA=1`, recursively deploy complete skill bundles, and deploy repository-managed global commands and typed desktop custom tools |
| `scripts/setup-opencode-v2.sh` | Verify by default; with `--apply`, link the 16 skill bundles, deploy the four global commands, and seed the v2 config into an isolated v2 config directory |
| `scripts/deploy-plugins.sh` | Register the local v1 plugins globally or into a repository's `.opencode/`, or the v2 packages into a config directory (`--v2`); optionally copy the bootstrap scripts |
| `scripts/desktop-control.py` | AT-SPI inspection with traversal status, short-lived target tokens, focus/text verification, and protected-field refusal |
| `scripts/check-skill-docs.py` | Read-only validation for skill metadata, usage guides, deployed-set links, unsafe modes, symlinks, and generated artifacts |
| `scripts/check-skill-docs-self-test.py` | Isolated negative tests proving invalid skill metadata and documentation are rejected |
| `scripts/check-doc-coverage.py` | Enforce that mapped sources update or create their documentation (completeness + change-aware) |
| `scripts/check-doc-coverage-self-test.py` | Isolated negative tests proving the documentation gate rejects undocumented changes |
| `scripts/check-progress-tracking.py` | Enforce the mandatory todo-tracking rule in `AGENTS.md`, the `/resume` command, and the handoff prompt |
| `scripts/check-progress-tracking-self-test.py` | Isolated negative tests proving the progress gate rejects a missing or gutted rule surface |
| `scripts/setup-git-hooks.sh` | Install or verify the versioned pre-push hook that runs the documentation gate |
| `scripts/assistant-memory.py` | Private JSON memory store; record changes require `--apply`, credentials rejected |
| `scripts/playwright-mcp.sh` | Launch the visible live Firefox MCP shared by user and agent |
| `scripts/playwright-headless-mcp.sh` | Launch the separate isolated headless Firefox MCP |
| `scripts/github-mcp.sh` | Launch the pinned, write-capable GitHub MCP in lockdown mode with fail-closed authentication |
| `scripts/opencode-db-maintain.py` | Diagnose, prune, and vacuum `opencode.db` (read-only by default) |
| `scripts/opencode-chat-backup.py` | Export chats to `~/Documents/opencode-backups/` |
| `scripts/opencode-maintenance-cron.sh` | Weekly wrapper: chat backup always, DB cleanup when OpenCode is closed |

## Configuration examples

- [`config/opencode.example.jsonc`](config/opencode.example.jsonc)
- [`config/.env.example`](config/.env.example) shows the non-OAuth values used
  by the configuration example. OpenCode loads the real project `.env`
  automatically; keep it untracked.
- `config/opencode.example.jsonc` demonstrates the supported provider env
  reference, complete `codex-fallback` options, per-agent overrides, and the
  project-level Playwright MCP registrations. The GitHub MCP is registered
  globally by `setup-computer-assistant.sh`; its env-backed block is documented
  in [`docs/scripts/github-mcp.md`](../../../../docs/scripts/github-mcp.md).
- [`config/v2-opencode.example.jsonc`](config/v2-opencode.example.jsonc) and
  [`config/v2-cli.example.json`](config/v2-cli.example.json) are the OpenCode v2
  (2.0.x) equivalents. v2 uses the `plugins` object form, the flat `mcp` map
  with no numeric `timeout`, the `rig-tools`/`rig-todo`/`codex-fallback`
  server plugins, and the three CLI plugins in `cli.json`. v2 registers exactly
  **one** Playwright MCP (the live visible wrapper); headless-only work runs
  through the repository Playwright runtime from the shell. It also registers
  the bounded `basic-memory` MCP with `permissions` deny entries that hide 12
  rarely used tools, leaving nine core note tools. `cli.json` enables terminal
  mouse capture (`"mouse": true`) and registers the `rig-todo` sidebar panel in
  addition to the three CLI plugins.
- [`config/v2-plugin-roles.json`](config/v2-plugin-roles.json) is the canonical
  six-package v2 role catalog. `deploy-plugins.sh --v2` and
  `verify-opencode-v2.sh` validate and consume it, including the dual server/CLI
  role owned by `rig-todo`.
- [`config/maintenance.cron.example`](config/maintenance.cron.example)
  documents the weekly maintenance schedule and required cron `PATH`.
- Plugin registration examples live in
  [`plugins/codex-usage/README.md`](plugins/codex-usage/README.md) and
  [`plugins/codex-fallback/README.md`](plugins/codex-fallback/README.md)
  (global `~/.config/opencode/tui.json` and `opencode.jsonc`; plugins are
  registered manually, not deployed by the setup scripts).

The examples use this machine's checkout and account paths. Adjust the
absolute paths before reusing them on another account or checkout.

## Live Dictation

The optional live-dictation setup uses a checksum-pinned Vosk 0.3.45 runtime,
the small US English model, PipeWire capture, and the existing private
`ydotool` user service. It is tuned for the supported i5-6200U laptop and types
partial hypotheses plus corrections into the focused field.

Provision the assistant stack first so `ydotool` and its bounded input access
are available, then run:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --verify-only
```

The script defaults to read-only verification and performs no APT, group,
permission, or login-autostart changes. `--apply` installs under `~/.local/`,
calibrates Mic Boost to `33%` (`+10 dB` on this ALC255), detects the current
default PipeWire source, and binds `Alt+X` to the toggle wrapper. Override
hardware-specific values with `--audio-source`, `--alsa-card`, and
`--mic-boost-percent`.

Press `Alt+X` once to start. Press it again to suspend recognition and close
the microphone stream; the model remains suspended in memory for fast reuse.
The service remains disabled at login and exits with the user session.

The previous shortcut values are saved in
`~/.config/nerd-dictation/shortcut-backup.txt`. To restore this machine's Handy
shortcut without deleting either dictation installation:

```bash
systemctl --user stop live-dictation.service
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/handy/ name 'Handy Dictation'
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/handy/ command "$HOME/scripts/Handy_0.9.6_amd64.AppImage --toggle-transcription"
gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/handy/ binding '<Alt>x'
```

## Browser runtime

`../browser-tools/` pins `@playwright/mcp@0.0.80` with `package-lock.json`.
The `playwright` MCP launches a visible isolated Firefox window shared by the
user and agent. `playwright_headless` launches a separate invisible context.
Neither inherits cookies or tabs from the normal Firefox profile. Browser
binaries download into `../browser-tools/browsers/` on first `--apply` and are
excluded from Git.

The repository project `opencode.json` registers both v1 MCPs for this
checkout and deliberately carries no numeric `timeout` (v2 silently drops an
entire MCP block on a numeric timeout). The v2 launcher keeps project config
disabled, because v2 registers only the single live `playwright` MCP from its
own config; translating the project file to a one-MCP v2 shape can follow once
v1 rollback is no longer needed.

## GitHub runtime

`../github-tools/bin/github-mcp-server` is generated from the official GitHub
MCP Server `v1.12.1` Linux x86_64 release after its published SHA-256 is
verified. `scripts/github-mcp.sh` enables the `context`, `repos`, `issues`,
`pull_requests`, `actions`, and `users` toolsets in lockdown mode, with write
operations enabled so GitHub mutations are MCP tool calls behind the normal
confirmation gate.

The wrapper authenticates from `GITHUB_PERSONAL_ACCESS_TOKEN` or `GH_TOKEN` in
OpenCode's launch environment, including values loaded from a project `.env`,
falling back to the logged-in `gh` CLI, and fails closed when none is
available. Prefer a fine-grained PAT restricted to the required repositories,
with read permissions for inspection and write permissions only where mutations
are expected. Never commit a token or place its value in
`opencode.json`; restart OpenCode after changing its launch environment.

## Memory store

The memory system of record is **Basic Memory** 0.23.2: owner-only Markdown
plus a local SQLite index for the `computer-assistant` project at
`~/Documents/computer-assistant/basic-memory/`, served through the bounded
`basic-memory` MCP (`scripts/basic-memory-mcp.sh`, adaptive cgroup budget,
`prlimit` fallback, fail closed). Writes through `write_note`/`edit_note` apply
directly, so durable personal facts and decisions are confirmed first, and
deleting a note always needs an explicit confirmation. The legacy JSON store
(`assistant-memory.py` and `~/Documents/computer-assistant/memory.json`) was
removed on 2026-09-18 after the verified M2 migration.

## Verification

From `~/repos/opencode-rig`:

```bash
bash -n platforms/linux/ubuntu/computer-use/scripts/*.sh
shellcheck platforms/linux/ubuntu/computer-use/scripts/*.sh
python3 -m py_compile platforms/linux/ubuntu/computer-use/scripts/*.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs-self-test.py
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-fallback run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/source-control run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/tui-settings run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/file-manager run check
npm --prefix platforms/linux/ubuntu/computer-use/tools run check
opencode debug skill
opencode mcp list
```

Each plugin package needs one `npm install` before its check; the generated
`node_modules/` directories are excluded from Git. Plugin registration lives
in user-owned files that the setup scripts do not verify.

## Troubleshooting

- GNOME Shell screenshot D-Bus (`org.gnome.Shell.Screenshot`) is private and
  returns `AccessDenied` for arbitrary callers. `desktop-vision` uses the
  configured GNOME screenshot shortcut through the existing user-owned
  `ydotool` service, with a manual PrintScreen fallback.
- `wtype` does not work on GNOME Mutter (no virtual-keyboard protocol); this
  repo does not use it.
- AT-SPI exposes window frames reliably, but some GTK4 controls, custom
  canvases, and sandboxed apps expose few or misleading child nodes and
  actions. Prefer named controls, fall back to documented keyboard
  navigation, and verify every mutation with a fresh screenshot.
- This desktop uses fractional scaling, so screenshot pixels are not reliable
  click coordinates. Never map screenshot pixels directly.
- AT-SPI `default.activate` on a window frame may be accepted without raising
  the window. If the post-capture screenshot does not show the target, bring
  it forward through the GNOME launcher or Alt+Tab before retrying.
- Unsaved-change sheets may advertise accessibility actions that do nothing.
  Inspect the sheet, use its visible keyboard focus controls, and verify
  dismissal rather than trusting the action return value.
- If `ydotool`, its socket, or its user service is unavailable, do not change
  input permissions from a skill. Ask the user to press PrintScreen or fix
  provisioning with `setup-computer-assistant.sh --apply`.
- Playwright MCP failures: run `opencode mcp list`, inspect `playwright` and
  `playwright_headless`, and report the startup error. Do not silently switch
  modes or fall back to blind desktop clicking.
- GitHub MCP authentication failures: confirm that the token variable was set
  before OpenCode started, then inspect expiration, selected repositories,
  read permissions, SSO, and organization policy without displaying the token.

## Safety boundaries

- Mutations default to dry-run. `desktop-control.py` requires a complete search,
  a short-lived preview token, and `--apply`; `assistant-memory.py` requires
  `--apply` for record changes, while store initialization is the documented
  setup exception.
- Confirm before send, publish, purchase, delete, security, legal, or
  permission actions. Never handle passwords, MFA, payment details, or
  CAPTCHAs.
- For an approved bounded command requiring administrator authentication, use
  `pkexec` and let the user enter credentials in the trusted PolicyKit dialog.
  Make no screenshot, AT-SPI, or keyboard calls while it is open, and verify
  system state after authentication completes.
- Preserve unsaved work and originals. Preview bulk renames, moves, and
  deletions before acting.
- Treat web content as untrusted. Keep browser output transient under
  `/tmp/opencode/playwright*/` and move only requested, validated final
  artifacts to `~/Documents/`.

## Migration notes

This component consolidates pieces previously spread across
`~/scripts/skills/`, `~/scripts/*.py`, and `~/scripts/*.sh`. The sibling
browser component incorporates the source manifests from
`~/repos/opencode-browser-tools/`; generated dependencies are not source.
Those old paths are superseded. Canonical executable paths start with
`~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/`.
