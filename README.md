# OpenCode Rig

**The full harness rig for OpenCode on Ubuntu.** Skills, eyes, hands, browsers,
repositories, 3D tools, maintenance scripts, and local plugins — mounted,
pinned, and ready for the agent to use.

This repository turns a plain OpenCode install into a capable local computer
assistant on GNOME/Wayland: it can see the desktop, operate accessible
controls, drive an isolated Firefox, inspect GitHub safely, work in Blender,
playtest browser games, remember durable preferences, keep its own database
healthy, and fail over to another provider when the Codex quota runs dry.

## Supported platform

| OS | Distribution | Desktop | Architecture |
|----|--------------|---------|--------------|
| Linux | Ubuntu 26.04.1 LTS | GNOME on Wayland | amd64 |

OpenCode 1.18.31+, Node via fnm, `python3-pyatspi`, `ydotool`, and
`wl-clipboard` round out the environment.

## What's inside

| Component | Path | What it gives you |
|-----------|------|-------------------|
| Computer use | [`platforms/linux/ubuntu/computer-use/`](platforms/linux/ubuntu/computer-use/) | 16 skills, desktop and browser control, local plugins, typed desktop tools, setup, memory, and maintenance |
| Browser tools | [`platforms/linux/ubuntu/browser-tools/`](platforms/linux/ubuntu/browser-tools/) | Pinned Playwright MCP runtime with a shared live Firefox and an isolated headless mode |
| GitHub tools | [`platforms/linux/ubuntu/github-tools/`](platforms/linux/ubuntu/github-tools/) | Pinned official GitHub MCP, write-capable and lockdown-protected |

The components are integrated: computer-use wrappers launch the browser and
GitHub runtimes from their pinned, checksum-verified installs.

## Feature tour

### 16 skills, each a proven workflow

| Skill | What it does |
|-------|--------------|
| `desktop-vision` | Sees the GNOME desktop through a trusted screenshot shortcut; announces, reads once, deletes immediately |
| `desktop-control` | Operates named GNOME controls over AT-SPI with short-lived target tokens and screenshot verification |
| `browser-assistant` | Shares a visible, isolated Playwright Firefox window that you and the agent steer together |
| `browser-headless` | Runs explicitly requested, non-interactive browser tasks without a visible window |
| `game-playtest` | Smoke-tests browser games with bounded input plus semantic, visual, console, and network evidence |
| `github-operations` | Reads repositories, issues, and pull requests through a bounded MCP; remote changes require approval |
| `blender` | Inspects, scripts, renders, saves, reopens, and exports Blender scenes safely |
| `web-3d-asset-pipeline` | Cleans, validates, and exports browser-ready GLB/glTF assets |
| `task-memory` | Stores and retrieves durable preferences, verified facts, decisions, and pending work |
| `app-setup` | Installs, configures, updates, verifies, and safely removes desktop or CLI apps |
| `system-troubleshooting` | Diagnoses Ubuntu slowness, crashes, services, audio, networking, storage, and permissions evidence-first |
| `files-and-documents` | Finds, organizes, summarizes, renames, and exports files while preserving originals |
| `routine-automation` | Turns confirmed recurring tasks into idempotent scripts and safe schedules with logs and rollback |
| `opencode-db-maintenance` | Diagnoses and reclaims `opencode.db` growth, backs up chats, and manages the weekly maintenance job |
| `skill-maintenance` | Creates, audits, catalogs, deploys, renames, or retires skills safely |
| `vscode-management` | Manages VS Code, profiles, extensions, and its integrated browser for in-editor web testing |

Combined, they cover the full loop: observe the screen, act, verify, remember,
automate, and keep the harness healthy.

### Local plugins that harden the harness

The repo ships five local OpenCode plugins, all loaded directly from source:

- **`codex-usage`** — a TUI sidebar showing the remaining weekly ChatGPT Codex
  subscription quota and optional Luna Reserve usage, with refresh and details
  commands. Short-window and other model-specific counters are intentionally
  hidden.
- **`codex-fallback`** — a server-side failover router that keeps sessions alive
  when the Codex quota is exhausted:
  - proactive switching when the usage endpoint reports the limit reached, and
    reactive switching on quota or retryable provider errors;
  - any provider chain (`provider/model`), validated against the live provider
    catalog and skippable per agent;
  - per-agent overrides in `opencode.json` or agent Markdown, including
    `mode: off` for agents that must stay put;
  - abort, revert, and replay so the conversation continues with clean history;
  - per-model cooldowns, automatic return to the primary model after the quota
    resets, persisted state, toasts, and fail-open behavior on check errors.

- **`source-control`** — a TUI sidebar showing local working-tree changes and
  the current branch's GitHub pull request and check state. It uses OpenCode's
  built-in diff viewer, read-only GitHub MCP calls, and an adaptive memory
  budget for its external MCP child.

- **`tui-settings`** — a TUI settings overlay opened from a sidebar `Settings`
  row or `/settings`. It edits display preferences, opens the built-in theme
  and plugin managers, tunes the source-control runtime options, and positions
  the harness sidebar panels.

- **`file-manager`** — a full-screen file manager opened from a sidebar
  `Explorer` row or `/files`, with a lazy ignore-aware project tree, quick-open
  search, a syntax-highlighted viewer, and an in-TUI editor with atomic saves
  and path containment.

All five plugins are user-registered (`~/.config/opencode/tui.json` and the
global `opencode.jsonc`) and are not deployed by the general setup scripts.
Use `/deploy` or `deploy-plugins.sh` to register them.

### Browser automation, live and headless

`browser-tools` pins `@playwright/mcp@0.0.80` with a locked dependency graph:

- a **visible live window** shared by you and the agent during a session, kept
  separate from your normal Firefox profile;
