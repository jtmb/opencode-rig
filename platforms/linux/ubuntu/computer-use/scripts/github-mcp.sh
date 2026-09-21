#!/usr/bin/env bash
# Optional Source Control child MCP. The generic Open Rig GitHub MCP is the
# hosted OAuth endpoint and is configured remotely; this file is not registered
# by the canonical MCP setup and is unavailable in the WSL2 profile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UBUNTU_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP="$UBUNTU_ROOT/github-tools/bin/github-mcp-server"

if [ ! -x "$MCP" ]; then
  echo "github-mcp: runtime is not installed: $MCP" >&2
  exit 1
fi

# Resolve a credential without ever printing it. The explicit variables win;
# otherwise fall back to the logged-in GitHub CLI, which stores no token in this
# repository or in OpenCode's configuration.
if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ] && [ -n "${GH_TOKEN:-}" ]; then
  export GITHUB_PERSONAL_ACCESS_TOKEN="$GH_TOKEN"
fi
if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  gh_token="$(gh auth token 2>/dev/null || true)"
  if [ -n "$gh_token" ]; then
    export GITHUB_PERSONAL_ACCESS_TOKEN="$gh_token"
  fi
  unset gh_token
fi
if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ]; then
  echo "github-mcp: authentication is not configured; run 'gh auth login' or start OpenCode with GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN set" >&2
  exit 1
fi

# Write operations are enabled so GitHub mutations are MCP tool calls. The
# wrapper stays in lockdown mode, and the agent keeps its confirmation gate
# before publishing, merging, deleting, or changing workflows, repositories,
# or account settings.
exec "$MCP" stdio \
  --toolsets=context,repos,issues,pull_requests,actions,users \
  --lockdown-mode
