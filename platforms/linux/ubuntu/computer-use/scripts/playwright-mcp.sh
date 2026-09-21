#!/usr/bin/env bash
# Launch the canonical pinned Playwright MCP for the selected profile.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
PROFILE="${OPENCODE_MCP_PROFILE:-native}"
PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
VERSION="$(python3 "$RUNTIME" policy --kind npx)"
BROWSER_REVISION="$(python3 - "$RUNTIME" <<'PY'
import json
import sys
from pathlib import Path
policy_path = Path(sys.argv[1]).resolve().parent.parent / "config" / "mcp-versions.json"
policy = json.loads(policy_path.read_text(encoding="utf-8"))
print(policy["playwrightBrowserRevision"])
PY
)"
NATIVE_ROOT="${OPENCODE_MCP_NATIVE_ROOT:-$HOME/.local/share/opencode/mcp}"
NATIVE_BROWSER_CACHE="${OPENCODE_MCP_NATIVE_BROWSER_CACHE:-$HOME/.cache/ms-playwright}"

fail() {
  printf 'playwright-mcp: %s\n' "$*" >&2
  exit 1
}

PROVISION=0
VERIFY_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --provision) PROVISION=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--verify-only|--provision]"
      exit 0 ;;
    *) echo "Usage: $0 [--verify-only|--provision]" >&2; exit 2 ;;
  esac
done
[ "$VERIFY_ONLY" -eq 0 ] || [ "$PROVISION" -eq 0 ] || fail "--verify-only and --provision are mutually exclusive"
case "$PROFILE" in
  native|wsl2) ;;
  *) fail "unsupported MCP profile: $PROFILE" ;;
esac

if [ "$PROFILE" = "wsl2" ]; then
  [[ "$PROFILE_ROOT" = /* ]] || fail "wsl2 MCP profile root must be absolute"
  if [ "$PROVISION" -eq 1 ]; then
    python3 "$RUNTIME" prepare --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --apply --quiet
  fi
  NPX="$(python3 "$RUNTIME" runner --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --kind npx --override "${OPENCODE_MCP_NPX_BIN:-}" 2>/dev/null || true)"
  NODE="$(python3 "$RUNTIME" runner --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --kind node --override "${OPENCODE_MCP_NODE_BIN:-}" 2>/dev/null || true)"
  [ -n "$NPX" ] || fail "no trusted npx runner is available"
  [ -n "$NODE" ] || fail "no trusted Node.js runner is available"
  MCP_ROOT="$PROFILE_ROOT/mcp/playwright"
  environment=(
    "HOME=$MCP_ROOT/home"
    "npm_config_cache=$PROFILE_ROOT/cache/npm"
    "PLAYWRIGHT_BROWSERS_PATH=$PROFILE_ROOT/cache/ms-playwright"
    "PATH=$(dirname "$NODE"):$(dirname "$NPX"):/usr/local/bin:/usr/bin:/bin"
    "LANG=${LANG:-C.UTF-8}"
  )
  for name in HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR; do
    if [[ -n "${!name:-}" ]]; then environment+=("$name=${!name}"); fi
  done
  if [ "$PROVISION" -eq 1 ]; then
    exec /usr/bin/env -i "${environment[@]}" "$NPX" --yes "@playwright/mcp@$VERSION" install-browser chrome-for-testing
  fi
  python3 "$RUNTIME" mcp-runtime --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --quiet
  if [ "$VERIFY_ONLY" -eq 1 ]; then
    printf 'runner=%s\n' "$NPX"
    printf 'version=%s\n' "$VERSION"
    printf 'profile_root=%s\n' "$PROFILE_ROOT"
    exit 0
  fi
  exec /usr/bin/env -i "${environment[@]}" "$NPX" --offline --yes "@playwright/mcp@$VERSION" \
    --headless --isolated --no-webmcp --browser chromium \
    --output-dir "$MCP_ROOT/output" --output-max-size 52428800
fi

NODE_OVERRIDE="${OPENCODE_MCP_NODE_BIN:-}"
if [ -n "$NODE_OVERRIDE" ] && [ -d "$NODE_OVERRIDE" ]; then NODE_OVERRIDE="$NODE_OVERRIDE/node"; fi
NODE="$(python3 "$RUNTIME" runner --kind node --override "$NODE_OVERRIDE" 2>/dev/null || true)"
[ -n "$NODE" ] || fail "trusted Node.js is unavailable; run setup-mcps.sh --apply"
PROJECT="$(cd "$COMPUTER_USE_ROOT/../browser-tools" && pwd)"
MCP="$PROJECT/node_modules/.bin/playwright-mcp"
BROWSER_BIN="$PROJECT/node_modules/.bin/playwright"
OUTPUT="${OPENCODE_MCP_OUTPUT_DIR:-$NATIVE_ROOT/playwright/output}"
if [ "$PROVISION" -eq 1 ]; then
  NPM_OVERRIDE="${OPENCODE_MCP_NPM_BIN:-}"
  if [ -n "$NPM_OVERRIDE" ] && [ -d "$NPM_OVERRIDE" ]; then NPM_OVERRIDE="$NPM_OVERRIDE/npm"; fi
  NPM="$(python3 "$RUNTIME" runner --kind npm --override "$NPM_OVERRIDE" 2>/dev/null || true)"
  [ -n "$NPM" ] || fail "trusted npm is unavailable; run setup-mcps.sh --apply"
  [ -f "$PROJECT/package.json" ] || fail "canonical browser-tools package.json is missing: $PROJECT/package.json"
  [ -f "$PROJECT/package-lock.json" ] || fail "canonical browser-tools package-lock.json is missing: $PROJECT/package-lock.json"
  (cd "$PROJECT" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --ignore-scripts --no-audit --no-fund)
fi
[ -x "$MCP" ] || fail "canonical Playwright MCP runtime is not installed: $MCP"
[ -x "$BROWSER_BIN" ] || fail "canonical Playwright runtime is not installed: $BROWSER_BIN"
installed="$(python3 - "$PROJECT/node_modules/@playwright/mcp/package.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle)["version"])
PY
)"
[ "$installed" = "$VERSION" ] || fail "Playwright MCP is $installed, expected pinned $VERSION"
if [ "$PROVISION" -eq 1 ]; then
  PATH="$(dirname "$NODE"):$PATH" PLAYWRIGHT_BROWSERS_PATH="$NATIVE_BROWSER_CACHE" "$BROWSER_BIN" install chrome-for-testing
  exit 0
fi
[ -x "$NATIVE_BROWSER_CACHE/chromium-$BROWSER_REVISION/chrome-linux64/chrome" ] || fail "pinned Chrome-for-Testing revision $BROWSER_REVISION is not installed: $NATIVE_BROWSER_CACHE"
if [ "$VERIFY_ONLY" -eq 1 ]; then
  printf 'runner=%s\n' "$NODE"
  printf 'runtime=%s\n' "$MCP"
  printf 'version=%s\n' "$VERSION"
  printf 'browser_root=%s\n' "$NATIVE_BROWSER_CACHE"
  exit 0
fi
mkdir -p "$OUTPUT"
chmod 700 "$OUTPUT"
export PATH="$(dirname "$NODE"):$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$NATIVE_BROWSER_CACHE"
python3 "$RUNTIME" mcp-runtime --profile native --quiet
exec "$MCP" --browser chromium --isolated --image-responses omit --output-dir "$OUTPUT"
