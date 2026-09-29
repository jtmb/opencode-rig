# Local GitHub MCP authenticated by `gh`

Open Rig registers the official GitHub MCP Server as a local, profile-owned
runtime. The portable declaration contains only the workspace-relative wrapper:

```json
{
  "github": {
    "type": "local",
    "command": [
      "./platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh"
    ],
    "disabled": false,
    "timeout": { "startup": 30000 }
  }
}
```

The canonical policy pins release `1.12.1`, archive
`github-mcp-server_Linux_x86_64.tar.gz`, and SHA-256
`e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`.
Native Ubuntu installs the binary below
`~/.local/share/opencode/mcp/github/`; WSL installs a separate copy below the
selected pilot's `mcp/github/` directory. Neither profile uses a
repository-owned generated binary.

## Authentication boundary

Authenticate the GitHub CLI yourself before setup:

```bash
gh auth login --hostname github.com
gh auth status --hostname github.com
```

At each MCP start, `github-mcp.sh` resolves a trusted canonical `gh` executable
and reads the existing login with `gh auth token --hostname`. The token is
captured without printing it and exists only in the child server's
`GITHUB_PERSONAL_ACCESS_TOKEN` environment. It is never placed in OpenCode
configuration, argv, marker data, repository files, logs, chat, or memory.

The wrapper rejects inherited `GH_TOKEN`, every inherited `GITHUB_*` variable,
and `OPENCODE_MCP_GH_BIN`. This prevents token fallbacks and environment
variables such as `GITHUB_TOOLSETS` from overriding the fixed command policy.
`GH_HOST` and `GH_CONFIG_DIR` may select an existing GitHub CLI login; the
wrapper validates the hostname and passes `GITHUB_HOST` to the server only for
non-default hosts.

The server exposes the bounded `context`, `repos`, `issues`, `pull_requests`,
`actions`, and `users` toolsets with lockdown mode enabled. Lockdown is a
best-effort content filter, not an authorization boundary. Available mutations
still require the repository's immediate confirmation gate.

## Setup and verification

```bash
platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh \
  --profile native --verify-only
platforms/linux/ubuntu/computer-use/scripts/setup-mcps.sh \
  --profile native --apply
```

WSL delegates to the same provisioner with its isolated profile root:

```bash
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-mcps.sh --verify-only
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-mcps.sh --apply
```

Verification requires the exact binary version, safe ownership and mode, the
canonical local declaration, and a usable saved `gh` login. After applying,
restart the shared OpenCode service and require `opencode mcp list` to report
`github connected`; `needs_auth` is not accepted for this local server.

The optional Source Control panel launches the same wrapper through its bounded
child-client limiter. That limiter forwards only non-secret profile and GitHub
CLI selection variables; it never forwards token variables.
