# `setup-git-hooks.sh`

Installs or verifies this repository's versioned Git hooks. The `pre-push` hook
runs the resource guard validator and the
[documentation coverage gate](check-doc-coverage.md), so plugin checks cannot
silently become unbounded and source changes cannot be pushed without their
documentation.

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

## Enforcement layers

The repository has local and CI enforcement for both resource-safe plugin
checks and documentation coverage:

- **Adaptive command wrapper.** Plugin typechecks and tests run in a transient
  memory-limited user service, with a budget recalculated from current memory.
- **Local pre-push hook** (this script). It blocks a push on this machine when
  a plugin package drops the wrapper or when documentation is incomplete.
- **GitHub Actions** (`.github/workflows/verify.yml`). It repeats the resource
  metadata check, bounded plugin checks, shell/Python lint, and documentation
  self-tests on every push and pull request. Because the repository is public,
  Actions is free and branch protection can require the `verify` check before
  `main` accepts changes.

The hook catches mistakes earliest; the required check is the server-side
backstop that also covers other machines and clones that skipped the hook.

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
- [`.github/workflows/verify.yml`](../../.github/workflows/verify.yml) — the CI
  enforcement layer.
- [`docs/README.md`](../README.md) — the documentation index.
