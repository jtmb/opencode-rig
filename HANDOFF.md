# Fresh handoff

Updated 2026-09-19 for the current Open Rig v2-only baseline.

## Copy-paste prompt

```text
Continue work in ~/repos/opencode-rig as Open Rig, the Ubuntu computer-use
agent harness for OpenCode v2.

Read AGENTS.md, README.md, platforms/linux/ubuntu/computer-use/README.md,
platforms/linux/ubuntu/computer-use/plugins-v2/README.md, docs/README.md, and
ROADMAP.md. Inspect the worktree before editing and preserve dirty work.

Run the current read-only gates in AGENTS.md first. Track multi-step work with
the todo tool, keep exactly one item in_progress, and verify the actual result.
Use --apply only for an approved write; restart the shared OpenCode service
(not only the TUI) after plugin/config changes. A TUI restart alone does not
reload server plugin code. Do not handle credentials, MFA, payment data, or
CAPTCHAs. Do not commit or push unless explicitly asked.
```

## Server-plugin reload procedure

Reopening or restarting the TUI does not reload server plugin code. Wait for
background child sessions to finish before restarting the shared service;
otherwise in-flight turns or child work may be interrupted. From the repository
root, run these commands in order:

```bash
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh service restart
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh service status
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh api get /api/info
```

The launcher's isolated config, data, and state remain on disk; this is not a
state reset. Persisted state does not guarantee that an in-flight request, turn,
or child session completes or resumes, so verify unfinished work after
reconnecting. After the authenticated service-info check succeeds, return to the TUI and run
`/restart`. Do not use `systemctl --user restart opencode.service`: this setup
has no persistent user unit.

The final clean restarts accepted omitted-model background launches through the
configured `openai/gpt-5.6-luna#max` agent model and released capacity after
terminal child follow-up. `/session-context`, `/tools`, and `/learn` rendered
nonblank supported CLI dialogs backed by bounded RPCs, without model generation,
session resume, or synthetic inbox messages. The direct `session_context`
backend remains a separately verified surface.

## Active surfaces

There are twelve local v2 workspaces. The role catalog deploys eleven: server
roles for `orchestration-policy`, `git-tool`, `integrated-browser`,
`repo-learning`, `rig-tools`, `rig-todo`, and `codex-fallback`; CLI roles for
`repo-learning`, `rig-todo`, `source-control`, `codex-usage`, `file-manager`,
`integrated-browser`, and `resource-monitor`. `ponytail-adapter` is the
twelfth workspace and has its own bounded setup.
The examples and canonical role catalog live under
`platforms/linux/ubuntu/computer-use/config/`.

`integrated-browser` owns one temporary Playwright BrowserContext and headed
Chromium window per OpenCode session. Its server tool and fullscreen CLI panel
share that context through typed RPC; the existing Firefox Playwright MCP is
unchanged. After explicit operator approval, Playwright installed pinned
Chromium 153.0.8010.12 revision 1243 in the isolated pilot cache without root,
system-browser changes, or sandbox weakening. The tool passed headed launch,
Example Domain rendering, bounded JPEG/ARIA/console capture, an accessible-link
click through to IANA, and cleanup. The fullscreen controller independently
launched Example Domain, rendered `ready · 1 tab` plus its ARIA snapshot, and
confirmed close back to `stopped · 0 tabs` with no Chrome process remaining.

The repository contains 19 skills, including `development-conventions`,
`agent-orchestration`, and `session-context`. The `rig-tools` server exposes 25
bounded tools, while its CLI export uses supported dialogs and RPCs for
`/tools` and `/session-context`; these commands do not generate a model turn,
resume the session, or write synthetic inbox messages. Source/package tests
cover the direct backend, and fresh post-restart rendered/interaction checks
accepted `/session-context`, `/tools`, and `/learn`.
The separate plugin-owned `/subagents` command opens a fullscreen session panel
with bounded resolved `provider/model#variant` child rows. It does not modify or
equal the native bottom Subagents panel because v2.0.7 exposes no supported
row-renderer or data hook. The right sidebar separately shows up to eight active
direct children; a real `General · openai/gpt-5.6-luna#max` row rendered with
animation at 120 columns, without animation at 99 columns, and opened the child
on click. The corrected layout anchors Explorer before `sidebar.content`, then
replaces that content with supported MCP status plus active children, and
anchors Todo after it. At 140×60, Explorer rendered first, Context was absent,
three MCP rows were connected, a real active child was visible, and Todo was
present. The MCP section uses `- MCP` plus colored `• name Connected` rows and
collapses to `+ MCP (3 active)`; native `/mcps`
remains management. Clicking Explorer opens its fullscreen repository viewer. The native bottom picker
still misses cross-client children; the operator declined a plugin panel above
the chat bar, so that native limitation remains explicit.
Explorer now uses a native-diff-style fullscreen two-pane layout backed only by
supported APIs. The left tree includes every safe local repository file; changed
files render working-tree patches, clean files render syntax-highlighted source,
and deleted paths remain diff-only entries. Added and deleted patches use the
full-width unified layout automatically; modified patches retain split/unified
choice through `v` and the clickable header control. Live 140×60 evidence
covered the 410-change all-patches view, clean `.gitignore`, full-width deleted
`docs/migration/opencode-v2.md`, the clickable side-by-side/full-width toggle,
source selection, and entry into the preserved guarded editor. Physical
pointer activation, tabs, cursor placement, edit/discard guards, and `Ctrl+S`
remain available. Twenty-one
managed parser assets and the OpenTUI-bundled language set pass automated
verification; a visual audit of every syntax family is not claimed.

