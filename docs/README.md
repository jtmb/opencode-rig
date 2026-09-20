# Open Rig documentation

This directory is the deep reference for the Open Rig harness and its code:

- the **OpenCode v2 plugins** that compose the harness,
- the **desktop, vision, repository, orchestration, and session-context tools**
  exposed by the v2 tool plugin, and
- the **scripts** that provision, launch, inspect, and maintain it.

The component `README.md` files stay short and task-oriented (what to install,
which command to run, quick checks). The documents here answer the next
question: *how does it actually work, what does each option do, and how do the
pieces fit together?*

## Who this is for

| Reader | Start here |
|--------|------------|
| Anyone evaluating or modifying v2 plugins | [`plugins/README.md`](plugins/README.md) |
| Anyone provisioning or debugging the scripts | [`scripts/README.md`](scripts/README.md) |
| A maintainer needing the complete current inventory | [`maintainer-features.md`](maintainer-features.md) |
| An agent needing full behavioral detail | the per-file documents below |

## Contents

### Plugins

| Document | Covers |
|----------|--------|
| [`plugins/README.md`](plugins/README.md) | Active v2 packages, server vs. CLI surfaces, registration, adaptive resource guards, and the common security model |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md) | Configurable hook enforcement for background-only, capacity-gated subagents |
| [`plugins/codex-fallback.md`](plugins/codex-fallback.md) | The active v2 server failover router: hooks, configuration precedence, proactive and reactive switching, cooldown state, and recovery |
| [`plugins/screen-terminal.md`](plugins/screen-terminal.md) | Bounded GNU Screen list/capture and token-gated OpenCode TTY start/input/resize/stop usage |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md) | Source Control panel and lifecycle |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/README.md) | Active Explorer tree, viewer, editor, and safety contract |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/resource-monitor/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/resource-monitor/README.md) | Per-TUI CPU/RAM measurement, formatting, and shared-service exclusion |
| [`plugins/ponytail.md`](plugins/ponytail.md) | OpenCode v2 adapter for the official Ponytail package, per-session modes, and safe updates |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/README.md) | Active v2 plugin workspace, role registration, bounded checks, and Explorer status |

### Desktop tools

| Document | Covers |
|----------|--------|
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md) | v2 desktop/vision tools, repository gates, agent capacity, OpenCode API/runtime/TTY management, `/tools`, and bounded session-context retrieval |

### Memory

| Document | Covers |
|----------|--------|
| [`memory.md`](memory.md) | The Basic Memory knowledge base: layout, exposed tools, registration, and operations |

### Plans

| Document | Covers |
|----------|--------|
| [`plans/explorer-ide.md`](plans/explorer-ide.md) | Explorer recovery, rendered visual and click audits, safety acceptance, and planned IDE increments |

### Brand

| Document | Covers |
|----------|--------|
| [`brand.md`](brand.md) | Open Rig positioning, voice, palette, and logo usage |

### Scripts

| Document | Covers |
|----------|--------|
| [`scripts/README.md`](scripts/README.md) | Index grouped by role plus the conventions every script follows |
| [`scripts/setup-computer-assistant.md`](scripts/setup-computer-assistant.md) | Full-stack provisioning: system packages, skills, memory, browser and GitHub MCP runtimes |
| [`scripts/setup-opencode.md`](scripts/setup-opencode.md) | Deploying skills, commands, custom tools, and v2 starting config into an isolated config directory |
| [`scripts/setup-ponytail-plugin.md`](scripts/setup-ponytail-plugin.md) | Bounded install/update, private runtime verification, daily timer, rollback, disable, and uninstall for Ponytail |
| [`scripts/deploy-plugins.md`](scripts/deploy-plugins.md) | Registering the local plugins globally or into a repository, plus the `/deploy` command and optional bootstrap copy |
| [`scripts/setup-live-dictation.md`](scripts/setup-live-dictation.md) | Checksum-pinned Vosk dictation runtime and the `Alt+X` shortcut |
| [`scripts/desktop-control.md`](scripts/desktop-control.md) | AT-SPI inspection and mutation with traversal bounds and short-lived target tokens |
| [`scripts/basic-memory-mcp.md`](scripts/basic-memory-mcp.md) | The bounded Basic Memory MCP launcher: adaptive cgroup budget, prlimit fallback, and the nine exposed tools |
| [`scripts/check-skill-docs.md`](scripts/check-skill-docs.md) | Skill metadata/documentation validation and its negative self-test |
| [`scripts/check-progress-tracking.md`](scripts/check-progress-tracking.md) | The mandatory todo-tracking gate: required rule surfaces, exit codes, and its negative self-test |
| [`scripts/check-doc-coverage.md`](scripts/check-doc-coverage.md) | The documentation coverage gate: map rules, completeness, change-aware checks, and the exemption |
| [`scripts/git-safety-gates.md`](scripts/git-safety-gates.md) | Repository-local git-safety and bounded-command gate checks with context-bound evidence |
| [`scripts/setup-git-hooks.md`](scripts/setup-git-hooks.md) | Installing the pre-push hook that enforces the documentation gate |
| [`scripts/playwright-mcp.md`](scripts/playwright-mcp.md) | The visible, user-shared Playwright Firefox launcher |
| [`scripts/github-mcp.md`](scripts/github-mcp.md) | The pinned, write-capable, lockdown-protected GitHub MCP launcher |
| [`scripts/opencode-db-maintain.md`](scripts/opencode-db-maintain.md) | Database statistics, event-log pruning, VACUUM, and hardening |
| [`scripts/opencode-chat-backup.md`](scripts/opencode-chat-backup.md) | Full-fidelity chat export with a pruning manifest |
| [`scripts/opencode-maintenance-cron.md`](scripts/opencode-maintenance-cron.md) | The weekly wrapper that combines backup and cleanup |

## Conventions used throughout

These conventions are stated once here rather than repeated in every document.

- **Read-only by default.** Setup and deployment scripts expose
  `--verify-only` (the default), and only change the system when
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

- Root [`README.md`](../README.md) - product overview and feature tour.
- [`maintainer-features.md`](maintainer-features.md) - durable inventory of
  implementation paths, user surfaces, evidence, boundaries, and limits.
- [`AGENTS.md`](../AGENTS.md) - concise agent index for rules, important files,
  memory awareness, and verification routes.
- [`agent-policy.md`](agent-policy.md) - authoritative repository-wide agent
  workflow, precedence, safety, roadmap, and verification rules.
  verification.
- [`HANDOFF.md`](../HANDOFF.md) - new-chat handoff prompt and live-state record.
- [`ROADMAP.md`](../ROADMAP.md) - implementation, automated-evidence, and pending live-acceptance ledger.
- Component READMEs under `platforms/linux/ubuntu/` - install and troubleshooting
  for each component.
