# Open Rig v2 plugins

The active OpenCode v2 plugin workspace contains twelve modular packages:

| Package | Role | Surface |
|---|---|---|
| [`orchestration-policy`](orchestration-policy/README.md) | server | durable session Goals with fail-closed pre-restart Auto handoff, bounded Auto self-resume of plugin-set transient blockers, evidence-gated Plan→Build, per-hook operator workflow settings including a `requireTodoDispatch` toggle that decouples agent admission from per-Todo binding (admission follows `maxConcurrent`), configured-only admission with bounded restored-child idle reconciliation, a read-only `admission_status` counter surface, and policy-index, binary-protection, and project-memory gates |
| [`git-tool`](git-tool/README.md) | server | bounded read-only diffs through OpenCode's native VCS API |
| [`repo-learning`](repo-learning/README.md) | server + CLI | opt-in structured observation and read-only review |
| `rig-tools` | server + CLI | durable `/goal` controls, configurable footer/sidebar summaries with hover/focus preview, per-session Auto/Manual handoff, one Ctrl+P workflow-settings entry, bounded desktop/repository/runtime tools, additive active-child and managed-Screen sidebar, `/subagents`, a fullscreen Hermes `/hooks` panel, and commit/push gates that compute the exact outgoing range even when a remote advertises refs this clone has not fetched |
| `rig-todo` | server + CLI | Todo tools, retained sidebar history, and fullscreen `/tasks` Kanban |
| `codex-fallback` | server | provider fallback routing |
| [`chatgpt-connector`](chatgpt-connector/README.md) | server | ChatGPT image, search, and session-private chat tools through active OpenAI OAuth |
| `source-control` | CLI | working-tree and PR panel |
| `codex-usage` | CLI | compact Codex quota, DeepSeek balance, OpenCode Go, and OpenCode Zen status panel |
| `file-manager` | CLI | fullscreen all-files repository and diff viewer with guarded editing |
| `resource-monitor` | CLI | per-TUI CPU and RAM footer |
| [`ponytail-adapter`](ponytail-adapter/README.md) | server | v2 bridge for the official Ponytail package, commands, skills, and per-session modes |

The default protected binary paths include `$HOME/.opencode/bin/opencode`; a
direct-binary read-only probe is limited to the exact `api get /api/info` argv.

`rig-tools` recovery includes read-only `opencode_recovery_status` diagnostics
and current-location `basic_memory_recovery` marker/readiness checks. A
`connected-awaiting_read_note` result is not recovery proof; only a successful
direct live `read_note` call verifies note readability. See the
[OpenCode recovery guide](../../../../../docs/scripts/opencode-recovery.md).

Registration is object-based: server entries belong in `opencode.jsonc`, CLI
entries in `cli.json`. See the v2 examples and
`config/v2-plugin-roles.json`; local packages resolve their root `server` or
`tui` entrypoint. `ponytail-adapter` is a catalog-managed server package and
its official `@dietrichgebert/ponytail@4.10.0` dependency is pinned in this
workspace's lockfile.

The headed Chromium `integrated-browser` package is retired from active roles
and the workspace. The separate [headless Firefox skill](../skills/browser-headless/SKILL.md)
remains available for isolated browser automation.

The portable project and native/WSL global MCP sets are exactly
`basic-memory`, `github`, and `chatgpt`. WSL browser actions use the
Windows-default-browser connector with Playwright-like tools in place of the
former project-only Playwright MCP; live browser capability remains unverified
until bounded probes pass.

```jsonc
{ "plugins": [{ "package": "/absolute/path/to/plugins-v2/rig-tools", "options": {} }] }
```

## Checks

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2 run test:browser-retirement
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/<package> run check
```

Checks use the shared bounded command wrapper. Most packages use its 45% memory
and 80% V8 heap defaults; `chatgpt-connector` uses a measured 55%/80% override,
while `rig-todo` retains its explicit 60%/80% override.
The v2 health/deployment checks validate the role catalog and canonical package
paths without launching MCPs; the workspace self-test covers registration
retirement and setup integration.

## Current status

All twelve active packages have v2 checks. `git-tool`, `rig-tools`, and
`rig-todo` provide core agent tools; `rig-tools` also registers in-process runtime status/reload,
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