The resource footer and system-resources overlay have fresh standalone TTY
evidence at wide and narrow widths. Provider Usage correctly reads the live
provider catalog and rendered truthful unavailable-data states at 120, 80, and
60 columns. RLE observes bounded metadata automatically unless explicitly
paused; token-bound resume, observing status, restart-to-paused behavior, and
the visible `/learn` dialog have package/live evidence. The native
Subagents panel lists completed reviewers but currently omits model and variant;
`/subagents` is the separate plugin-owned panel described above, not a
native-panel change. No installed binary patch is allowed. A private
project-enabled runtime
showed Basic Memory, GitHub, and Playwright connected (`3 MCP`). That existing
Firefox MCP remains a separate surface; the plugin-owned headed Chromium flow
has its own completed live acceptance above.
The current `opencode.json` selects `openai/gpt-5.6-luna#max` for both
`explore` and `general`; orchestration allows at most three background children
only after memory approval. Clean-restart live fixtures accepted omitted-model
resolution, terminal-child capacity release, and required parent follow-up.
Repository change/review/correction/release work now starts with persisted
`task_declare`, requires a validated direct background child and accepted
follow-up, and fails closed when capacity is unavailable. Correction tasks also
require roadmap, active-todo, and project-memory acknowledgements. The live
repair exercise exposed and fixed result-shape child binding, lifecycle pairing,
worker readiness, restore nullability, and follow-up persistence; the final
verification child `ses_f3f3d5ee2ffeMbGbZ6kVXTltKp` was accepted after canonical
QA passed. OpenCode v2 still has no supported final-answer or semantic-intent
veto; enforcement is explicit-tool and lifecycle based.
Permission policy checks pass; commit and push remain separately gated and no
commit or push was performed.

## Final verification

- The portable acceptance-evidence manifest passes with ten claims and three
  independently reviewed background records. Canonical repository QA passes all
  twelve package checks, every self-test, policy/documentation/deployment gates,
  format/link validation, and Git whitespace checks.
- PR #3 CI portability is bounded: CI pins the locally verified Node 22.22.2
  release, installs both locked v2 workspaces before package QA, and uses a
  workspace-relative Playwright MCP command; the verifier also accepts the
  setup assistant's checkout-local absolute form.
- Canonical QA keeps bounded start and end context for failed commands so
  runner-only test assertions remain visible without dumping full output.
- `integrated-browser` package typecheck/tests and disposable role-deployment
  self-tests pass; its pinned headed Chromium runtime and controller now pass
  live launch, navigation, rendering, accessible interaction, and cleanup.
- Final authenticated runtime evidence reports OpenCode 2.0.7, PID `253389`,
  92 active plugins, zero failures, and three connected MCPs.
- The protected `platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage/README.md`
  remains unchanged at SHA-256
  `04b507aeb8a12954f605c3a393f7aae61f255fd7d31007c381e5406a0d36f5af`.
  A live protected-path preview was denied before reaching the installed
  OpenCode executable; do not patch or replace installed distribution files.
- The worktree is intentionally dirty and remains uncommitted and unpushed;
  preserve unrelated changes. Release staging must be refreshed after the
  current correction scope is complete.
- npm's lockfile audit still reports 13 dependency findings (2 low, 11
  moderate); no dependency churn was added solely to mask those findings.

## Exact next actions

1. Review and stage the exact scope, then rerun the state-bound QA and
   documentation gates.
2. Seek separate explicit approvals for
   commit, push, and PR merge.
