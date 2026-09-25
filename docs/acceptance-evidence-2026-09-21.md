# Unified Ubuntu live acceptance evidence — 2026-09-21

This artifact retains the 2026-09-21 bounded evidence from OpenCode `2.0.11`
after the native-Ubuntu and Ubuntu-on-WSL2 convergence and records the final
2026-09-22 text-capture reconciliation below. Earlier responsive captures came
from the real repository TUI through `screen_terminal`; interactions used its
state-bound preview/apply workflow. A later bounded WSL `vision_capture`
privacy check returned an unrelated active Windows media window and was
correctly rejected as TUI visual evidence. No screenshot file was created or
retained.

The retained sections are the 2026-09-21 capture record. The final
2026-09-22 section is fresh bounded text evidence, but it is only partial
acceptance for the later correction: it does not accept the corrected
Provider Usage rolling-window visibility, all-visible-row Todo history,
Explorer theme fallback, change-aware UI gate, or cross-repository
orchestration portability. No screenshot artifact was created or retained.

## Scope boundary for the current correction

The Provider Usage captures below are retained as 2026-09-21 rendering and
interaction evidence for the native MCP-style sidebar, responsive no-wrap
layout, and collapsed/expanded behavior. The final 2026-09-22 text capture
accepts only partial server-role/readiness evidence: the OpenAI ready text and
refresh interaction remain useful, while its Zen/Ingenium `OFFLINE` rows are
superseded and do not accept current provider visibility. It does not prove
the authoritative two-hour activity boundary or hidden inactive providers.
It is text evidence, not a screenshot artifact.

The retained Todo captures likewise prove additive coexistence only. The final
2026-09-22 text capture below accepts current/pending placement and readable
wrapping at 180/140 columns, but its compact/truncated completed-history rows
are superseded and do not accept the all-visible-row contract. It records
native sidebar hiding at 80/60 and makes no row-visibility claim at those narrow
widths.

## Final 2026-09-22 live correction record

The following is the retained bounded text record from the parent session. Its
partial observations are labeled below; it does not claim a screenshot or
persistence artifact:

1. **Active global deployment.** Repository
   `deploy-plugins.sh --config-dir ~/.config/opencode --cli-config
   ~/.config/opencode/cli.json --plugins all --apply` completed, followed by a
   verify-only run with exit 0. Installed OpenCode binaries were untouched.
2. **Restarted runtime.** The shared service was restarted after every child
   completed and received follow-up. In-process runtime after restart was
   OpenCode `2.0.11`; plugins total `94`, active `94`, failed `0`, builtin `86`,
   external `8`. `opencode-rig.codex-usage` loaded from repository root
   `plugins-v2/codex-usage/server.ts`, was active, and exposed `server+tui`.
   Basic Memory, GitHub, and Playwright MCPs were connected. Providers were
   `opencode` enabled, `openai` auto, and `ingenium-primary`/`ingenium-back-up`
   enabled, with 21 models.
3. **Todo current-work layout (partial).** A bounded GNU Screen standalone TUI continued
   the current session. At 180 and 140 columns, the Todo header was `4/5`,
   `Active subagents 0`, and `Parent verification and completion` appeared
   first while in progress; its detail wrapped readably over multiple lines.
   Completed history stayed one-line compact/truncated. That proves current
   work was not hidden behind completed entries, but the compact/truncated
   history is superseded and is not acceptance of the corrected row contract.
   No screenshot file was retained.
4. **Provider Usage rendering (partial).** The same 140-column text capture after
   authoritative server reload showed `OpenAI READY · Weekly: 28% left`,
   `OpenCode Zen OFFLINE`, and enabled Ingenium providers `OFFLINE` (with the
   long label safely bounded). It showed `Updated just now` after interaction.
   The OpenAI ready text and bounded row rendering remain evidence, but the
   Zen/Ingenium offline-row result is superseded: it does not prove current
   authoritative Zen readiness, recent-activity qualification, or inactive
   Ingenium suppression.
5. **Refresh interaction.** `Ctrl+P` → `Refresh provider usage` was present;
   executing it produced `Provider usage — Usage limits refreshed.` and changed
   the timestamp to `Updated just now`; OpenAI remained `READY` with weekly
   usage.
6. **Responsive behavior.** At 80 and 60 columns, OpenCode's native responsive
   layout hid the sidebar rather than wrapping or corrupting rows; the main pane
   remained usable. Provider rows are not claimed at widths where native
   OpenCode hides the entire sidebar.
