#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_WSL2_CONFIG_DIR:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}/config}"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../../.." && pwd)"
SHARED_DEPLOY="$REPO_ROOT/platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh"
PLUGINS="all"
APPLY=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --plugins) PLUGINS="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --verify-only) APPLY=0; shift ;;
    --help|-h)
      echo "Usage: $0 [--config-dir DIR] [--plugins all|server|cli|wsl-interop] [--verify-only|--apply]"
      exit 0 ;;
    *) echo "Unsupported argument: $1" >&2; exit 2 ;;
  esac
done

PILOT_DIR="$(dirname "$CONFIG_DIR")"
CLI_CONFIG="$PILOT_DIR/xdg/opencode/cli.json"
mode=(--verify-only)
if [[ "$APPLY" -eq 1 ]]; then mode=(--apply); fi

if [[ "$PLUGINS" != "wsl-interop" ]]; then
  "$SHARED_DEPLOY" \
    --config-dir "$CONFIG_DIR" \
    --cli-config "$CLI_CONFIG" \
    --plugins "$PLUGINS" \
    "${mode[@]}"
fi

arguments=(deploy --config-dir "$CONFIG_DIR" --plugins "$PLUGINS")
if [[ "$APPLY" -eq 1 ]]; then arguments+=(--apply); fi
python3 "$SCRIPT_DIR/configure.py" "${arguments[@]}"
