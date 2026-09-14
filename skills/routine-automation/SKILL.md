---
name: routine-automation
description: Turn a confirmed recurring computer task into an idempotent script and optional schedule with logs, locking, dry-run behavior, verification, and rollback. Use when the user asks to automate, schedule, run regularly, create a cron job, timer, recurring backup, or reusable setup procedure.
---

# Routine Automation

Automate only a workflow that is understood and has succeeded manually.

## Procedure

1. Define inputs, outputs, frequency, success criteria, failure behavior,
and ownership of generated data.
2. Inspect existing scripts, cron entries, and user/system timers to avoid
duplicates or conflicting jobs.
3. Put standalone utilities in `~/scripts/`. Use Bash with
`#!/usr/bin/env bash` + `set -euo pipefail`, or Python standard library.
4. Default destructive behavior to `--dry-run`; require `--apply` for writes.
5. Make reruns idempotent. Add locking for scheduled jobs, bounded retries,
atomic writes, useful exit codes, and private logs without secrets.
6. Prefer a systemd user timer for desktop-user jobs; use cron only when it
is already the established convention or materially simpler.
7. Run syntax/lint checks, a dry run, one controlled real run, and a second
idempotence run before scheduling.
8. Provide status, disable, uninstall, and rollback commands.

## Safety

- Ask before creating schedules that send data, delete files, use network
credentials, incur cost, wake the machine, or require root.
- Do not schedule fragile GUI automation unless no API/CLI exists and the
user explicitly accepts focus-dependent behavior.
- Never hide failures. A scheduled task must leave a bounded status trail.
