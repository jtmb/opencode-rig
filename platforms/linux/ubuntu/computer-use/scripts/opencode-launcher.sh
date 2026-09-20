#!/usr/bin/env bash
# Run the isolated OpenCode v2 stack and provide a small compatibility command
# for opening its built-in web UI.
set -euo pipefail

PILOT="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}"
BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"

if [ ! -x "$BIN" ]; then
  echo "ERROR: OpenCode v2 binary is not executable: $BIN" >&2
  exit 1
fi

mkdir -p "$PILOT/config" "$PILOT/data" "$PILOT/state" "$PILOT/cache"

export OPENCODE_CONFIG_DIR="$PILOT/config"
export XDG_DATA_HOME="$PILOT/data"
export XDG_STATE_HOME="$PILOT/state"
export XDG_CACHE_HOME="$PILOT/cache"
export RIG_PARSERS_DIR="${RIG_PARSERS_DIR:-$PILOT/cache/opencode-rig/parsers}"
export OPENCODE_DISABLE_AUTOUPDATE="${OPENCODE_DISABLE_AUTOUPDATE:-1}"

# Reuse API-key credentials when the previous installation's credential file is
# present. OAuth credentials remain intentionally unmapped and must be connected
# through OpenCode itself.
LEGACY_AUTH="${OPENCODE_LEGACY_AUTH_FILE:-$HOME/.local/share/opencode/auth.json}"
if [ -f "$LEGACY_AUTH" ]; then
  credentials="$(python3 - "$LEGACY_AUTH" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    raise SystemExit(0)

for provider, entry in data.items():
    if not isinstance(entry, dict) or entry.get("type") != "api":
        continue
    key = entry.get("key")
    if isinstance(key, str) and key:
        name = provider.upper().replace("-", "_") + "_API_KEY"
        print(f"{name}={key}")
PY
  )" || credentials=""
  if [ -n "$credentials" ]; then
    while IFS='=' read -r name value; do
      [ -n "$name" ] && export "$name=$value"
    done <<< "$credentials"
  fi
  unset credentials
fi

web_usage() {
  cat <<'EOF'
Usage: opencode web [--no-open]

Start the shared OpenCode v2 service, print its pairing credentials, and open
the built-in web UI in the default browser. Use --no-open to print access
details without launching a browser.
EOF
}

open_web() {
  local should_open=1
  local url=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-open)
        should_open=0
        shift ;;
      -h|--help)
        web_usage
        return 0 ;;
      *)
        echo "ERROR: unsupported opencode web argument: $1" >&2
        web_usage >&2
        return 2 ;;
    esac
  done

  # `service start` is idempotent. Do not restart a healthy shared service:
  # restarts can race with other clients and invalidate in-flight requests.
  url="$("$BIN" service start)"
  url="${url%%$'\n'*}"
  if [[ ! "$url" =~ ^https?:// ]]; then
    url="$("$BIN" service status)"
    url="${url%%$'\n'*}"
  fi
  if [[ ! "$url" =~ ^https?:// ]]; then
    echo "ERROR: OpenCode service did not report an HTTP(S) URL" >&2
    return 1
  fi

  "$BIN" pair --url "$url"

  if [ "$should_open" -eq 0 ]; then
    return 0
  fi

  if [ -n "${OPENCODE_WEB_OPENER:-}" ]; then
    "$OPENCODE_WEB_OPENER" "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1
  elif command -v gio >/dev/null 2>&1; then
    gio open "$url" >/dev/null 2>&1
  else
    echo "NOTICE: no desktop URL opener found; open $url manually" >&2
  fi
}

if [ "${1:-}" = web ]; then
  shift
  open_web "$@"
  exit $?
fi

exec "$BIN" "$@"
