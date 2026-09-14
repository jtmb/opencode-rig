#!/usr/bin/env bash
# Start the pinned Playwright MCP in an isolated Firefox profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin"
PROJECT="$(cd "$SCRIPT_DIR/../browser" && pwd)"
MCP="$PROJECT/node_modules/.bin/playwright-mcp"
OUTPUT="/tmp/opencode/playwright"

if [ ! -x "$NODE_BIN/node" ]; then
  echo "playwright-mcp: fnm default Node is unavailable: $NODE_BIN/node" >&2
  exit 1
fi
if [ ! -x "$MCP" ]; then
  echo "playwright-mcp: runtime is not installed: $MCP" >&2
  echo "Run ~/repos/opencode-computer-use/scripts/setup-computer-assistant.sh --apply to provision it." >&2
  exit 1
fi

mkdir -p "$OUTPUT"
export PATH="$NODE_BIN:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PROJECT/browsers"

exec "$MCP" \
  --browser firefox \
  --isolated \
  --image-responses omit \
  --output-dir "$OUTPUT"
