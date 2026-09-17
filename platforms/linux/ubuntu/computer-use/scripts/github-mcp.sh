#!/usr/bin/env bash
# Start the pinned GitHub MCP with a bounded, read-only tool surface.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UBUNTU_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP="$UBUNTU_ROOT/github-tools/bin/github-mcp-server"

if [ ! -x "$MCP" ]; then
  echo "github-mcp: runtime is not installed: $MCP" >&2
  exit 1
fi

if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
  if [ -n "${GH_TOKEN:-}" ]; then
    export GITHUB_PERSONAL_ACCESS_TOKEN="$GH_TOKEN"
  else
    echo "github-mcp: authentication is not configured; start OpenCode with GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN set" >&2
    exit 1
  fi
fi

exec "$MCP" stdio \
  --toolsets=context,repos,issues,pull_requests \
  --read-only \
  --lockdown-mode
