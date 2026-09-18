# `assistant-memory.py`

> **Retired.** Basic Memory replaced this store in the 2026-09-18 M2 migration.
> The script and this document remain only until the deletion confirmation in
> `HANDOFF.md`; do not write new memories here.

A small, private JSON memory store for the local computer-assistant skills,
managed only through this script. Reads are safe by default; writes preview
first and require `--apply`. The store lives outside the repository.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py init
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py list
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py search "prefers dark mode"
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py remember "Prefers dark mode" --category preference --source user
python3 platforms/linux/ubuntu/computer-use/scripts/assistant-memory.py validate
```

## Store location and permissions

| Item | Value |
|------|-------|
| Default path | `~/Documents/computer-assistant/memory.json` |
| Override | `ASSISTANT_MEMORY_PATH` environment variable |
| Directory mode | `0700` (enforced) |
| File mode | `0600` (enforced) |
| Lock file | `.memory.lock` beside the store, `0600` |

`validate` fails if the file is not `600`, the directory is not `700`, or
either is not owned by the current user. The parent directory is created and
re-chmodded on every locked access.

## Schema

```json
{
  "version": 1,
  "entries": [
    {
      "id": "mem-20260101T120000Z-1a2b3c4d",
      "category": "preference",
      "text": "Prefers dark mode",
      "source": "user",
      "created_at": "2026-01-01T12:00:00+00:00",
      "updated_at": "2026-01-01T12:00:00+00:00",
      "expires": null
    }
  ]
}
```

- `version` must be `1`.
- `id` must be unique and non-empty.
- `category` is one of `preference`, `system`, `workflow`, `decision`,
  `pending`.
- `source` is one of `user`, `observed`, `verified`.
- `text` must be non-empty.
- `created_at` and `updated_at` must be ISO-8601 parseable.
- `expires` is `null` or a `YYYY-MM-DD` date.

`validate_store()` runs before every read and write, so a corrupted store is
reported rather than silently used.

## Commands

| Command | Writes? | Description |
|---------|---------|-------------|
| `init` | yes | Create an empty owner-only store; idempotent, and re-fixes permissions if it exists |
| `list` | no | List active memories; filters `--category`, `--source`, `--all` (include expired), `--json` |
| `search QUERY` | no | Case-insensitive, all-terms-match search over text; same filters |
| `remember TEXT` | with `--apply` | Add a memory |
| `forget ID` | with `--apply` | Remove one memory by id |
| `prune` | with `--apply` | Remove all expired memories |
| `validate` | no | Validate schema, modes, ownership; print the entry count |

`remember` requires `--category` and `--source`. `search` splits the query on
whitespace and requires every term to appear (case-folded) in the entry text.

### `remember` semantics

- Whitespace in the text is collapsed.
- Empty text is rejected.
- The text is checked against `SECRET_PATTERN`; a match refuses the write with
  "refusing text that looks like a credential".
- `--expires YYYY-MM-DD` sets an optional expiry.
- Without `--apply`: prints `{ "dry_run": true, "would_remember": {...} }` and
  changes nothing.
- With `--apply`: if an entry with the same category and case-folded text
  already exists, it reports `applied: false` with the duplicate. Otherwise it
  creates the entry and prints it. Ids are `mem-<UTC timestamp>-<8 hex>`.

### `forget` and `prune`

Both preview by default and apply with `--apply`. `forget` errors if the id is
not found. `prune` counts entries whose `expires` date is before today.

## Concurrency and atomicity

Every command that touches the store holds a lock:

- `init`, `remember`, `forget`, `prune` take an **exclusive** lock.
- `list`, `search`, `validate` take a **shared** lock.

The lock is an `flock` on `.memory.lock` (`0600`). Writes go to a `mkstemp` temp
file in the store directory, are flushed and `fsync`ed, chmodded `0600`, then
moved into place with `os.replace`. A crash cannot leave a partially written
store.

## Credential rejection

The guardrail pattern rejects:

- `-----BEGIN ... PRIVATE KEY-----`
- `password:` / `passwd=` / `api_key:` / `access_token=` / `secret:` followed by
  a value
- `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` tokens and `sk-` keys of 20+ characters

This is a guardrail, **not** a guarantee. Never deliberately store passwords,
tokens, keys, payment details, or full private conversations. Store only
explicit durable preferences, verified system facts, tested workflows, approved
decisions, and concrete pending work.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Runtime error (invalid store, credential-shaped text, id not found, unsafe permissions, etc.) via `SystemExit` |
| `2` | Argument parsing error (unknown command, missing required option) |

## Notes

- The memory store is outside the repository and never committed.
- `--json` output is suitable for programmatic consumption.
- Related: the `task-memory` skill, [`opencode-chat-backup.md`](opencode-chat-backup.md)
  (a separate, less sensitive export path).
