#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "Usage: $0 -- command [args...]" >&2
  exit 2
fi
shift
if ! command -v timeout >/dev/null 2>&1; then
  echo "ERROR: timeout is required for bounded WSL2 checks" >&2
  exit 1
fi
exec timeout --foreground --signal=TERM --kill-after=5s 180s "$@"
