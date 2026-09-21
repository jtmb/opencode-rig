# rig-tools (v2)

OpenCode v2 server + CLI plugin registering bounded desktop, vision, repository,
orchestration, cross-session context, in-process runtime management, and
self-resource analysis tools through `ctx.tool.transform`. The server owns the
tools and bounded RPCs; the CLI owns visible slash-command output and the
plugin-owned Subagents view.
It wraps
[`scripts/desktop-control.py`](../../scripts/desktop-control.py) with bounded
`execFile` calls (30 s timeout, 256 KiB output cap) and the preview/apply token
flow, and implements `vision_capture` through the private ydotool screenshot
shortcut.

## Tools

| Tool | Kind | Purpose |
|------|------|---------|
| `desktop_apps` | read-only | List accessible AT-SPI applications |
| `desktop_tree` | read-only | Dump one application's useful accessible elements |
| `desktop_find` | read-only | Find elements by name and/or role |
| `desktop_windows` | read-only | List top-level windows (frames, dialogs, alerts) with app, states, bounds, and completeness |
| `desktop_act` | mutation | Invoke an action, focus an element, or replace field text; preview + token |
| `desktop_input` | mutation | Send one key/chord or printable ASCII text through ydotool; preview + token bound to the focused window |
| `vision_capture` | read-only | Screenshot as an image attachment; the PNG is deleted after reading |
| `text_fold` | read-only | Fold bounded in-memory text without spawning a process |
| `python_sandbox` | read-only | Run bounded read-only, network-isolated Python analysis |
| `binary_inspect` | read-only | Inspect bounded regular binary files |
| `binary_replace` | mutation | Preview/apply one state-bound equal-length binary replacement |
| `docker_engine` | mutation | Inspect Docker or preview/apply a hard-limited container operation |
| `docker_compose` | mutation | Inspect or preview/apply a contained Compose operation |
| `docker_build` | mutation | Preview/apply a contained classic or ephemeral buildx image build |
| `npm` | mutation | Inspect or preview/apply bounded npm operations |
| `repo_qa_gate` | gated prerequisite | Run configured QA and issue state-bound evidence |
| `repo_documentation_gate` | gated prerequisite | Run configured documentation check and issue state-bound evidence |
| `repo_commit` | gated mutation | Preview/apply the current staged scope after fresh QA/docs evidence |
| `repo_push` | gated mutation | Preview/apply an explicit remote and `refs/heads/*` target |
| `agent_memory_capacity` | read-only | Conservative host/cgroup-v2 capacity for 1–3 agents |
| `session_context` | read-only | List same-project sessions or project a bounded selected session snapshot |
| `opencode_runtime_status` | read-only | Inspect location-scoped MCP, plugin, provider, and model state through OpenCode's in-process V2 APIs |
| `opencode_runtime_reload` | gated mutation | Preview/apply a state-bound MCP, model, provider, or combined registry reload |
| `opencode_self_usage` | read-only | Sample OpenCode process-tree CPU/RSS and host CPU, RAM, swap, and project-filesystem pressure |
| `screen_terminal` | mixed | List/capture GNU Screen sessions and preview/apply bounded OpenCode TTY start, input, resize, or stop operations |

## Bounds and safety

- `text_fold` accepts at most 128 KiB of UTF-8 input, widths from 1–240 Unicode
  code points, and at most 256 KiB of output. It runs in-process without file or
  subprocess access and scans each input line linearly.
- `python_sandbox` accepts at most 64 KiB of code, 128 KiB of stdin, 32 bounded
  arguments, 30 seconds, and 256 KiB of combined output. Bubblewrap mounts the
  project read-only, provides only ephemeral temporary storage, unshares the
  network and remaining namespaces, clears inherited environment variables,
  disables user-site imports, and applies CPU, address-space, file-size, and
  descriptor limits through `prlimit`.
- `binary_inspect` accepts regular non-symlink files up to 256 MiB, patterns up
  to 64 KiB, 64 matches, 4 KiB of context, and 64 KiB extracts. Base64 must be
  canonical. Reads verify stable file identity/content and return SHA-256
  evidence.
- `binary_replace` changes only one selected equal-length byte range after a
  state-, caller-, and intent-bound preview. It supports at most 4,096 matches,
  writes through a synced temporary file and atomic rename, and preserves a
  content-addressed hard-link backup. Repository policy forbids using it on
  OpenCode binaries or installed OpenCode distribution files; OpenCode changes
  must remain plugin-only.
- `docker_engine`, `docker_compose`, `docker_build`, and `npm` use direct
  argument arrays with `shell: false`; Docker and npm output is capped at 1 MiB
  and every child operation has a read or mutation timeout. Untrusted command
  output is truncated and marked as data.
