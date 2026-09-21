# Hosted GitHub MCP and optional Source Control compatibility

Open Rig registers GitHub's credential-free hosted MCP endpoint:

```text
https://api.githubcopilot.com/mcp/
```

The declaration is global in the native profile and in the isolated WSL2
server profile. It contains no token, authorization header, client secret, or
local credential field:

```json
{
  "github": {
    "type": "remote",
    "url": "https://api.githubcopilot.com/mcp/",
    "disabled": false,
    "timeout": { "startup": 30000 }
  }
}
```

## Authentication

Start the relevant OpenCode profile, open `/mcps`, select `github`, and finish
the hosted OAuth flow in the browser. Until that is complete, `needs_auth` is
the expected fail-closed state. OpenCode stores the authorization in its own
profile-managed connection store; never paste a token or add a header/client
secret to `opencode.jsonc`.

## Setup and verification

Native setup writes the hosted declaration while its canonical Basic Memory and
Playwright launchers remain local:

```bash
platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
```

WSL2 delegates generic MCP setup to the same Ubuntu implementation while
passing its separate pilot root:

```bash
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-mcps.sh --verify-only
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-mcps.sh --apply
```

Verification accepts either `connected` or the unauthenticated `needs_auth`
state, but rejects local GitHub commands and any credential-bearing field.

## Optional Source Control compatibility

`platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh` and the sibling
`platforms/linux/ubuntu/github-tools/` runtime are retained only for the
optional Source Control child-client path. Generic MCP setup does not provision
or register them, and the WSL2 profile does not use them. The generic `github`
declaration remains the hosted OAuth endpoint above.
