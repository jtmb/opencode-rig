# Open Rig maintainer feature inventory

This is the durable inventory of what the repository currently provides. It is
written from the checked source tree and configuration, not from intended
roadmap behavior. A feature marked **implemented** has source/configuration and
a documented check; **runtime-dependent** means the code is present but its
behavior depends on installed OpenCode, providers, credentials, native runtime
support, or fresh UI evidence; **planned/limited** is not a completion claim.

## Boundary and architecture

The maintained target is Ubuntu 26.04.1 LTS amd64 with GNOME on Wayland,
OpenCode v2.0.7 or a compatible checked v2 release, Node.js 22.6+ for plugin
checks, Python 3, AT-SPI, `ydotool`, and `wl-clipboard`. Other Linux
distributions are not claimed as supported. Open Rig is the harness and OpenCode
is the underlying runtime. Optional Blender and NumPy support belongs to the
Blender and web 3D workflows.

Primary implementation is under
`platforms/linux/ubuntu/computer-use/`. Server plugins register in
`opencode.jsonc`; CLI/TUI plugins register in `cli.json`. The role catalog is
`config/v2-plugin-roles.json`, and the complete examples are
`config/v2-opencode.example.jsonc` and `config/v2-cli.example.json`.

## v2 plugin packages

All eleven catalog-managed packages have package checks. Ponytail is the twelfth
local package and is deployed separately by its bounded adapter setup.

| Package | Role and user surface | Status and evidence |
|---|---|---|
| `rig-tools` | Server tools for bounded desktop/vision operations, repository gates, capacity checks, and read-only cross-session context; also `/session-context` | **Implemented.** Source registration is in `rig-tools/src/index.ts`; package check, focused context tests, and bounded wrappers are the evidence path. |
| `orchestration-policy` | Server hooks for background-only subagents, capacity/allowlist enforcement, policy-index validation, installed-binary protection, and periodic project-memory reconciliation | **Implemented in source/package evidence.** Live acceptance requires a shared-service restart and a new-session reconciliation. |
| `git-tool` | Server-side bounded read-only unified Git diff | **Implemented.** Uses the native v2 VCS API and returns bounded text because v2.0.7 reserves rich rendering for built-in tool IDs. |
| `integrated-browser` | Server and CLI control for a temporary per-session headed Chromium window, with shared typed RPC and bounded navigation/accessibility diagnostics | **Implemented in source/package evidence.** Live headed acceptance remains blocked until the pinned runtime has a Chromium executable and a usable desktop session. |
| `repo-learning` | Server automatic bounded structured observation plus CLI read-only review panel | **Implemented with a narrow active boundary.** New state observes automatically and an explicit pause persists; synthesis, promotion, active retrieval, Basic Memory writes, and optimization effects are not registered. |
| `rig-todo` | Server Todo tools and a CLI/TUI Todo panel | **Implemented in source/config.** Runtime behavior is validated by its package check and v2 deployment check. |
| `codex-fallback` | Server-side provider/model fallback routing | **Implemented, runtime-dependent.** It is inactive without a valid configured chain and depends on target provider catalog and credentials. |
| `source-control` | CLI/TUI working-tree and pull-request panel | **Implemented in source/config, runtime-dependent** for GitHub data and live TUI behavior. |
| `codex-usage` | CLI/TUI Codex quota, DeepSeek balance, and OpenCode Zen status panel | **Implemented, live dialog accepted, runtime-dependent** for authenticated usage data and endpoint availability. |
| `file-manager` | CLI/TUI docked Explorer with tree, quick-open, viewer, tabs, and explicit-save editor | **Implemented baseline with live disposable-project evidence.** Safety/model checks and pointer/keyboard acceptance cover the baseline; broader IDE behavior and every syntax-family visual remain unclaimed. |
| `resource-monitor` | CLI/TUI CPU and RSS footer token plus system-resources overlay | **Implemented with package and live TTY evidence.** It samples the TUI process tree and excludes the shared service subtree. |

`ponytail-adapter` bridges the official Ponytail `4.10.0` content into v2 and
is maintained outside the general role catalog.

### Explorer parser matrix

