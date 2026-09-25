# `verify-opencode-v2.sh`

Read-only health check for the isolated OpenCode v2 stack. It never connects an
MCP server, so it never launches a browser.

```bash
platforms/linux/ubuntu/computer-use/scripts/verify-opencode-v2.sh
```

Override the paths with environment variables:

| Variable | Default |
|----------|---------|
| `OPENCODE_V2_PILOT_DIR` | `~/.opencode-v2-pilot` |
| `OPENCODE_V2_BIN` | `~/.local/opt/opencode-v2/opencode` |
| `OPENCODE_V2_REPO` | `~/repos/opencode-rig` |
| `OPENCODE_V2_CONFIG_DIR` | `$OPENCODE_V2_PILOT_DIR/config` |

## Checks

- The v2 binary exists and `--version` reports `opencode v2.x`.
- The server config (`opencode.jsonc`) and CLI config (`cli.json`) exist.
- The canonical v2 role catalog validates package paths, role entrypoints, and
  expected config files.
- The config-dir `skills/` source has 19 entries (no stray `README`).
- The config-dir `commands/` source has at least the four global commands.
- Global `mcp.servers` declares exactly `basic-memory`, `github`, and `chatgpt`
  with their enabled local wrappers; Playwright and legacy flat same-name MCP
  keys are absent.
- Repository `opencode.json` declares the same exact three-server set:
  Basic Memory, GitHub, and ChatGPT use workspace-relative local wrappers with
  no credential fields. The wrappers use OpenCode's default workspace `cwd`.
- Native and isolated WSL global profiles use the same three MCPs. WSL browser
  actions use the Windows-default-browser connector with Playwright-like tools
  instead of a project-only Playwright MCP; live browser capability still needs
  bounded probes.
- Repository and canonical example agent models bind Build/Explore/General to
  `openai/gpt-6-luna#max` and Plan/Architect to `openai/gpt-6-sol#max`. The
  selected server profile must explicitly define the five roles and cannot retain GPT-5.6 or a
  swapped GPT-6 family; unrelated explicitly selected custom models are preserved.
- `cli.json` has `session.permissions` exactly `prompt` and
  `attention.sound` exactly `false`.
- Every catalog-declared server and CLI role is declared in its expected config,
  with canonical package paths, no duplicate or malformed entries, and an
  existing role entrypoint. This includes both `rig-todo` roles.
- `cli.json` selects the `aura` theme for the configured v2 theme.
- JSONC parsing is string-safe, accepts line/block comments and trailing commas,
  and rejects malformed input and duplicate object keys.
- The deployed skill tree contains no symbolic links.

It exits non-zero if any check fails, printing `OK:` lines for each pass and
`FAIL:` lines for each problem. A missing binary or config still runs the
remaining checks so every problem appears in one pass. Because it is a
config/file check, it is safe to run in CI and while a v2 TUI is running. It
does not install dependencies, download parser assets, or modify the target
configuration.
