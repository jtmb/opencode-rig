# `basic-memory-mcp.sh`

Launches the Basic Memory MCP server for the `computer-assistant` project inside
an adaptive user-cgroup memory budget. It is registered as the `basic-memory`
MCP server in the v2 config; the server's rarely used tools are hidden with
`permissions` deny entries so only the core note tools remain.

```bash
platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh --verify-only
```

## What it does

- Resolves `basic-memory` from `PATH` (or `BASIC_MEMORY_BIN`) and exits `2`
  when it is missing or not executable.
- Computes an adaptive budget from current host and cgroup availability: 20% of
  effective memory and 25% of free swap, with a 64 MiB floor. The fractions
  mirror the source-control plugin's bounded GitHub MCP child.
- Runs `basic-memory mcp --project <project>` under:
  - `systemd-run --user --pipe --wait --collect` with `MemoryMax` and
    `MemorySwapMax` when the user systemd manager is available, or
  - `prlimit --as=<budget>` otherwise.
- Fails closed when neither limiter is available; the server never starts
  unbounded.

## Options and environment

| Option / variable | Meaning |
|-------------------|---------|
| `--verify-only` | Print the binary, project, limiter, and budget without starting the server |
| `-h`, `--help` | Show usage |
| `BASIC_MEMORY_PROJECT` | Project name (default `computer-assistant`) |
| `BASIC_MEMORY_BIN` | Executable override (default: `PATH` lookup) |

## Verification

`--verify-only` prints one `key=value` line per item:

```text
binary=/home/james/.local/bin/basic-memory
project=computer-assistant
limiter=systemd-run
available_bytes=...
memory_budget_bytes=...
swap_budget_bytes=...
```

A bounded stdio smoke (initialize + `tools/list`) lists all 21 Basic Memory
tools; the deployed v2 config hides 12 of them (`read_content`, `view_note`,
`move_note`, the project/workspace managers, the schema tools, and the
compatibility `search`/`fetch`) through `permissions` deny entries, leaving
nine core tools: `search_notes`, `read_note`, `write_note`, `edit_note`,
`delete_note`, `build_context`, `recent_activity`, `list_directory`, and
`basic_memory_diagnostics`.

## Safety

- Bounded, fail-closed memory: the server cannot exhaust the login session
  while indexing or embedding notes.
- The server reads and writes only the project directory
  (`~/Documents/computer-assistant/basic-memory/`, owner-only) and its local
  SQLite index.
- Never store passwords, tokens, private keys, payment details, MFA codes, or
  whole conversations in notes; the `task-memory` skill carries that rule.
