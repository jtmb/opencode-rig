#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${OPENCODE_WSL2_CONFIG_DIR:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}/config}"
MODE="verify"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --apply|--prepare) MODE="apply"; shift ;;
    --verify-only) MODE="verify"; shift ;;
    --help|-h)
      echo "Usage: $0 [--config-dir DIR] [--verify-only|--prepare|--apply]"
      exit 0 ;;
    *)
      echo "Usage: $0 [--config-dir DIR] [--verify-only|--prepare|--apply]" >&2
      exit 2 ;;
  esac
done

arguments=(setup --config-dir "$CONFIG_DIR")
if [ "$MODE" = "apply" ]; then arguments+=(--apply); fi
python3 "$SCRIPT_DIR/configure.py" "${arguments[@]}"
if [ "$MODE" = "apply" ]; then
  "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$CONFIG_DIR" --plugins all --apply
fi
