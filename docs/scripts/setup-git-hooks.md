# `setup-git-hooks.sh`

Installs or verifies this repository's versioned Git hooks. The only hook is
`pre-push`, which runs the [documentation coverage gate](check-doc-coverage.md)
so a source change cannot be pushed without its documentation.

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-git-hooks.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-git-hooks.sh --apply
```

## Options

| Option | Effect |
|--------|--------|
| `--verify-only` | Read-only check (default) |
| `--apply` | Set `core.hooksPath` and fix the hook mode |
| `-h`, `--help` | Show help |

`--verify-only` and `--apply` are mutually exclusive; bad usage exits `2`.

## What `--apply` does

1. Makes `.githooks/pre-push` executable (`0755`).
2. Sets the repository-local Git config `core.hooksPath` to `.githooks`.

Both steps are idempotent. `core.hooksPath` is repository-local, so it is not
committed and each clone must install the hook once. Because the path is
relative (`.githooks`), it resolves inside whichever worktree the hook runs in.

## Verification

`--verify-only` checks that:

- `core.hooksPath` is `.githooks`.
- `.githooks/pre-push` exists and is executable.

It exits `1` when either is missing, so it is usable as a gate. Add it to the
per-clone setup routine after cloning.

## Why a hook

Branch protection (required status checks) is unavailable on a private
repository without GitHub Pro, so a CI check cannot hard-block a direct push to
`main`. The pre-push hook is the only mechanism that actually stops the push on
this machine.

## Bypass

- `git push --no-verify` skips the hook entirely.
- A `Doc-Gate: exempt` line in a commit message bypasses only the change-aware
  check for that push; completeness still runs.

Both are deliberate and visible; prefer them over weakening the gate.

## Rollback

```bash
git config --unset core.hooksPath
```

Removes the hook installation for this clone. The versioned `.githooks/`
directory is untouched.

## Related

- [`check-doc-coverage.md`](check-doc-coverage.md) — the gate the hook runs.
- [`documentation-map.json`](../../documentation-map.json) — the rules.
- [`docs/README.md`](../README.md) — the documentation index.