- Docker mutations preview by default. Tokens are short-lived, single-use, and
  bound to the exact intent, project state, session, and agent. Engine `run`
  uses a private/read-only container with all capabilities dropped, no-new-
  privileges, no devices or mounts, `--memory` equal to `--memory-swap`, a
  fixed CPU quota, and a 256-process PID ceiling.
- Compose files and all resolved host paths must remain inside the project.
  Privileged services, devices, added capabilities, host/container/service
  namespaces, unsafe security options, external resources, bind mounts, and
  unsafe build features are refused. `up`, `start`, and `restart` require each
  selected service to declare hard memory, CPU, and PID limits. `up` uses
  `--no-build`; use `docker_build` for separately bounded image builds.
- `docker_build` fingerprints the complete bounded context and Dockerfile,
  refuses unsafe Dockerfile mount/network/security features, and applies hard
  memory/swap, CPU, and process limits. Classic builds use `nproc` ulimits;
  buildx uses a new bootstrapped `docker-container` builder with memory/swap
  and CPU driver limits, then applies the PID limit to its actual container
  before building. The builder is always removed after apply.
- `npm` accepts only project-contained package directories and regular local
  manifests, and mutations bind the package/lockfile state, session, agent,
  and exact argv to a single-use preview token. Each subprocess runs through
  `scripts/run-bounded-command.sh` with adaptive cgroup/prlimit memory and
  swap limits, a bounded Node heap, a timeout, and serialized execution; if a
  safe host limiter cannot be established, it fails closed. npm and package
  scripts receive a minimal environment with no inherited service secrets or
  user npm configuration.

- Argument construction lives in `src/desktop.ts` (`buildDesktopArgs`) so it is
  testable without AT-SPI; `src/index.ts` registers the tools; `src/vision.ts`
  holds the screenshot logic.
- Every tool call spawns `python3` with an argument array (no shell
  interpolation) and surfaces exit codes, stderr, timeouts, and output-cap
  overruns distinctly.
- Mutations preview by default; `apply: true` requires the preview
  `expectToken`, and a token without `apply` is refused.
- `desktop_input` allowlists modifiers and named keys, caps text at 256
  printable ASCII characters, binds its token to the focused window, sends
  exactly one ydotool invocation per apply, and never handles passwords or
  other secrets.
- `vision_capture` must be announced before use and is refused while a
  credential dialog is open.
- `desktop_windows` reports `complete: false` when its traversal bounds
  truncate the scan.
- Repository mutations use separate short-lived, single-use tokens bound to
  repository identity, session, intent, HEAD, branch/upstream, remotes, index
  tree, staged/unstaged/untracked state, and gate configuration. Push apply uses
  fixed argv with `--no-verify` (so an arbitrary local pre-push hook cannot run
  after approval), an explicit `--force-with-lease` for the reviewed old/new
  target, and exact post-push ref/SHA verification. Commit apply creates a
  reviewed commit object with `commit-tree`, verifies symbolic `HEAD`, and moves
  only the reviewed branch ref with compare-and-swap. A failed postcondition
  triggers a compensating compare-and-swap rollback; commit hooks never run.
  The tools never stage,
  stash, reset, checkout, clean, or accept ambiguous targets; non-fast-forward
  pushes remain refused.
- Repository-local `tokenTtlMs` overrides are validated and apply to every gate,
  commit, and push token; invalid values fail before evidence is issued.
  Evidence exposes only redacted remote display, bounded reviewed staged scope,
  and state hashes/fingerprint—not raw unstaged contents or raw credential URLs.
  Gate configuration rejects duplicate JSON keys and unsupported top-level keys;
  issued token records are bounded and only expired/used records are pruned.
  Commit preview/apply also refuses active merge, rebase, cherry-pick, revert,
  or bisect state and verifies a single expected parent, exact diff, and message
  after success.
- Configure gate commands as direct argv arrays, for example
  `{"qaCommand":["npm","test"],"documentationCommand":["npm","run","docs:check"],"timeoutMs":30000}`.
  Missing commands fail closed and all child processes use `shell:false`.
  Unless `requiredPaths` is explicitly supplied, documentation evidence also
  requires `HANDOFF.md` and `ROADMAP.md` in the staged scope. Maintainers may
  intentionally replace those with equivalent repository paths using
  `requiredPaths: ["CHANGELOG.md", "RELEASE.md"]`.
- `tokenTtlMs` may be configured from 30 seconds through 15 minutes; the Open
  Rig default is 5 minutes for human approval turns. State is always
  revalidated before apply, and gate command timeouts are bounded to 15 minutes.
