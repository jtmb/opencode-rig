---
name: opencode-db-maintenance
description: Diagnose and reclaim opencode.db SQLite disk usage when the database fills the disk (event-table bloat, freelist pages, VACUUM, prune); back up chats to opencode-backups and manage the weekly maintenance cron job. Use ONLY when the user mentions opencode database size, disk space, opencode.db, VACUUM, prune, chat backup, opencode-backups, cron, or DB maintenance.
---

# OpenCode DB Maintenance

Operator guide for the maintenance scripts in `~/repos/opencode-computer-use/scripts/` (stdlib-only,
no deps), which handle OpenCode's known unbounded SQLite growth at
`~/.local/share/opencode/opencode.db`:

- `opencode-db-maintain.py` — diagnose + prune + vacuum (see below).
- `opencode-chat-backup.py` — export every chat to JSON (see Backup).
- `opencode-maintenance-cron.sh` — weekly wrapper wiring both together
  (see Scheduling).

## Symptom to cause map

There are two distinct bloat mechanisms. Diagnose before fixing —
`VACUUM` alone only helps the first:

1. **Freelist bloat (empty pages).** SQLite defaults to `auto_vacuum=OFF`,
   so deleted sessions leave freelist pages that are never returned to the
   filesystem. File is large but live data is small. Fix: `VACUUM` +
   `auto_vacuum=INCREMENTAL` (upstream issues #16777, #16729, #31526).
2. **Live `event`-table bloat.** The `event` table keeps a full message
   snapshot per `message.updated.1` / `message.part.updated.1` streaming
   update forever, amplified by full `summary.diffs` patch text
   (upstream #33356: 13 GB with freelist ~0%, #41175: 39 GB, #32005,
   #42748, #46138). Here `VACUUM` reclaims ~nothing — superseded rows must
   be deleted first, then `VACUUM`.

## Diagnose (read-only, safe while OpenCode runs)

```bash
python3 ~/repos/opencode-computer-use/scripts/opencode-db-maintain.py --stats
python3 ~/repos/opencode-computer-use/scripts/opencode-db-maintain.py --dry-run [--keep N]
```

How to read the output:

- `freelist` large relative to file (e.g. >20%) with modest `event`
  share → type 1, vacuum-only suffices.
- `event` table dominant (>80% of `sum(length(data))`), `freelist` ~0%,
  top type `message.part.updated.1` or `message.updated.1` → type 2,
  prune-then-vacuum needed.
- `orphaned events` = rows whose session is gone (safe to delete).
- `superseded snapshots` = older full-snapshot rows per message/part id
  (safe: newest per id is always retained).

Manual SQL equivalents (read-only):

```sql
PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count;
PRAGMA journal_mode; PRAGMA auto_vacuum;
SELECT type, count(*), sum(length(data)) FROM event GROUP BY type;
```

## Fix paths

Close OpenCode first whenever `--apply` is used. The script refuses to run
if another process holds the DB (override: `--skip-lock-check`).

```bash
# Full fix: prune orphaned + superseded event rows, then VACUUM + harden
python3 ~/repos/opencode-computer-use/scripts/opencode-db-maintain.py --apply [--keep N]

# Physical reclaim only: no row deletes, just checkpoint + VACUUM +
# auto_vacuum=INCREMENTAL + restore journal_mode=WAL
python3 ~/repos/opencode-computer-use/scripts/opencode-db-maintain.py --apply --vacuum-only
```

Every `--apply` automatically: WAL checkpoint → timestamped backup
(`<db>.backup.<timestamp>`) → backup integrity verification →
batched deletes (default `--batch 2000`) → `VACUUM` →
`integrity_check`. Keep the backup until OpenCode is verified working.

## Safety rules

- Default is read-only: `--stats` / `--dry-run` change nothing.
  `--keep N` (default 10) exempts the newest N sessions from compaction —
  on a small/new DB this correctly reports zero candidates.
- The script deletes from `event` only. It never touches
  `event_sequence` numbering, aggregates with a sync/workspace owner,
  the newest snapshot per message/part, or rows whose live
  `message`/`part` projection row is missing.
- Never `--apply` against a DB copy made with a bare `cp` while OpenCode
  runs (the `-wal` may hold uncommitted data); the script's own backup
  path checkpoints first, which is why it is safe.

## Prevention

- Upstream long-term fixes are still pending: `opencode db prune` CLI
  (#43456), replay-safe snapshot compaction (#41711), diff-patch eviction
  (#42771). Until those land, this skill is the maintenance path.

## Backup (all current chats)

```bash
python3 ~/repos/opencode-computer-use/scripts/opencode-chat-backup.py --dry-run   # preview
python3 ~/repos/opencode-computer-use/scripts/opencode-chat-backup.py --force     # write
```

- Exports every session via `opencode export <id>` (full fidelity,
  re-importable with `opencode import`). Read-only against the DB —
  safe while OpenCode runs and from cron.
- Layout: `~/Documents/opencode-backups/<repo>/<slug>__<title>.json`,
  where `<repo>` is the git remote name when the session directory is a
  checkout, else the directory basename. Filenames are stable per session,
  so repeat runs overwrite in place.
- `--prune-deleted` removes JSONs whose session no longer exists
  (default: keep — backups are the safety net).

## Scheduling (cron)

`~/repos/opencode-computer-use/scripts/opencode-maintenance-cron.sh` runs both halves under a lock:

1. Chat backup (always safe, runs every time).
2. `opencode-db-maintain.py --apply` — applies only when OpenCode is
   closed; otherwise logs "skipped, OpenCode running" and retries next run.

Crontab (installed):

```cron
0 3 * * 0 /home/james/repos/opencode-computer-use/scripts/opencode-maintenance-cron.sh
@reboot sleep 120 && /home/james/repos/opencode-computer-use/scripts/opencode-maintenance-cron.sh --catch-up
```

- Weekly Sunday 03:00 plus a boot catch-up: `--catch-up` runs immediately
  only if the last success marker is >7 days old (covers machine-off).
- Status: `./opencode-maintenance-cron.sh --verify-only`. Full log:
  `~/Documents/opencode-backups/maintenance.log`.
- Cron PATH must include `/home/james/.opencode/bin` (where the
  `opencode` binary lives) — already set in the installed crontab.
