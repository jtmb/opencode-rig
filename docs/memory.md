# Memory

The assistant's durable memory is **Basic Memory** — local-first Markdown notes
plus a SQLite index with hybrid search, exposed over MCP. It replaced the
legacy owner-only JSON store (`assistant-memory.py`) in the 2026-09-18 M2
migration; the legacy files remain only until the explicit deletion
confirmation recorded in `HANDOFF.md`.

## Layout

| Piece | Location |
|-------|----------|
| Knowledge base (notes) | `~/Documents/computer-assistant/basic-memory/` (owner-only, `700`) |
| Index | project SQLite database under the same directory |
| Embedding model | FastEmbed `bge-small-en-v1.5`, cached in `~/.cache/huggingface` |
| Launcher | `scripts/basic-memory-mcp.sh` (adaptive user-cgroup budget, `prlimit` fallback, fail closed) |
| Registration | v2 config flat `mcp` map, server name `basic-memory` |

## Tools

The server exposes 21 tools; a v2 `permissions` deny list hides 12 of them,
leaving the nine core tools:

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

The hidden tools are the schema tools, project/workspace management,
`move_note`, `view_note`, `read_content`, and the compatibility `search`/`fetch`.

## Using it

- Load the `task-memory` skill for request handling and the safety rules.
- Read narrowly: `recent_activity`, then `search_notes`/`build_context`, then
  `read_note`.
- `write_note` and `edit_note` apply directly. Confirm before recording a
  personal fact or durable decision, replace obsolete facts instead of
  accumulating contradictions, and ask before deleting a note.
- Never store passwords, API keys, tokens, private keys, payment details, MFA
  codes, dictated private content, or whole chats.

## Operations

- Bounded launcher check:
  `platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh --verify-only`
  prints the binary, project, limiter, and memory/swap budget.
- Connection: `opencode mcp list` reports `basic-memory connected`.
- Version pin: `0.23.2`, verified by
  [`setup-computer-assistant.sh --verify-only`](scripts/setup-computer-assistant.md).
- The budget is 20% of effective memory and 25% of free swap, with a 64 MiB
  floor, matching the source-control plugin's bounded MCP child.
