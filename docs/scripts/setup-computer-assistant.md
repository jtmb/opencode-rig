# `setup-computer-assistant.sh`

Full-stack provisioning and verification for the local computer-assistant
capabilities on Ubuntu GNOME. This is the top-level setup entry point: it
installs system packages, deploys v2 skills and commands, verifies
the bounded Basic Memory installation, and installs the pinned Playwright and
GitHub MCP runtimes.

```bash
# Read-only health check (default)
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only

# Provision or repair the stack
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
```

`--verify-only` and `--apply` are mutually exclusive; any other argument exits
with a usage error (`2`).

## Security-relevant changes made by `--apply`

The script header lists these explicitly, because they are the operations that
need review before running on a new machine:

- Enables AT-SPI so user processes can inspect and control accessible widgets.
- Installs and enables `ydotool` and adds the user to the `input` group (which
  grants synthetic-input access).
- Enables the single isolated Playwright browser MCP in the **project** `opencode.json`
  (project-only, never global; no normal-browser cookies).
- Installs a checksum-pinned GitHub MCP and enables its global, write-capable
  wrapper in lockdown mode.

## Pins and paths

| Item | Value |
|------|-------|
| Playwright MCP | `@playwright/mcp@0.0.80` (`BROWSER_MCP_VERSION`) |
| GitHub MCP | `v1.12.1` (`GITHUB_MCP_VERSION`) |
| GitHub archive | `github-mcp-server_Linux_x86_64.tar.gz` |
| GitHub SHA-256 | `e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b` |
| Project config | `$REPO_ROOT/opencode.json` |
| v2 config | `$OPENCODE_V2_PILOT_DIR/config` |
| OpenCode binary | `$OPENCODE_V2_BIN`, default `~/.local/opt/opencode-v2/opencode` |
| Browser project | `platforms/linux/ubuntu/browser-tools/` |
| GitHub project | `platforms/linux/ubuntu/github-tools/` |
| Basic Memory | `0.23.2` (`BASIC_MEMORY_VERSION`) via `basic-memory-mcp.sh` |
| Required packages | `python3-pyatspi`, `ydotool`, `wl-clipboard` |

Node is used from the fnm default alias at
`~/.local/share/fnm/aliases/default/bin`.

## What `--apply` does

`--apply` runs four phases in order, then always runs `verify()`:

1. `install_system_dependencies`
2. `initialize_local_state` (runs `setup-opencode.sh --prepare`, then registers
   all v2 plugins; the final `verify()` phase performs one full health check)
3. `install_browser_runtime`
4. `install_github_runtime`

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
- During local-state setup, stale pilot MCP configuration is migrated to V2
  scopes: global `mcp.servers.github` and `mcp.servers.basic-memory` use their
  pinned local wrappers, while Playwright is project-only in the repository
  config. Obsolete flat `mcp.github`, `mcp.playwright`, and
  `mcp.basic-memory` keys are removed only after those destinations validate.
- A failed preparation (including accumulated skill-copy, destination,
  extra-file, or parser checks) stops immediately under `set -e`; plugin and
  runtime phases are not started and no false preparation success is reported.

### 3. Browser runtime

- Verifies fnm Node/npm, `browser-tools/package.json`, and `package-lock.json`
  exist.
- `browser_runtime_complete()` requires all of: the installed
  `@playwright/mcp` version equals `0.0.80`, the `playwright-mcp` and
  `playwright` binaries are executable, and the expected Firefox binary
  (resolved via `playwright install --dry-run firefox`) exists under
  `browser-tools/browsers/`.
- When incomplete, it runs `npm ci --ignore-scripts --no-audit --no-fund`
  followed by `playwright install firefox` with `PLAYWRIGHT_BROWSERS_PATH` set
  to the component-local `browsers/` directory.
- Registers exactly one Playwright MCP entry project-only (see below).

### 4. GitHub runtime

- `github_runtime_complete()` requires the executable to exist and
  `--version` to contain `1.12.1`.
- When incomplete, it requires `curl`, `install`, `sha256sum`, and `tar`;
  downloads the archive to a temp dir under `/tmp/opencode/`, verifies the
  published SHA-256, extracts it, and installs `github-mcp-server` as `0755`
  under `github-tools/bin/`.
- Registers the GitHub MCP entry globally.

## MCP registration

Playwright MCP entries are written into the **project** `opencode.json`, not the
global config, and duplicate nested or legacy flat entries are actively removed
from the global files. Basic Memory is global-only alongside GitHub.
The GitHub MCP entry is written into the **global** config
(`$OPENCODE_V2_PILOT_DIR/config/opencode.jsonc`),
and any duplicate project entry is removed. The embedded Python editor writes
these entries atomically (temp file + `os.replace`):

