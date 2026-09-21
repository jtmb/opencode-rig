# `check-progress-tracking.py`

Enforces the repository's mandatory progress-tracking rule: multi-step work is
tracked with the todo tool, with exactly one item `in_progress` and items
`completed` only after their verification passes. The rule itself lives in
[`docs/agent-policy.md`](../agent-policy.md); root
[`AGENTS.md`](../../AGENTS.md) is its concise index.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-progress-tracking.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-progress-tracking.py --root /path/to/tree
```

Read-only: the script never writes to the repository.

## What it checks

| Surface | Requirement |
|---------|-------------|
| `AGENTS.md` | links to `docs/agent-policy.md` |
| `docs/agent-policy.md` | a `## Work and progress` section that mentions `ROADMAP.md`, the `todo tool`, `in_progress`, and `completed` |
| `platforms/linux/ubuntu/computer-use/commands/resume.md` | mentions `todo` |
| `HANDOFF.md` | the copy-paste prompt mentions `todo tool` |

Markers are matched case-insensitively as substrings, not as exact sentences,
so the rule text can be reworded without breaking the gate.

## Options

| Option | Meaning |
|--------|---------|
| `--root DIR` | Repository root (default: this script's repository) |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Every operating surface still carries the progress-tracking requirement |
| `1` | One or more surfaces dropped or gutted the requirement; each violation is printed to standard error as `ERROR: ...` |

## Self-test

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-progress-tracking-self-test.py
```

Builds temporary fixture trees and runs the real CLI against them, proving the
gate rejects a missing policy-index link, a policy section that lost
`in_progress`, and a `/resume` or handoff prompt that lost the todo marker,
while accepting the compliant fixture.

## Limitations

- The gate proves the rule is present and wired; it cannot observe whether a
  live session actually used the todo tool. That discipline remains an
  operating responsibility, reviewed with the session's reported todo state.
- The gate is intentionally tolerant of wording, so it would not catch a
  rewritten rule that keeps the markers but changes their meaning; review
  remains a human responsibility.
- The check runs in the required `verify` CI job and in the local verification
  list in [`AGENTS.md`](../../AGENTS.md).
