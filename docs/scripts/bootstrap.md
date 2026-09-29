# `bootstrap.sh`

`bootstrap.sh` is the single repository entry point for provisioning the
complete Open Rig user-space stack on native Ubuntu and Ubuntu under WSL2. It
selects the host profile, calls the canonical profile scripts, keeps
verification read-only, and records an apply journal without replacing
existing configuration.

## Prerequisites

- Ubuntu, or Ubuntu running under WSL2. The script reads `/etc/os-release` and
  `/proc/sys/kernel/osrelease`; other Linux distributions are not supported.
- `python3`, `node`, `npm`, `git`, `awk`, and `sha256sum` on `PATH`.
- The repository-local Node `26.4.0` QA runtime is verified by the bootstrap;
  use `--apply` once to provision it when missing.
- For WSL2, Windows PowerShell (`powershell.exe`) or PowerShell 7
  (`pwsh.exe`) must be resolvable through WSL interoperability.
- An existing authenticated `gh` CLI session is optional. Bootstrap checks
  `gh auth status` without displaying its output. Without it, the GitHub MCP
  cannot connect, but bootstrap does not fail solely for that reason.

Bootstrap does not perform provider login. OpenCode handles provider logins
when it is run. Native input-group changes may require a complete logout/login
before `/dev/uinput` and the `ydotool` user service can be verified.

## CLI contract

```text
./bootstrap.sh --verify-only        # read-only health check (default mode; no writes at all, not even logs)
./bootstrap.sh --apply              # provision the detected platform
./bootstrap.sh --platform auto|native|wsl2   # default auto
./bootstrap.sh --user-only          # skip sudo/privileged steps
./bootstrap.sh --dry-run            # print the ordered stage plan without mutating (any mode)
./bootstrap.sh --help
```

`--verify-only` is the default. `--dry-run` may be combined with either mode;
it prints the selected plan and exits without creating a journal or touching a
configuration. An explicit platform selection must match the detected host
for a real verify/apply. A mismatch is a usage error unless the operator
explicitly sets `OPEN_RIG_BOOTSTRAP_FORCE_PLATFORM=1`; dry-run plans may select
either profile for review.

Platform detection treats a kernel release containing both `microsoft` and
`wsl` (case-insensitive) as `wsl2`; all other detected kernel releases select
`native`. `--platform` selects the requested profile after that safety check.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success, or all requested verification checks passed. |
| `1` | Verification found one or more missing or failed checks. |
| `2` | Usage error, including an unknown option, conflicting modes, or an unsafe platform mismatch. |
| `3` | A required prerequisite is missing, such as a non-Ubuntu host or missing `python3`, `node`, `npm`, or `git`. |
| `4` | An apply stage failed. The failing stage, journal path, and suggested rerun command are printed. |

## Ordered stages

The apply path echoes each stage before it runs. Delegate output is bounded to
the first 240 lines per stage, while the journal records stage status and the
portable configuration hashes. Verification uses the same dependency order
but continues after a failed check so that it can report all available
`OK:`/`MISSING/FAILED:` results.

Native setup and the v2 health delegate check the project, canonical example,
and selected server agent-model roles. The isolated WSL setup seeds and verifies
the same canonical assignments without discovering the project configuration:
Build/Explore/General use `openai/gpt-6-luna#max`, Plan/Architect use
`openai/gpt-6-sol#max`. On an existing selected profile, apply upgrades known
GPT-5.6 roles and verify-only reports drift without writing; live profile apply
and server restart remain separately authorized operations.

### Native Ubuntu

| Order | Verify-only | Apply |
|------:|-------------|-------|
| 1 | Bootstrap preflight: Ubuntu, `python3`, Node/npm, Git, and optional `gh` status. | Same preflight. |
| 2 | `setup-qa-runtime.py --verify-only` checks the checkout-local Node `26.4.0` and npm `11.17.0` runtime without writes. | Record the pre-apply SHA-256 of `opencode.json`. |
| 3 | `setup-computer-assistant.sh --verify-only` plus `--user-only` when selected. | `setup-qa-runtime.py --apply` downloads and checksum-verifies the official archive, then atomically installs below ignored `toolchains/node/`. |
| 4 | `deploy-plugins.sh --plugins all --verify-only`. | `setup-computer-assistant.sh --apply` plus `--user-only` when selected. |
| 5 | `verify-opencode-v2.sh`. | `deploy-plugins.sh --plugins all --apply`. |
| 6 | `setup-git-hooks.sh --verify-only`. | The same v2 health check. |
| 7 | — | `setup-git-hooks.sh --apply`. |
| 8 | — | Read `opencode.json` SHA-256 again and fail if it differs from the pre-apply hash. |

