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
| An operator using Ubuntu under WSL2 | [`../platforms/windows/wsl2/ubuntu/computer-use/README.md`](../platforms/windows/wsl2/ubuntu/computer-use/README.md) |
| An agent needing full behavioral detail | the per-file documents below |

## Contents

### Plugins

| Document | Covers |
|----------|--------|
| [`plugins/README.md`](plugins/README.md) | Active v2 packages, server vs. CLI surfaces, registration, adaptive resource guards, and the common security model |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md) | Durable session Goals, evidence-gated Plan→Build handoff, and orchestration policy enforcement |
| [`plugins/codex-fallback.md`](plugins/codex-fallback.md) | The active v2 server failover router: hooks, configuration precedence, proactive and reactive switching, cooldown state, and recovery |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/chatgpt-connector/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/chatgpt-connector/README.md) | ChatGPT OAuth connector tools, session-private chat, MCP scope, and live-evidence limits |
| [`plugins/provider-usage.md`](plugins/provider-usage.md) | Authoritative provider/integration/connection resolution, universal visibility and status rules, sanitized usage snapshots, adapters, and native sidebar rendering |
| [`plugins/screen-terminal.md`](plugins/screen-terminal.md) | Bounded GNU Screen list/capture and token-gated OpenCode TTY start/input/resize/stop usage |
| [`plugins/hermes-hooks.md`](plugins/hermes-hooks.md) | Opt-in Hermes observer, bounded metadata snapshot, and fullscreen `/hooks` pipeline panel |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md) | Source Control panel and lifecycle |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/README.md) | Active Explorer tree, viewer, editor, and safety contract |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/resource-monitor/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/resource-monitor/README.md) | Per-TUI CPU/RAM measurement, formatting, and shared-service exclusion |
| [`plugins/ponytail.md`](plugins/ponytail.md) | OpenCode v2 adapter for the pinned official Ponytail package, per-session modes, and canonical bootstrap path |
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/README.md) | Active v2 plugin workspace, role registration, bounded checks, and Explorer status |

### Desktop tools

| Document | Covers |
|----------|--------|
| [`../platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md`](../platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md) | `/goal` controls and prompt-footer Auto/Manual handoff, v2 desktop/vision tools, repository gates, runtime tools, and bounded session-context retrieval |

### Memory

| Document | Covers |
|----------|--------|
| [`memory.md`](memory.md) | The Basic Memory knowledge base: layout, exposed tools, registration, and operations |

### Plans

| Document | Covers |
|----------|--------|
| [`plans/explorer-ide.md`](plans/explorer-ide.md) | Explorer recovery, rendered visual and click audits, safety acceptance, and planned IDE increments |

### Acceptance evidence

| Document | Covers |
|----------|--------|
| [`acceptance-evidence-2026-09-21.md`](acceptance-evidence-2026-09-21.md) | Fresh unified-Ubuntu MCP and 140/80/60-column sidebar acceptance |
| [`acceptance-evidence-2026-09-19.md`](acceptance-evidence-2026-09-19.md) | Historical v2.0.7 command, Explorer, diff, browser, and fullscreen evidence |
| [`wsl2-acceptance-2026-09-21.md`](wsl2-acceptance-2026-09-21.md) | Historical pre-convergence WSL2 backend and host-boundary evidence |

### Brand

| Document | Covers |
|----------|--------|
| [`brand.md`](brand.md) | Open Rig positioning, voice, palette, and logo usage |

### Scripts