7. **WSL privacy boundary.** `vision_capture(mode=window)` used the checked-in
   bounded in-memory WSL2 backend, returned an unrelated active Windows media
   window, retained no screenshot file, and was correctly rejected as TUI visual
   evidence. The accepted live evidence above is text capture.
8. **Outstanding boundaries.** Privileged native-host acceptance, fresh
   isolated WSL2 full `bootstrap.sh --apply` plus Windows action acceptance, and
   bootstrap live-apply evidence remain pending. Fresh deployed correction
   evidence for Provider Usage, all Todo row statuses, Explorer open/interact/
   close, the combined affected sidebar, and cross-repository orchestration
   portability also remains pending. No top-level bootstrap apply was run, and
   no persistent screenshot artifact exists.

## Runtime and MCPs

- The restarted shared service reported 94 total/94 active plugins, zero failed
  (86 builtin, 8 external).
- `basic-memory`, `github`, and `playwright` each reported `connected`.
- Basic Memory `0.23.2` returned diagnostics and one bounded recent-activity
  page. Playwright opened an isolated data page and evaluated its title as
  `OpenRigMcpProbe`. The local GitHub MCP read the repository root through the
  authenticated `gh` session. No token, account identity, or repository file
  content was recorded.
- `setup-computer-assistant.sh --apply --user-only` and its verify phase handled
  both the isolated pilot and the active standard CLI profile. The active
  `~/.config/opencode/cli.json` retained notifications, set
  `attention.sound: false`, restored prompt permissions, and passed explicit
  CLI-plugin verification. Skills, commands, canonical global/project MCP
  declarations, pinned runtimes, parser assets, and all three live MCP
  connections also passed. The portable `opencode.json` hash remained
  `810fe54afa1b68b5377f662f7979b585526670aae3ce72695f69160f327ae8b7`.

## Responsive sidebar

The table below is retained historical 2026-09-21 evidence for the prior
responsive baseline. Its forced-sidebar observations, provider row states, and
compact-history observations are not reused for current correction claims. The
final 2026-09-22 record above correctly reports that native OpenCode hides the
sidebar at 80 and 60 columns.

| Width | Rendered result | Interaction result |
|---|---|---|
| 140×60 | One native `MCP` section listed Basic Memory, GitHub, and Playwright as connected. Active subagents, Todo, and Source Control remained separate additive sections. Expanded Provider Usage matched the native MCP grammar: disclosure triangle, semantic bullet, provider name left, and state right. Its collapsed form was the single line `▸ Provider Usage · 1 ready · 3 offline`; the provider counts/statuses are historical and superseded. No duplicate white MCP section appeared. | Pointer interaction expanded and collapsed Provider Usage, and a full TUI restart preserved the stored state. This remains native composition/interaction evidence, not current provider visibility acceptance. |
| 80×60 | OpenCode's `auto` layout initially hid the sidebar. The bounded `ctrl+x,b` leader chord showed native MCP and the additive sections without overlap. Expanded Provider Usage aligned historical provider rows on the left with right-aligned state values. A direct color-preserving capture showed red bullets/`OFFLINE` and green `READY`; those status observations are superseded. | The initial capture correctly showed `Active subagents 0`; an independent live review correctly observed `Active subagents 1` while that reviewer child was running. The difference is temporal, not a rendering defect. Expanded and collapsed Provider Usage both accepted pointer interaction. |
| 60×60 | The forced sidebar remained visible after resize. Native MCP, Active subagents, Todo, Source Control, working directory, and Provider Usage stayed within the narrow pane. Historical one-line provider rows and states are retained only as prior layout evidence and are not current visibility acceptance. | Provider Usage expanded and collapsed without reflowing adjacent native content. Full refresh error text remains available in `/provider-usage` rather than consuming a compact sidebar row. |

The active standard profile was corrected before a real background child
completed. Immediately after that completion, `attention.notifications`
remained `true`, `attention.sound` was `false`, and the direct active-window
capture showed an intact parent TUI with no new `ALSA` or native fd-2 diagnostic
text. Subsequent 140/80/60 captures were also clean. Replacement glyphs in
`screen_terminal` hardcopy are controller sanitization of TUI box-drawing
characters, not stderr output.

## Active-row repair found during acceptance

The first real active-child attempt exposed a runtime-only failure that static
source checks had missed: `rig-tools` selected a row through the optional
`theme.background.surface.offset` token, which the active theme did not expose.
The slot displayed OpenCode's bounded plugin error while the native MCP, Todo,
Source Control, and Provider Usage surfaces remained intact. The row now uses
the resolved semantic accent scale. After the package's 117 tests passed and
the TUI restarted, the active child rendered without a plugin error at 140×60.

