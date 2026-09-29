#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../../.." && pwd)"
CANONICAL_SETUP="$REPO_ROOT/platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh"
PILOT="${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --pilot-dir) PILOT="$2"; shift 2 ;;
    --apply) MODE="--apply"; shift ;;
    --verify-only) MODE="--verify-only"; shift ;;
    --help|-h)
      echo "Usage: $0 [--pilot-dir DIR] [--verify-only|--apply]"
      exit 0 ;;
    *)
      echo "Unsupported argument: $1" >&2
      exit 2 ;;
  esac
done

MODE="${MODE:---verify-only}"
if [[ ! -f "$CANONICAL_SETUP" || -L "$CANONICAL_SETUP" ]]; then
  echo "ERROR: canonical MCP setup is missing or symlinked: $CANONICAL_SETUP" >&2
  exit 1
fi
exec env OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PILOT" \
  "$CANONICAL_SETUP" --profile wsl2 --profile-root "$PILOT" "$MODE"
