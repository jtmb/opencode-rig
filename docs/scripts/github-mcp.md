# `github-mcp.sh`

Launches the pinned official GitHub MCP Server with a deliberately small,
read-only tool surface. This is the `github` MCP that OpenCode registers
project-only. Publishing, merging, workflows, deletions, and account or
repository security changes are **not** available through it and stay behind an
explicit confirmation gate.

```bash
./platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh
```

The script is normally launched by OpenCode as an MCP server, not by hand. It
resolves a credential automatically, so no environment variable is required
when the `gh` CLI is logged in.

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
     --toolsets=context,repos,issues,pull_requests \
     --read-only \
     --lockdown-mode
   ```

## Flags and toolsets

| Flag | Meaning |
|------|---------|
| `stdio` | Speak MCP over standard input/output |
| `--toolsets=context,repos,issues,pull_requests` | Expose only these four toolsets |
| `--read-only` | Do not perform write operations |
| `--lockdown-mode` | Restrict to the lockdown tool surface |

The four toolsets cover exactly the read-oriented skill workflows: repository
context, repository content, issues, and pull requests.

## Pin

`setup-computer-assistant.sh` installs the official GitHub release `v1.12.1`
(`github-mcp-server_Linux_x86_64.tar.gz`) after verifying its published SHA-256
`e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`. The
executable is generated, gitignored, and must be updated together with the
version, archive URL, and checksum in the setup script. Do not use `latest`.

## Integration

- Registered as the MCP named `github` in the **project** `opencode.json`,
  project-only, with a 30 s timeout.
- When a token is present, `setup-computer-assistant.sh --verify-only` confirms
  `opencode mcp list` reports it connected. Without a token, verification
  reports authentication as pending instead of failing.

## Authentication

The credential comes from an explicit environment variable or, failing that,
from the logged-in `gh` CLI. To use a dedicated credential instead:

- Set `GITHUB_PERSONAL_ACCESS_TOKEN` (or `GH_TOKEN`) in OpenCode's launch
  environment **before** OpenCode starts.
- Prefer a fine-grained PAT limited to the required repositories and read
  permissions.
- Never put a token in this repository, in `opencode.json`, or in any committed
  file.
- Restart OpenCode after changing its launch environment.
- The wrapper never prints, logs, or stores the token value; it is passed to
  the server only through the `GITHUB_PERSONAL_ACCESS_TOKEN` environment.

If authentication later fails, check expiration, selected repositories, read
permissions, SSO, and organization policy — without displaying the token.

## Failure behavior

| Condition | Result |
|-----------|--------|
| Executable missing | Prints the path and exits `1` |
| No credential available | Prints a `gh auth login` / token-variable message and exits `1` |
| Token invalid or expired | The MCP reports an authentication error; the wrapper does not retry with another credential |

The wrapper fails closed: it never starts an unauthenticated server.

## Security

- Read-only and lockdown modes are always on.
- Only four toolsets are exposed.
- Credentials come from the environment or the logged-in `gh` CLI and stay out
  of the repository and configuration.
- Remote mutations are not possible through this MCP; the `github-operations`
  skill performs separately approved changes through `gh` after inspecting the
  target and passing the confirmation gate.

## Related

- [`setup-computer-assistant.md`](setup-computer-assistant.md) — installs and
  registers the runtime.
- `github-tools/README.md` — the pin and its checksum.
- [`AGENTS.md`](../../AGENTS.md) — the GitHub operating policy.
