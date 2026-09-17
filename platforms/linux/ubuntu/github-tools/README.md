# GitHub Tools

Pinned native GitHub MCP Server runtime for OpenCode on Ubuntu amd64.

The generated executable is installed at `bin/github-mcp-server` by
`../computer-use/scripts/setup-computer-assistant.sh --apply` and is excluded
from Git. The current pin is the official GitHub release `v1.12.1`:

- Archive: `github-mcp-server_Linux_x86_64.tar.gz`
- SHA-256: `e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`
- Release: <https://github.com/github/github-mcp-server/releases/tag/v1.12.1>

The computer-use wrapper starts the server with only the `context`, `repos`,
`issues`, and `pull_requests` toolsets, plus read-only and lockdown modes. It
requires `GITHUB_PERSONAL_ACCESS_TOKEN` (or `GH_TOKEN`) in OpenCode's launch
environment and never stores the credential in this repository or OpenCode
configuration.

Update the version, archive URL, and published checksum together in
`../computer-use/scripts/setup-computer-assistant.sh`, then reinstall and rerun
the verification checks. Do not replace the pin with `latest`.
