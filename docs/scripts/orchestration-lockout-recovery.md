# Orchestration policy lockout recovery

`recover-orchestration-lockout.py` is a bounded, audited maintenance applier
for a demonstrable bootstrap lockout: a broken indexed policy or repair path
prevents the supported orchestration tools from repairing the policy files
needed to restore that path. It does not disable or bypass the plugin's runtime
hooks. Run it as an operator from a trusted local terminal, outside an
OpenCode-managed session whose policy hooks may block ordinary mutations.

## When this override is acceptable

Use this recovery only when all of the following are true:

1. The bootstrap lockout is reproducible and blocks mutation of the indexed
   policy files.
2. No supported session, declared task, delegated child, or plugin repair path
   can perform the required correction.
3. The operator explicitly authorizes the exact repair and provides a reason
   that will be recorded in the manifest and audit log.
4. Every edit stays within this exact allowlist: `AGENTS.md`,
   `docs/agent-policy.md`,
   `platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/policy.ts`,
   and `platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/index.ts`.
5. The timestamped pristine backup and append-only audit log are retained.
6. After applying, the operator verifies the plugin reload in a supported hand,
   confirms the runtime has loaded
   the expected plugin, and runs the normal package, documentation, and
   repository checks.

Routine repository work still goes through declared tasks and delegated,
independently verified children. This maintenance path is not a shortcut for
ordinary changes, missing delegation, or unresolved task ownership.

## Build the edit specification

Write a UTF-8 JSON file outside the repository with a required reason and one
or more exact replacements:

```json
{
  "reason": "Operator-authorized recovery of the demonstrated bootstrap lockout",
  "edits": [
    {
      "file": "docs/agent-policy.md",
      "old": "exact unique text copied from the current file",
      "new": "the explicitly approved replacement text"
    }
  ]
}
```

The example strings are placeholders: copy the exact current text into `old`
and review the complete replacement in `new`. `file` may be repository-relative
or an absolute path under this checkout. Paths containing `..`, symlinks,
non-regular files, invalid UTF-8, and anything outside the allowlist are
refused. Each old string must occur exactly once in its file; overlapping edits
are refused. The tool accepts at most 16 edits, limits each `old` and `new` to
64 KiB, requires non-empty `new` text, and limits their combined UTF-8 size to
256 KiB. The JSON document is capped at 2 MiB, the reason at 4 KiB, and each
target file at 16 MiB.

## Dry-run and apply

The default is a read-only dry-run. It validates every file and edit before any
write and prints before/after byte sizes and SHA-256 digests for each file:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/recover-orchestration-lockout.py \
  --spec /path/to/recovery-spec.json
```

Review the exact `old`/`new` text in the spec and the dry-run digests. Only with
explicit operator authorization, apply the same spec:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/recover-orchestration-lockout.py \
  --spec /path/to/recovery-spec.json \
  --apply
```

`--reason "..."` may override the required spec reason; the effective reason is
written to both the backup manifest and audit record. `--spec -` reads the JSON
from standard input. Optional `--verify` syntax-checks edited TypeScript with
the checkout-local Node executable declared by `.opencode/rig-gates.json`; if
that optional runtime is unavailable or not runnable, it reports a skip and
does not fail solely for that missing tool. When Node is available, the check
uses a temporary `.ts` file under `/tmp` and removes it afterward; it does not
change the checkout.

## Backups, audit, and rollback

By default, state is stored outside the checkout at
`$XDG_STATE_HOME/opencode-rig/policy-maintenance/`, or at
`~/.local/state/opencode-rig/policy-maintenance/` when `XDG_STATE_HOME` is
unset. `--state-dir /absolute/path` selects another state directory, which
must also remain outside the repository, `.git` internals, and OpenCode
configuration, data, and installed-binary directories. Standard XDG/OpenCode
roots are refused.

Each successful apply creates
`backups/<UTC-timestamp>-<process>-<random>/`, containing pristine copies under
`files/` and a `manifest.json` with the reason, file paths, modes, sizes, and
before/after SHA-256 digests. The append-only `audit.jsonl` records each apply
or failed apply, its reason, affected-file digests, and backup location. Keep
the backup directory, manifest, audit log, and original edit spec together;
the tool never prunes them.

If an apply fails, it stops at the first error, attempts to restore every file
it replaced from the retained pristine backup copies, appends a failure record
when the state directory remains writable, and reports whether rollback
completed. Keep the backup and inspect the reported files before retrying.

To intentionally reverse a successful patch, use the retained original spec to
make a new spec with every edit's `old` and `new` values swapped and a rollback
reason. Run the reverse spec as a dry-run first, then apply it only after review.
Exact-match validation will refuse the rollback if the current files have
drifted or the reverse text is no longer unique; do not work around that
refusal with a broad replacement.

## Prohibited targets and actions

This tool must never edit plugin storage, installed OpenCode binaries or
distribution files, credentials, or unrelated repository paths. It does not
write `.git` internals, deploy, restart, or alter plugin state. Never disable
the orchestration plugin or edit its storage to escape a lockout. After
recovery, reload and verify the plugin in the supported hand and complete the
normal checks before resuming routine delegated work.
