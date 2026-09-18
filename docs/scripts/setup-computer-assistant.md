# `setup-computer-assistant.sh`

Full-stack provisioning and verification for the local computer-assistant
capabilities on Ubuntu GNOME. This is the top-level setup entry point: it
installs system packages, deploys skills, commands, and custom tools,
initializes the memory store, and installs the pinned Playwright and GitHub MCP
runtimes.

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
- Enables isolated Playwright browser MCPs in the **project** `opencode.json`
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
| Global configs | `~/.config/opencode/opencode.json` and `opencode.jsonc` |
| Browser project | `platforms/linux/ubuntu/browser-tools/` |
| GitHub project | `platforms/linux/ubuntu/github-tools/` |
| Memory store | `~/Documents/computer-assistant/memory.json` |
| Required packages | `python3-pyatspi`, `ydotool`, `wl-clipboard` |

Node is used from the fnm default alias at
`~/.local/share/fnm/aliases/default/bin`.

## What `--apply` does

`--apply` runs four phases in order, then always runs `verify()`:

1. `install_system_dependencies`
2. `initialize_local_state`
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

- Runs `setup-opencode.sh --apply` to deploy skills, commands, and custom tools
  (see [`setup-opencode.md`](setup-opencode.md)).
- Runs `assistant-memory.py init` to create the owner-only store (see
  [`assistant-memory.md`](assistant-memory.md)).

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
- Registers the two Playwright MCP entries project-only (see below).

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
global config, and duplicate entries are actively removed from the global files.
The GitHub MCP entry is written into the **global** config
(`~/.config/opencode/opencode.jsonc` when present, otherwise `opencode.json`),
and any duplicate project entry is removed. The embedded Python editor writes
these entries atomically (temp file + `os.replace`):

```json
{
  "type": "local",
  "command": ["<absolute wrapper path>"],
  "enabled": true,
  "timeout": 30000
}
```

`ensure_mcp()` takes a scope argument. For the project-scoped `playwright` and
`playwright_headless` entries it:

1. `ensure_project_mcp_entry` — create or update the project entry.
2. `remove_global_mcp_entry` — delete the name from `opencode.json`/`jsonc`.
3. `project_mcp_matches` — confirm the project entry matches exactly.
4. `global_mcp_has_entry` and `mcp_config_matches` — confirm the global config
   is clean and `opencode debug config` resolves the wrapper.

For the global-scoped `github` entry it:

1. `ensure_global_mcp_entry` — create or update the entry in the global config.
2. `remove_project_mcp_entry` — delete the name from the project
   `opencode.json`.
3. `global_mcp_matches` — confirm the global entry matches exactly.
4. `project_mcp_has_entry` and `mcp_config_matches` — confirm the project config
   is clean and `opencode debug config` resolves the wrapper.

If **both** `~/.config/opencode/opencode.json` and `opencode.jsonc` exist, the
script treats the configuration as conflicting and refuses to set up MCPs until
they are consolidated. An unparseable global config is treated as "entry
present" so it is never silently overwritten.

The wrappers registered are:

- `playwright` → `playwright-mcp.sh` (project)
- `playwright_headless` → `playwright-headless-mcp.sh` (project)
- `github` → `github-mcp.sh` (global)

## Verification

`verify()` is read-only and reports `OK:`/`MISSING/FAILED:` lines. It checks:

- All required packages are installed.
- GNOME toolkit accessibility is enabled.
- The AT-SPI Python binding imports.
- The account is in the `input` group.
- `/dev/uinput` is writable in this login.
- `ydotool.service` is active and its private socket exists.
- `desktop-control.py apps` runs (AT-SPI inspection works).
- `assistant-memory.py validate` passes.
- The pinned Playwright runtime and Firefox binary are complete.
- The pinned GitHub MCP runtime is present.
- `opencode mcp list` reports the live and headless Playwright MCPs connected.
- The GitHub MCP is connected when a token is present in the environment,
  otherwise it reports authentication as pending.
- Each MCP is bound to the right scope — Playwright project-only, GitHub
  global-only — and resolved by `opencode debug config`.
- `setup-opencode.sh --verify-only` passes (skills, commands, and custom tools
  deployed).

`verify()` returns non-zero if any check fails, so `--verify-only` is suitable
as a health gate.

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
