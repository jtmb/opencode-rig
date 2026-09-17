---
name: task-memory
description: Store and retrieve durable user preferences, verified computer facts, workflow decisions, and pending tasks in a private local memory file. Use when the user says remember, forget, continue later, what did we decide, or when durable context would prevent repeated setup. Never store credentials or full private conversations.
metadata:
  schema-version: "1"
  category: "memory"
  tags: "memory,preferences,decisions,pending"
---

# Task Memory

Use `~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py`.
The owner-only store is
`~/Documents/computer-assistant/memory.json`.

## Read narrowly

Search only for context relevant to the current task:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py search "audio microphone"
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py list --category pending
```

Do not dump the entire store into every conversation.

## What belongs in memory

- `preference`: explicit, durable user choices.
- `system`: verified hardware, OS, or application facts; add an expiry
  when the fact can become stale.
- `workflow`: a tested procedure that succeeded on this machine.
- `decision`: a user-approved implementation or policy choice.
- `pending`: unfinished work with a concrete next step; normally expires.

Use source `user` for direct statements, `observed` for local evidence,
and `verified` only after an acceptance test.

## Write deliberately

Writes preview by default. Review the preview, then add `--apply`:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py remember "Use local speech models" \
  --category preference --source user
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py remember "Use local speech models" \
  --category preference --source user --apply
```

Remove and prune the same way:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py forget MEMORY_ID
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py forget MEMORY_ID --apply
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py prune
```

## Rules

- Never store passwords, API keys, tokens, private keys, payment details,
  dictated private content, or whole chats. The script rejects common
  credential shapes, but that is only a guardrail.
- Do not record guesses as facts. Prefer a short pending item when uncertain.
- Do not silently remember incidental personal details. Explicit user
  preferences and verified machine configuration are appropriate.
- Replace obsolete facts rather than accumulating contradictions.
- Run `python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py validate` after maintenance.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
