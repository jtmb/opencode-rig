# `setup-computer-assistant.sh`

Full-stack provisioning and verification for the local computer-assistant
capabilities on Ubuntu GNOME. This is the top-level setup entry point: it
installs system packages, deploys v2 skills, commands, and the opt-in ChatGPT
agent, verifies Basic Memory, and installs the pinned GitHub MCP runtime.
ChatGPT reuses the active OpenCode OpenAI OAuth connection and has no API-key
fallback. WSL browser actions use the Windows-default-browser connector with
Playwright-like tools in place of the former project-only Playwright MCP; live
browser capability remains unverified until bounded probes pass.

```bash
# Read-only health check (default)
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only

# Provision or repair the stack
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply

# Provision or verify only user-owned OpenCode state when elevation is unavailable
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply --user-only
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only --user-only
```

`--verify-only` and `--apply` are mutually exclusive; `--user-only` may modify
either mode. It skips package installation, GNOME accessibility settings,
input-group changes, `ydotool` activation, and their verification, while still
running every skill, plugin, MCP, config, and live-connection check. This keeps
the user-owned deployment on the same top-level path when non-interactive
elevation is unavailable. Any other argument exits with a usage error (`2`).
The setup provisions the native local runtimes and
declares the canonical local GitHub wrapper. The optional Source Control child
client reuses that same wrapper and profile-owned runtime.

## Security-relevant changes made by `--apply`

The script header lists these explicitly, because they are the operations that
need review before running on a new machine:

- Enables AT-SPI so user processes can inspect and control accessible widgets.
- Installs and enables `ydotool` and adds the user to the `input` group (which
  grants synthetic-input access).
- Registers the `chatgpt` MCP in both the portable project and global profiles;
  the connector reuses OpenCode's active OAuth connection and stores no API key
  or token in config.
- Installs the checksum-pinned official GitHub MCP below the profile and
  registers its local wrapper. The wrapper reads the existing `gh` login and
  never writes a token, authorization header, or client secret to config.

## Pins and paths

| Item | Value |
|------|-------|
| Node.js | profile-owned `22.22.2`, checksum verified |
| GitHub MCP | official server `1.12.1`, checksum verified and profile-owned |
| ChatGPT MCP | repository-owned `chatgpt-connector` using OpenCode's active OAuth |
| Project config | `$REPO_ROOT/opencode.json` |
| Isolated v2 config | `$OPENCODE_V2_CONFIG_DIR`, else `$OPENCODE_V2_PILOT_DIR/config` |
| Active native CLI config | `$OPENCODE_V2_ACTIVE_CLI_CONFIG`, else `$XDG_CONFIG_HOME/opencode/cli.json`, else `~/.config/opencode/cli.json` |
| OpenCode binary | `$OPENCODE_V2_BIN`, default `~/.local/opt/opencode-v2/opencode` |
| Basic Memory | `0.23.2` via `basic-memory-mcp.sh` |
| Required packages | `python3-pyatspi`, `ydotool`, `wl-clipboard` |

Native Node is installed under `~/.local/share/opencode/mcp/node/`. WSL uses
the equivalent directory below its pilot root. Neither profile falls back to
fnm, system Node, or the other profile.

## What `--apply` does

`--apply` runs two phases in order, then always runs `verify()`:

1. `install_system_dependencies`
2. `initialize_local_state` (prepares OpenCode files, deploys all v2 plugins,
  normalizes the owned global MCP entries, verifies the portable project MCP
  config without rewriting it, and delegates Basic Memory/GitHub runtime setup to
   `setup-mcps.sh`)

### 1. System dependencies

- Checks each required package with `dpkg-query`; installs the missing ones with
  `apt-get install -y --no-remove`.
- Adds the current user to the `input` group if absent (a full logout/login may
  be required for `/dev/uinput` access).
- Sets `org.gnome.desktop.interface toolkit-accessibility true`.
- Runs `systemctl --user daemon-reload`.
- Enables and starts `ydotool.service` only if `/dev/uinput` is writable in the
  current login; otherwise it prints a notice to log out and back in.

