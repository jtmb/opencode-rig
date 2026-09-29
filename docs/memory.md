# Memory

The assistant's durable memory is **Basic Memory** — local-first Markdown notes
plus a SQLite index with hybrid search, exposed over MCP. It replaced the
legacy owner-only JSON store (`assistant-memory.py`) in the 2026-09-18 M2
migration; the legacy files were removed on 2026-09-18 after the explicit
deletion confirmation.

## Layout

| Piece | Location |
|-------|----------|
| Knowledge base (notes) | `~/Documents/computer-assistant/basic-memory/` (owner-only, `700`) |
| Index | project SQLite database under the same directory |
| Embedding model | FastEmbed `bge-small-en-v1.5`, cached in `~/.cache/huggingface` |
| Launcher | `scripts/basic-memory-mcp.sh` (adaptive user-cgroup budget, `prlimit` fallback, fail closed) |
| Registration | v2 `mcp.servers` entry named `basic-memory` |

## Tools

The server exposes 21 tools; the selected project's effective permissions deny
11 management tools, leaving the nine core note tools plus
`basic-memory_list_memory_projects`:

| Tool | Use |
|------|-----|
| `recent_activity` | Orient in recently changed notes |
| `search_notes` | Hybrid search for task-relevant notes |
| `build_context` | Follow relations around a note |
| `read_note` | Read one exact note |
| `write_note` | Create a note |
| `edit_note` | Append, replace, or find-replace in a note |
| `delete_note` | Delete one note (explicit confirmation required) |
| `list_directory` | Browse the note tree |
| `basic_memory_diagnostics` | Version and configuration diagnostics |

The selected project and the separate pilot profile deny schema tools,
workspace listing, project creation and deletion, `move_note`, `view_note`,
`read_content`, and compatibility `search`/`fetch`. Build's `allow */*` comes
after project-wide rules, so its own management denies must follow that wildcard
to be effective. The selected project allows `basic-memory_list_memory_projects`
for bounded discovery; the opt-in does not enable cross-project access by itself.

## Cross-project access

`OPENCODE_MEMORY_CROSS_PROJECT` controls the actual Basic Memory server scope:

- Unset, empty, or `false` (the default) starts `basic-memory mcp --project
  <project>`, restricting the server to `BASIC_MEMORY_PROJECT` (default
  `computer-assistant`).
- Exactly lowercase `true` omits `--project`, allowing the MCP server to route
  to other existing projects. `BASIC_MEMORY_DEFAULT_PROJECT` still points at
  the configured default, so requests without `project` or `project_id` stay on
  that project.
- Any other value is malformed and aborts startup with an error; it never
  enables cross-project mode.

In cross-project mode, choose a project with a tool's `project` or `project_id`
field. `search_notes` can search every accessible project only when explicitly
called with `search_all_projects: true`; a specific project selector takes
precedence. The project-list tool is allowed in the opted-in machine config to
find existing project names and IDs. Project IDs disambiguate projects across
workspaces, so `basic-memory_list_workspaces` is not needed and remains denied.
The project-list permission is static in OpenCode; the environment variable
gates Basic Memory's server scope, not tool visibility. Project creation and
deletion, note moves, raw-content/view tools, schema tools, and compatibility
`search`/`fetch` remain denied. Access is limited to projects available to the
local Basic Memory configuration and its credentials; the switch neither
creates projects nor changes the automatic `computer-assistant`
rule-reconciliation binding below.

### Setting the machine-local opt-in

The server reads `OPENCODE_MEMORY_CROSS_PROJECT` from its process environment,
so the opt-in is set on the selected OpenCode service, not in `opencode.json`:

```bash
opencode service set env OPENCODE_MEMORY_CROSS_PROJECT true
opencode service get env OPENCODE_MEMORY_CROSS_PROJECT
```

`opencode service set` takes `<key> <value> [<env-value>]`: with `key=env`,
`value` is the variable name and `env-value` is its value. `env` is a
recognized service key — `opencode service get env <NAME>` is accepted while a
bogus key fails with `Unknown service config key`. Unset it with
`opencode service unset env OPENCODE_MEMORY_CROSS_PROJECT`. Setting or
unsetting service configuration stops the shared background service, and its
next start applies the environment; start it explicitly with
`opencode service start` when needed. The value is machine-local and persists
in the private service configuration (`~/.config/opencode/service.json`).

Not verified here: no write was applied on the running regular service, which
stores no service environment (`opencode service get` prints `{}`) and reports
the variable unset. The checked-in `opencode.json` sets no environment for
`basic-memory`, and the example config sets the opt-in to `false`. Confirm
routing to a distinct existing project only after a supported reload; do not
treat an MCP connection as proof.

## Using it

- Load the `task-memory` skill for request handling and the safety rules.
- Read narrowly: `recent_activity`, then `search_notes`/`build_context`, then
  `read_note`.
- `write_note` and `edit_note` apply directly. Confirm before recording a
  personal fact or durable decision, replace obsolete facts instead of
  accumulating contradictions, and ask before deleting a note.
- Never store passwords, API keys, tokens, private keys, payment details, MFA
  codes, dictated private content, or whole chats.

## Project rule reconciliation

The `orchestration-policy` server plugin performs the Open Rig lookup
deterministically. Its project configuration binds the `computer-assistant`
knowledge base directory to the `open-rig` and `opencode-rig` tags. Every new
session starts due; the hook reads only regular, non-symlink Markdown files in
that directory, selects tagged `decision` and `preference` notes, and injects
only size-bounded contents as untrusted reference data. It does not launch a
second Basic Memory process, and unrelated projects are not searched
implicitly.

After review, the agent calls `rule_reconciliation` with an aligned, resolved,
or conflicting outcome. Recognized repository mutation tools remain blocked
until that audit succeeds. Reported conflicts require an observed question-tool
round trip and an explicit resolution. The next check becomes due after the
configured number of user turns: `reconciliationIntervalTurns`, default `10`,
bounded from `1` through `100`.

The audit stores the project, bindings, lookup digest, note count, outcome, and
conflict resolution in plugin storage. It does not write, delete, or overwrite
Basic Memory. A service restart loses in-memory turn counters and safely makes
the next request due as a new-session check.

A failed lookup cannot be marked aligned. It is treated as a conflict and can
proceed only after the question tool records the operator's explicit resolution,
which avoids both silent fail-open behavior and an unresolvable fail-closed
deadlock.

## Operations

- Bounded launcher check:
  `platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh --verify-only`
  prints the binary, project scope, limiter, and memory/swap budget.
- Connection: `opencode mcp list` reports `basic-memory connected`.
- Version pin: `0.23.2`, verified by
  [`setup-computer-assistant.sh --verify-only`](scripts/setup-computer-assistant.md).
- The budget is 20% of effective memory and 25% of free swap, with a 64 MiB
  floor, matching the source-control plugin's bounded MCP child.
