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

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCODE_WSL2_PILOT_DIR` | `~/.opencode-wsl2-pilot` | Owns isolated config, data, state, and cache. |
| `OPENCODE_WSL2_CONFIG_DIR` | `$OPENCODE_WSL2_PILOT_DIR/config` | Selects the setup and verification target. |
| `OPENCODE_V2_BIN` | `~/.opencode/bin/opencode` | Selects the executable launched without modification. |
| `OPENCODE_MCP_UVX_BIN` | first trusted `uvx` candidate | Optional canonical Basic Memory runner override. |
| `OPENCODE_MCP_NPX_BIN` | first trusted `npx` candidate | Optional canonical Playwright runner override. |
| `OPENCODE_MCP_NODE_BIN` | first trusted `node` candidate | Optional canonical Node.js runner override. |
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
Canonical Ubuntu `rig-tools` owns the shared MCP and active-subagent sections,
so the WSL plugin does not duplicate them. Unknown OpenCode versions outside
the tested range disable the custom WSL contribution while leaving the native
interface intact.

## Web search

The isolated config enables OpenCode's built-in web search with
`provider: "random"` and `websearch: ask`. Credentials remain in OpenCode's
connection store or provider environment variables; they are never written by
these scripts. Live verification distinguishes configured search from an
authenticated provider capable of returning results.

## MCP servers

The WSL server profile receives the canonical three entries under `mcp.servers`
from the Ubuntu MCP implementation:

- **Basic Memory 0.23.2** runs through `uvx` with its home, notes, and cache
  beneath the pilot.
- **GitHub** uses GitHub's hosted OAuth endpoint. No authorization header,
  personal access token, client secret, or provider credential is written to
  configuration.
- **Playwright MCP** uses the canonical pinned package and runs headless and
  isolated with its output, npm cache, and pinned Chrome-for-Testing revision
  beneath the pilot.

`setup-mcps.sh` delegates to the canonical Ubuntu provisioner. `--apply`
provisions only the two local runtimes and writes a version marker after both
succeed. Its default `--verify-only` path is read-only. Normal MCP startup
verifies that marker, the exact cached package versions, and the pinned browser
before opening stdio; it does not silently provision a missing runtime during
an agent session. For GitHub, start
`opencode-wsl2.sh`, open `/mcps`, select `github`,
and complete OAuth in the browser. OpenCode keeps that authorization in the
isolated profile's managed store; never paste a token into `opencode.jsonc`.
Until this login is completed, `needs_auth` is the expected fail-closed state,
not a connected result.

`verify-wsl2.sh --live` checks the exact canonical configuration, provisioned
local MCP runtimes, and a fixed HTTPS/TLS
request without reading provider credentials. It also probes WSL2, systemd,
interoperability, structured PowerShell, AST-only raw preview, and read-only
Windows app enumeration. The fresh hardened 2026-09-21 run used OpenCode
v2.0.11 and Windows PowerShell 5.1. It proved kernel-confirmed WSL2/interop,
trusted executable identity, structured PowerShell, AST-only raw preview,
Windows application enumeration, a complete 434-node UI Automation traversal,
and an exact focus-action preview. Basic Memory `recent_activity` and
Playwright navigation/title evaluation both completed in the isolated profile.
GitHub reached its hosted endpoint and reported `needs_auth`; no post-hardening
focus apply or third MCP connection is claimed.

Earlier acceptance showed the built-in `websearch` returning current results
with `provider: "random"` and a 140×60 TUI preserving native Context while
rendering the then-local Open Rig WSL2, MCP, Active subagents, and `/wsl-status`
sections. MCP and Active subagents are now canonical Ubuntu `rig-tools`
contributions. The earlier rendered and mutating checks preceded both the final
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
