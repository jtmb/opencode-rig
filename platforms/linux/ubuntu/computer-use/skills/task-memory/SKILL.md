---
name: task-memory
description: Store and retrieve durable user preferences, verified computer facts, workflow decisions, and pending tasks in the local Basic Memory knowledge base. Use when the user says remember, forget, continue later, what did we decide, or when durable context would prevent repeated setup. Never store credentials or full private conversations.
metadata:
  schema-version: "1"
  category: "memory"
  tags: "memory,preferences,decisions,pending"
---

# Task Memory

Use the `basic-memory` MCP tools: `recent_activity`, `search_notes`,
`build_context`, `read_note`, `write_note`, `edit_note`, `delete_note`, and
`list_directory`. The knowledge base is owner-only Markdown plus a local
SQLite index at `~/Documents/computer-assistant/basic-memory/`, served under
the adaptive memory budget in `scripts/basic-memory-mcp.sh`.

## Read narrowly

- `recent_activity` orients you in recently changed notes before a memory task.
- `search_notes` for task-relevant terms; do not dump the whole knowledge base
  into the conversation.
- `build_context` follows relations around a note when a broader picture is
  needed.
- `read_note` reads one exact note once search has identified it.

## What belongs in notes

- `preference`: explicit, durable user choices.
- `system`: verified hardware, OS, or application facts.
- `workflow`: a tested procedure that succeeded on this machine.
- `decision`: a user-approved implementation or policy choice.
- `pending`: unfinished work with a concrete next step.

Set `note_type` and tags accordingly, and keep each note short.

## Write deliberately

- `write_note` applies directly; there is no preview step. Confirm with the
  user before recording a personal fact or a durable decision, and prefer a
  short pending note when uncertain.
- `edit_note` corrects or extends a note; replace obsolete facts instead of
  accumulating contradictions.
- `delete_note` only after an explicit confirmation in the moment, and never
  bulk-delete a directory.
- Reference related notes by title in a relation (`[[Title]]`) so
  `build_context` can navigate the knowledge base.

## Rules

- Never store passwords, API keys, tokens, private keys, payment details, MFA
  codes, dictated private content, or whole chats.
- Do not record guesses as facts. Prefer a short pending item when uncertain.
- Do not silently remember incidental personal details.
- The legacy JSON store and `assistant-memory.py` are retired after the M2
  migration; use Basic Memory only.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
