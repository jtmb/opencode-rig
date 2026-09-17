# Routine Automation Usage

This guide explains how to use the `routine-automation` skill. The
agent-facing operating rules remain in [SKILL.md](./SKILL.md); OpenCode does
not automatically load this usage guide when the skill is loaded.

Category: `automation`

Tags: `automation`, `scheduling`, `scripts`, `idempotence`

## Purpose and when to use it

Use `routine-automation` to convert a confirmed recurring computer task into
an idempotent script and, when appropriate, a safe schedule.

Appropriate requests include:

- "Run this backup every Sunday and log the result."
- "Turn these proven manual steps into a script I can rerun safely."
- "Schedule this report with a disable and rollback path."
- "Create a reusable setup procedure with verification."

Automation is appropriate only after the manual workflow is understood and
has already succeeded.

## Prerequisites and setup verification

Before automating, the agent and user should define:

- Inputs, outputs, frequency, and ownership of generated data.
- Success criteria and expected failure behavior.
- Existing scripts, cron entries, user timers, and system timers.
- Required permissions, secrets, network access, and cost.
- Log location, retention, locking needs, and rollback procedure.

The user should confirm that the workflow recurs, that automation is worth
its maintenance cost, and whether a schedule is needed or a manually invoked
script is sufficient.

## How to request it

Ask in ordinary language and name the recurrence.

Example requests:

- "Automate this weekly cleanup, but never delete without a preview."
- "Create a script that checks this status and leaves a bounded log."
- "Schedule this existing report-generation script safely."

The agent should not automate a fragile, untested, or poorly understood
procedure merely because it can be scheduled.

## Worked workflow and expected result

A representative agent workflow is:

1. Document the proven manual workflow.
2. Inspect existing scripts and schedules to avoid duplication or conflicts.
3. Create a standalone Bash or Python standard-library utility.
4. Default destructive behavior to `--dry-run`; require `--apply` for writes.
5. Add idempotence, locking for scheduled jobs, bounded retries, atomic
   writes, useful exit codes, and private logs without secrets.
6. Prefer a systemd user timer for desktop-user work; use cron only when it
   is already the convention or materially simpler.
7. Run syntax/lint checks, a dry run, one controlled real run, and a second
   idempotence run.
8. Add status, disable, uninstall, and rollback commands.
9. Schedule the tested workflow only after user approval.

Expected result: repeated execution produces the same safe outcome, failures
are visible in a bounded log, concurrent runs do not corrupt data, and the
schedule can be disabled or removed cleanly.

## Verification and known limitations

The agent must demonstrate syntax checks, dry-run behavior, a controlled real
run, and a second idempotence run. Scheduling is not verification by itself.

Known limitations:

- Scheduled jobs run under a different environment from an interactive shell.
- GUI automation remains focus-dependent and fragile.
- Credentials, expiring tokens, interactive approval, and changing web pages
  can break unattended workflows.
- Logs and retained artifacts consume disk space.
- A duplicated or conflicting schedule can produce surprising behavior.

## Troubleshooting

- Duplicate work: inspect cron, user timers, system timers, and existing
  scripts before creating another schedule.
- Nondeterministic behavior: add locking, retries, explicit ordering, and
  deterministic inputs.
- Silent failure: preserve useful exit codes and bounded logs instead of
  discarding output.
- Environment failure: test under the scheduled user's environment and
  explicit paths.
- Fragile GUI dependency: first seek an API or CLI; proceed with GUI
  automation only if the user explicitly accepts its limitations.

## Safety, confirmation, and elevation

The agent must:

- Ask before creating a schedule that sends data, deletes files, uses network
  credentials, incurs cost, wakes the machine, or requires root.
- Never schedule fragile GUI automation without an explicit user acceptance.
- Never hide failures.
- Keep secrets out of scripts and logs.
- Preserve unsaved work and original data.
- Follow the normal confirmation gates for deletions, security changes,
  publishing, purchases, legal acceptance, and consequential system changes.

## Related skills and documents

- [`system-troubleshooting`](../system-troubleshooting/README.md) diagnoses
  failures in a manual or scheduled workflow.
- [`task-memory`](../task-memory/README.md) can preserve a tested procedure
  before it is automated.
- [`opencode-db-maintenance`](../opencode-db-maintenance/README.md) is an
  example of a scheduled backup and maintenance workflow.
- The canonical catalog entry is in `skills/README.md`.
