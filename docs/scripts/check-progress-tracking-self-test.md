# `check-progress-tracking-self-test.py`

Negative tests for [`check-progress-tracking.py`](check-progress-tracking.md).

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-progress-tracking-self-test.py
```

The self-test builds temporary fixture trees under the system temporary
directory and runs the real checker CLI (with `--root`) against each of them:

| Fixture | Expected |
|---------|----------|
| Compliant AGENTS section, `/resume` step, and handoff prompt | exit `0` |
| `AGENTS.md` without the `## Progress Tracking` section | exit `1` |
| Progress section that lost `in_progress` | exit `1` |
| `/resume` command without the todo marker | exit `1` |
| Handoff prompt without the todo marker | exit `1` |

It prints `OK:` on success and writes the failing case's output to standard
error, exiting `1`, when a rejection is not produced. It runs in the required
`verify` CI job. The fixtures live only under the system temporary directory and
are removed automatically; the repository is never written to.
