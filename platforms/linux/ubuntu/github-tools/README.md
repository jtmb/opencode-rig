# Optional Source-Control GitHub Tools

The generic Open Rig `github` MCP is no longer a local executable. It is the
credential-free hosted OAuth endpoint
`https://api.githubcopilot.com/mcp/`, configured by the canonical Ubuntu MCP
policy and authenticated from `/mcps`.

This directory is retained only for the optional Source Control sidebar's
bounded child-client compatibility path. It is not registered as the generic
`github` MCP, is not provisioned by `setup-computer-assistant.sh`, and is not
available in the WSL2 profile. The generated executable, if an operator
provisions that optional path separately, is excluded from Git. Its historical
pin is the official GitHub release `v1.12.1`:

- Archive: `github-mcp-server_Linux_x86_64.tar.gz`
- SHA-256: `e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`
- Release: <https://github.com/github/github-mcp-server/releases/tag/v1.12.1>

The optional child-client path remains outside the generic MCP declaration and
does not change the hosted OAuth contract. Do not place credentials in this
repository or OpenCode configuration.
