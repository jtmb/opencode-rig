#!/usr/bin/env bash
# Launch the pinned profile-owned GitHub MCP from the existing gh login.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
PROFILE="${OPENCODE_MCP_PROFILE:-native}"
PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
HOST="${GH_HOST:-github.com}"

fail() {
  printf 'github-mcp: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: github-mcp.sh [--verify-only]

The wrapper reads the existing authenticated gh session at process start. It
never accepts a token from inherited environment variables or configuration.
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
  native|wsl2) ;;
  *) fail "unsupported MCP profile: $PROFILE" ;;
esac
if [ "$PROFILE" = "wsl2" ]; then
  [[ "$PROFILE_ROOT" = /* ]] || fail "wsl2 MCP profile root must be absolute"
  RUNTIME_ARGS=(--profile "$PROFILE" --profile-root "$PROFILE_ROOT")
else
  RUNTIME_ARGS=(--profile "$PROFILE")
fi
[[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?$ ]] || fail "GH_HOST must be a hostname with an optional port"

if [ -n "${OPENCODE_MCP_GH_BIN:-}" ]; then
  fail "OPENCODE_MCP_GH_BIN is not accepted; install gh at a trusted canonical path"
fi
mapfile -t INHERITED_NAMES < <(compgen -e)
for NAME in "${INHERITED_NAMES[@]}"; do
  case "$NAME" in
    GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN) fail "inherited GitHub token variables are not accepted: $NAME" ;;
  esac
done
unset INHERITED_NAMES NAME

MCP="$(python3 "$RUNTIME" github-runtime "${RUNTIME_ARGS[@]}")"
GH="$(python3 "$RUNTIME" runner --kind gh "${RUNTIME_ARGS[@]}")"

# The authenticated gh store is authoritative; token-bearing environment
# variables were rejected above so they cannot supersede the saved login.
if ! TOKEN="$("$GH" auth token --hostname "$HOST")"; then
  fail "cannot read the authenticated gh session for $HOST; run 'gh auth login --hostname $HOST'"
fi
if [ -z "$TOKEN" ] || [ "${#TOKEN}" -gt 16384 ] || [[ "$TOKEN" == *$'\n'* ]] || [[ "$TOKEN" == *$'\r'* ]]; then
  unset TOKEN
  fail "gh returned an invalid authentication token"
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  unset TOKEN
  printf 'runtime=%s\n' "$MCP"
  printf 'gh=%s\n' "$GH"
  printf 'host=%s\n' "$HOST"
  exit 0
fi

export GITHUB_PERSONAL_ACCESS_TOKEN="$TOKEN"
unset TOKEN
if [ "$HOST" != "github.com" ]; then
  export GITHUB_HOST="$HOST"
fi
export PATH="/usr/local/bin:/usr/bin:/bin"
export LANG="${LANG:-C.UTF-8}"

# Exec directly after reducing the exported environment. This keeps the token
# out of argv while preventing unrelated provider credentials from reaching the
# server. Flags remain authoritative because inherited GITHUB_* controls were
# rejected before credential resolution.
mapfile -t EXPORTED_NAMES < <(compgen -e)
for NAME in "${EXPORTED_NAMES[@]}"; do
  case "$NAME" in
    HOME|PATH|LANG|LC_*|HTTPS_PROXY|https_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_HOST) ;;
    *) unset "$NAME" ;;
  esac
done
unset EXPORTED_NAMES NAME

exec "$MCP" stdio \
  --toolsets=context,repos,issues,pull_requests,actions,users \
  --lockdown-mode
