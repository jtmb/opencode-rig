# `basic-memory-mcp.sh`

Launches the canonical Basic Memory `0.23.2` MCP server for the local
`computer-assistant` project inside an adaptive memory budget. The same
launcher serves native Ubuntu and Ubuntu on WSL2; WSL selects a private profile
root for its home, notes, configuration, and uv cache.

```bash
platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh --verify-only
```

## What it does

- Resolves a trusted absolute `uvx` owned by root or the current user, rejects
  group/world-writable runners, and runs exactly `basic-memory==0.23.2`.
- Enables uv prerelease dependency resolution because this Basic Memory release
  pins `fastmcp==4.0.0b1`. Normal MCP startup is offline after provisioning.
- `--provision` creates or validates the local `computer-assistant` project,
  points it at the selected notes root, and makes it the default. An existing
  project with a different path or non-local mode fails closed; a correct
  project with the wrong default is repaired through Basic Memory's own CLI.
- Computes an adaptive budget from current host and cgroup availability: 20% of
  effective memory and 25% of free swap, with a 64 MiB floor. The fractions
  mirror the source-control plugin's bounded GitHub MCP child.
- Runs `basic-memory mcp --project <project>` under one bounded launch path:
  - Native Ubuntu uses `systemd-run --user --pipe --wait --collect` with
    `MemoryMax` and `MemorySwapMax` when the user systemd manager is available,
    or `prlimit --as=<budget>` otherwise.
  - WSL2 uses `run-bounded-command.sh` with 20% memory and 25% swap fractions.
    The systemd path applies `MemoryMax` and `MemorySwapMax`. Its long-lived MCP
    launch uses `--persistent`, which skips the check timeout and shared check
    lock while retaining the selected limits. Without systemd, the runner uses
    a generous address-space ceiling and monitors process-tree RSS against the
    memory budget; it does not reuse that RSS budget as `RLIMIT_AS`.
- Fails closed when neither limiter is available; the server never starts
  unbounded.

## Options and environment

| Option / variable | Meaning |
|-------------------|---------|
| `--verify-only` | Print the binary, project, limiter, and budget without starting the server |
| `--provision` | Populate the pinned package cache and register/repair the local project |
| `-h`, `--help` | Show usage |
| `BASIC_MEMORY_PROJECT` | Project name (default `computer-assistant`) |
| `OPENCODE_MCP_PROFILE` | `native` (default) or `wsl2` |
| `OPENCODE_MCP_PROFILE_ROOT` | Isolated WSL/profile state root |
| `OPENCODE_MCP_UVX_BIN` | Optional trusted absolute `uvx` override |
| `OPENCODE_MCP_NATIVE_ROOT` | Native private runtime/config root |
| `BASIC_MEMORY_HOME` | Native notes root |

## Verification

`--verify-only` prints one `key=value` line per item:

```text
binary=/home/james/.local/bin/uvx
project=computer-assistant
version=0.23.2
notes=/home/james/Documents/computer-assistant/basic-memory
limiter=systemd-run
available_bytes=...
memory_budget_bytes=...
swap_budget_bytes=...
```

Verification also checks the selected project's configuration, pinned runtime,
provisioning marker, notes root, and local/default status. It does not create
directories, download packages, or alter project configuration.

## Safety

- Bounded, fail-closed memory: the server cannot exhaust the login session
  while indexing or embedding notes.
- Native notes live under `~/Documents/computer-assistant/basic-memory/` by
  default. WSL notes and indexes stay under its private pilot root.
- Never store passwords, tokens, private keys, payment details, MFA codes, or
  whole conversations in notes; the `task-memory` skill carries that rule.