`file-manager/parsers.manifest.json` pins `tree-sitter-wasm` 2.0.1 and records
hashes for 21 managed languages: JSON (with JSONC alias), YAML, TOML, Bash
(shell alias), Python, Go, Rust, SQL, HTML, CSS (SCSS alias), XML, C, C++, Java,
Ruby, PHP, Lua, Dockerfile, INI, diff, and Make (Makefile alias). OpenTUI
0.5.11 supplies JavaScript/JSX, TypeScript/TSX, Markdown, and Zig; plain text
is the fallback. `parsers:install` and `parsers:verify` are bounded and do not
download assets. Native parser-worker and rendered tests may skip when the host
runtime lacks support.

## Skills and user workflows

The source catalog contains 19 skills, recursively deployed by
`scripts/setup-opencode.sh`:

| Skill | User surface |
|---|---|
| `desktop-vision` | Trusted GNOME screenshots for visual verification |
| `desktop-control` | AT-SPI inspection and guarded GUI actions |
| `browser-assistant` | Visible isolated Playwright Firefox shared with the user |
| `browser-headless` | Explicitly requested isolated non-interactive browser work |
| `game-playtest` | Browser-game input, canvas/WebGL screenshots, console and responsive QA |
| `task-memory` | Durable preferences, facts, decisions, and pending work |
| `session-context` | Bounded read-only evidence from another session in the current project |
| `app-setup` | Ubuntu application installation, configuration, verification, and removal |
| `github-operations` | Bounded GitHub repository, issue, PR, release, and checks workflows |
| `blender` | Safe Blender inspection, scripting, rendering, save/reopen, and export checks |
| `system-troubleshooting` | Evidence-first Ubuntu diagnosis and reversible fixes |
| `files-and-documents` | Find, organize, summarize, rename, and export while preserving originals |
| `web-3d-asset-pipeline` | Verified browser-ready GLB/glTF preparation |
| `routine-automation` | Idempotent recurring scripts and schedules with rollback |
| `opencode-db-maintenance` | `opencode.db` diagnosis, backup, prune, VACUUM, and maintenance scheduling |
| `development-conventions` | Focused source, test, documentation, API, language, UI, and Open Rig operating conventions |
| `skill-maintenance` | Skill lifecycle, catalog, deployment, and documentation maintenance |
| `agent-orchestration` | Bounded delegated work with ownership and verification rules |
| `vscode-management` | VS Code package, settings, extensions, workspaces, and integrated-browser workflows |

The skills are instructions and workflows, not proof that every optional
dependency or live application is installed.

### Orchestration contract

Every repository change, review, correction, or release starts with
`task_declare` and requires at least one direct capacity-approved background
child plus an accepted parent `subagent_followup`. Corrections also require
roadmap, active-todo, and project-memory acknowledgements. Use `explore` for
planning/reconnaissance and normally `general` for implementation; `Build`
retains access to configured subagents. No more than three children may run,
and unavailable capacity fails closed instead of falling back to direct work.
Main-agent verification and separate commit/push approval remain mandatory.
OpenCode v2 has no supported semantic-intent or final-answer veto, so the plugin
enforces explicit tool and session-lifecycle boundaries.

## MCP and runtime wrappers

- `scripts/playwright-mcp.sh` launches the one registered visible Playwright
  MCP. Explicit headless work uses the pinned browser runtime through bounded
  shell execution, not a second MCP. The project-enabled standalone runtime
  connects this MCP, but visible page interaction still requires an attached
  desktop browser.
- `scripts/github-mcp.sh` launches the pinned GitHub MCP runtime with bounded
  toolsets and credential lookup outside the repository.
- `scripts/basic-memory-mcp.sh` launches Basic Memory under an adaptive memory
  budget; the v2 example permits the documented core note tools.
- `scripts/desktop-control.py` supplies bounded AT-SPI inspection/mutation
  semantics used by the desktop tools.
- `scripts/run-bounded-command.sh` contains resource-sensitive subprocesses.
- `browser-tools/` and `github-tools/` contain the pinned runtime installations;
  their launchers and checks are the integration boundary.

## Setup, deployment, and checking

