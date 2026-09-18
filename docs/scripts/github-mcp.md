# `github-mcp.sh`

Launches the pinned official GitHub MCP Server with a bounded, write-capable
tool surface. This is the `github` MCP that OpenCode registers globally, so
GitHub reads and mutations are MCP tool calls rather than `gh` shell commands.
Lockdown mode stays enabled, and the agent keeps its confirmation gate before
publishing, merging, deleting, or changing workflows, repositories, or account
settings.

```bash
./platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh
```

The script is normally launched by OpenCode as an MCP server, not by hand. It
resolves a credential automatically, so no environment variable is required
when the `gh` CLI is logged in. OpenCode also loads a project `.env`, so a
project can provide the token through an env-backed MCP entry.

## What it does

1. Resolves `UBUNTU_ROOT` from the script location and expects the executable at
   `github-tools/bin/github-mcp-server`. If it is missing, it prints the path
   and exits `1`.
2. Resolves authentication, **failing closed**. The first available source
   wins, and the token is never printed:
   - `GITHUB_PERSONAL_ACCESS_TOKEN` if set.
   - Otherwise `GH_TOKEN`, copied into `GITHUB_PERSONAL_ACCESS_TOKEN`.
   - Otherwise the logged-in `gh` CLI, via `gh auth token`.
   - If none is available, it prints an error telling the user to run
     `gh auth login` or start OpenCode with one of the variables set, and exits
     `1`.
3. Replaces itself (`exec`) with the server:

   ```bash
   github-mcp-server stdio \
     --toolsets=context,repos,issues,pull_requests,actions,users \
     --lockdown-mode
   ```

## Flags and toolsets

| Flag | Meaning |
|------|---------|
| `stdio` | Speak MCP over standard input/output |
| `--toolsets=context,repos,issues,pull_requests,actions,users` | Expose these six toolsets |
| `--lockdown-mode` | Restrict to the lockdown tool surface |

Write operations are enabled by omitting `--read-only`. The six toolsets cover
repository context and content, issues, pull requests, Actions workflow runs,
and users - the practical "GitHub commands" surface, including creating and
merging pull requests, commenting, creating issues, updating files and
branches, and triggering or re-running workflows. Every enabled toolset adds
its tool schemas to each request's context, so widen `--toolsets` deliberately;
`--toolsets=all` is intentionally not used.

## Pin

`setup-computer-assistant.sh` installs the official GitHub release `v1.12.1`
(`github-mcp-server_Linux_x86_64.tar.gz`) after verifying its published SHA-256
`e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`. The
executable is generated, gitignored, and must be updated together with the
version, archive URL, and checksum in the setup script. Do not use `latest`.

## Integration

- Registered as the MCP named `github` in the **global** config
  (`~/.config/opencode/opencode.jsonc` when present, otherwise
  `opencode.json`), global-only, with a 30 s timeout.
- When a token is present, `setup-computer-assistant.sh --verify-only` confirms
  `opencode mcp list` reports it connected. Without a token, verification
  reports authentication as pending instead of failing.

The setup script's minimal registration inherits the OpenCode launch
environment. If the config should explicitly pass the project `.env` value to
the local MCP, use this global `opencode.json`/`opencode.jsonc` entry shape:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "github": {
      "type": "local",
      "command": [
        "/home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh"
      ],
      "enabled": true,
      "timeout": 30000,
      "environment": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "{env:GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

The reference is only a variable name; the token value stays in the untracked
`.env` or comes from `GH_TOKEN`/the logged-in `gh` CLI. The wrapper still falls
back to `GH_TOKEN` and then `gh auth token` when the explicit variable is empty.

## Authentication

The credential comes from an explicit environment variable or, failing that,
from the logged-in `gh` CLI. To use a dedicated credential instead:

- Set `GITHUB_PERSONAL_ACCESS_TOKEN` (or `GH_TOKEN`) in OpenCode's launch
  environment **before** OpenCode starts. A project `.env` loaded by OpenCode
  is one supported way to provide that environment value.
- Prefer a fine-grained PAT limited to the required repositories, with read
  permissions for inspection and write permissions only where mutations are
  expected.
- Never put a token in this repository, in `opencode.json`, or in any committed
  file.
- Restart OpenCode after changing its launch environment.
- The wrapper never prints, logs, or stores the token value; it is passed to
  the server only through the `GITHUB_PERSONAL_ACCESS_TOKEN` environment.

If authentication later fails, check expiration, selected repositories, scopes
(read and write), SSO, and organization policy — without displaying the token.

## Failure behavior

| Condition | Result |
|-----------|--------|
| Executable missing | Prints the path and exits `1` |
| No credential available | Prints a `gh auth login` / token-variable message and exits `1` |
| Token invalid or expired | The MCP reports an authentication error; the wrapper does not retry with another credential |

The wrapper fails closed: it never starts an unauthenticated server.

## Security

- Lockdown mode is always on, and write operations are enabled.
- Six toolsets are exposed (context, repos, issues, pull_requests, actions,
  users); the toolset list is the blast-radius control, since each enabled
  toolset's schemas also consume context on every request.
- Credentials come from the environment or the logged-in `gh` CLI and stay out
  of the repository and configuration.
- Mutations are MCP tool calls and remain behind the confirmation gate: inspect
  the target, then ask before publishing, merging, deleting, dispatching
  workflows, or changing repositories, permissions, or security settings. The
  `github-operations` skill documents that policy.

## Related

- [`setup-computer-assistant.md`](setup-computer-assistant.md) — installs and
  registers the runtime.
- `github-tools/README.md` — the pin and its checksum.
- [`AGENTS.md`](../../AGENTS.md) — the GitHub operating policy.