`setup-computer-assistant.sh` is the canonical native delegate. Its
privileged phase covers the apt packages `python3-pyatspi`, `ydotool`, and
`wl-clipboard`, adding the current account to `input`, enabling GNOME toolkit
accessibility, reloading the user manager, and enabling the `ydotool` user
service. `--user-only` skips all of those privileged/desktop operations and
their checks; it still provisions and verifies user-owned OpenCode state.

### Ubuntu under WSL2

| Order | Verify-only | Apply |
|------:|-------------|-------|
| 1 | Bootstrap preflight: Ubuntu, `python3`, Node/npm, Git, and optional `gh` status. | Same preflight. |
| 2 | `setup-qa-runtime.py --verify-only` checks the repository's separate QA runtime; it does not access the WSL pilot. | Record the pre-apply SHA-256 of `opencode.json`. |
| 3 | Validate the isolated `<pilot>/config` path with the WSL `configure.py` path checker; no directory is created. | `setup-qa-runtime.py --apply` installs below the repository's ignored `toolchains/node/`, outside WSL profile state. |
| 4 | `setup-opencode.sh --config-dir "$OPENCODE_WSL2_CONFIG_DIR" --verify-only`. | Validate the isolated path with the WSL `configure.py` checker; no directory is created. |
| 5 | WSL-tree `deploy-plugins.sh --config-dir ... --plugins all --verify-only`. | WSL `setup-opencode.sh --config-dir "$OPENCODE_WSL2_CONFIG_DIR" --apply`, including the pinned WSL plugin workspace install when missing. |
| 6 | WSL-tree `setup-mcps.sh --pilot-dir "$OPENCODE_WSL2_PILOT_DIR" --verify-only`. | WSL-tree `deploy-plugins.sh --config-dir ... --plugins all --apply`. |
| 7 | WSL-tree `verify-wsl2.sh --source`. `--live` is never part of bootstrap's default verification. | WSL-tree `setup-mcps.sh --pilot-dir "$OPENCODE_WSL2_PILOT_DIR" --apply`; its canonical MCP implementation remains profile-rooted under the WSL pilot. |
| 8 | Read-only WSL additions: PowerShell resolution, exact `wsl-interop` server/CLI registration, Windows UI Automation source/config presence, and static in-memory screenshot-fallback wiring. No screenshot is taken. | WSL-tree `verify-wsl2.sh --source`, still without `--live`. |
| 9 | — | The same read-only WSL additions after provisioning. |
| 10 | — | Read `opencode.json` SHA-256 again and fail if it differs from the pre-apply hash. |

Every WSL delegate receives `OPENCODE_WSL2_PILOT_DIR` and
`OPENCODE_WSL2_CONFIG_DIR`, plus its explicit path argument where supported.
Defaults are `~/.opencode-wsl2-pilot` and
`~/.opencode-wsl2-pilot/config`. Bootstrap never calls the native top-level
setup script with WSL state. The WSL wrapper's intentional delegation to the
canonical MCP/plugin implementation remains profile-isolated.

The WSL screenshot check reads source registration only. It confirms that the
shared `vision_capture` tool routes WSL to `windows.screenshot`, decodes a
bounded PNG in memory, and that the checked WSL host exposes that method. It
does not invoke PowerShell, capture the desktop, or create a screenshot file.

## Security and filesystem effects

Verification and dry-run do not create journals, temporary files, config
directories, or logs. They only read repository/source/config state and run
the canonical read-only delegates. Apply is additive and writes only through
the selected delegates plus the bootstrap journal. The QA runtime stage uses
the ignored checkout-local `toolchains/node/` directory and does not change the
profile-owned Node `22.22.2` runtime:

- Native apply may invoke `sudo`/PolicyKit through the canonical setup,
  install the three desktop packages, modify `input` membership, enable the
  GNOME accessibility setting, and enable the per-user `ydotool` service.
- User-owned state includes isolated OpenCode config, skills, commands,
  plugin registrations, MCP runtimes/caches, browser assets, and the native
  Git hook setting. Existing unrelated config entries are preserved by the
  delegates.
