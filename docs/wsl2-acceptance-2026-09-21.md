# WSL2 acceptance evidence — 2026-09-21

This artifact records bounded evidence for the independent Ubuntu-on-WSL2
platform from the pre-convergence security-correction run. It is intentionally
historical: prior rendered and mutating acceptance is not treated as fresh
post-hardening or current canonical-MCP proof.

## Environment

- OpenCode: `2.0.11`
- WSL package: `2.6.2.0`
- Linux kernel: `6.6.87.2-microsoft-standard-WSL2`
- Windows: `10.0.26200.9457`
- PID 1: systemd, running
- WSL interoperability: enabled with `/init` interpreter
- PowerShell: Windows PowerShell `5.1.26100.9444` (`Desktop`)
- WSLg: unavailable
- Isolated pilot used for live checks: `/tmp/opencode/open-rig-wsl2-live`

## Automated and live checks

The following repository commands passed:

```text
npm --prefix platforms/windows/wsl2/ubuntu/computer-use/plugins-v2 run check
  typecheck: passed
  tests: 36 passed, 0 failed

python3 platforms/windows/wsl2/ubuntu/computer-use/scripts/self-test.py
  disposable setup/deployment/rollback/launcher checks: passed

python3 platforms/windows/wsl2/ubuntu/computer-use/scripts/check-ownership-boundary.py
  no duplicate generic MCP or developer-specific dependency: passed

bash -n platforms/windows/wsl2/ubuntu/computer-use/scripts/*.sh
  passed

OPENCODE_WSL2_PILOT_DIR=/tmp/opencode/open-rig-wsl2-live \
  platforms/windows/wsl2/ubuntu/computer-use/scripts/verify-wsl2.sh --live
  passed
```

The Windows-side `setup-open-rig-wsl.ps1 -Mode Verify` check also passed and
reported the Ubuntu distribution as WSL2 without changing Windows or WSL.

The live verifier returned an absolute expected Windows PowerShell installation
path plus a bound file-identity digest, one structured process result, an
AST-only `Get-Date` raw preview, five visible Windows applications, and one
unique Brave top-level window after visiting 434 UI Automation nodes. The
traversal explicitly returned `truncated: false`. The action preview bound the
complete process ID, runtime ID, name, automation ID, control type, class,
enabled/offscreen state, bounds, executable identity, caller, WSL fingerprint,
working directory, and timeout. No UI action was applied by this fresh verifier.

## MCP evidence

The pre-convergence `setup-mcps.sh --apply` run provisioned Basic Memory
`0.23.2`, Playwright MCP `0.0.82`, and Chrome-for-Testing revision `1246`
beneath the pilot. A subsequent `--verify-only` passed against that historical
marker, both cached package versions, the managed uv environment target, and
the regular browser executable. The current canonical policy is Playwright MCP
`0.0.80` with browser revision `1243`; this artifact does not claim fresh
runtime evidence for that policy.

An isolated OpenCode run then completed these read-only Code Mode calls:

```text
basic-memory.recent_activity({ page_size: 1, page: 1 })  -> completed
playwright.browser_navigate(data:text/html,<title>OpenRigMcpProbe</title>) -> completed
playwright.browser_evaluate(() => document.title) -> OpenRigMcpProbe
```

OpenCode logged both local MCPs connected (`21` Basic Memory tools and `25`
Playwright tools). GitHub's hosted MCP endpoint returned HTTP 401 and OpenCode
reported `needs_auth`. The config contains no authorization header, token,
client secret, or provider credential. GitHub is provisioned but **not** claimed
connected until the operator completes OAuth through the isolated TUI's
`/mcps` screen and performs a read-only GitHub call.

## Remaining acceptance limits

- No fresh post-hardening rendered TUI/sidebar check.
- No visible interactive `ask` permission prompt; noninteractive MCP probes used
  OpenCode's explicit `--auto` test mode.
- No post-hardening Windows UI action apply.
- No GitHub OAuth connection.
- No WSLg or PowerShell 7 fallback evidence.
- Canonical repository QA stops in the unrelated native-Ubuntu
  `codex-fallback` package because its bounded-command lock-descriptor check
  fails. `shellcheck` is also unavailable if the shell stage is reached. This
  artifact records only the focused WSL2 scope and does not bypass either gate.
