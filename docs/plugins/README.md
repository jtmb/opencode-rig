# OpenCode v2 plugins

Open Rig uses twelve local OpenCode v2 packages. They are modular additions to the
server and CLI surfaces, registered from isolated v2 configuration and loaded
from canonical paths in this checkout.

| Package | Role | Provides |
|---|---|---|
| [`orchestration-policy`](../../platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/README.md) | server | Hook-enforced subagents, policy-index validation, installed-binary protection, and project-memory reconciliation |
| [`git-tool`](../../platforms/linux/ubuntu/computer-use/plugins-v2/git-tool/README.md) | server | Bounded read-only unified diffs through OpenCode's native VCS API |
| [`integrated-browser`](../../platforms/linux/ubuntu/computer-use/plugins-v2/integrated-browser/README.md) | server + CLI | Bounded external headed Chromium window with a shared per-session BrowserContext |
| [`repo-learning`](../../platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/README.md) | server + CLI | Explicitly enabled structured observation and a read-only review panel |
| [`rig-tools`](../../platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/README.md) | server | Desktop/vision tools, repository gates, capacity checks, OpenCode API/runtime/TTY management, `/tools`, and bounded cross-session context with `/session-context` |
| [`rig-todo`](../../platforms/linux/ubuntu/computer-use/plugins-v2/rig-todo/README.md) | server + CLI | Todo tools and the live Todo panel |
| [`codex-fallback`](../../platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback/README.md) | server | Quota-aware provider fallback routing |
| [`source-control`](../../platforms/linux/ubuntu/computer-use/plugins-v2/source-control/README.md) | CLI | Working-tree and optional PR status panel |
| [`codex-usage`](provider-usage.md) | CLI | Provider Usage panel for Codex quota, DeepSeek balance, and OpenCode Zen status |
| [`file-manager`](../../platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/README.md) | CLI | Docked Explorer tree, viewer, and explicit-save editor |
| [`resource-monitor`](../../platforms/linux/ubuntu/computer-use/plugins-v2/resource-monitor/README.md) | CLI | Per-TUI CPU and RAM footer status |
| [`ponytail-adapter`](ponytail.md) | server | OpenCode v2 bridge for the official Ponytail commands, skills, and per-session modes |

The bounded GNU Screen acceptance tool exposed by `rig-tools` has a separate
usage and safety guide at [`screen-terminal.md`](screen-terminal.md).

The Ponytail bridge has a separate compatibility and lifecycle guide at
[`ponytail.md`](ponytail.md), including its V1-only upstream boundary and
bounded update procedure.

OpenCode's built-in `/settings` supplies host settings; no separate settings
package is required. The canonical role catalog is
[`config/v2-plugin-roles.json`](../../platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json).
The separately managed `ponytail-adapter` is intentionally not in that general
role catalog; `setup-ponytail-plugin.sh` owns its package, registration, and
update timer.

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

After changing plugins or config, restart OpenCode and run the v2 health check.
The repository history records prior architecture; current documentation is
v2-only.
