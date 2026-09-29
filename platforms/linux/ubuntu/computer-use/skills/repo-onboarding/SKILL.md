---
name: repo-onboarding
description: "The repo-onboarding skill helps agents onboard downstream consumer repositories: OpenCode v2, opencode.json, MCP servers, Basic Memory, and set up a safe integration. Use for consumer-repository migration, agent/model setup, or verification against the Open Rig harness."
metadata:
  schema-version: "1"
  category: "maintenance"
  tags: "onboarding,downstream,opencode,mcp,memory,integration"
---

# Repo Onboarding

Onboard a downstream repository against the canonical Open Rig source without
guessing paths, duplicating integrations, or treating source checks as live
acceptance.

## Preflight (read-only)

1. Identify the consumer repository and its active OpenCode v2 installation.
   Confirm the selected binary reports v2; do not migrate a different runtime
   by assumption.
2. Locate the canonical Open Rig checkout. Do not assume a fixed path: it is the
   checkout containing both root `bootstrap.sh` and
   `platforms/linux/ubuntu/computer-use/`. Record its actual absolute path.
3. Inventory the consumer's `opencode.json`, `.opencode/` tree, plugins, agent
   declarations, skills, and `mcp.servers`. Inspect existing global v2 config
   only at its selected path. Run `git status --short` and preserve all dirty
   work.
4. Keep preflight read-only. Do not replace, format, or normalize existing
   configuration while discovering the setup.

## Choose the integration mode

- Prefer the harness's deployed global skills, commands, and MCP stack for
  capabilities it already supplies.
- Use a repo-local plugin only for behavior specific to the consumer repository
  and not already provided by the deployed harness.
- Reuse existing skills and services instead of registering duplicate local
  copies, MCPs, or plugins.

## Deploy and restart

- Run the canonical `bootstrap.sh` in verify-only mode first. It is verify-only
  by default; it writes only when explicitly given `--apply`.
- When deploying the v2 skills, commands, and agents, run
  `platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply` with
  the intended v2 config directory selected (use `--config-dir` when needed).
  It recursively deploys those bundles to that selected directory. Review the
  target and dirty state before every apply.
- Restart OpenCode after skill deployment. Skills do not hot-reload; do not
  claim live skill behavior before the restart and a fresh check.
- Never patch installed OpenCode binaries or distribution files. Extend runtime
  behavior through supported repo-local plugins.

## Configure the consumer `opencode.json`

- Use the OpenCode v2 schema and configure only the providers, agents, models,
  and permissions the consumer needs.
- When migrating, preserve the current config as the baseline and translate
  settings selectively to v2; do not overwrite it with a harness example.
- Verify provider and model IDs against the selected installation's actual
  provider/model catalog and availability. Do not copy an ID from another
  repository or guess one, including a model variant/profile.
- Give each agent a recognized ID, explicit role, verified model, and
  least-privilege permissions. Check that any phase or tool-allowlist plugin
  recognizes each agent ID.
- Keep tokens, API keys, and other secrets out of source, config examples,
  logs, transcripts, and acceptance evidence. Use the target's supported auth
  store or credential flow.

## Configure MCP servers

- Declare MCP entries under `mcp.servers`. For Basic Memory and GitHub, set the
  `command` to the absolute path of the canonical checkout's
  `platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh` or
  `github-mcp.sh`; resolve the checkout path during preflight rather than
  copying a guessed home directory.
- The GitHub wrapper reads the saved `gh` login and deliberately rejects
  inherited `GH_TOKEN` and `GITHUB_*` variables. Never put a GitHub token in
  config or wrapper environment entries.
- The Basic Memory wrapper applies a bounded memory budget and fails closed
  when it cannot establish a safe budget.
- Playwright is a skill/CLI-plugin capability, not an always-on MCP. Do not add
  a Playwright MCP entry just to obtain browser automation.

## Configure optional per-project memory

Basic Memory stores local Markdown notes with a SQLite index, organized into
projects (workspaces). To opt a consumer into the `orchestration-policy`
plugin's memory context:

1. In `orchestration-policy.options`, set `memoryProject` to the project name,
   `memoryDirectory` to its absolute, non-symlink notes directory, and
   `memoryBindings` to one or more tag bindings. Configure all three together.
2. Separately register `basic-memory` under `mcp.servers`, with `command` set to
   the absolute path of the canonical checkout's
   `platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh`. This MCP
   registration supplies the agent's note tools; it does not replace the plugin
   options.

The plugin injects only regular Markdown notes whose frontmatter type is
`decision` or `preference` and whose tags match a configured binding. It does not
launch another Basic Memory process, search unrelated projects implicitly, or
write memory. Bounds are 512 directory entries, 32 matching notes, 64 KiB per
note, and 4,000 injected characters per note; symlinks are rejected. Enabling
memory makes `rule_reconciliation` mandatory, and recognized repository
mutations stay blocked until its audit succeeds. The plugin never writes memory.

Each consumer has its own pool unless the operator deliberately shares one:
distinct `memoryDirectory` roots are separate pools; the same root with different
`memoryBindings` gives consumers separate tag-scoped views of one shared pool.
Basic Memory `0.23.2` supports multiple projects/workspaces, but the default
deployment restricts the MCP server to one project with `basic-memory mcp
--project`. `BASIC_MEMORY_DEFAULT_PROJECT` remains the fallback project
(`computer-assistant`) when a request has no project selector. Set
`OPENCODE_MEMORY_CROSS_PROJECT=true` in the server/MCP environment as the explicit
opt-in to omit `--project`; unset, empty, or `false` keeps the single-project
restriction, and any other value fails startup with exit 2. Runtime repair
detection defaults to `computer-assistant`; its `--allow-non-default` option is
for repair detection, not model-driven project selection. Cross-project access
is an explicit operator choice and does not alter the plugin's configured
`memoryProject`, `memoryDirectory`, or `memoryBindings` selection.

The default deployment also denies `basic-memory_list_memory_projects`. To make
project discovery available in a cross-project deployment, allow that tool in
the selected OpenCode permissions; a caller can then target a project with a
tool's `project` or `project_id` argument, and `search_notes` supports
`search_all_projects: true`. Keep the canonical example closed unless explicitly
opting in: it sets the environment value to `false` and retains the project-list
deny. Project creation/deletion (`basic-memory_create_memory_project` and
`basic-memory_delete_project`), workspace listing (`basic-memory_list_workspaces`),
`view_note` (`basic-memory_view_note`), `move_note` (`basic-memory_move_note`),
`read_content` (`basic-memory_read_content`), schema tools, and compatibility
`search`/`fetch` remain denied. The other note tools remain subject to the
selected config's permissions.

## Follow the orchestration contract

- Keep the parent delegation-only. Run children in the background.
- Create exactly one Todo for each child launch. Its leading text must match the
  child's description exactly; never put session IDs in shared Todo text.
- Use configured `maxConcurrent` from `1..10` as the sole child-admission gate.
- Children must not commit, push, or launch nested agents. Preserve separate
  approval for any parent commit or push.

## Verify and report honestly

- Restart OpenCode, run the consumer repository's own gates, and record each
  exact command and exit code. Update the consumer's existing roadmap or change
  ledger with the outcome and observed evidence when it has one.
- Source inspection and package tests are not live acceptance. Keep visible or
  runtime-dependent claims pending until fresh host evidence exists.
- Report missing dependencies, unavailable providers, failed gates, and live
  checks not performed. Never promote a claim based only on deployment output.

## Observed downstream pitfalls

- Guessing model IDs instead of checking the selected provider catalog.
- Provider plugins whose session/tool hooks fire for every provider.
- Endpoint discovery that shells out to a missing binary, then silently falls
  back to an unreachable host.
- Confusing loaded-context headroom with the compaction buffer.
- Documentation drifting from real test counts.
- Repository renames breaking hardcoded absolute paths.
- Unknown agent IDs receiving zero tools under a phase/tool-allowlist plugin.

## Usage guide

For request examples, prerequisites, verification, and safety guidance, read
[`README.md`](./README.md).