## Current correction status

The repository state after the retained capture contains focused source/package
corrections whose live acceptance is still pending:

- **Provider Usage:** `codex-usage` now has focused visibility/activity tests
  for runtime readiness, OpenCode Zen without a quota adapter, disabled/absent
  providers, and the inclusive two-hour boundary. The retained live text does
  not exercise those corrected cases; no current Zen/Ingenium visibility claim
  is made.
- **Todo:** `rig-todo` now routes every visible status through one word-wrapped
  row and bounds only omitted history. The retained live text contains the
  superseded compact/truncated history form; a fresh narrow combined sidebar
  run is required.
- **Explorer:** current `file-manager/src/tui.tsx` still evaluates
  `theme().background.surface.offset` in the full panel path. The live
  `session.panel` crash remains unresolved. The rendered fixture's explicit
  palette proves tree/tab component behavior only, not minimum-theme panel
  fallback; package minimal-theme coverage and fresh `/explorer`
  open/interact/close evidence remain pending.
- **Orchestration portability:** current package tests accept namespaced
  consuming-project agents and arbitrary resolved models without global
  allowlists, but the prior cross-repository denial requires fresh deployed
  live regression evidence.
- **Change-aware UI testing:** the current documentation map/check is
  source-to-document coverage, not a UI source-digest mapping to behavioral/
  render tests and fresh deployed evidence. That gate remains in progress.

## Automated and independent review

- `rig-tools`: typecheck and 119 tests passed after the active-row,
  leader-chord, and bounded WSL screenshot corrections.
- **Historical rendering baseline:** `codex-usage` typecheck and 19 tests
  passed, including collapsed default, native MCP-style rows, semantic status
  tones, conditional summary, and one-line truncation.
- The current 2026-09-22 `codex-usage` package check passes typecheck and 35
  tests, including the focused visibility/activity corrections represented by
  `provider-state.test.ts`, `provider-visibility.test.ts`, and
  `activity-state.test.ts`. The final text record above is only partial live
  OpenAI/refresh evidence; it does not accept corrected provider visibility and
  no screenshot file was retained.
- The current 2026-09-22 `orchestration-policy` package check passes typecheck
  and 41 tests, including namespaced-agent/arbitrary-model portability. Fresh
  cross-repository live revalidation remains pending.
- The current `rig-todo` layout package check passes 15 tests; the final text
  record above accepts fresh live 180/140 current/pending placement and records
  native 80/60 sidebar hiding, but its compact/truncated history is superseded.
  No screenshot file was retained.
- `file-manager`: its rendered OpenTUI fixture runs in a captured subprocess;
  the package check passed without leaking native stderr into the TUI. It does
  not cover the full panel's missing-theme-token fallback, and no current live
  Explorer acceptance is claimed.
- MCP runtime, dual-profile native setup, disposable WSL2 isolation, WSL
  ownership, and all 36 WSL interop tests passed. The bounded WSL
  `vision_capture(mode=window)` privacy check returned an unrelated Windows
  media window and was rejected as TUI visual evidence; its PNG stayed in
  memory and no screenshot file was retained.
- Independent review `ses_f39c6cf3fffeXZS2jPfZHY5uhi` correctly rejected the
  pre-repair capture because it lacked active and narrow-width proof. The
  repaired captures therefore supersede, rather than relabel, that incomplete
  evidence.
- Independent QA review `ses_f39be7855ffeviyvT6mrT22d01` passed the focused
  repository-QA self-test and the complete canonical gate, including the narrow
  historical `wsl-session.md` HEAD-whitespace exemption.

## Remaining host boundary

The user-owned OpenCode stack has bounded deployed-runtime evidence, but the
affected correction surfaces below are not accepted. Full native-GNOME
desktop-control provisioning still requires interactive elevation for
`python3-pyatspi`, `ydotool`, `wl-clipboard`, input-group membership,
`/dev/uinput`, and the private ydotool service. The current WSL2 host proves the
bounded in-memory Windows capture fallback with Windows PowerShell 5; the
current window result was unrelated media content and was rejected as TUI visual
evidence. A fresh isolated WSL profile, WSLg, PowerShell 7, and Windows-side
action-apply evidence remain outside this acceptance.

The retained text record provides partial OpenAI/refresh and Todo
current/pending evidence only. The authoritative Provider Usage visibility
correction, all-visible-row Todo history, Explorer fallback and interaction,
cross-repository orchestration portability, native privileged-host acceptance,
fresh isolated WSL2 full apply/action acceptance, and cross-platform bootstrap
live-apply evidence remain pending. No screenshot artifact is claimed.
