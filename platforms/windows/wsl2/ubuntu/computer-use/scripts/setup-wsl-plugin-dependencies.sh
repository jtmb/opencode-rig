#!/usr/bin/env bash
set -euo pipefail

APPLY=0
MODE_SET=0

usage() {
  echo "Usage: $0 [--apply|--verify-only]" >&2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --apply)
      [[ "$MODE_SET" -eq 0 ]] || { usage; exit 2; }
      APPLY=1
      MODE_SET=1
      shift
      ;;
    --verify-only)
      [[ "$MODE_SET" -eq 0 ]] || { usage; exit 2; }
      MODE_SET=1
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--apply|--verify-only]"
      exit 0
      ;;
    *) usage; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGINS_ROOT="$COMPUTER_USE_ROOT/plugins-v2"
WORKSPACE_MANIFEST="$PLUGINS_ROOT/package.json"
LOCKFILE="$PLUGINS_ROOT/package-lock.json"
TSC="$PLUGINS_ROOT/node_modules/.bin/tsc"
BOUNDED_RUNNER="$SCRIPT_DIR/run-bounded-command.sh"

fail() { printf 'ERROR: %s\n' "$*" >&2; }

[[ -f "$WORKSPACE_MANIFEST" && ! -L "$WORKSPACE_MANIFEST" ]] || {
  fail "WSL plugin workspace manifest is missing or symlinked: $WORKSPACE_MANIFEST"
  exit 1
}
[[ -f "$LOCKFILE" && ! -L "$LOCKFILE" ]] || {
  fail "WSL plugin workspace lockfile is missing or symlinked: $LOCKFILE"
  exit 1
}

if [[ "$APPLY" -eq 1 && ! -x "$TSC" ]]; then
  command -v npm >/dev/null 2>&1 || { fail "npm is required to install the WSL plugin workspace"; exit 1; }
  [[ -x "$BOUNDED_RUNNER" ]] || { fail "bounded command runner is missing or not executable: $BOUNDED_RUNNER"; exit 1; }
  if "$BOUNDED_RUNNER" -- npm --prefix "$PLUGINS_ROOT" ci --ignore-scripts --no-audit --no-fund; then
    printf 'OK: installed the pinned WSL plugin workspace with lifecycle scripts disabled\n'
  else
    fail "bounded WSL plugin workspace installation failed"
    exit 1
  fi
fi

if [[ ! -x "$TSC" ]]; then
  fail "WSL plugin workspace dependencies are missing (TypeScript 5.9.3); rerun setup-opencode.sh --apply"
  exit 1
fi

printf 'OK: WSL plugin workspace dependencies are ready\n'