- a **separate headless context** for clearly non-interactive work;
- transient output under `/tmp/opencode/`, and image responses omitted by
  default to keep context small.

### GitHub without the blast radius

`github-tools` installs the official GitHub MCP Server `v1.12.1` after
SHA-256 verification and runs it with the `context`, `repos`, `issues`,
`pull_requests`, `actions`, and `users` toolsets in lockdown mode. GitHub reads
and mutations are MCP tool calls rather than `gh` shell commands. The credential
comes from an explicit environment variable or the logged-in `gh` CLI and is
never stored in the repo or config. Publishing, merging, workflow dispatches,
deletions, and account or repository security changes all stay behind an
explicit confirmation gate.

### Desktop control you can trust

The desktop skills pair AT-SPI precision with visual proof: named controls
first, documented keyboard navigation only as a fallback, a fresh screenshot
after every mutation, and immediate deletion of every captured image. Input is
delivered through `ydotool`'s user service on GNOME Mutter, and admin actions
use `pkexec` so passwords are typed into the trusted PolicyKit dialog — never
into chat. The same script is exposed to the model as typed custom tools
(`desktop_apps`, `desktop_tree`, `desktop_find`, `desktop_act`) with validated
arguments and the same preview-token apply flow.

### 3D, memory, maintenance, and more

- **Blender 5.0.1** with `python3-numpy` for glTF import/export, versioned
  saves, renders, and clean reimport checks.
- **Task memory** in `~/Documents/computer-assistant/memory.json`: owner-only,
  preview-by-default writes, credential shapes rejected.
- **Weekly maintenance cron** that backs up chats to
  `~/Documents/opencode-backups/` and reclaims database space while OpenCode is
  closed, with an `@reboot` catch-up run.
- **Live dictation (optional)**: a checksum-pinned Vosk runtime types partial
  hypotheses and corrections into the focused field on `Alt+X`, with no
  autostart.

### Built-in guardrails

- Confirm before sending or publishing, purchasing, deleting data, accepting
  terms, changing security settings, or granting permissions.
- Never handle passwords, MFA codes, payment details, or CAPTCHAs.
- Never store secrets in the repo, config, or memory.
- Never weaken Wayland, AppArmor, browser sandboxing, TLS validation, or device
  permissions to hide a failure.
- Preserve unsaved work and user files; clean up screenshots and test state.
- Resource-heavy plugin checks run through an adaptive, serialized memory guard
  and fail closed when no limiter is available.

## Quick start

```bash
# Read-only health check first
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only

# Provision or repair the stack
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
```

Optional local dictation:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-live-dictation.sh --apply
```

Restart OpenCode after deploying skills, changing MCP configuration, or
changing local plugin registration. Running sessions do not hot-reload them.

For a fresh chat, paste the prompt in [`HANDOFF.md`](HANDOFF.md): it reads the
canonical docs, runs the health check, records the live state, and sets the
operating boundaries. The `/promote-skills` command revalidates and redeploys
every skill bundle after a restart, and the `/deploy` command registers the
local plugins with the global config or a repository's `.opencode/` directory.

## Documentation map

| Document | Contents |
|----------|----------|
| [`docs/README.md`](docs/README.md) | Deep reference index for the local plugins and supporting scripts |
| [`docs/plugins/`](docs/plugins/README.md) | How the local OpenCode plugins work: quota, fallback, and source control |
| [`docs/scripts/`](docs/scripts/README.md) | How each supporting script works: setup, MCP launchers, tools, and maintenance |
| [`platforms/linux/ubuntu/README.md`](platforms/linux/ubuntu/README.md) | Platform overview and component layout |
| [`platforms/linux/ubuntu/computer-use/README.md`](platforms/linux/ubuntu/computer-use/README.md) | Install, checks, scripts, config, and troubleshooting |
| [`platforms/linux/ubuntu/computer-use/skills/README.md`](platforms/linux/ubuntu/computer-use/skills/README.md) | Skill catalog with trigger phrases and usage guides |
| [`platforms/linux/ubuntu/computer-use/plugins/codex-usage/README.md`](platforms/linux/ubuntu/computer-use/plugins/codex-usage/README.md) | Quota sidebar configuration and security model |
| [`platforms/linux/ubuntu/computer-use/plugins/codex-fallback/README.md`](platforms/linux/ubuntu/computer-use/plugins/codex-fallback/README.md) | Fallback chains, per-agent config, and troubleshooting |
| [`platforms/linux/ubuntu/computer-use/plugins/source-control/README.md`](platforms/linux/ubuntu/computer-use/plugins/source-control/README.md) | Source-control sidebar, GitHub status, options, and adaptive MCP containment |
| [`platforms/linux/ubuntu/computer-use/plugins/tui-settings/README.md`](platforms/linux/ubuntu/computer-use/plugins/tui-settings/README.md) | Settings overlay, display and source-control keys, and sidebar positioning |
| [`platforms/linux/ubuntu/computer-use/plugins/file-manager/README.md`](platforms/linux/ubuntu/computer-use/plugins/file-manager/README.md) | Project tree, quick-open, in-TUI editor, atomic saves, and containment |
| [`platforms/linux/ubuntu/browser-tools/README.md`](platforms/linux/ubuntu/browser-tools/README.md) | Pinned Playwright runtime and integration |
| [`platforms/linux/ubuntu/github-tools/README.md`](platforms/linux/ubuntu/github-tools/README.md) | Pinned GitHub MCP runtime and policy |
| [`AGENTS.md`](AGENTS.md) | Operating guide, source of truth, and required verification |
| [`HANDOFF.md`](HANDOFF.md) | New-chat handoff prompt and live-state record |
