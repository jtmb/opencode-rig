# `opencode-db-maintain.py`

Safe maintenance for OpenCode's SQLite store (`opencode.db`). It addresses two
well-known unbounded-growth problems and is read-only by default.

- **Freelist bloat.** OpenCode's store uses `auto_vacuum=OFF`, so deleted rows
  free pages inside the file but never return disk space to the filesystem.
- **Live event-log bloat.** The `event` table keeps a full snapshot for every
  `message.updated.1` and `message.part.updated.1` streaming update forever,
  amplified by full `summary.diffs` patch text. `VACUUM` alone cannot help there
  because superseded rows must be deleted first.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --stats
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --dry-run
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --apply
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --apply --keep 20 --batch 5000
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --apply --vacuum-only
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--db PATH` | resolved | Path to `opencode.db` |
| `--stats` | — | Read-only health report |
| `--dry-run` | yes (without `--apply`) | Report prune candidates without changing anything |
| `--apply` | — | Perform writes |
| `--vacuum-only` | off | Skip row deletes; only checkpoint, VACUUM, and harden |
| `--keep N` | `10` | Newest N sessions exempt from compaction |
| `--batch N` | `2000` | Delete batch size |
| `--no-backup` | off | Skip the backup (not recommended) |
| `--skip-lock-check` | off | Apply even if another process may hold the DB |
| `--force` | off | Skip the confirmation prompt with `--apply` |
| `--version` | — | Print the script version |

Conflicting or invalid options exit `2`: `--apply` with `--dry-run`,
`--apply` with `--stats`, negative `--keep`, or `--batch` below 1.

## Database resolution

`resolve_db()` prefers, in order: `--db`, the `OPENCODE_DB` environment
variable, then the existing candidate under `$XDG_DATA_HOME/opencode/` or
`~/.local/share/opencode/`, then a macOS path. When multiple candidates exist,
the **largest** file wins; if none exists, the standard Linux path is used and
the later file check fails with an error.

## Statistics (`--stats`)

`collect_stats()` opens the database read-only (`mode=ro`) and reads:

- `PRAGMA page_size`, `page_count`, `freelist_count`, `journal_mode`,
  `auto_vacuum`, and the on-disk file size.
- Row counts and `sum(length(data))` for `event`, `message`, `part`, `session`,
  and `event_sequence` (the last has no `data` column).
- An `event` breakdown grouped by `type`, ordered by byte size.

The report shows storage totals, live data versus freelist, the per-table
breakdown, and the per-event-type breakdown with percentages. It warns when the
file exceeds 1 GB and notes when `auto_vacuum` is OFF with a non-empty freelist.

## Prune candidates (read-only)

Candidate analysis runs even in dry-run mode. Two kinds of event rows are
identified:

### Orphaned events

Events whose `aggregate_id` (session) no longer exists, found by a `LEFT JOIN`
against `session`. Events belonging to an owned aggregate are excluded.

### Superseded snapshots

For `message.updated.1` (payload key `info`) and `message.part.updated.1`
(payload key `part`), rows are grouped by the message/part id. Within each
group, the single newest row (maximum `seq`) is retained and the older rows are
candidates. The analysis is deliberately conservative:

- Owned aggregates (`event_sequence.owner_id` present, i.e. a sync/workspace
  owner) are never touched.
- The newest `--keep` sessions are exempt.
- Malformed JSON payloads are skipped.
- A candidate is deleted only if its projection row still exists in `message`
  or `part`; otherwise it is kept rather than guessed at.

The report prints row counts and byte sizes for both categories, the exempt
session count, and an estimate of the file size after pruning and VACUUM.

## Applying (`--apply`)

Order of operations:

1. **Lock check.** `db_holder()` runs `fuser` against the exact path (falling
   back to a `/proc` scan that only applies to the live DB path and excludes
   this repository's maintenance processes). If a holder is found and
   `--skip-lock-check` was not passed, it refuses and exits `3`.
2. **Pre-check.** `PRAGMA integrity_check` must return `ok`, or it exits `4`.
3. **Confirmation.** Unless `--force` or stdin is not a TTY, it prompts with the
   file size and row count.
4. **Backup.** Unless `--no-backup`, it writes `<db>.backup.<timestamp>` using
   SQLite's online backup API (`pages=100`, `sleep=0.050`), which captures
   committed WAL data. The backup's integrity is verified; failure exits `5`.
5. **Delete.** If there are candidates and not `--vacuum-only`, it deletes the
   orphaned and superseded event ids in `--batch`-sized transactions (WAL
   journal mode), printing progress. Only `event` rows are deleted;
   `event_sequence` numbering is left intact.
6. **VACUUM and harden.** `PRAGMA auto_vacuum=INCREMENTAL`, then `VACUUM`, then
   `PRAGMA journal_mode=WAL` (VACUUM can reset the journal mode).
7. **Post-check.** `PRAGMA integrity_check` must pass, or it exits `6` and
   prints the restore command for the backup.
8. **Report.** Prints before/after sizes, bytes reclaimed, and the backup path.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `2` | Invalid arguments or database not found |
| `3` | Refused to apply because a process holds the DB (use `--skip-lock-check` to override) |
| `4` | Pre-check `integrity_check` failed |
| `5` | Backup integrity check failed |
| `6` | Post-check `integrity_check` failed (restore the backup) |

## Safety model

- Read-only by default; every write requires `--apply`.
- The newest snapshot per message/part is always retained.
- Owned aggregates, the newest sessions, and rows with missing projections are
  never deleted.
- Deletes are batched so large databases do not overflow the journal.
- Integrity is verified before and after, and a verified backup is created
  before any write.
- The script refuses to run against a held database unless explicitly forced.

## Notes and limitations

- The `event` table is the only table modified; message and part projections are
  only read.
- Prefer running `--apply` while OpenCode is **closed**, which is how
  [`opencode-maintenance-cron.sh`](opencode-maintenance-cron.md) invokes it.
- Keep the backup until OpenCode has been verified working again.
- `fuser` is optional; the `/proc` fallback only detects the live database path.

## Related

- [`opencode-chat-backup.md`](opencode-chat-backup.md) — back up chats before
  compaction.
- [`opencode-maintenance-cron.md`](opencode-maintenance-cron.md) — the scheduled
  wrapper.
- The `opencode-db-maintenance` skill — the operational workflow and decision
  guidance.