```json
{
  "type": "local",
  "command": ["<absolute wrapper path>"],
  "disabled": false,
  "timeout": { "startup": 30000 }
}
```

`ensure_mcp()` takes a scope argument. For the project-scoped `playwright`
entry it:

1. `ensure_project_mcp_entry` — create or update the project entry.
2. `remove_global_mcp_entry` — delete the name from `opencode.json`/`jsonc`.
3. `project_mcp_matches` — confirm the project entry names the wrapper.
4. `global_mcp_has_entry` and `mcp_config_matches` — confirm the global config
   is clean and exactly one scoped entry names the wrapper.

For the global-scoped `github` entry it:

1. `ensure_global_mcp_entry` — create or update the entry in the global config.
2. `remove_project_mcp_entry` — delete the name from the project
   `opencode.json`.
3. `global_mcp_matches` — confirm the global entry names the wrapper.
4. `project_mcp_has_entry` and `mcp_config_matches` — confirm the project config
   is clean and exactly one scoped entry names the wrapper.

The migration parses JSON and JSONC with the strict string-aware parser,
rejecting malformed or duplicate-key input. It validates both target files and
symlink safety before writing either one, then uses atomic mode-preserving
writes. Existing `mcp.timeout`, unrelated servers/settings, and options on
legacy or nested entries are retained; affected JSONC files may be normalized
to canonical JSON, removing comments and trailing-comma formatting.

The initial setup preflight rejects a symlinked V2 config root, ancestor, or
server/CLI config target, and rejects simultaneous `opencode.json` and
`opencode.jsonc` pilot files before parser, plugin, or runtime work begins.

The script uses the isolated v2 config directory and refuses conflicting JSON
and JSONC files there until they are consolidated. Existing fields on the named
server are preserved while its type, command, enabled state, and startup timeout
are normalized. Malformed config is never silently overwritten.

The wrappers registered are:

- `playwright` → `playwright-mcp.sh` (project)
- `github` → `github-mcp.sh` (global)

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
- Basic Memory `0.23.2` is on `PATH` and `basic-memory-mcp.sh --verify-only`
  resolves a limiter and a usable budget.
- The pinned Playwright runtime and Firefox binary are complete.
- The pinned GitHub MCP runtime is present.
- `opencode mcp list` reports the single live Playwright MCP connected.
  When the caller explicitly sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, this
  shared-service probe is reported as deferred rather than silently overriding
  the opt-out; the project entry, pinned runtime, and local wrapper are still
  verified.
- The GitHub MCP is connected when a token is present in the environment,
  otherwise it reports authentication as pending.
- Each MCP is bound to the right scope — Playwright project-only, GitHub
  global-only, and Basic Memory global-only — in valid `mcp.servers` entries;
  no obsolete flat MCP keys remain, `session.permissions` is exactly `prompt`,
  and the configured v2 binary
  lists their live connection state with `OPENCODE_CONFIG_DIR` set to the
  isolated directory.
- `setup-opencode.sh --verify-only` passes (skills, commands,
  deployed).
- `deploy-plugins.sh --plugins all --verify-only` passes, including
  `cli.json` `session.permissions: "prompt"` for rig-tools gates.

`verify()` returns non-zero if any check fails, so `--verify-only` is suitable
as a health gate.

The apply order is intentionally strict: `setup-opencode.sh --prepare` seeds
the complete examples and deploys skills, commands, and pinned parser assets;
`deploy-plugins.sh --plugins all --apply` then registers all seven catalog
packages and enforces prompt permissions; after runtime installation,
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
- Browser binaries and the GitHub executable are downloaded during `--apply`
  and are gitignored.
- `ydotool` access may require a logout/login after the first `--apply` on a
  new machine; the script prints a notice and verification fails until then.
- The GitHub MCP authenticates from `GITHUB_PERSONAL_ACCESS_TOKEN` or `GH_TOKEN`
  in OpenCode's launch environment, including values loaded from a project
  `.env`, or from the logged-in `gh` CLI. The script never reads, stores, or
  verifies the token value itself. The GitHub connection check is treated as
  pending until an explicit variable or `gh auth` is available.
- Reading order: [`setup-opencode.md`](setup-opencode.md),
  [`setup-live-dictation.md`](setup-live-dictation.md),
  [`github-mcp.md`](github-mcp.md), [`playwright-mcp.md`](playwright-mcp.md).
