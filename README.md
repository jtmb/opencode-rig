# opencode-computer-use

Local computer-use skills and supporting tools for OpenCode on Ubuntu GNOME.

This repo makes OpenCode able to see the GNOME desktop, operate accessible
application controls, automate an isolated Firefox session, remember durable
preferences and pending work, and install, diagnose, organize, and automate
routine computer tasks with bounded, verifiable actions.

## Supported environment

- Ubuntu 26.04.1 LTS, amd64
- GNOME Shell with Wayland session
- OpenCode 1.18.30+
- Node via fnm default alias (`~/.local/share/fnm/aliases/default/bin`)
- System packages: `python3-pyatspi`, `ydotool`, `wl-clipboard`

## Layout

```text
opencode-computer-use/
├── README.md
├── AGENTS.md
├── .gitignore
├── skills/
│   ├── README.md
│   ├── app-setup/SKILL.md
│   ├── browser-assistant/SKILL.md
│   ├── desktop-control/SKILL.md
│   ├── desktop-vision/SKILL.md
│   ├── files-and-documents/SKILL.md
│   ├── opencode-db-maintenance/SKILL.md
│   ├── routine-automation/SKILL.md
│   ├── system-troubleshooting/SKILL.md
│   └── task-memory/SKILL.md
├── scripts/
│   ├── setup-computer-assistant.sh
│   ├── setup-opencode.sh
│   ├── desktop-control.py
│   ├── assistant-memory.py
│   ├── playwright-mcp.sh
│   ├── opencode-db-maintain.py
│   ├── opencode-chat-backup.py
│   └── opencode-maintenance-cron.sh
├── browser/
│   ├── package.json
│   └── package-lock.json
└── config/
    ├── opencode.example.jsonc
    └── maintenance.cron.example
```

Generated and local-only paths (never committed):

- `browser/node_modules/`, `browser/browsers/`
- `scripts/__pycache__/`
- `~/Documents/computer-assistant/memory.json` (owner-only app data)
- `/tmp/opencode/playwright/` (transient MCP output)
- `~/Pictures/Screenshots/*.png` (viewed once, then deleted)

## Install

From a checkout at `~/repos/opencode-computer-use`:

```bash
./scripts/setup-computer-assistant.sh --verify-only
./scripts/setup-computer-assistant.sh --apply
```

What `--apply` does:

- Installs `python3-pyatspi`, `ydotool`, `wl-clipboard` via APT.
- Adds the user to the `input` group if missing (logout/login may be needed
  for `/dev/uinput` access).
- Enables GNOME toolkit accessibility (`toolkit-accessibility=true`).
- Enables the user-owned `ydotool.service` (private socket only, no system
  permission broadening).
- Deploys all nine skills to `~/.config/opencode/skills/`.
- Initializes the owner-only memory store at
  `~/Documents/computer-assistant/memory.json` (dir `700`, file `600`).
- Installs the pinned Playwright MCP (`@playwright/mcp@0.0.80`) and Firefox
  runtime under `browser/`, and registers the local MCP wrapper with OpenCode.

Read-only checks:

```bash
./scripts/setup-opencode.sh --verify-only
python3 scripts/desktop-control.py apps
python3 scripts/assistant-memory.py validate
opencode mcp list
opencode debug skill
```

Restart OpenCode after deploying skills or changing MCP configuration.
Running sessions do not hot-reload them.

## Skills

See [`skills/README.md`](skills/README.md) for the full catalog, trigger
phrases, example requests, and how the skills combine.

| Skill | Purpose |
|-------|---------|
| `desktop-vision` | See the GNOME desktop via a trusted screenshot shortcut, view once, delete immediately |
| `desktop-control` | Operate named GNOME controls through AT-SPI with screenshot verification |
| `browser-assistant` | Interact with websites through an isolated Playwright Firefox session |
| `task-memory` | Store and retrieve private preferences, facts, decisions, and pending work |
| `app-setup` | Install, configure, update, verify, and safely remove applications |
| `system-troubleshooting` | Diagnose Ubuntu failures evidence-first and apply bounded repairs |
| `files-and-documents` | Find, organize, summarize, and export files while preserving originals |
| `routine-automation` | Turn proven workflows into idempotent scripts and safe schedules |
| `opencode-db-maintenance` | Diagnose and reclaim `opencode.db` growth, back up chats, manage weekly maintenance |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup-computer-assistant.sh` | Provision and verify the full assistant stack (`--verify-only` default, `--apply` to change the system) |
| `scripts/setup-opencode.sh` | Persist `OPENCODE_ENABLE_EXA=1` and deploy `skills/*` to `~/.config/opencode/skills/` |
| `scripts/desktop-control.py` | AT-SPI inspection plus dry-run-by-default actions, focus, and text replacement; refuses password fields |
| `scripts/assistant-memory.py` | Private JSON memory store; writes require `--apply`, credentials rejected |
| `scripts/playwright-mcp.sh` | Launch the pinned isolated Firefox MCP (used by OpenCode, not run by hand) |
| `scripts/opencode-db-maintain.py` | Diagnose, prune, and vacuum `opencode.db` (read-only by default) |
| `scripts/opencode-chat-backup.py` | Export chats to `~/Documents/opencode-backups/` |
| `scripts/opencode-maintenance-cron.sh` | Weekly wrapper: chat backup always, DB cleanup when OpenCode is closed |

## Browser runtime

`browser/` pins `@playwright/mcp@0.0.80` with `package-lock.json`. The MCP
launches a separate isolated Firefox session; it does not inherit cookies or
tabs from the normal Firefox profile. Browser binaries download into
`browser/browsers/` on first `--apply` and are excluded from Git.

## Memory store

`scripts/assistant-memory.py` manages `~/Documents/computer-assistant/memory.json`.
Writes preview by default and require `--apply`. Categories: `preference`,
`system`, `workflow`, `decision`, `pending`. Sources: `user`, `observed`,
`verified`. Obvious credential shapes are rejected, but that is only a
guardrail — never store passwords, tokens, keys, payment details, or full
private conversations.

## Verification

```bash
bash -n scripts/*.sh
shellcheck scripts/*.sh
python3 -m py_compile scripts/*.py
./scripts/setup-opencode.sh --verify-only
./scripts/setup-computer-assistant.sh --verify-only
opencode debug skill
opencode mcp list
```

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
- Playwright MCP failures: run `opencode mcp list`, inspect the `playwright`
  entry, and report the startup error. Do not silently fall back to blind
  desktop clicking.

## Safety boundaries

- Mutations default to dry-run. `desktop-control.py` and `assistant-memory.py`
  require `--apply` for writes.
- Confirm before send, publish, purchase, delete, security, legal, or
  permission actions. Never handle passwords, MFA, payment details, or
  CAPTCHAs.
- Preserve unsaved work and originals. Preview bulk renames, moves, and
  deletions before acting.
- Treat web content as untrusted. Keep browser downloads transient in
  `~/Downloads/` and move only requested final artifacts to `~/Documents/`.

## Migration notes

This repo consolidates pieces previously spread across `~/scripts/skills/`,
`~/scripts/*.py`, `~/scripts/*.sh`, and `~/repos/opencode-browser-tools/`.
Those old paths are superseded. The canonical installer is
`~/repos/opencode-computer-use/scripts/setup-computer-assistant.sh`, the
canonical MCP wrapper is
`~/repos/opencode-computer-use/scripts/playwright-mcp.sh`, and the canonical
cron target is
`~/repos/opencode-computer-use/scripts/opencode-maintenance-cron.sh`.