- WSL apply writes the isolated WSL pilot tree, canonical Ubuntu and WSL plugin
  workspace dependencies, and the separately selected repository-local QA
  runtime under `toolchains/node/`. It does not change Windows, WSL systemd,
  firewall, proxy, CA, or security settings. The PowerShell check is resolution-only.
- Before and after apply, bootstrap records a SHA-256 of the repository's
  `opencode.json`. A changed digest is an apply failure (exit `4`); the
  bootstrap itself never edits that file.
- Journals are created only for apply under
  `${XDG_STATE_HOME:-$HOME/.local/state}/open-rig/bootstrap/` with mode `0600`.
  They contain stage/status metadata and hashes, not command output or
  credentials. GitHub status output is suppressed so no token material is
  printed or persisted.
- Before a delegate runs, token-bearing `GH_TOKEN` and `GITHUB_*` environment
  variables are removed in the child process. The saved `gh` login remains the
  only GitHub authentication path.

No `curl | bash` operation is used. The explicit `--apply` path downloads the
official Node archive over HTTPS and verifies its pinned SHA-256 before
installation; other network or package-cache activity is limited to delegates
that provision their pinned dependencies.

## Authentication and relogin

Run `gh auth login --hostname github.com` yourself before expecting the local
GitHub MCP to connect. Bootstrap performs only the read-only `gh auth status`
check; the existing `gh` session is the sole GitHub credential source and no
token, authorization header, or client secret is copied into configuration.
Provider logins happen inside OpenCode, not in bootstrap.

After native apply adds the account to `input`, log out and back in (or start a
new login session) before expecting `/dev/uinput` and `ydotool` verification to
pass. A user-service manager reload and desktop session may also be required.

## Rollback and disablement

Apply is additive; bootstrap has no destructive uninstall or rollback phase.
Stop OpenCode before quarantining a profile so it cannot recreate files while
being disabled.

To quarantine a WSL pilot without deleting evidence:

```bash
pilot="${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}"
mv "$pilot" "${pilot}.disabled.$(date +%Y%m%d%H%M%S)"
```

Do not copy quarantined WSL config into a native profile. To disable native
desktop additions, an operator can stop the user service and revert the
accessibility/group changes after reviewing local policy:

```bash
systemctl --user disable --now ydotool.service
gsettings set org.gnome.desktop.interface toolkit-accessibility false
sudo gpasswd -d "$USER" input
```

The `input` removal takes effect after logout/login. Installed apt packages,
profile files, plugin registrations, and the Git hook remain until an
operator removes or quarantines them deliberately; unrelated files are not
deleted by bootstrap.

## Limitations

- Native privileged behavior depends on Ubuntu package policy, GNOME/Wayland,
  AT-SPI, `/dev/uinput`, user systemd, and a relogin. `--user-only` knowingly
  leaves those host checks unprovisioned.
- WSL `--source` verification is portable source/config evidence, not fresh
  Windows UI, PowerShell, systemd, provider, or rendered-TUI acceptance;
  fresh-WSL acceptance remains pending.
  Bootstrap does not opt into `verify-wsl2.sh --live`; run that separately on
  an interactive WSL2 host when live acceptance is explicitly wanted.
- The WSL profile requires Windows interoperability and a resolvable PowerShell
  executable. It does not mutate the Windows host and does not perform Windows
  UI actions or screenshots.
- Bootstrap does not install provider credentials, authenticate providers, or
  make claims about live MCP connections when verification prerequisites are
  absent. The optional `gh` check can pass or be noticed independently of the
  rest of the stack.

## Verification commands

Start with the read-only aggregate check:

```bash
./bootstrap.sh --verify-only
```

Review either profile's plan without writing anything:

```bash
./bootstrap.sh --platform native --dry-run
./bootstrap.sh --platform wsl2 --dry-run
```

On a native Ubuntu host, a user-only health check is useful when desktop
privileges are intentionally unavailable:

```bash
./bootstrap.sh --verify-only --user-only
```

On an actual WSL2 Ubuntu host, the default source-bound verification is:

```bash
./bootstrap.sh --platform wsl2 --verify-only
platforms/windows/wsl2/ubuntu/computer-use/scripts/verify-wsl2.sh --live
```

The second command is an explicit, interactive live check and is not part of
bootstrap's default or apply path.
