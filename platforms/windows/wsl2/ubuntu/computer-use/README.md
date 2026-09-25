# Open Rig for Ubuntu on WSL2

This platform is the WSL2 profile for Open Rig's canonical Ubuntu
implementation. Generic MCP launchers, policy, provisioning, and verification
remain owned by `platforms/linux/ubuntu/computer-use/`; this tree owns only the
WSL/Windows interop package, profile wiring, and isolated state delegation.

## Supported boundary

- Windows 11 22H2 or newer with current Store WSL.
- Ubuntu running as WSL2 with systemd enabled.
- Windows interoperability enabled.
- OpenCode v2.0.7 or newer within the tested compatibility range.
- PowerShell 7 (`pwsh.exe`) preferred; Windows PowerShell
  (`powershell.exe`) is a fallback.

Source verification is portable and does not claim live WSL, PowerShell,
Windows UI, or rendered-TUI acceptance. Those claims require `--live` checks
on an interactive WSL2 installation.

## Setup

Verification is read-only. Apply writes only to the explicitly selected,
isolated OpenCode configuration directory.

```bash
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-opencode.sh --apply
platforms/windows/wsl2/ubuntu/computer-use/scripts/deploy-plugins.sh --plugins all --apply
platforms/windows/wsl2/ubuntu/computer-use/scripts/setup-mcps.sh --apply
platforms/windows/wsl2/ubuntu/computer-use/scripts/verify-wsl2.sh --source
platforms/windows/wsl2/ubuntu/computer-use/scripts/verify-wsl2.sh --live
```

To register only the WSL interop server and CLI roles in an existing WSL
profile, target that profile's exact config directory:

```bash
CONFIG_DIR="${OPENCODE_WSL2_CONFIG_DIR:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}/config}"
platforms/windows/wsl2/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --config-dir "$CONFIG_DIR" --plugins wsl-interop --verify-only
```

After separately authorizing the config write, replace `--verify-only` with
`--apply`. This installs both `wsl-interop` roles and the exact `ask`
permissions for `wsl_browser_open` and `wsl_browser_act`; it does not reload an
already running server. For a non-default selected service, use only the config
directory actually owned by that exact service, then confirm its location, PID,
and port again after its separately authorized restart. Do not use the WSL
profile deployer for a native service that cannot access the Windows host.

WSL2 setup first verifies or installs the canonical Ubuntu plugins-v2 lockfile,
including `@dietrichgebert/ponytail@4.10.0`; it does not use a HOME-based
Ponytail install. Apply also installs the WSL interop workspace from this tree's
own lockfile with lifecycle scripts disabled. Source verification fails clearly
when its TypeScript dependency is missing and still requires the typecheck. The
shared deployment wrapper then registers the single catalog-managed
`ponytail-adapter` server role in the isolated profile.