Privileged commands go through `run_root()`, which prefers, in order: running
as root, cached non-interactive `sudo -n`, `pkexec` (when a D-Bus session is
present), and finally an interactive `sudo`. The user's credential is entered
only into the trusted `sudo`/PolicyKit dialog.

### 2. Local state

- Runs `setup-opencode.sh --prepare` to seed the complete canonical examples,
  deploy v2 skills/commands, and install/verify pinned parser assets without
  running a premature health check (see [`setup-opencode.md`](setup-opencode.md)).
  It does not recreate the retired legacy JSON memory store.
- Registers all catalog v2 plugins after preparation. The final `verify()` phase
  then runs exactly one real `setup-opencode.sh --verify-only` health check.
  This works for clean and stale targets; registration is idempotent and
  preserves plugin options, unrelated settings, and existing modes.
- Registers and verifies the CLI plugin roles separately in the active native
  CLI config when it differs from the isolated profile. This explicitly keeps
  `attention.notifications` unchanged while enforcing `attention.sound: false`
  and prompt permissions in the TUI the operator actually launched. Verifying
  only the isolated profile is not accepted as native-TUI evidence.
- During local-state setup, the pilot's owned global entries are normalized:
  `mcp.servers.github` uses the canonical absolute local wrapper and
  `mcp.servers.basic-memory` and `mcp.servers.chatgpt` use their canonical
  absolute local wrappers. Legacy Playwright and obsolete flat MCP keys are
  removed. Unrelated global servers and settings are preserved.
- The checked-in repository `opencode.json` remains portable and owns exactly
  `basic-memory`, `github`, and `chatgpt`. Setup verifies it read-only and
  never normalizes or rewrites it.
- A failed preparation (including accumulated skill-copy, destination,
  extra-file, or parser checks) stops immediately under `set -e`; plugin and
  runtime phases are not started and no false preparation success is reported.

### MCP runtimes

- `setup-mcps.sh` provisions or verifies Basic Memory `0.23.2`, GitHub MCP
  Server `1.12.1`, and profile-owned Node `22.22.2`. The local ChatGPT MCP
  connector uses that Node runtime and does not download a separate server or
  browser runtime.
- Basic Memory enables uv prerelease resolution for its pinned FastMCP beta
  dependency, then runs offline. It creates or repairs the local
  `computer-assistant` default project at the selected notes root.
- GitHub uses a checksum-pinned official archive and an owner-only binary below
  the selected profile. The wrapper rejects inherited token/control variables
  and reads only the existing authenticated `gh` session.
- ChatGPT resolves OpenAI OAuth through the active OpenCode v2 service. It does
  not accept or fall back to an API key. WSL browser integration uses the
  Windows-default-browser connector with Playwright-like tools instead of a
  Playwright MCP; browser actions remain unverified until bounded probes pass.
- Provisioning writes its marker only after every package, executable, and
  version check passes.

## MCP registration

The portable repository `opencode.json` and native global config both declare
exactly `basic-memory`, `github`, and `chatgpt`. Playwright is no longer
registered as a project MCP. The isolated WSL global profile uses the same
three-server set; its Windows-default-browser connector supplies the replacement
browser boundary.

GitHub and ChatGPT entries contain only their local wrappers in both scopes.

```json
{
  "type": "local",
  "command": ["./platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh"],
  "disabled": false,
  "timeout": { "startup": 30000 }
}
```

Global normalization parses JSON/JSONC with the strict string-aware parser,
rejects malformed or duplicate-key input, refuses symlinked targets/ancestors,
and uses an atomic mode-preserving write. Existing unrelated servers/settings
are retained. The project verifier is strictly non-mutating; even `--apply` is
rejected for project scope.

The initial setup preflight rejects a symlinked V2 config root, ancestor,
isolated server/CLI target, or active native CLI target, and rejects simultaneous `opencode.json` and
`opencode.jsonc` pilot files before parser, plugin, or runtime work begins.

The script uses the isolated v2 config directory and refuses conflicting JSON
and JSONC files there until they are consolidated. Existing fields on the named
server are preserved while its type, command, enabled state, and startup timeout
are normalized. Malformed config is never silently overwritten.

The local wrappers are:

