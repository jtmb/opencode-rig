# Task Memory Usage

This guide explains how to use the `task-memory` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `memory`

Tags: `memory`, `preferences`, `decisions`, `pending`

## Purpose and when to use it

Use `task-memory` to preserve durable context across sessions in Basic Memory,
a local-first Markdown knowledge base shared by the user and the assistant.

Appropriate requests include:

- "Remember that I prefer direct automation with verification."
- "What did we decide about screenshots?"
- "Continue where we left off yesterday."
- "Forget that outdated hardware fact."
- "Show pending work that still has a concrete next step."

Do not use memory as a substitute for inspecting current system, project, or
application state.

## Prerequisites and setup verification

- The `basic-memory` MCP server is registered in the v2 config and launched
  through `scripts/basic-memory-mcp.sh`, which applies an adaptive user-cgroup
  memory budget and fails closed without a limiter.
- The project is `computer-assistant` at
  `~/Documents/computer-assistant/basic-memory/` (owner-only, `700`), with its
  SQLite index and the FastEmbed `bge-small-en-v1.5` model cached locally.
- The wrapper's resolved limiter and budget can be checked read-only:

  ```bash
  platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh --verify-only
  ```

- Registration and connection:

  ```bash
  opencode mcp list   # basic-memory connected
  ```

Only the core nine tools are exposed (`search_notes`, `read_note`,
`write_note`, `edit_note`, `delete_note`, `build_context`, `recent_activity`,
`list_directory`, `basic_memory_diagnostics`); the project/workspace managers,
schema tools, `move_note`, `view_note`, `read_content`, and the compatibility
`search`/`fetch` tools are hidden by `permissions` deny entries.

## How to request it

Ask in ordinary language. The user does not need to know titles, folders, or
tool names.

Example requests:

- "Remember this durable preference."
- "Search memory for microphone setup."
- "List pending items."
- "Remove the obsolete note about the old printer."

The agent should read narrowly with `search_notes`/`build_context` and avoid
dumping the whole knowledge base into a conversation.

## Worked workflow and expected result

A representative retrieval workflow:

1. `recent_activity` to see recently changed notes.
2. `search_notes` with task-relevant terms.
3. `read_note` the best hit, or `build_context` to pull in related notes.

A representative write workflow:

1. Decide whether the fact is durable and appropriate (see the rules below).
2. Confirm with the user before recording personal facts or decisions.
3. `write_note` with a short title, a `directory` such as `preferences` or
   `decisions`, a `note_type`, tags, and a concise body. Relations use
   `[[Other note title]]`.

Corrections use `edit_note` (append, replace a section, or find-replace).
Deletion uses `delete_note` only after an explicit confirmation in the moment;
the tool deletes files, so never bulk-delete a directory.

Expected result: the relevant note is retrieved or changed deliberately, and
the agent reports the note title and its location (permalink) when useful
without exposing unrelated notes.

## Note types and tags

- `preference` — explicit durable user choices.
- `system` — verified hardware, OS, or application facts.
- `workflow` — tested procedures that succeeded on this machine.
- `decision` — user-approved implementation or policy choices.
- `pending` — unfinished work with a concrete next step.

Keep notes short and link related notes by title so `build_context` can follow
the graph.

## Verification and known limitations

The agent verifies writes by reading the note back with `read_note` or by
finding it again with `search_notes`.

Known limitations:

- Search is hybrid (semantic plus keyword) and can miss differently worded
  notes; try several terms or `build_context` from a related note.
- Notes have no expiry field; retire stale pending items with `edit_note` or
  `delete_note` instead of leaving contradictions.
- Writes apply directly with no preview; the confirmation rule below is the
  guardrail.
- The legacy JSON store and `assistant-memory.py` are retired after the M2
  migration and must not be used for new writes.

## Troubleshooting

- `basic-memory` not connected: check `opencode mcp list`, then the wrapper
  with `--verify-only`; a missing limiter or binary exits `2` with a reason.
- Permission error: confirm the project directory is owned by the user with
  mode `700`; do not broaden permissions.
- Empty search result: try broader terms, `recent_activity`, or
  `list_directory`.
- Wrong note edited: `read_note` first; `edit_note` requires an exact title,
  permalink, or memory URL.
- Startup slow or memory pressure: the wrapper bounds the server; report the
  symptom instead of removing the limiter.

## Safety, confirmation, and elevation

The agent must never store:

- Passwords.
- API keys or access tokens.
- Private keys.
- Payment details.
- MFA codes.
- Dictated private content.
- Whole chats or unrelated personal details.

Ask before deleting a note, and ask before recording sensitive personal
context even when it is not on the forbidden list. This skill does not require
administrator elevation for normal memory operations.

## Related skills and documents

- [`routine-automation`](../routine-automation/README.md) can use a remembered
  tested workflow as automation input.
- [`system-troubleshooting`](../system-troubleshooting/README.md) can verify
  or replace stale system facts.
- The bounded launcher is documented in `docs/scripts/basic-memory-mcp.md`
  in the repository.
- The canonical catalog entry is in `skills/README.md`.
