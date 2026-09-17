# Scripts

The scripts under
`platforms/linux/ubuntu/computer-use/scripts/` provision, launch, inspect, and
maintain the harness. This directory documents each one in depth. The
component [`README.md`](../../platforms/linux/ubuntu/computer-use/README.md)
lists them at a glance and covers the operating environment.

## Index by role

### Provisioning

| Script | Document | What it does |
|--------|----------|--------------|
| `setup-computer-assistant.sh` | [`setup-computer-assistant.md`](setup-computer-assistant.md) | Full-stack provisioning and verification (system packages, skills, memory, Playwright, GitHub MCP) |
| `setup-opencode.sh` | [`setup-opencode.md`](setup-opencode.md) | Persists `OPENCODE_ENABLE_EXA` and deploys skills and global commands content-aware |
| `setup-live-dictation.sh` | [`setup-live-dictation.md`](setup-live-dictation.md) | Optional checksum-pinned Vosk dictation runtime and `Alt+X` shortcut |

### Plugin deployment

| Script | Document | What it does |
|--------|----------|--------------|
| `deploy-plugins.sh` | [`deploy-plugins.md`](deploy-plugins.md) | Register the local plugins globally or into a repository's `.opencode/`, optionally copying the bootstrap scripts |

### MCP launchers

| Script | Document | What it does |
|--------|----------|--------------|
| `playwright-mcp.sh` | [`playwright-mcp.md`](playwright-mcp.md) | Launches the visible, user-shared Firefox MCP |
| `playwright-headless-mcp.sh` | [`playwright-headless-mcp.md`](playwright-headless-mcp.md) | Launches the isolated, invisible Firefox MCP |
| `github-mcp.sh` | [`github-mcp.md`](github-mcp.md) | Launches the pinned read-only GitHub MCP |

### Desktop and memory tools

| Script | Document | What it does |
|--------|----------|--------------|
| `desktop-control.py` | [`desktop-control.md`](desktop-control.md) | AT-SPI app inspection and mutation with dry-run tokens |
| `assistant-memory.py` | [`assistant-memory.md`](assistant-memory.md) | Owner-only JSON memory store |

### Documentation validation

| Script | Document | What it does |
|--------|----------|--------------|
| `check-skill-docs.py` | [`check-skill-docs.md`](check-skill-docs.md) | Validates skill metadata and usage guides |
| `check-skill-docs-self-test.py` | [`check-skill-docs.md`](check-skill-docs.md) | Proves the validator rejects invalid input |

### Database maintenance

| Script | Document | What it does |
|--------|----------|--------------|
| `opencode-db-maintain.py` | [`opencode-db-maintain.md`](opencode-db-maintain.md) | Diagnoses, prunes, and VACUUMs `opencode.db` |
| `opencode-chat-backup.py` | [`opencode-chat-backup.md`](opencode-chat-backup.md) | Exports every chat to re-importable JSON |
| `opencode-maintenance-cron.sh` | [`opencode-maintenance-cron.md`](opencode-maintenance-cron.md) | Weekly wrapper combining the two above |

## Shared conventions

- **Language.** Shell scripts use `#!/usr/bin/env bash` and
  `set -euo pipefail`. Python scripts are stdlib-only and pin no third-party
  runtime dependency unless explicitly documented (the live-dictation venv,
  built by its own setup script, is the exception, and it is isolated).
- **Read-only by default.** Verification is the default mode. Mutating scripts
  document the exact switch (`--apply`) that changes the system, and most also
  offer a `--dry-run` that prints what would happen.
- **Idempotency.** Re-running a script is safe. Setup scripts compare content
  before copying and only touch files that differ; maintenance scripts use
  markers, locks, and bounded retries.
- **Atomic writes.** File mutations go through a temp file in the target
  directory followed by `rename` (or `os.replace`), so a partial write never
  lands in place.
- **Permissions.** Private data is owner-only: memory is `600`/`700`, fallback
  state is `600`, and transient `/tmp/opencode/` output is `700`.
- **Confinement to user space.** Scripts manage user-owned files, a user
  systemd service, and an existing GNOME shortcut. The only privileged
  operations are APT installs and `usermod` in `setup-computer-assistant.sh`,
  and they are requested through `sudo`/`pkexec` only when `--apply` is passed.
- **No secrets.** No script writes a credential to the repository or to
  `opencode.json`. The GitHub token is read only from the launch environment.

## Verifying the toolchain

The repository's required checks for any cross-cutting change are listed in
[`AGENTS.md`](../../AGENTS.md). The script-relevant subset is:

```bash
bash -n platforms/linux/ubuntu/computer-use/scripts/*.sh
shellcheck platforms/linux/ubuntu/computer-use/scripts/*.sh
python3 -m py_compile platforms/linux/ubuntu/computer-use/scripts/*.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs-self-test.py
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py validate
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py apps
```
