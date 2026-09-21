#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PILOT="${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}"
BIN="${OPENCODE_V2_BIN:-$HOME/.opencode/bin/opencode}"

if [[ "$BIN" != /* ]] || [[ ! -f "$BIN" ]] || [[ ! -x "$BIN" ]] || [[ -L "$BIN" ]]; then
  echo "ERROR: OpenCode v2 binary must be an absolute, regular, non-symlink executable: $BIN" >&2
  exit 1
fi
canonical_bin="$(/usr/bin/realpath -e -- "$BIN")"
if [[ "$canonical_bin" != "$BIN" ]]; then
  echo "ERROR: OpenCode v2 binary path is not canonical: $BIN" >&2
  exit 1
fi
if [[ "$(/usr/bin/stat -c %u -- "$BIN")" != "$(/usr/bin/id -u)" ]]; then
  echo "ERROR: OpenCode v2 binary is not owned by the current user: $BIN" >&2
  exit 1
fi
binary_mode="$(/usr/bin/stat -c %a -- "$BIN")"
if (( (8#$binary_mode & 8#022) != 0 )); then
  echo "ERROR: OpenCode v2 binary must not be group- or world-writable: $BIN" >&2
  exit 1
fi
/usr/bin/python3 "$SCRIPT_DIR/configure.py" check-path --config-dir "$PILOT/config"
if [[ "$#" -gt 0 && -d "$1" ]]; then
  echo "ERROR: directory arguments can discover project configuration; launch in the isolated workspace instead: $1" >&2
  exit 2
fi
for argument in "$@"; do
  case "$argument" in
    --server|--server=*)
      echo "ERROR: the isolated WSL2 launcher does not connect to a shared server" >&2
      exit 2 ;;
  esac
  case "$argument" in
    /*|./*|../*|~/*)
      if [[ -d "$argument" ]]; then
        echo "ERROR: directory arguments can discover project configuration; launch in the isolated workspace instead: $argument" >&2
        exit 2
      fi ;;
  esac
done
case "${1:-}" in
  service|uninstall)
    echo "ERROR: service and uninstall commands are outside the isolated WSL2 launcher boundary" >&2
    exit 2 ;;
esac
/usr/bin/python3 "$SCRIPT_DIR/configure.py" runtime --config-dir "$PILOT/config" --apply
export OPENCODE_CONFIG_DIR="$PILOT/config"
export OPENCODE_DISABLE_PROJECT_CONFIG=1
export XDG_CONFIG_HOME="$PILOT/xdg"
export XDG_DATA_HOME="$PILOT/data"
export XDG_STATE_HOME="$PILOT/state"
export XDG_CACHE_HOME="$PILOT/cache"
export OPENCODE_DISABLE_AUTOUPDATE="${OPENCODE_DISABLE_AUTOUPDATE:-1}"
unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CLI_CONFIG_CONTENT OPENCODE_SERVER
cd "$PILOT/workspace"
if [[ "${1:-}" = "debug" && "${2:-}" = "paths" ]] || [[ "${1:-}" =~ ^(-h|--help|-v|--version)$ ]]; then
  exec "$BIN" "$@"
fi
case "${1:-}" in
  api|run|mini)
    command="$1"
    shift
    exec "$BIN" "$command" --standalone "$@" ;;
  "") exec "$BIN" --standalone ;;
  *)
    echo "ERROR: unsupported isolated launcher command; use the TUI, api, run, mini, or debug paths" >&2
    exit 2 ;;
esac
