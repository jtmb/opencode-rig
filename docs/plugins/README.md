# OpenCode v2 plugins

Open Rig uses twelve local OpenCode v2 packages. They are modular additions to the
server and CLI surfaces, registered from isolated v2 configuration and loaded
from canonical paths in this checkout.

| Package | Role | Provides |
|---|---|---|
| [`orchestration-policy`](../../platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md) | server | Durable session Goals, evidence-gated Plan→Build handoff, configured-limit subagents, policy-index and installed-binary protection, project-memory reconciliation, and task-scoped external GitHub issue writes |
| [`git-tool`](../../platforms/linux/ubuntu/computer-use/plugins-v2/git-tool/README.md) | server | Bounded read-only unified diffs through OpenCode's native VCS API |
| [`repo-learning`](../../platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/README.md) | server + CLI | Explicitly enabled structured observation and a read-only review panel |
| [`rig-tools`](../../platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md) | server + CLI | Durable `/goal` controls, Auto/Manual prompt-footer handoff, desktop/vision tools, repository gates, OpenCode runtime/recovery/TTY management, and bounded `/session-context` |
| [`rig-todo`](../../platforms/linux/ubuntu/computer-use/plugins-v2/rig-todo/README.md) | server + CLI | Todo tools, retained sidebar history, and the fullscreen `/tasks` Kanban |
| [`codex-fallback`](../../platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback/README.md) | server | Quota-aware provider fallback routing |
| [`chatgpt-connector`](../../platforms/linux/ubuntu/computer-use/plugins-v2/chatgpt-connector/README.md) | server | Active-OpenAI-OAuth image generation, web search, and session-private chat tools |
| [`source-control`](../../platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md) | CLI | Working-tree and optional PR status panel |
| [`codex-usage`](provider-usage.md) | CLI | Compact Provider Usage panel with a versioned, downstream-consumable design ledger |
| [`file-manager`](../../platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/README.md) | CLI | Docked Explorer tree, viewer, and explicit-save editor |
| [`resource-monitor`](../../platforms/linux/ubuntu/computer-use/plugins-v2/resource-monitor/README.md) | CLI | Per-TUI CPU and RAM footer status |
| [`ponytail-adapter`](ponytail.md) | server | OpenCode v2 bridge for the official Ponytail commands, skills, and per-session modes |

The bounded GNU Screen acceptance tool exposed by `rig-tools` has a separate
usage and safety guide at [`screen-terminal.md`](screen-terminal.md).
The opt-in Hermes observer shipped with `rig-tools` is deployed and verified
with [`deploy-hermes-plugin.py`](../scripts/deploy-hermes-plugin.md).
The agent-free Basic Memory recovery CLI and the plugin's preview/apply tool are
documented in [`opencode-recovery.md`](../scripts/opencode-recovery.md).

The Ponytail bridge has a separate compatibility and dependency guide at
[`ponytail.md`](ponytail.md), including its V1-only upstream boundary and
canonical lockfile/bootstrap path.

OpenCode's native **Open settings** controls host preferences. The plugin's
single **Open Rig workflow settings** entry in Ctrl+P controls Rig display,
session handoff, and workflow enforcements; no `/settings` slash alias or
separate settings package is required. The canonical role catalog is
[`config/v2-plugin-roles.json`](../../platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json).
`ponytail-adapter` is included in the general server role catalog. Its official
package is installed only through the canonical plugins-v2 workspace; the
retired floating external setup path is not supported.

The portable project and native/WSL global MCP sets are exactly
`basic-memory`, `github`, and `chatgpt`. WSL browser actions use its
Windows-default-browser connector and Playwright-like tools in place of the
former project-only Playwright MCP; live browser capability remains unverified
until bounded probes pass.

The headed Chromium `integrated-browser` plugin is retired. The distinct
[headless Firefox skill](../../platforms/linux/ubuntu/computer-use/skills/browser-headless/SKILL.md)
remains available for isolated browser automation.

## Registration

Server packages are listed in `opencode.jsonc`; CLI packages are listed in
`cli.json`. Local packages use the object form, not a bare npm name:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "/absolute/path/to/plugins-v2/rig-tools", "options": {} }
  ]
}
```

The complete shapes are [`v2-opencode.example.jsonc`](../../platforms/linux/ubuntu/computer-use/config/v2-opencode.example.jsonc) and [`v2-cli.example.json`](../../platforms/linux/ubuntu/computer-use/config/v2-cli.example.json). A package can be removed by deleting its object from the relevant `plugins` array and restarting OpenCode.

## Surfaces and safety

- Server plugins expose bounded tools, lifecycle hooks, and registered slash
  commands to the OpenCode service; CLI plugins render panels, commands, and
  keymaps in the TUI.
- `rig-tools` uses preview tokens for mutations. File-manager writes enforce
  project containment, `.git` and outside-root symlink refusal, fingerprints, dirty guards,
  and atomic replacement.
- Plugin checks run through the shared bounded command wrapper. Run a package's
  check with:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/<package> run check
```

The Explorer is an active component, but its broader IDE roadmap remains
planned. See [`docs/plans/explorer-ide.md`](../plans/explorer-ide.md) for the
rendered-UI and interaction acceptance gates.

## Removal and troubleshooting

Open Rig does not require a monolithic install. Remove one package registration,
restart OpenCode, and retain the rest of the harness. Do not edit generated
`node_modules` or deployed copies as a substitute for source changes.

To check for an older headed Chromium registration in the selected server and
CLI configs, then remove only entries whose package path is the canonical
`integrated-browser` package, use:

```bash
platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --config-dir "$HOME/.opencode-v2-pilot/config" \
  --cli-config "$HOME/.config/opencode/cli.json" \
  --retire-integrated-browser --verify-only
platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --config-dir "$HOME/.opencode-v2-pilot/config" \
  --cli-config "$HOME/.config/opencode/cli.json" \
  --retire-integrated-browser --apply
```

Use the actual active config paths when they differ from these defaults. The
retirement preserves unrelated plugin entries, settings, and files; it does not
delete the dormant source package, browser skills, or browser caches.

After changing plugins or config, restart OpenCode and run the v2 health check.
The repository history records prior architecture; current documentation is
v2-only.
