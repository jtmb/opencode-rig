# Repo Onboarding Usage

Use the [agent-facing workflow](./SKILL.md) to onboard a downstream consumer
repository to OpenCode v2 with the canonical Open Rig harness.

Category: `maintenance`

Tags: onboarding,downstream,opencode,mcp,memory,integration

## Purpose and when to use it

Use `repo-onboarding` when an agent must set up a downstream repository,
migrate its OpenCode v2 configuration, choose between deployed global
capabilities and repo-local behavior, or verify an existing integration. It
keeps consumer configuration grounded in the actual Open Rig checkout and
target runtime.

## Prerequisites and setup verification

- Identify the consumer repo and preserve its dirty work.
- Locate the Open Rig checkout by finding both root `bootstrap.sh` and
  `platforms/linux/ubuntu/computer-use/`; do not assume a path.
- Confirm the selected OpenCode binary reports v2.
- Inventory `opencode.json`, `.opencode/`, plugins, agents, skills, and
  `mcp.servers`; inspect provider/model availability in the selected target.
- Keep discovery read-only until the operator approves a specific apply target.

## How to request it

Ask for the repository and desired integration outcome, for example:

- "Onboard this consumer repo to our OpenCode v2 harness; inspect first and
  preserve all dirty work."
- "Compare this repo's MCP and plugin setup with the canonical Open Rig
  checkout; reuse existing global capabilities."
- "Set up only the consumer-specific agent and verify the model IDs against the
  provider catalog."

## Worked workflow and expected result

1. Inventory the consumer and locate the canonical harness without assuming a
   home-directory path.
2. Choose the deployed global skills/commands/MCP stack or a repo-local plugin
   for a genuinely consumer-specific capability; avoid duplicate integrations.
3. Verify actual provider/model IDs, agent IDs, permissions, and existing MCP
   declarations before editing `opencode.json`; preserve existing settings and
   migrate selectively to the v2 schema.
4. For a global deployment, verify first, select the intended v2 config
   directory, then use `setup-opencode.sh --apply`. Restart OpenCode before
   expecting newly deployed skills to load.
5. Declare Basic Memory and GitHub under `mcp.servers` using the absolute paths
   to the canonical `basic-memory-mcp.sh` and `github-mcp.sh` wrappers. Keep
   secrets out of config, logs, and evidence. Playwright is provided through
   skills/CLI plugins, not an always-on MCP.
6. If opting into policy memory, set `memoryProject`, an absolute non-symlink
   `memoryDirectory`, and one or more `memoryBindings` tags together in
   `orchestration-policy.options`. Separately register `basic-memory` under
   `mcp.servers` with the absolute canonical `basic-memory-mcp.sh` path so the
   agent receives its note tools. Basic Memory is local Markdown plus a SQLite
   index, organized into projects (workspaces).
7. Choose the consumer's pool deliberately: distinct `memoryDirectory` roots
   isolate pools; the same root with different bindings shares storage while
   giving each consumer a tag-scoped view. Only matching `decision` and
   `preference` notes are injected, unrelated projects are not searched
   implicitly, and `rule_reconciliation` must pass before recognized mutations.

Expected result: a minimal, target-verified consumer setup with existing
capabilities reused, explicit deployment/restart status, and exact gate
commands and exit codes recorded in the consumer's existing roadmap/change
ledger when available.

## Verification and known limitations

`bootstrap.sh` is verify-only by default and writes only with `--apply`;
`setup-opencode.sh --apply` recursively deploys skills, commands, and agents to
the selected v2 config directory. Skills do not hot-reload. Run the consumer
repository's own gates and perform fresh live checks after restart. Source and
test evidence alone are not live acceptance; keep visible claims pending until
host evidence exists.

The wrappers require their real runtime prerequisites and authentication: the
GitHub wrapper uses saved `gh` login and rejects inherited `GH_TOKEN` and
`GITHUB_*`; Basic Memory fails closed when it cannot establish its memory
budget. The policy-memory lookup allows at most 512 directory entries, 32
matching notes, 64 KiB per note, and 4,000 injected characters per note, and
rejects symlinks. It selects only tagged `decision`/`preference` notes from the
configured directory, never writes memory, and requires a successful
`rule_reconciliation` before recognized repository mutations.

Basic Memory `0.23.2` supports multiple projects, but the default deployment
restricts its MCP server to one project with `basic-memory mcp --project` and
denies `basic-memory_list_memory_projects`. `BASIC_MEMORY_DEFAULT_PROJECT`
(`computer-assistant` by default) remains the fallback when no project selector
is supplied. Set `OPENCODE_MEMORY_CROSS_PROJECT=true` in the server/MCP
environment to explicitly omit `--project`; unset, empty, or `false` keeps the
single-project restriction, and any other value fails startup with exit 2.
`mcp_runtime.py` defaults repair checks to `computer-assistant`;
`--allow-non-default` only relaxes that repair check.

In a cross-project deployment, permit `basic-memory_list_memory_projects` in
the selected OpenCode permissions to enable project discovery. Callers may then
target a project with a tool's `project` or `project_id` argument, and
`search_notes` supports `search_all_projects: true`. The canonical example stays
closed unless explicitly opted in: its environment value is `false` and its
project-list deny remains. Project creation/deletion
(`basic-memory_create_memory_project`, `basic-memory_delete_project`), workspace
listing (`basic-memory_list_workspaces`), `view_note` (`basic-memory_view_note`),
`move_note` (`basic-memory_move_note`), `read_content`
(`basic-memory_read_content`), schema tools, and compatibility `search`/`fetch`
remain denied. Cross-project MCP access does not change the policy-memory
plugin's explicit `memoryProject`, `memoryDirectory`, or `memoryBindings`
selection.

## Troubleshooting

- A provider/model is unavailable: recheck the selected runtime's catalog and
  authentication; replace guessed IDs with discovered IDs.
- An agent receives no tools: confirm its ID is recognized by the configured
  phase/tool-allowlist plugin.
- Hooks run for unexpected providers: inspect provider-plugin registration and
  whether a session/tool hook is global to every provider.
- Discovery falls back to an unreachable endpoint: verify the helper binary
  exists and report discovery errors instead of accepting a silent fallback.
- Memory reconciliation blocks writes: verify the paired project/directory
  options, absolute path, note types/tags, and successful `rule_reconciliation`.
- After a repo rename, stale absolute paths or README test counts remain:
  search for the old root and compare documentation with actual test output.
- Keep loaded-context headroom separate from the compaction buffer; measure and
  report each value independently.

## Safety, confirmation, and elevation

- Obtain approval before any configuration or deployment write; select the exact
  target and pass `--apply` explicitly.
- Keep provider and GitHub secrets in their supported auth stores, never in
  source, MCP config, logs, transcripts, or evidence.
- Preserve unrelated files and dirty work. Never patch installed OpenCode
  binaries or distribution files.
- Do not claim live behavior before restart and host verification. Do not commit
  or push without separate explicit approval for each action.

## Related skills and documents

- [`agent-orchestration`](../agent-orchestration/README.md) defines the parent,
  child, Todo, and verification contract.
- [`skill-maintenance`](../skill-maintenance/README.md) covers canonical skill
  source, indexing, and validation.
- [`development-conventions`](../development-conventions/README.md) routes
  Open Rig v2 configuration and documentation work.
- [`OpenCode skills catalog`](../README.md) lists the canonical skill bundle.
