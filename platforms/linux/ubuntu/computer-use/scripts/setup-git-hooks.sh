#!/usr/bin/env bash
# Install or verify this repository's versioned Git hooks.
#
# The only hook is pre-push, which runs the documentation coverage gate
# described in docs/scripts/check-doc-coverage.md. Verification is the default;
# --apply sets core.hooksPath and fixes the hook mode.
set -euo pipefail

APPLY=0
MODE_SET=0
HOOKS_PATH=".githooks"
HOOK="$HOOKS_PATH/pre-push"

usage() {
  echo "Usage: $0 [--verify-only|--apply]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=1; MODE_SET=1; shift ;;
    --verify-only)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      MODE_SET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  echo "ERROR: not inside a Git work tree" >&2
  exit 2
fi

ok() { echo "OK: $*"; }
fail() { echo "MISSING/FAILED: $*" >&2; }

status=0

if [ "$APPLY" -eq 1 ]; then
  if [ ! -f "$REPO_ROOT/$HOOK" ]; then
    fail "hook source missing: $REPO_ROOT/$HOOK"
    exit 1
  fi
  chmod 0755 "$REPO_ROOT/$HOOK"
  git -C "$REPO_ROOT" config core.hooksPath "$HOOKS_PATH"
  ok "core.hooksPath -> $HOOKS_PATH"
fi

configured="$(git -C "$REPO_ROOT" config --get core.hooksPath || true)"
if [ "$configured" = "$HOOKS_PATH" ]; then
  ok "core.hooksPath is $HOOKS_PATH"
else
  fail "core.hooksPath is '${configured:-unset}'; run with --apply"
  status=1
fi

if [ -f "$REPO_ROOT/$HOOK" ]; then
  if [ -x "$REPO_ROOT/$HOOK" ]; then
    ok "$HOOK is executable"
  else
    fail "$HOOK is not executable; run with --apply"
    status=1
  fi
else
  fail "$HOOK is missing"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Documentation gate hook is active for this clone."
else
  echo "Documentation gate hook is not active; run $0 --apply" >&2
fi
exit "$status"