| Path | Responsibility |
|---|---|
| `setup-computer-assistant.sh` | Ubuntu dependencies, runtimes, skills, commands, and initial config |
| `setup-opencode.sh` | 19 skills, four repository commands, v2 config, and parser cache |
| `deploy-plugins.sh` | Atomic registration of selected server/CLI packages from the role catalog |
| `verify-opencode-v2.sh` | v2 environment, role, config, and deployment verification |
| `v2-plugin-catalog.py` | Catalog/role/package validation |
| `check-skill-docs.py` | Skill metadata and documentation validation |
| `check-doc-coverage.py` | Documentation-map coverage and change-aware checks |
| `check-plugin-resource-guards.py` | Resource guard policy checks |
| `check-progress-tracking.py` | Todo/progress tracking policy checks |
| `check-git-safety-policy.py` | Git safety policy checks |
| `setup-git-hooks.sh` | Installs the versioned pre-push checks |

Setup/deployment verify-only modes are read-only; `--apply` is explicit and
existing configuration is preserved. Checks and package commands are routed
through the bounded wrapper where documented. Restart OpenCode after changing
skills, MCP declarations, config, or plugins.

## Git gates and exact tool status

The stable `rig-tools` names are:

- `agent_memory_capacity` - **implemented** read-only conservative host/cgroup-v2
  capacity check for one to three requested agents.
- `session_context` - **implemented** read-only same-project session listing and
  bounded selected-session projection. It separates live state from saved
  outcome and omits reasoning, provider state, attachments, shell output, and
  tool inputs/results.
- `opencode_runtime_status` - **implemented** read-only, bounded inspection of
  location-scoped MCP, plugin, provider, and model state through OpenCode's
  in-process V2 APIs.
- `opencode_runtime_reload` - **implemented** state-bound preview/apply reload
  for MCP, model, and provider registries with fresh before/after API evidence.
- `opencode_self_usage` - **implemented** read-only, concurrency-bounded
  analysis of OpenCode process-tree CPU/RSS and host CPU, RAM, swap, and project
  filesystem pressure without exposing process command lines.
- `screen_terminal` - **implemented** bounded GNU Screen list/capture plus
  state-bound standalone OpenCode start, key/text/primary-click input, PTY
  resize, and stop actions. Full usage is documented in
  [`plugins/screen-terminal.md`](plugins/screen-terminal.md).
- `repo_qa_gate` - **implemented** configured QA gate with state-bound evidence.
- `repo_documentation_gate` - **implemented** configured documentation gate;
  missing configuration fails closed.
- `repo_commit` - **implemented** preview/apply commit gate requiring fresh QA,
  documentation evidence, exact staged scope, and separate approval.
- `repo_push` - **implemented** preview/apply push gate requiring explicit
  remote/ref, fresh state, and separate approval.

`rig-tools` also registers two non-resuming server commands. `/session-context`
inserts a bounded result into the invoking session without modifying the source
session. `/tools` inserts the complete tested tool/usage catalog, while
`/tools <query>` filters it. Neither is one of the four deployed Markdown
commands.

These are plugin tools, not a promise that every repository has configured QA
or documentation commands. Raw shell commit/push is denied by the plugin
policy. Commit approval never implies push approval. The companion protocol and
external-repository acceptance procedure are documented in
[`scripts/git-safety-gates.md`](scripts/git-safety-gates.md).

## Safety boundaries and known limits

Preview/apply tokens, path containment, atomic saves, dirty/conflict guards,
isolated browser profiles, bounded subprocesses, and explicit approval gates
are implemented boundaries. Credentials, passwords, MFA, payments, CAPTCHAs,
and secrets are not handled in chat or stored in this repository or memory.

Known limits include provider-dependent fallback and quota data, optional
runtime dependencies, incomplete AT-SPI exposure in some applications, native
OpenTUI rendering/worker skips on unsupported hosts, and Explorer visual/click
acceptance that requires fresh evidence. The wider Explorer IDE roadmap is not
complete. No root license is declared; do not infer licensing or model
availability from this inventory.

## Branding

Product-facing name: **Open Rig**. OpenCode names the underlying runtime. The
approved visual system, palette, usage rules, and SVG assets are in
[`brand.md`](brand.md). The identity documentation explicitly does not claim
trademark clearance or a registered/exclusive mark.
