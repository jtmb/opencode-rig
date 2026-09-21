# Open Rig v2 plugins

The active OpenCode v2 plugin workspace contains twelve modular packages:

| Package | Role | Surface |
|---|---|---|
| [`orchestration-policy`](orchestration-policy/README.md) | server | hook-enforced subagent, policy-index, binary-protection, and project-memory reconciliation gates |
| [`git-tool`](git-tool/README.md) | server | bounded read-only diffs through OpenCode's native VCS API |
| [`integrated-browser`](integrated-browser/README.md) | server + CLI | bounded external headed Chromium window with a shared per-session BrowserContext |
| [`repo-learning`](repo-learning/README.md) | server + CLI | opt-in structured observation and read-only review |
| `rig-tools` | server | bounded desktop, repository, orchestration, OpenCode API runtime/self-analysis, GNU Screen acceptance, cross-session tools, CLI dialogs, and the plugin-owned `/subagents` panel |
| `rig-todo` | server + CLI | Todo tools and panel |
| `codex-fallback` | server | provider fallback routing |
| `source-control` | CLI | working-tree and PR panel |
| `codex-usage` | CLI | Codex quota, DeepSeek balance, and OpenCode Zen status panel |
| `file-manager` | CLI | fullscreen all-files repository and diff viewer with guarded editing |
| `resource-monitor` | CLI | per-TUI CPU and RAM footer |
| [`ponytail-adapter`](ponytail-adapter/README.md) | server | v2 bridge for the official Ponytail package, commands, skills, and per-session modes |

Registration is object-based: server entries belong in `opencode.jsonc`, CLI
entries in `cli.json`. See the v2 examples and
`config/v2-plugin-roles.json`; local packages resolve their root `server` or
`tui` entrypoint. The separately managed `ponytail-adapter` is registered by
`scripts/setup-ponytail-plugin.sh`, not by the general role catalog.

```jsonc
{ "plugins": [{ "package": "/absolute/path/to/plugins-v2/rig-tools", "options": {} }] }
```

## Checks

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/<package> run check
```

Checks use the shared bounded command wrapper. The v2 health/deployment checks
validate the role catalog and canonical package paths without launching MCPs.

## Current status

All twelve packages have v2 checks. `git-tool`, `integrated-browser`, `rig-tools`, and `rig-todo` provide the core
agent tools; `rig-tools` also registers in-process runtime status/reload,
OpenCode resource self-analysis, bounded GNU Screen acceptance, supported CLI
dialog/RPC paths for `/tools` and `/session-context`, and the separate
plugin-owned fullscreen `/subagents` session panel with bounded resolved
`provider/model#variant` rows. The latest blank command bodies are pre-fix
historical evidence; fresh rendered/interaction acceptance remains pending
until the shared service is restarted. The plugin panel does not modify or
equal the native bottom Subagents panel because v2.0.7 exposes no supported
row-renderer or data hook. Explorer's fullscreen two-pane repository viewer,
clean-source and changed-diff modes, explicit-save editor, and baseline
pointer/keyboard flows have live evidence; the resource
monitor reports the local TUI process tree; and fallback routing is active when
configured providers permit it. A visual audit of every Explorer syntax family
is not claimed.
