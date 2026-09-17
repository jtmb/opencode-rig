# Task Memory Usage

This guide explains how to use the `task-memory` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `memory`

Tags: `memory`, `preferences`, `decisions`, `pending`

## Purpose and when to use it

Use `task-memory` to preserve durable context across sessions.

Appropriate requests include:

- "Remember that I prefer direct automation with verification."
- "What did we decide about screenshots?"
- "Continue where we left off yesterday."
- "Forget that outdated hardware fact."
- "Show pending work that still has a concrete next step."

Do not use memory as a substitute for inspecting current system, project, or
application state.

## Prerequisites and setup verification

The private store is managed by the repository's `assistant-memory.py`
utility and stored as an owner-only file:

```text
~/Documents/computer-assistant/memory.json
```

The expected directory mode is `700` and file mode is `600`. Setup
initializes the store with:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py init
```

Unlike record changes, `init` performs filesystem and permission work without
`--apply`.

Validate an existing store with:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py validate
```

## How to request it

Ask in ordinary language. The user does not need to know categories, sources,
IDs, or expiry formats.

Example requests:

- "Remember this durable preference."
- "Search memory for microphone setup."
- "List pending items."
- "Remove the obsolete entry with this ID."

The agent should read narrowly and avoid dumping the entire memory store into
a conversation.

## Worked workflow and expected result

A representative retrieval workflow is:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py search "audio microphone"
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py list --category pending
```

List and search support optional `--category`, `--source`, `--all`, and
`--json` filters. Without `--all`, expired entries are hidden.

A representative write workflow previews first:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py remember "Use local speech models" \
  --category preference --source user
```

After reviewing the preview, the same command with `--apply` writes the
record and returns its generated ID and timestamps. There is no separate
`--dry-run` flag.

A representative removal workflow is:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py forget MEMORY_ID
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py forget MEMORY_ID --apply
```

A representative pruning workflow is:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py prune
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py prune --apply
```

Expected result: relevant records are retrieved or changed deliberately. The
agent reports the stored text, category, source, expiry, and ID when useful,
without exposing unrelated memories.

## Memory categories and sources

Use:

- `preference` for explicit durable user choices.
- `system` for verified hardware, OS, or application facts.
- `workflow` for tested procedures that succeeded on this machine.
- `decision` for user-approved implementation or policy choices.
- `pending` for unfinished work with a concrete next step.

Use:

- `user` for direct user statements.
- `observed` for local evidence.
- `verified` only after an acceptance test.

Add an expiry date in `YYYY-MM-DD` format when a fact or pending item can
become stale. To replace obsolete information, forget the old record and
remember the corrected one; there is no update subcommand.

## Verification and known limitations

The agent should validate the store after maintenance and preserve exact IDs
for later correction or deletion.

Known limitations:

- Search is textual and may miss differently worded records.
- Expired records require `--all` to appear.
- There is no merge or update operation.
- Duplicate detection applies to identical category and text.
- Memory can become stale; prefer a short pending item over recording a guess
  as a fact.

## Troubleshooting

- Permission error: inspect the store path and modes, then restore owner-only
  permissions through `init` or explicit permission repair.
- Unexpected empty result: retry with `--all`, a broader term, category, or
  source filter.
- Credential-like text rejected: that refusal is intentional. Do not attempt
  to disguise the value.
- ID not found: list or search for the current ID rather than guessing.
- Conflicting facts: replace the obsolete fact instead of accumulating
  contradictions.

## Safety, confirmation, and elevation

The agent must never store:

- Passwords.
- API keys or access tokens.
- Private keys.
- Payment details.
- Dictated private content.
- Whole chats or unrelated personal details.

The script's credential rejection is only a guardrail. This skill does not
require administrator elevation for normal memory operations.

## Related skills and documents

- [`routine-automation`](../routine-automation/README.md) can use a remembered
  tested workflow as automation input.
- [`system-troubleshooting`](../system-troubleshooting/README.md) can verify
  or replace stale system facts.
- The canonical catalog entry is in `skills/README.md`.
