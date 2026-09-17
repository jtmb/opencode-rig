# opencode-rig Documentation

This directory is the deep reference for the parts of the repository that are
code rather than skills:

- the **local OpenCode plugins** that harden the harness, and
- the **scripts** that provision, launch, inspect, and maintain it.

The component `README.md` files stay short and task-oriented (what to install,
which command to run, quick checks). The documents here answer the next
question: *how does it actually work, what does each option do, and how do the
pieces fit together?*

## Who this is for

| Reader | Start here |
|--------|------------|
| Anyone evaluating or modifying the plugins | [`plugins/README.md`](plugins/README.md) |
| Anyone provisioning or debugging the scripts | [`scripts/README.md`](scripts/README.md) |
| An agent or maintainer needing full behavioral detail | the per-file documents below |

## Contents

### Plugins

| Document | Covers |
|----------|--------|
| [`plugins/README.md`](plugins/README.md) | What a local OpenCode plugin is, TUI vs. server plugins, registration, the shared Codex usage layer, adaptive resource guards, and the common security model |
| [`plugins/codex-usage.md`](plugins/codex-usage.md) | The TUI quota sidebar: store, polling, credentials, endpoint parsing, UI, options, and errors |
| [`plugins/codex-fallback.md`](plugins/codex-fallback.md) | The server failover router: hooks, configuration precedence, proactive and reactive switching, cooldown state, and recovery |
| [`plugins/source-control.md`](plugins/source-control.md) | Local working-tree status, bounded GitHub pull-request lookup, adaptive MCP memory budgets, UI behavior, and lifecycle |

### Scripts

| Document | Covers |
|----------|--------|
| [`scripts/README.md`](scripts/README.md) | Index grouped by role plus the conventions every script follows |
| [`scripts/setup-computer-assistant.md`](scripts/setup-computer-assistant.md) | Full-stack provisioning: system packages, skills, memory, browser and GitHub MCP runtimes |
| [`scripts/setup-opencode.md`](scripts/setup-opencode.md) | `OPENCODE_ENABLE_EXA` persistence and content-aware deployment of skills and commands |
| [`scripts/deploy-plugins.md`](scripts/deploy-plugins.md) | Registering the local plugins globally or into a repository, plus the `/deploy` command and optional bootstrap copy |
| [`scripts/setup-live-dictation.md`](scripts/setup-live-dictation.md) | Checksum-pinned Vosk dictation runtime and the `Alt+X` shortcut |
| [`scripts/desktop-control.md`](scripts/desktop-control.md) | AT-SPI inspection and mutation with traversal bounds and short-lived target tokens |
| [`scripts/assistant-memory.md`](scripts/assistant-memory.md) | The private JSON memory store: schema, commands, locking, and credential rejection |
| [`scripts/check-skill-docs.md`](scripts/check-skill-docs.md) | Skill metadata/documentation validation and its negative self-test |
| [`scripts/check-doc-coverage.md`](scripts/check-doc-coverage.md) | The documentation coverage gate: map rules, completeness, change-aware checks, and the exemption |
| [`scripts/setup-git-hooks.md`](scripts/setup-git-hooks.md) | Installing the pre-push hook that enforces the documentation gate |
| [`scripts/playwright-mcp.md`](scripts/playwright-mcp.md) | The visible, user-shared Playwright Firefox launcher |
| [`scripts/playwright-headless-mcp.md`](scripts/playwright-headless-mcp.md) | The isolated headless Playwright Firefox launcher |
| [`scripts/github-mcp.md`](scripts/github-mcp.md) | The pinned, read-only, lockdown-protected GitHub MCP launcher |
| [`scripts/opencode-db-maintain.md`](scripts/opencode-db-maintain.md) | Database statistics, event-log pruning, VACUUM, and hardening |
| [`scripts/opencode-chat-backup.md`](scripts/opencode-chat-backup.md) | Full-fidelity chat export with a pruning manifest |
| [`scripts/opencode-maintenance-cron.md`](scripts/opencode-maintenance-cron.md) | The weekly wrapper that combines backup and cleanup |

## Conventions used throughout

These conventions are stated once here rather than repeated in every document.

- **Read-only by default.** Every mutating script exposes `--dry-run` (the
  default) or `--verify-only` (the default), and only changes the system when
  passed `--apply`. Scripts that manage files write atomically and are
  idempotent, so re-running them is safe.
- **Path placeholders.** `$REPO_ROOT` is the repository checkout
  (`~/repos/opencode-rig` on the reference machine). `$SCRIPT_DIR` is the
  `platforms/linux/ubuntu/computer-use/scripts/` directory. `$HOME` is the
  user's home directory.
- **Exit codes.** `0` means success. `2` is a usage or input error. Scripts
  with richer states document their own codes; for example
  `opencode-db-maintain.py` returns `3` when OpenCode holds the database and
  refuses to apply, and `4`/`5`/`6` for integrity or backup failures.
- **No secrets in the repository.** OpenCode may load local, untracked project
  `.env` values through `{env:NAME}` references for API keys and other secrets.
  GitHub credentials may come from that environment or the logged-in `gh` CLI;
  OpenAI OAuth remains in OpenCode's own data directory. No document here
  instructs you to commit a secret value to the repository or to a config file.
- **Restart to reload.** OpenCode does not hot-reload skills, MCP
  configuration, or plugins. Restart it after changing any of them.

## Related documentation

- Root [`README.md`](../README.md) — product overview and feature tour.
- [`AGENTS.md`](../AGENTS.md) — operating guide, source of truth, and required
  verification.
- [`HANDOFF.md`](../HANDOFF.md) — new-chat handoff prompt and live-state record.
- Component READMEs under `platforms/linux/ubuntu/` — install and troubleshooting
  for each component.