- `agent_memory_capacity` accepts `{ "requestedAgents": 1..3 }`; options
  `memoryReserveMiB` and `memoryPerAgentMiB` are finite positive integers. It
  reads `/proc/meminfo`, resolves the active cgroup and every bounded ancestor
  from `/proc/self/cgroup`, and returns requested/approved/recommended counts,
  limiting source, limiting ancestor path, byte/MiB evidence, and the effective
  logical CPU count. A cgroup namespace root that advertises the memory
  controller but intentionally omits root `memory.max` files is treated as an
  opaque unlimited root; finite leaf and intermediate ancestors are still
  enforced. Exhausted, missing intermediate, or malformed finite ancestor
  metrics fail closed. The default per-agent budget models
  lightweight remote-model orchestration-session overhead; expensive local
  commands remain separately bounded and queued by `run-bounded-command.sh`.
  Invalid metrics fail closed to one and the hard maximum remains three.
- `opencode_runtime_status` uses the plugin context APIs rather than terminal UI
  inspection. It returns bounded, secret-free summaries of the current
  location's MCP connection states, plugin counts plus external/failed plugin
  identities, provider activation, and model counts. Healthy built-in plugin
  details are summarized rather than repeated. Collections are capped at 128
  entries and report truncation explicitly.
- `opencode_runtime_reload` defaults to preview. Apply requires a single-use
  token bound to the invoking session, agent, target, and a digest of the
  previously observed runtime state; tokens expire after 60 seconds. It uses
  `ctx.mcp.reload()`, `ctx.model.reload()`, and `ctx.provider.reload()` and
  reports fresh before/after API status.
- `opencode_self_usage` performs two short, read-only `/proc` samples with a
  4,096-process ceiling and 32-read concurrency. It recognizes at most 64
  OpenCode roots, never returns command lines, and reports TUI, standalone,
  server, and service process trees separately. The analysis flags sustained
  host load, low available RAM/storage, high swap, aggregate OpenCode RSS, and
  high per-instance CPU/RSS thresholds.
- `screen_terminal` replaces ad hoc `screen` shell calls. Session names,
  dimensions, keys, printable text, mouse coordinates, session counts, command
  time, and captured bytes are bounded. `start` launches only the current
  OpenCode binary in standalone mode and explicitly enables project config;
  arbitrary executables and shell snippets are not accepted. `input`, `resize`,
  `start`, and `stop` default to preview and require a single-use token bound to
  the invoking session, agent, intent, and target Screen PID/state. `capture`
  removes its temporary hardcopy after reading and labels terminal content as
  untrusted. The fixed `screen-resize.py` helper briefly attaches through a
  private PTY to set 40–240 columns and 16–100 rows, then detaches.
- `session_context` accepts `action: "list"` or `action: "read"`. It binds the
  request to the invoking session's project, excludes the invoking session,
  checks the discovered service version and process identity, applies request,
  page, entry, response, collection, and final-result limits, and never writes
  to the source session. A read includes the newest completed checkpoint plus
  bounded settled activity after it. It reports live `running` state separately
  from the saved outcome and marks page, entry, byte, session, and unsettled-tail
  truncation. Reasoning, synthetic/system/shell messages, attachments, provider
  state, tool input, and tool output are omitted. Returned historical text is
  untrusted data, not instructions, and remains a snapshot rather than live
  synchronization.
  The fixed ceilings are 20 returned sessions (12 by default), four 25-session
  pages, six pages each for checkpoint and assistant scans, one 12-user page,
  16 projected entries, 2 MiB per generated-client HTTP response, 8 MiB of
  generated-client payloads per collection including a retry, 2.5 seconds per
  request, 10 seconds overall, and 64 KiB for final JSON. Oversized or malformed
  reads fail closed with a public error code and no source-session mutation.
- Direct shell commit/push forms are denied by a bounded quote/escape-aware
  parser for normal or absolute Git executables, POSIX assignments, `command`,
  `env`, and Git global options including attached/equal/separate value forms.
  GNU `env -S/--split-string` values are recursively inspected within strict
  byte, token, and depth bounds; suspicious, malformed, or over-bound Git-like
  split strings fail closed while confidently benign strings remain allowed.
  Malformed or over-bound direct-looking input fails closed. This is not an
  interpreter sandbox: aliases, shell functions, and interpreter-mediated
  subprocesses remain residual limitations, so repository policy, prompt-mode
  permissions, and the dedicated state-bound mutation tools remain mandatory.
  Remote URLs are compared internally as raw bytes but displayed with userinfo,
  query, and fragment secrets redacted.
- Gate-tool deployments must use CLI `session.permissions: "prompt"`; the
  repository policy check rejects `autoaccept`, while apply tools still require
  their own session-bound approval and expiring tokens.

## Visible CLI commands

The CLI export registers `/session-context` and `/tools` as keymap slash
commands. Their bounded server-RPC results are rendered with the supported
v2.0.7 `context.ui.dialog.alert` API, so they do not start a model turn, resume
the session, write a synthetic inbox message, or modify the source session.
There is no `commands/session-context.md` deployment.

