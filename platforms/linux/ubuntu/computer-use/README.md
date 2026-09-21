# Open Rig for Ubuntu

This component supplies Open Rig's canonical Ubuntu computer-use skills, v2
plugins, profile-aware bounded MCP launchers, configuration examples, and
verification scripts. Ubuntu-on-WSL2 delegates its generic MCP surface here
while keeping a separate profile, runtime, cache, and notes root.

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
before applying its AT-SPI, `ydotool`, browser, and GitHub changes. It also
links skills, deploys commands, and seeds missing v2 config files; plugin
deployment registers canonical local packages.

## Layout

| Path | Purpose |
|---|---|
| `skills/` | Capability-specific agent instructions |
| `plugins-v2/` | Server and CLI plugin packages |
| `config/` | v2 server/CLI examples and role catalog |
| `scripts/` | Bounded setup, deployment, launch, and health checks |
| `../browser-tools/` | Native Ubuntu Playwright runtime |
| `config/mcp-versions.json` | One shared Basic Memory/Playwright/OAuth policy |

## Configuration and operation

Server plugins use `opencode.jsonc` and CLI plugins use `cli.json`; both use
`plugins` object entries with a canonical package path. The complete shapes are
[`config/v2-opencode.example.jsonc`](config/v2-opencode.example.jsonc) and
[`config/v2-cli.example.json`](config/v2-cli.example.json). The role catalog is
[`config/v2-plugin-roles.json`](config/v2-plugin-roles.json).

The twelve local v2 workspaces are documented in
[`plugins-v2/README.md`](plugins-v2/README.md). Explorer opens with
`/explorer`, `/editor`, `/files`, or `Ctrl+Alt+X`; its wider IDE roadmap is
explicitly planned, not complete. Resource-aware fallback is documented in the
[`codex-fallback` README](plugins-v2/codex-fallback/README.md).

`resource-monitor` adds compact CPU and RAM usage for each TUI's local process
tree while excluding the shared `opencode serve --service` subtree. The footer,
system overlay, Provider Usage details, and Explorer baseline have fresh
standalone TTY evidence. Setup and deployment are verified in disposable config;
provider data and visible-browser interaction remain runtime-dependent.

The `github` MCP is GitHub's hosted OAuth endpoint; do not add a token,
authorization header, or client secret to configuration. Complete sign-in from
OpenCode's `/mcps` screen. Restart OpenCode after changing skills, MCP
declarations, config, or plugins.
Remove an individual plugin by removing its v2 registration object and
restarting; the rest of the harness remains usable.

## Safety and checks

Verification is read-only by default. Desktop actions require preview tokens;
file operations enforce containment and atomic-save guards; browser profiles
are isolated; credentials remain outside the repository. Run package checks
through the bounded wrapper and follow the repository gates in
[`AGENTS.md`](../../../../AGENTS.md).
