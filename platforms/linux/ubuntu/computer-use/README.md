# Open Rig for Ubuntu

This component supplies Open Rig's canonical Ubuntu computer-use skills, v2
plugins, profile-aware bounded MCP launchers, configuration examples, and
verification scripts. Ubuntu-on-WSL2 delegates its generic MCP surface here
while keeping a separate profile, runtime, cache, and notes root.

Native Ubuntu and isolated WSL2 profiles use exactly three MCPs:
`basic-memory`, `github`, and `chatgpt`. Visible browser work and QA from WSL use
the Windows-default-browser tools documented in the
[`browser-assistant` guide](skills/browser-assistant/README.md). The direct-pinned
Playwright package is not an MCP; use it only for explicitly requested headless
Firefox tasks.

## Supported environment

- Ubuntu 26.04.1 LTS amd64
- GNOME Shell on Wayland
- OpenCode v2.0.7 (or a compatible v2 release validated by the checks)
- Node.js 22.6+ for plugin checks and Python 3
- `python3-pyatspi`, `ydotool`, and `wl-clipboard`
- Optional Blender 5.0.1 and NumPy for 3D workflows

Other Linux distributions are not claimed as supported.

## Install and verify

From the repository root, use the active v2-only scripts:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --plugins all --apply
./platforms/linux/ubuntu/computer-use/scripts/verify-opencode-v2.sh
```

The first command is read-only. Review the
[`setup-computer-assistant.sh` reference](../../../../docs/scripts/setup-computer-assistant.md)
before applying its AT-SPI, `ydotool`, and GitHub runtime changes. It also
links skills, deploys commands, and seeds missing v2 config files; plugin
deployment registers canonical local packages.

## Layout

| Path | Purpose |
|---|---|
| `skills/` | Capability-specific agent instructions |
| `plugins-v2/` | Server and CLI plugin packages |
| `config/` | v2 server/CLI examples and role catalog |
| `scripts/` | Bounded setup, deployment, launch, and health checks |
| `../browser-tools/` | Direct-pinned Playwright package for explicitly requested headless Firefox; no MCP or browser downloads |
| `config/mcp-versions.json` | Basic Memory, Node.js, and GitHub runtime pins |

## Configuration and operation

Server plugins use `opencode.jsonc` and CLI plugins use `cli.json`; both use
`plugins` object entries with a canonical package path. The complete shapes are
[`config/v2-opencode.example.jsonc`](config/v2-opencode.example.jsonc) and
[`config/v2-cli.example.json`](config/v2-cli.example.json). The role catalog is
[`config/v2-plugin-roles.json`](config/v2-plugin-roles.json).
The portable project and seeded profile assign GPT-6 Luna `#max` to Build,
Explore, and General, and GPT-6 Sol `#max` to Plan and the read-only Architect
subagent. Selected profiles verify
these role defaults; setup `--apply` upgrades only known older assignments
while preserving unrelated custom model choices.

The twelve local v2 workspaces are documented in
[`plugins-v2/README.md`](plugins-v2/README.md). Explorer opens with
`/explorer`, `/files`, or `Ctrl+Alt+X`; OpenCode's native `/editor` command
remains separate. Its wider IDE roadmap is explicitly planned, not complete.
Resource-aware fallback is documented in the
[`codex-fallback` README](plugins-v2/codex-fallback/README.md).

`ponytail-adapter` is one of the twelve catalog-managed server/CLI workspace
packages. Its official `@dietrichgebert/ponytail@4.10.0` dependency is pinned
in `plugins-v2/package-lock.json`; native and WSL2 setup verify or install that
workspace before deploying the role.

`resource-monitor` adds compact CPU and RAM usage for each TUI's local process
tree while excluding the shared `opencode serve --service` subtree. The footer,
system overlay, Provider Usage details, and Explorer baseline have fresh
standalone TTY evidence. Setup and deployment are verified in disposable config;
provider data and visible-browser interaction remain runtime-dependent.

The agent-free OpenCode recovery CLI and `rig-tools` recovery tools provide
bounded MCP diagnosis and Basic Memory readiness checks. Marker repair is
preview-first, and connected status never substitutes for a caller-owned live
`read_note` check. See the
[`OpenCode recovery guide`](../../../../docs/scripts/opencode-recovery.md).

The `github` MCP is the pinned official local server. Its wrapper reads only the
existing authenticated `gh` session at process start and passes the transient
token in the child environment. Do not add a token, authorization header,
client secret, or GitHub control variable to configuration. Restart OpenCode
after changing skills, MCP declarations, config, or plugins.
Remove an individual plugin by removing its v2 registration object and
restarting; the rest of the harness remains usable.

## Safety and checks

Verification is read-only by default. Desktop actions require preview tokens;
file operations enforce containment and atomic-save guards; headless Firefox
contexts are isolated, while WSL visible-browser tools use the user's Windows
default browser; credentials remain outside the repository. Run package checks
through the bounded wrapper and follow the repository gates in
[`AGENTS.md`](../../../../AGENTS.md).
