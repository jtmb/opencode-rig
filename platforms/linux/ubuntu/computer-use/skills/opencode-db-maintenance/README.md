# OpenCode DB Maintenance Usage

This guide explains how to use the `opencode-db-maintenance` skill. The
agent-facing operating rules remain in [SKILL.md](./SKILL.md); OpenCode does
not automatically load this usage guide when the skill is loaded.

Category: `maintenance`

Tags: `maintenance`, `sqlite`, `backup`, `cron`

## Purpose and when to use it

Use this skill only for OpenCode database growth, chat backup, and scheduled
maintenance.

Appropriate requests include:

- "Diagnose why `opencode.db` is using so much disk space."
- "Show prune candidates without changing the database."
- "Back up all chats before we prune anything."
- "Check whether weekly maintenance is scheduled."

Do not use it for unrelated SQLite databases, general disk cleanup, or
ordinary OpenCode use.

## Prerequisites and setup verification

The relevant scripts are:

```text
platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py
platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py
platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh
```

The database is normally:

```text
~/.local/share/opencode/opencode.db
```

Chat backups normally use:

```text
~/Documents/opencode-backups/
```

The user should say whether OpenCode is open, whether deletion is permitted,
and whether `.backup` files and exported chats may consume additional disk
space.

## How to request it

Ask in ordinary language and name one of the skill's trigger terms, such as
`opencode.db`, disk usage, `VACUUM`, prune, chat backup, or maintenance cron.

Example requests:

- "`opencode.db` is huge. Diagnose it read-only."
- "Preview prune candidates while keeping the newest 20 sessions."
- "Export all chats without pruning."
- "Check the maintenance status and recent log."

The agent must not infer approval for database writes from a diagnostic
request.

## Worked workflow and expected result

### Read-only diagnosis

Representative commands are:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --stats
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --dry-run --keep 20
```

`--stats` reports storage health. `--dry-run` reports orphaned and superseded
candidates without changing anything. Do not combine these read-only flags
with `--apply`.

Expected result: the agent identifies whether the problem is freelist bloat,
live event-table bloat, another issue, and the approximate recoverable space.

### Targeted database maintenance

Close OpenCode before any `--apply` operation. Representative maintenance
commands are:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --apply --keep 20
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-db-maintain.py --apply --vacuum-only
```

Expected result: the script checks integrity, creates and verifies an online
backup unless explicitly disabled, removes only eligible event rows or
performs only physical reclamation, runs `VACUUM` and hardening, and reports
before/after sizes.

### Chat backup

A representative preview is:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py --dry-run
```

The backup utility writes by default. `--dry-run` prevents writes, while
`--force` only skips the confirmation prompt. Do not describe `--force` as a
read-only option.

A representative actual backup is:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-chat-backup.py --force
```

`--prune-deleted` is a separate destructive option. It removes only
script-owned exports recorded in the backup manifest: exports for deleted
sessions and stale renamed exports after a successful replacement. It does
not prune when any export fails, and it preserves files that the manifest
does not identify.

### Scheduling and status

The weekly wrapper normally performs backup and then attempts database
cleanup. Its read-only status form is:

```bash
~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/opencode-maintenance-cron.sh --verify-only
```

Do not use `--dry-run` with this wrapper: it does not recognize that option.
The default wrapper invocation performs work; `--backup-only` still performs
backup work. Successful backup and cleanup update separate markers. A failed
cleanup does not update the cleanup marker, while a skipped cleanup preserves
the successful backup marker without claiming full maintenance success.

## Verification and known limitations

The agent must verify integrity results, backup location, before/after size,
maintenance logs, and cron status. A zero exit status is not enough when data
can be lost.

Known limitations:

- Maintenance can require substantial temporary disk space.
- A large database can take significant time to prune and vacuum.
- A bare filesystem copy made while OpenCode runs may omit WAL data.
- Lock bypass and backup-skipping options exist and must not be used
  routinely.
- Version-specific upstream behavior and issue numbers can become stale.

## Troubleshooting

- OpenCode is running: close it before `--apply`; do not routinely bypass the
  lock check.
- Integrity failure: stop and restore from the verified timestamped backup.
- Export failure: inspect the failing session ID, available disk space, and
  `opencode export` error.
- Cron has no entry: inspect the user crontab and installed script path.
- Unexpected size change: compare stats, candidate report, logs, and backup
  before rerunning maintenance.

## Safety, confirmation, and elevation

The agent must:

- Keep diagnosis read-only until deletion is explicitly approved.
- Close OpenCode before database writes.
- Preserve a verified backup until OpenCode is working.
- Ask before pruning, vacuuming, pruning deleted backups, deleting data, or
  changing schedules.
- Avoid lock bypasses and backup skipping unless the user explicitly accepts
  the added risk.
- Never store database credentials or unrelated private chat content outside
  the approved backup location.

This skill does not require administrator elevation for its normal database
and backup operations.

## Related skills and documents

- [`routine-automation`](../routine-automation/README.md) provides general
  scheduling, logging, locking, and rollback practices.
- [`files-and-documents`](../files-and-documents/README.md) handles
  preservation and organization of exported artifacts.
- [`system-troubleshooting`](../system-troubleshooting/README.md) diagnoses
  storage or application failures outside this narrow maintenance workflow.
- The canonical catalog entry is in `skills/README.md`.