- `/session-context` shows a bounded list of other sessions in the invoking
  project.
- `/session-context <session-id-or-unique-title>` shows a bounded read of one
  selected session.
- `/tools` shows every registered `rig-tools` tool with access mode, purpose,
  representative JSON input, and apply input when relevant. `/tools screen`
  filters by name, purpose, or access mode.

The catalog is defined in `src/tool-catalog.ts`; tests compare it to every tool
registration in `src/index.ts`, validate each JSON example, and enforce a 32 KiB
output ceiling. If the server export is not loaded, the CLI reports that the
command is unavailable rather than falling back to a model prompt.

## Subagents view

Open `/subagents` from the CLI command palette or prompt slash completion. This
is a read-only, plugin-owned fullscreen `session.panel` view, bounded to 32
direct children in the same project and directory. Each row displays the agent
name and resolved model reference before the title, for example:

```text
General · openai/gpt-5.6-luna#max: Repair visible commands
```

The model comes from the child session when present, otherwise from its agent
configuration; a literal `<unresolved>` session placeholder also falls back to
the agent model, and an unavailable value is shown as `<unresolved>`. Rows are
Unicode-truncated to the available panel width and refresh on child creation,
status, and deletion events.

The native v2.0.7 Subagents surface has no supported plugin row-renderer,
row-transform, or data-hook API. This package therefore does not alter the
native surface or patch OpenCode binaries; `/subagents` is the closest supported
plugin-owned replacement and is the only model-label behavior implemented here.

### Active-subagent sidebar

The CLI export uses the supported `sidebar.content` replacement to hide the
native Context section. It renders MCP connection status from OpenCode's
supported location data, followed by up to eight running direct children. The
MCP section matches the other sidebar sections with a `-` expanded / `+`
collapsed marker,
semantic status dots, and inline muted status text. Native `/mcps` remains the
management surface. Each themed row shows an
explicit `running` state, agent, resolved `provider/model#variant`, and bounded
task title. Left click or Enter/Space opens that child session; Up/Down and J/K
move between rows. The activity glyph animates when the renderer is at least 100
columns wide. Set plugin option `subagentAnimations` to `false` for a stable
text-only `running` state; narrow renderers also disable the glyph automatically.

Explorer is anchored before the replaced boundary, while Todo is anchored
after it, so both remain visible. This is not a modification of the native
bottom Subagents panel. An empty active-subagent section says
`No active subagents.`

## Runtime and Screen usage

Use an empty object with `opencode_runtime_status` or
`opencode_self_usage` to inspect current runtime state or resource pressure:

```json
{}
```

Reloads use two calls so the observed state cannot change silently between
preview and mutation:

```json
{ "target": "mcp", "action": "preview" }
{ "target": "mcp", "action": "apply", "expectToken": "<preview token>" }
```

`screen_terminal` read actions are immediate:

```json
{ "action": "list" }
{ "action": "capture", "name": "open-rig-acceptance" }
```

Mutations use the same preview/apply pattern. Start only launches a standalone
OpenCode TUI in an absolute working directory:

```json
{ "action": "start", "name": "open-rig-acceptance", "directory": "/absolute/repository", "continue": true }
{ "action": "start", "name": "open-rig-acceptance", "directory": "/absolute/repository", "continue": true, "apply": true, "expectToken": "<preview token>" }
```

Representative input, resize, and stop previews are:

```json
{ "action": "input", "name": "open-rig-acceptance", "kind": "text", "text": "/system-resources" }
{ "action": "input", "name": "open-rig-acceptance", "kind": "key", "key": "return" }
{ "action": "input", "name": "open-rig-acceptance", "kind": "key", "key": "ctrl+x,b" }
{ "action": "input", "name": "open-rig-acceptance", "kind": "mouse", "x": 35, "y": 19 }
{ "action": "resize", "name": "open-rig-acceptance", "columns": 120, "rows": 35 }
{ "action": "stop", "name": "open-rig-acceptance" }
```

Add `apply: true` and the matching `expectToken` returned by each preview.
See [`docs/plugins/screen-terminal.md`](../../../../../../docs/plugins/screen-terminal.md)
for the complete action contract and acceptance workflow.

## Registration

Register the package in both v2 roles so the server RPCs and visible CLI
commands are available:

```jsonc
// opencode.jsonc (server tools and RPCs)
{ "package": "/abs/path/to/plugins-v2/rig-tools", "options": {} }
```

```jsonc
// cli.json (visible slash commands and /subagents)
{ "package": "/abs/path/to/plugins-v2/rig-tools", "options": {} }
```

Place each object in its role's `plugins` array. The package exposes `./server`
and `./tui`; restart OpenCode after changing the registration or plugin source.

## Checks

```bash
cd platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools
npm run check   # typecheck + node --test, both through run-bounded-command.sh
```