- `basic-memory` → `basic-memory-mcp.sh` (project and global)
- `github` → `github-mcp.sh` (project and global)
- `chatgpt` → `chatgpt-mcp.sh` (project and global)

## Verification

`verify()` is read-only and reports `OK:`/`MISSING/FAILED:` lines. It checks:

- All required packages are installed.
- The configured executable reports an OpenCode v2 version.
- GNOME toolkit accessibility is enabled.
- The AT-SPI Python binding imports.
- The account is in the `input` group.
- `/dev/uinput` is writable in this login.
- `ydotool.service` is active and its private socket exists.
- `desktop-control.py apps` runs (AT-SPI inspection works).
- Basic Memory `0.23.2` resolves through trusted `uvx`; its local
  `computer-assistant` project, notes root, default state, limiter, and usable
  budget validate.
- Profile-owned Node `22.22.2` and GitHub MCP Server `1.12.1` are complete.
- The canonical local GitHub wrapper is declared without credential fields and
  validates the existing `gh` login without printing its token.
- The ChatGPT wrapper uses the selected profile's pinned Node runtime and
  resolves OAuth only through the authenticated OpenCode service; no API-key
  fallback is configured.
- `opencode mcp list` reports Basic Memory, GitHub, and ChatGPT connected.
  When the caller explicitly sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, this
  shared-service probe is reported as deferred rather than silently overriding
  the opt-out; the project entry, pinned runtime, and local wrapper are still
  verified.
- GitHub `needs_auth` or `failed` is rejected; the local server must be
  `connected`.
- Both portable project and global configs have exactly the three canonical
  entries: Basic Memory, GitHub, and ChatGPT; no Playwright MCP is registered;
  no obsolete flat MCP keys remain, `session.permissions` is exactly `prompt`,
  and the configured v2 binary
  lists their live connection state with `OPENCODE_CONFIG_DIR` set to the
  isolated directory.
- `setup-opencode.sh --verify-only` passes (skills, commands,
  deployed).
- `deploy-plugins.sh --plugins all --verify-only` passes, including
  isolated `cli.json` `session.permissions: "prompt"` and silent attention for
  rig-tools gates.
- `deploy-plugins.sh --plugins cli --verify-only` passes against the explicitly
  selected active native CLI config, proving that child-completion sounds cannot
  initialize the native ALSA path while preserving system notifications.

`verify()` returns non-zero if any check fails, so `--verify-only` is suitable
as a health gate.

The apply order is intentionally strict: `setup-opencode.sh --prepare` seeds
the complete examples and deploys skills, commands, and pinned parser assets;
`deploy-plugins.sh --plugins all --apply` then registers all catalog packages
and enforces prompt permissions plus silent attention in the isolated profile;
the CLI-only pass applies the same owned settings to the active native CLI
profile. After runtime installation,
`verify()` invokes `setup-opencode.sh --verify-only` as the single full health check. A
failure in any phase stops the apply path and propagates non-zero. Preparation
does not overwrite existing config wholesale; plugin/permission edits may
normalize affected JSONC to canonical JSON, removing comments only in files
that require those edits.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Verification passed, or `--apply` completed and verified |
| `1` | One or more verification checks failed, or an apply phase failed |
| `2` | Invalid usage (conflicting or unknown arguments) |

## Notes and limitations

- The script assumes the canonical repository layout; it derives the project
  config path by walking up from `scripts/`.
- The ChatGPT MCP uses the active OpenCode OAuth connection and has no API-key
  fallback. Image generation, web search, private-chat continuity, and WSL
  browser actions remain unverified live until their bounded capability probes
  pass. WSL browser actions use the Windows-default-browser connector and
  Playwright-like tools instead of the former project-only Playwright MCP.
- `ydotool` access may require a logout/login after the first `--apply` on a
  new machine; the script prints a notice and verification fails until then.
- GitHub authentication is handled only by the existing `gh` login and the
  canonical wrapper's transient child environment; never add a token, header,
  client secret, or GitHub control variable to configuration.
- Reading order: [`setup-opencode.md`](setup-opencode.md),
  [`setup-live-dictation.md`](setup-live-dictation.md),
  [`github-mcp.md`](github-mcp.md), [`opencode-web-qa.md`](opencode-web-qa.md).