| Document | Covers |
|----------|--------|
| [`scripts/README.md`](scripts/README.md) | Index grouped by role plus the conventions every script follows |
| [`scripts/orchestration-lockout-recovery.md`](scripts/orchestration-lockout-recovery.md) | Operator-authorized, allowlisted bootstrap recovery, backups, audit, rollback, and verification |
| [`scripts/opencode-recovery.md`](scripts/opencode-recovery.md) | Target-bound native MCP readiness, bounded repair/reconnect, and caller-owned `read_note` proof |
| [`scripts/bootstrap.md`](scripts/bootstrap.md) | Single cross-platform native-Ubuntu/WSL2 bootstrap contract, staged verification/apply, journaling, rollback, and security boundaries |
| [`scripts/setup-computer-assistant.md`](scripts/setup-computer-assistant.md) | Full-stack provisioning: system packages, skills, memory, and local Basic Memory, GitHub, and ChatGPT MCPs |
| [`scripts/setup-opencode.md`](scripts/setup-opencode.md) | Deploying skills, the opt-in ChatGPT agent, commands, and v2 starting config into an isolated config directory |
| [`scripts/setup-plugin-dependencies.md`](scripts/setup-plugin-dependencies.md) | Pinned repository Ponytail dependency installation, fail-closed surface verification, and disposable planning checks |
| [`scripts/setup-qa-runtime.md`](scripts/setup-qa-runtime.md) | Checksum-pinned checkout-local Node/npm runtime, safe extraction, verification, and CI/bootstrap use |
| [`scripts/deploy-plugins.md`](scripts/deploy-plugins.md) | Registering the local plugins globally or into a repository, plus the `/deploy` command and optional bootstrap copy |
| [`scripts/setup-live-dictation.md`](scripts/setup-live-dictation.md) | Checksum-pinned Vosk dictation runtime and the `Alt+X` shortcut |
| [`scripts/desktop-control.md`](scripts/desktop-control.md) | AT-SPI inspection and mutation with traversal bounds and short-lived target tokens |
| [`scripts/basic-memory-mcp.md`](scripts/basic-memory-mcp.md) | The bounded Basic Memory MCP launcher: adaptive cgroup budget, prlimit fallback, and the nine exposed tools |
| [`scripts/mcp_runtime.md`](scripts/mcp_runtime.md) | Canonical three-server MCP policy, profile roots, trusted runners, and fail-closed runtime verification |
| [`scripts/setup-mcps.md`](scripts/setup-mcps.md) | Canonical profile-aware MCP provisioning delegated by WSL2 |
| [`scripts/check-skill-docs.md`](scripts/check-skill-docs.md) | Skill metadata/documentation validation and its negative self-test |
| [`scripts/check-progress-tracking.md`](scripts/check-progress-tracking.md) | The mandatory todo-tracking gate: required rule surfaces, exit codes, and its negative self-test |
| [`scripts/check-doc-coverage.md`](scripts/check-doc-coverage.md) | The documentation coverage gate: map rules, completeness, change-aware checks, and the exemption |
| [`scripts/git-safety-gates.md`](scripts/git-safety-gates.md) | Repository-local git-safety and bounded-command gate checks with context-bound evidence |
| [`scripts/setup-git-hooks.md`](scripts/setup-git-hooks.md) | Installing the pre-push hook that enforces the documentation gate |
| [`scripts/github-mcp.md`](scripts/github-mcp.md) | Pinned profile-owned GitHub MCP authenticated from the existing `gh` login |
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
  GitHub authentication comes only from the logged-in `gh` CLI;
  OpenAI OAuth remains in OpenCode's own data directory. No document here
  instructs you to commit a secret value to the repository or to a config file.
- **Restart to reload.** OpenCode does not hot-reload skills, MCP
  configuration, or plugins. Restart it after changing any of them.
- **Platform ownership.** The WSL2 Ubuntu profile has its own server/CLI
  configuration, interop plugin workspace, tests, and launcher. Generic MCP
  declarations, launchers, provisioning, and version policy are canonical
  under the Ubuntu computer-use tree; WSL delegates to them without sharing
  native profile state or using symlinks.

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
- [`ROADMAP.md`](../ROADMAP.md) - current implementation, automated-evidence, and pending live-acceptance ledger.
- [2026-09-25 roadmap archive](../roadmap-archive-2026-09-25.md) - byte-for-byte pre-consolidation roadmap retained for history.
- Component READMEs under `platforms/linux/ubuntu/` - install and troubleshooting
  for each component.
- [`../platforms/windows/wsl2/ubuntu/computer-use/README.md`](../platforms/windows/wsl2/ubuntu/computer-use/README.md)
  - isolated WSL2 setup, tools, security boundaries, and live-acceptance limits.
- [`wsl2-acceptance-2026-09-21.md`](wsl2-acceptance-2026-09-21.md) - focused
  WSL2 backend and historical pre-convergence MCP evidence with explicit
  remaining limits.
