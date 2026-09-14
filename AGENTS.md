# AGENTS.md — opencode-computer-use

Canonical repo for OpenCode local computer-use skills and supporting tools.

## Where things go

- Skill sources: `skills/<name>/SKILL.md` (folder name matches `name:`).
- Deployed skills: `~/.config/opencode/skills/<name>/SKILL.md` (via
  `scripts/setup-opencode.sh`, never edited directly).
- Scripts: `scripts/` (Bash `#!/usr/bin/env bash` + `set -euo pipefail`,
  Python stdlib-only).
- Browser manifests: `browser/package.json`, `browser/package-lock.json`.
  Generated `browser/node_modules/` and `browser/browsers/` stay out of Git.
- Config templates: `config/opencode.example.jsonc`,
  `config/maintenance.cron.example`. Live config lives at
  `~/.config/opencode/opencode.jsonc` and in the user crontab.
- Runtime data stays out of the repo: `~/Documents/computer-assistant/`,
  `~/Documents/opencode-backups/`, `/tmp/opencode/`,
  `~/Pictures/Screenshots/`.

## Conventions

1. Bash: absolute paths or explicit args, no `cd` chains. Default to
   read-only verification (`--verify-only`); writes require `--apply`.
2. Python: stdlib only unless the user explicitly approves a dependency.
   Destructive behavior defaults to dry-run; mutations require `--apply`.
3. Idempotent: safe re-runs only copy on content change, `npm ci` only on
   version drift, `mkdir -p`, guarded cron wrapper with `flock`.
4. No secrets in code, logs, skills, or memory. Memory rejects obvious
   credential shapes, but that is only a guardrail.
5. Sudo only where required (APT, usermod). Prefer existing user services;
   never broaden input permissions from a skill.
6. UI and memory mutations require `--apply`. Consequential desktop and
   browser actions require user confirmation and screenshot or page-state
   verification. Never handle passwords, MFA, payment details, or CAPTCHAs.
7. Skills: `name` is lowercase hyphen-separated, matches the folder, and
   stays within 64 chars. `description` covers what the skill does and when
   to trigger it, front-loads trigger keywords, and stays within 1024 chars.

## Editing checklist

- Update the source in this repo, redeploy with
  `./scripts/setup-opencode.sh`, and verify with
  `./scripts/setup-computer-assistant.sh --verify-only`.
- Shell: `bash -n <file>` + `shellcheck <file>`.
- Python: `python3 -m py_compile <file>` plus `--help` and dry-run paths.
- Skills: validate frontmatter (`name`, `description`), folder match, and
  `opencode debug skill` discovery of all nine assistant skills.
- Browser: keep `@playwright/mcp` pinned. If the version changes, update
  `browser/package.json`, regenerate `browser/package-lock.json`, update
  `BROWSER_MCP_VERSION` in `scripts/setup-computer-assistant.sh`, and
  re-run the Firefox smoke test.
- Docs: keep root `README.md`, `skills/README.md`, script usage, skill
  examples, and `config/` templates in sync when paths or behavior change.

## Verification

```bash
bash -n scripts/*.sh
shellcheck scripts/*.sh
python3 -m py_compile scripts/*.py
./scripts/setup-opencode.sh --verify-only
./scripts/setup-computer-assistant.sh --verify-only
opencode debug skill
opencode mcp list
python3 scripts/assistant-memory.py validate
python3 scripts/desktop-control.py apps
```

Restart OpenCode after skill or MCP changes; running sessions do not
hot-reload them.