The default isolated root is `~/.opencode-wsl2-pilot`. Override it with
`OPENCODE_WSL2_PILOT_DIR`; override the executable with `OPENCODE_V2_BIN`.
Server settings live at `$OPENCODE_WSL2_PILOT_DIR/config/opencode.jsonc`.
Global CLI settings live separately at
`$OPENCODE_WSL2_PILOT_DIR/xdg/opencode/cli.json`, selected by the launcher's
private `XDG_CONFIG_HOME`. The launcher removes inherited inline-config and
shared-server overrides before starting OpenCode.
The launcher prevents repository project configuration from leaking native-
Ubuntu paths into this profile. It always uses a private server from
`$OPENCODE_WSL2_PILOT_DIR/workspace` and rejects shared-server or directory
arguments that could re-enable project-config discovery. Repository paths
remain available only through explicit external-directory approvals.
The isolated WSL server profile seeds its Build, Explore, and General agent
defaults from the canonical Ubuntu GPT-6 Luna `#max` role assignments, and its
Plan and read-only Architect defaults from the GPT-6 Sol `#max` assignments.
Setup and verification reject stale GPT-5.6 agent references; selected
`--apply` upgrades the known roles without replacing unrelated custom models.
No project-config discovery or
active native-global config edit is needed for this WSL profile.

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_WSL2_PILOT_DIR` | `~/.opencode-wsl2-pilot` | Owns isolated config, data, state, and cache. |
| `OPENCODE_WSL2_CONFIG_DIR` | `$OPENCODE_WSL2_PILOT_DIR/config` | Selects the setup and verification target. |
| `OPENCODE_V2_BIN` | `~/.opencode/bin/opencode` | Selects the executable launched without modification. |
| `OPENCODE_MCP_UVX_BIN` | first trusted `uvx` candidate | Optional canonical Basic Memory runner override. |
| `OPENCODE_MCP_NODE_BIN` | profile-owned Node.js `22.22.2` | Optional path override for the pinned runtime used by the ChatGPT MCP wrapper; it must resolve to this profile's Node.js. |
| `HTTPS_PROXY` / `ALL_PROXY` | unset | Uses an existing WSL network proxy without printing its value. |
| `SSL_CERT_FILE` / `SSL_CERT_DIR` | system trust | Uses an operator-managed CA bundle or directory. |

## Tools

The server plugin exposes:

- `wsl_status` — read-only capability detection.
- `powershell_status` — read-only Windows PowerShell discovery.
- `powershell_command` — fixed, structured read-only JSON-RPC operations for
  processes, services, and paths.
- `powershell_raw` — preview by default; execution requires a matching,
  short-lived, single-use token and an OpenCode permission prompt.
- `windows_apps` and `windows_find` — read-only bounded Windows application
  and UI Automation discovery over JSON-RPC stdin/stdout.
- `wsl_browser_*` — agent-callable tools in the
  [WSL interop plugin](plugins-v2/wsl-interop/src/index.ts) for opening URLs in
  the current Windows default browser, listing matching windows, reading
  bounded UI Automation snapshots, capturing the selected window in-memory,
  and previewing/applying click, focus, type, or key actions on exact elements.
  `wsl_browser_open` reports ShellExecute request acceptance only; verify
  navigation separately. Screenshots use the selected HWND without activating
  it and fail closed on changed identity, occlusion, or blank/unpainted pixels.
- The shared `vision_capture` tool delegates to the fixed
  `windows.screenshot` host method when it detects WSL2 and the native
  GNOME/ydotool backend is unavailable. The capture stays in memory, is bounded
  to 6 MiB, and is returned as a PNG attachment without creating a host file.
- `windows_act` — preview/apply UI Automation for focus, invoke, value, toggle,
  and selection patterns. Apply requires an unchanged exact target, a
  short-lived single-use token, and an OpenCode permission prompt.

Raw PowerShell is not an operating-system sandbox. After explicit approval it
can mutate the Windows host with the current user's rights. The tool blocks
recognized Git commit/push, encoded-command, credential, and installed
OpenCode-binary operations, but arbitrary script semantics cannot be classified
completely.

Host operations fail closed unless the Linux kernel identifies WSL2 and the
`WSLInterop` binfmt registration is enabled with an interpreter. PowerShell is
resolved only from expected absolute Windows installation paths; preview tokens
bind its path and file identity, the WSL fingerprint, caller, working directory,
script or full UI snapshot, and timeout. Output decoding is fatal on malformed
UTF-8/UTF-16, process groups have bounded termination, structured paths accept
local drive roots only, and UI actions reject incomplete traversal before a
second in-host exact snapshot comparison.

## Sidebar behavior

The CLI role registers only an additive WSL capability/status contribution
**after** native `sidebar.content`; it never replaces native OpenCode content.
OpenCode owns the sole MCP sidebar row, and canonical Ubuntu `rig-tools`
contributes only the shared active-subagent section, so the WSL plugin does not
duplicate either one. Unknown OpenCode versions outside
the tested range disable the custom WSL contribution while leaving the native
interface intact.

## Web search

The isolated config enables OpenCode's built-in web search with
`provider: "random"` and `websearch: ask`. Credentials remain in OpenCode's
connection store or provider environment variables; they are never written by
these scripts. Live verification distinguishes configured search from an
authenticated provider capable of returning results.

## MCP servers

The WSL server profile receives exactly `basic-memory`, `github`, and `chatgpt`
under `mcp.servers` from the canonical Ubuntu MCP implementation:

- **Basic Memory 0.23.2** runs through `uvx` with its home, notes, project
  configuration, and cache beneath the pilot. Provisioning registers the local
  `computer-assistant` project at that notes root and makes it the default.
- **GitHub MCP Server 1.12.1** is checksum-pinned and installed below the pilot.
  Its canonical wrapper reads the existing authenticated `gh` session at
  process start; no authorization header, personal access token, client secret,
  or provider credential is written to configuration.
- **ChatGPT MCP** runs through the canonical local `chatgpt-mcp.sh` wrapper and
  uses the profile-owned, checksum-pinned Node.js `22.22.2` runtime beneath the
  pilot.

`setup-mcps.sh` delegates to the canonical Ubuntu provisioner. `--apply`
provisions Basic Memory `0.23.2`, profile-owned Node.js `22.22.2` for ChatGPT,
and GitHub MCP Server `1.12.1`, then writes a version marker after all verify.
Its default `--verify-only` path checks all launchers without changing any
profile file or mode. Basic Memory uses exactly one selected memory limiter; it
never falls through from `systemd-run` to a second `prlimit` launch. Normal MCP
startup verifies the marker, local project, pinned Basic Memory runtime,
profile-owned Node.js, and GitHub binary before opening stdio; it does not
silently provision a missing runtime during an agent session. Run
`gh auth login --hostname github.com` yourself before setup. The wrapper rejects
inherited token/control variables and obtains a transient token from the saved
login only when the child starts. `needs_auth` is not accepted for this local
server; the MCP must report `connected`.

WSL2 Basic Memory uses the canonical bounded-command runner with 20% memory and
25% swap fractions; the systemd path applies `MemoryMax` and `MemorySwapMax`.
Its long-lived MCP launch uses `--persistent`, so it skips the check-only timeout
and shared lock while keeping the selected limits. Without a user systemd
manager, the fallback applies a generous virtual-address-space ceiling and
monitors process-tree RSS against the memory budget; it does not reuse the RSS
budget as an address-space limit.

The 2026-09-21 hardened WSL run is historical evidence only. It used OpenCode
v2.0.11 and Windows PowerShell 5.1, and proved kernel-confirmed WSL2/interop,
trusted executable identity, structured PowerShell, AST-only raw preview,
Windows application enumeration, a complete 434-node UI Automation traversal,
and an exact focus-action preview. In that old isolated profile, Basic Memory
`recent_activity` and Playwright navigation/title evaluation completed while the
then-installed Playwright MCP was available. These calls predate the current
three-MCP configuration and the `wsl_browser_*` tools; they do not verify current
MCP connectivity or browser QA. The run's hosted GitHub `needs_auth` result also
predates the local-server conversion, and is not current connection evidence.
See the [historical WSL2 acceptance record](../../../../../docs/wsl2-acceptance-2026-09-21.md).

Live Windows-default-browser QA remains pending; no current rendered-browser
acceptance is claimed. Follow the [OpenCode Web QA guide](../../../../../docs/scripts/opencode-web-qa.md)
for the authenticated browser, exact service identity, rendered screenshot,
accessible snapshot, startup/error review, and observed interaction evidence.

Earlier acceptance showed the built-in `websearch` returning current results
with `provider: "random"` and a 140×60 TUI preserving native Context while
rendering the then-local Open Rig WSL2, MCP, Active subagents, and `/wsl-status`
sections. MCP is now native OpenCode content and Active subagents is the only
canonical Ubuntu `rig-tools` sidebar contribution. The earlier rendered and mutating checks preceded both the final
hardening pass and this ownership convergence, so they are not relabeled as
fresh shared-stack evidence.

Those noninteractive tool calls used OpenCode's explicit `--auto` test mode.
The checked configuration and tool registrations still set `websearch`, raw
PowerShell, and Windows actions to `ask`, but a visible interactive permission
prompt has not been accepted. WSLg was unavailable on that host, and PowerShell
7 fallback selection was not exercised. A fresh post-hardening rendered TUI,
visible permission prompt, and UI action apply also remain pending.

## Rollback

The Windows prerequisite script never changes Windows, WSL, systemd, firewall,
proxy, CA, or security settings. The Linux apply flow owns only the selected
isolated pilot directory. Stop its private TUI/server, then quarantine that
directory to disable the platform without deleting evidence:

```bash
pilot="${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}"
mv "$pilot" "${pilot}.disabled.$(date +%Y%m%d%H%M%S)"
```

Unset WSL2-specific environment overrides before returning to another profile.
Do not copy the quarantined `config/opencode.jsonc` or
`xdg/opencode/cli.json` into a native-Ubuntu
profile. Raw PowerShell and Windows UI actions run with the current Windows
user's authority; their host-side effects are operation-specific and are not
automatically reversible by removing the pilot.

## Non-goals in the first source release

- WSL1 or non-Ubuntu distributions.
- UAC, secure-desktop, login-screen, or cross-user automation.
- Claiming untested UI Automation patterns or applications from the one
  accepted focus action.
- Reimplementing or suppressing OpenCode's native sidebar.
- Modifying the native Ubuntu platform or installed OpenCode binaries.
