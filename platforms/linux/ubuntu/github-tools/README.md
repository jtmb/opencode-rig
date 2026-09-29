# Retired Repository-Owned GitHub Runtime

This directory no longer owns a generated GitHub MCP binary. The canonical
Ubuntu MCP policy installs the official server below each selected OpenCode
profile and registers
`platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh` for both the generic
`github` MCP and the optional Source Control child client.

The retained release identity documents the migration source:

- Version: `1.12.1`
- Archive: `github-mcp-server_Linux_x86_64.tar.gz`
- SHA-256: `e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`
- Release: <https://github.com/github/github-mcp-server/releases/tag/v1.12.1>

Do not restore `bin/` or place a credential in this directory. Provision and
verify the profile-owned runtime through
`computer-use/scripts/setup-mcps.sh`.
