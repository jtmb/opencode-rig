# `opencode-maintenance-cron.sh`

Weekly OpenCode maintenance wrapper. It always backs up chats first, then
attempts database cleanup, which only proceeds when OpenCode is closed. It is
idempotent, assumes no TTY, and is designed to be driven by cron.

```bash
./platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh
./platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh --backup-only
./platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh --catch-up
./platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh --backup-only --catch-up
./platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh --verify-only
```

## Modes

| Mode | Behavior |
|------|----------|
| full (default) | Backup, then attempt DB cleanup |
| `--backup-only` | Backup, then stop |
| `--catch-up` | Full maintenance only if the last cleanup is older than 7 days |
| `--backup-only --catch-up` | Catch-up backup only |
| `--verify-only` | Report status and change nothing |

`--verify-only` cannot be combined with `--catch-up`, and `--backup-only`
cannot be combined with a second mode flag. Invalid combinations exit `2`.

## Paths and markers

| Item | Path |
|------|------|
| Backup root | `~/Documents/opencode-backups` |
| Backup marker | `.last-backup` |
| Cleanup marker | `.last-cleanup` |
| Legacy marker | `.last-success` (ignored, reported if present) |
| Log | `maintenance.log` |
| Lock | `.maintenance.lock` |

`CATCH_UP_DAYS` is `7`.

## Flow

1. **Catch-up short-circuit.** With `--catch-up`, if the cleanup marker is 7 days
   old or newer, the script exits `0` immediately: the weekly run already covered
   it. Note this check uses the cleanup marker for all modes, including
   `--backup-only`.
2. **Lock.** Create the backup root, open the lock file on fd 9, and try
   `flock -n`. If another run holds it, print a notice and exit `0` (a
   concurrent run is already doing the work).
3. **Step 1 — backup.** Run
   [`opencode-chat-backup.py`](opencode-chat-backup.md) with `--force` (no
   prompt). On failure, log "chat backup FAILED; skipping cleanup" and exit `1`.
   On success, write the backup marker.
4. **Stop if backup-only.**
5. **Step 2 — cleanup.** Run
   [`opencode-db-maintain.py`](opencode-db-maintain.md) with `--apply --force`.
   The exit code decides the outcome:
   - `0` → write the cleanup marker, log applied.
   - `3` → log "DB cleanup skipped: OpenCode is running (will retry next run)".
     This is a normal, non-failing outcome.
   - anything else → log the failure and propagate the exit code.

Every line is timestamped and teed to `maintenance.log`.

## `--verify-only` report

Prints the backup root, the number of `*.json` backups found, the last backup
and cleanup marker timestamps and ages, any legacy marker, the last five log
lines, and the matching crontab entry (or a note that none exists).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success, catch-up not needed, lock busy, or verify-only report |
| `1` | Chat backup failed (cleanup skipped) |
| `2` | Invalid argument combination |
| `3`–`6` | Propagated from `opencode-db-maintain.py` (held DB, integrity, backup, or post-check failure) |

## Scheduling

The example schedule is in
`computer-use/config/maintenance.cron.example`:

```cron
PATH=/home/james/.opencode/bin:/home/james/.local/bin:/usr/local/bin:/usr/bin:/bin
0 3 * * 0 /home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh
@reboot sleep 120 && /home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh --catch-up
```

- Weekly on Sunday at 03:00.
- An `@reboot` catch-up run 120 seconds after boot, guarded by the 7-day
  cleanup marker, so a machine that was off during the scheduled window still
  catches up.
- The explicit `PATH` matters because cron's default `PATH` may not include
  `opencode` or the fnm Node directory.

## Notes and limitations

- The order is deliberate: a verified chat backup always precedes any database
  write, so a failed backup never leads to a compaction.
- Cleanup can only run while OpenCode is closed. A skipped cleanup (exit `3`) is
  expected when the machine is in use and is retried on the next run.
- The catch-up guard keys off the cleanup marker, so `--backup-only --catch-up`
  also skips when a recent cleanup exists. Use a plain `--backup-only` run when
  an unconditional backup is required.
- Related: [`opencode-chat-backup.md`](opencode-chat-backup.md),
  [`opencode-db-maintain.md`](opencode-db-maintain.md), and the
  `opencode-db-maintenance` skill.
