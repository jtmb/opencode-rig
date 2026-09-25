#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
PLUGIN_ROOT="$(cd -P "$SCRIPT_DIR/../plugins-v2/chatgpt-connector" && pwd -P)"
ENTRY="$PLUGIN_ROOT/src/mcp.ts"
PROFILE="${OPENCODE_MCP_PROFILE:-native}"
PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"

fail() {
  printf 'chatgpt-mcp: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: chatgpt-mcp.sh [--verify-only]

Launch the ChatGPT MCP with the selected profile's checksum-pinned Node.js.
The OpenAI OAuth connection stays in the authenticated OpenCode service.

Environment:
  OPENCODE_MCP_PROFILE       native (default) or wsl2
  OPENCODE_MCP_PROFILE_ROOT  isolated WSL/profile state root
EOF
}

VERIFY_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  native)
    if [[ -n "${OPENCODE_MCP_PROFILE_ROOT:-}" || -n "${OPENCODE_WSL2_PILOT_DIR:-}" ]]; then
      fail "native profile does not accept an isolated profile root"
    fi
    RUNTIME_ARGS=(--profile native)
    ;;
  wsl2)
    [[ "$PROFILE_ROOT" = /* ]] || fail "wsl2 profile root must be absolute"
    [[ ! "$PROFILE_ROOT" =~ [[:cntrl:]] ]] || fail "wsl2 profile root contains control characters"
    RUNTIME_ARGS=(--profile wsl2 --profile-root "$PROFILE_ROOT")
    ;;
  *) fail "unsupported MCP profile: $PROFILE" ;;
esac

[[ -f "$RUNTIME" && ! -L "$RUNTIME" ]] || fail "trusted MCP runtime helper is missing or symlinked"
[[ -f "$ENTRY" && ! -L "$ENTRY" ]] || fail "ChatGPT MCP entry point is missing or symlinked"
[[ "$(realpath "$ENTRY")" = "$ENTRY" ]] || fail "ChatGPT MCP entry point has a symlinked path"

NODE="$(python3 "$RUNTIME" runner --kind node "${RUNTIME_ARGS[@]}")"
EXPECTED_VERSION="$(python3 "$RUNTIME" policy --kind node)"
ACTUAL_VERSION="$("$NODE" --version)"
[[ "$ACTUAL_VERSION" = "v$EXPECTED_VERSION" ]] || fail "selected profile Node.js does not match its pinned version"

if [ "$VERIFY_ONLY" -eq 1 ]; then
  printf 'node=%s\n' "$NODE"
  printf 'node_version=%s\n' "$EXPECTED_VERSION"
  printf 'entry=%s\n' "$ENTRY"
  printf 'profile=%s\n' "$PROFILE"
  exit 0
fi

NODE_DIRECTORY="$(dirname "$NODE")"
[[ "$HOME" = /* && ! "$HOME" =~ [[:cntrl:]] ]] || fail "HOME must be an absolute path without control characters"
ENVIRONMENT=(
  "HOME=$HOME"
  "PATH=$NODE_DIRECTORY:/usr/bin:/bin"
  "LANG=${LANG:-C.UTF-8}"
)
for NAME in XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR; do
  VALUE="${!NAME:-}"
  if [[ -n "$VALUE" ]]; then
    [[ "$VALUE" = /* && ! "$VALUE" =~ [[:cntrl:]] ]] || fail "$NAME must be an absolute path without control characters"
    ENVIRONMENT+=("$NAME=$VALUE")
  fi
done
for NAME in $(compgen -e); do
  case "$NAME" in
    LC_*)
      VALUE="${!NAME}"
      [[ ! "$VALUE" =~ [[:cntrl:]] ]] && ENVIRONMENT+=("$NAME=$VALUE")
      ;;
  esac
done
unset NAME VALUE

exec /usr/bin/env -i "${ENVIRONMENT[@]}" "$NODE" --experimental-strip-types "$ENTRY"
