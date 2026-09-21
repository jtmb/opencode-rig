#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${OPENCODE_MCP_PROFILE:-native}"
PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
APPLY=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --profile-root|--pilot-dir) PROFILE_ROOT="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --verify-only) APPLY=0; shift ;;
  --help|-h)
      echo "Usage: $0 [--profile native|wsl2] [--profile-root DIR] [--verify-only|--apply]"
      exit 0 ;;
    *)
      echo "Unsupported argument: $1" >&2
      exit 2 ;;
  esac
done

RUNTIME=(python3 "$SCRIPT_DIR/mcp_runtime.py")
case "$PROFILE" in
  native)
    if [[ -n "${OPENCODE_MCP_PROFILE_ROOT:-}" || "$PROFILE_ROOT" != "$HOME/.opencode-wsl2-pilot" ]]; then
      echo "ERROR: native MCP setup does not accept --profile-root or a WSL pilot root" >&2
      exit 2
    fi
    if [[ "$APPLY" -eq 1 ]]; then
      "${RUNTIME[@]}" prepare --profile native --apply --quiet
      "${RUNTIME[@]}" node-runtime --profile native --apply --quiet
      OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/basic-memory-mcp.sh" --provision
      OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/playwright-mcp.sh" --provision
      "${RUNTIME[@]}" mcp-runtime --profile native --apply
    else
      "${RUNTIME[@]}" mcp-runtime --profile native
      OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/basic-memory-mcp.sh" --verify-only
      OPENCODE_MCP_PROFILE=native "$SCRIPT_DIR/playwright-mcp.sh" --verify-only
    fi
    ;;
  wsl2)
    if [[ "$APPLY" -eq 1 ]]; then
      "${RUNTIME[@]}" prepare --profile wsl2 --profile-root "$PROFILE_ROOT" --apply --quiet
      "${RUNTIME[@]}" node-runtime --profile wsl2 --profile-root "$PROFILE_ROOT" --apply --quiet
      OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
        "$SCRIPT_DIR/basic-memory-mcp.sh" --provision
      OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
        "$SCRIPT_DIR/playwright-mcp.sh" --provision
      "${RUNTIME[@]}" mcp-runtime --profile wsl2 --profile-root "$PROFILE_ROOT" --apply
    else
      "${RUNTIME[@]}" mcp-runtime --profile wsl2 --profile-root "$PROFILE_ROOT"
      OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
        "$SCRIPT_DIR/basic-memory-mcp.sh" --verify-only
      OPENCODE_MCP_PROFILE=wsl2 OPENCODE_MCP_PROFILE_ROOT="$PROFILE_ROOT" \
        "$SCRIPT_DIR/playwright-mcp.sh" --verify-only
    fi
    ;;
  *)
    echo "ERROR: unsupported MCP profile: $PROFILE" >&2
    exit 2
    ;;
esac
