# Open Rig roadmap

Updated 2026-09-29. This is the consolidated current-state ledger. The complete
pre-consolidation roadmap is preserved byte-for-byte in
 [`roadmap-archive-2026-09-25.md`](roadmap-archive-2026-09-25.md),
SHA-256 `89ae96b03eda659b66f7d0db4bac15d04cfe2878cb93931285e2bc870031a25b`.

## Purpose and how to use

Use this ledger for the current verified baseline, open workstreams, blockers,
and next actions. Evidence below is scoped to the stated run or snapshot; the
archive retains the detailed history, superseded states, and prior evidence.
Visible UI claims require retained host-render and interaction evidence and
checker acceptance; test-renderer output alone cannot promote a claim.

## Current verified state

- **Selected service:** OpenCode `2.0.11` at
  `/home/brajam/repos/opencode-rig`; `opencode_runtime_status` reports 95/95
  plugins active and the Basic Memory, ChatGPT, and GitHub MCPs connected.
- **Canonical QA:** state-bound preview and apply previously passed all 12 curated packages
  and canonical checks at worktree fingerprint
  `a8e6e2a3605f29af92b25a811220d69d399a820df938186b012030a7f17a5c43`
  (output SHA-256
  `00411da60bea72a0dcca436bb18e7d94a93af8cc535e31e1720cbf87d757ffc8`). The
  pre-archive fingerprint `16103fda8ac2b34a7450e2562ad986149df6de085c1443f18e862e2dc3565b24`
  is historical. A subsequent full read-only canonical QA run on the working
  tree passed after narrowing the generated-frame whitespace exclusions. A new
  full canonical QA run passed all twelve curated packages and the acceptance
  gate after the 2026-09-28 v9 inventory and cross-worktree sidebar fix.
- **Acceptance inventory:** the historical 2026-09-25 v3 snapshot had 14 source
  mappings, 28 execution receipts, and 15 native test-render captures. The
  fresh 2026-09-28 **v9** ready run covers 15 sources, 30 focused receipts
  (including the new Goal slot regression), and 16 native captures, with current
  corrected UI source hashes. A foreground WSL-terminal Screen-stop pair
  validates, so `sidebar-coexistence` is `limited`; eight other visible claims
  remain `planned`. The companion start images show Screen 0→1; stop records
  bind the visible 1→0 transition and shared Goal/Todo/Active Subagents sidebar.
- **Documentation verification:** the historical documentation gate passed with
  462 mapped files and 173 changed at the earlier fingerprint. Focused current
  documentation coverage passes at 551 mapped files. The state-bound
  documentation gate requires staged ROADMAP.md/HANDOFF.md paths; nothing is staged.

## Remaining workstreams

**Execution continuity correction (operator, 2026-09-29):** A conversation
checkpoint is continuity context, not a request to pause. Continue the active
roadmap Goal and code fixes until the operator explicitly says to stop or a
specific supported approval/runtime gate blocks that action. A blocked row
does not suspend independent rows. The earlier pause interpretation was wrong.

**P0 skill-discovery correction (operator report):** The repository contains
20 canonical `platforms/linux/ubuntu/computer-use/skills/*/SKILL.md` entries,
but the loaded project-scoped `/api/skill` list exposes only 12 total and just
two of those canonical repository skills (`repo-onboarding` and
`skill-maintenance`, from global copies). Neither project `opencode.json` nor
the selected global config declares the canonical skills directory. OpenCode
V2 supports a project `skills` source resolved from the active working
directory. A distinct DeepSeek Flash child owns the minimal project config
fix in an isolated worktree; parent must review, integrate and verify the
selected service's loaded skill IDs and interactive `/skills` visibility before
closing this correction. Preserve unrelated dirty work and do not assume the
skill files are discovered merely because they exist on disk.
The parent reviewed and integrated the one-line `opencode.json` source change
byte-identically (SHA-256 `22a77c07…`). Project JSON with duplicate-key check
and 20-skill metadata validation pass. The selected service hot-reloaded its
skills: `/api/skill` now returns every one of the 20 canonical `SKILL.md` IDs
from the repository path, and the active agent's available-skills catalog
immediately includes them. This proves loaded service/model discovery; the
operator's interactive `/skills` list still needs direct confirmation before
the host-visible claim is closed.
An independently started disposable OpenCode 2.0.11 TUI in the project
accepted `/skills`, opened the Skills picker, and filtering for
`agent-orchestration` displayed its repository description. The Screen was
stopped after the interaction. This is genuine separate-client menu proof,
not a retained screenshot of the operator's existing Windows client; that
client's own menu should be re-opened for its final host confirmation.

**P0 Auto Goal handoff correction (operator report):** The operator reports
Auto Plan→Build does not work. Their screenshot is a `/btw` explanation of
the setting, not a Plan-ready execution trace; it cannot prove where handoff
stalled. Read-only selected-service Goal RPC currently reports this parent's
session `blocked/manual` with objective `finish the roadmap` and the replacement
Opus session `cleared/manual`; neither is currently an Auto Plan-ready state.
A distinct read-only DeepSeek Flash child is tracing the actual Auto transition
and tests. Do not switch the operator's handoff mode or claim a fix without an
isolated failing path plus loaded behavior verification.
The accepted read-only trace found no current Auto-ready Plan in those two
sessions. A pinned-Node isolated probe independently reproduced a separate
restart-orphan gap: a persisted ready/succeeded Auto Plan does not hand off
when a fresh in-memory runtime has not yet observed `session.status idle`;
a later idle event or explicit handoff toggle does recover. This gap is **not**
proven to cause the operator's report. The screenshot still supplies no
 session ID or Plan-ready event trace, so the reported live case stays open.
An isolated worker added persisted-idle detection with a failing-before unit
test, but parent review found that the plugin's startup path never invokes
`driveIdle`: its test called the method directly. That candidate is
`changes_required` and not integrated. A revision must prove a real startup
trigger (without guessing active-session idle or duplicating Build), then
verify loaded behavior separately from the operator's untraced complaint.
A second isolated revision wired a documented `server.connected` event to
scan persisted Goals, and its real-plugin fixture and pinned Goal tests pass.
**It is also `changes_required`:** parent read-only loaded service inspection
found an actual `running` session whose `SessionInfo` still has the previous
turn's `outcome=succeeded` and `time.idle`. Those fields do **not** prove
current idle. Never integrate a startup sweep that can hand off based on this
stale positive; require an authoritative current-idle observation, plus a
regression for running-with-stale-idle fields, or leave restart recovery
fail-closed. No loaded Auto fix or operator-case resolution is claimed.
A third isolated revision used `ctx.session.wait`, which the real service kept
pending for a running session and resolved for an idle one; 27 focused pinned
tests passed. Parent kept it `changes_required`: startup scans all historical
Goals and opens unbounded waits even for Manual/blocked/complete records; the
documented plugin session domain cannot inspect an inbox already queued before
restart, so user-input priority is not proven by loop-idle alone. A bounded,
eligible-only revision with an honest queued-input proof or fail-closed limit is
underway; none of the three candidates was integrated.
**2026-09-29 source integration:** The fourth, bounded revision is now in the
primary checkout byte-for-byte: it scans at most 256 records, opens at most
four waits for eligible Auto ready/succeeded unsent Plans, uses current
`session.wait` instead of stale `SessionInfo.time.idle`, and admits the restart
prompt with `delivery: "queue"`. Parent independently reran focused tests and
full twelve-package QA. This is **source verification only**: V2's plugin
session domain cannot inspect pre-existing inbox items, the queue-order and
agent-switch interaction remains unproven on a real queued-user case, and the
operator's original failure lacks a ready-Plan trace. Keep live Auto acceptance
open and add a non-paid queued-user characterization before promotion.
The characterization confirmed an unsafe edge: a disposable stub server
showed `delivery: "queue"` wakes an idle loop, and the plugin cannot see an
inbox item queued before startup. A fourth candidate blocked restart recovery
after `session.wait`, but parent rejected it because a `session.status idle`
event can reach `driveIdle` while the asynchronous scan/wait has not blocked
the persisted Goal. **The current primary source remains unproven and is not
loaded into the shared service**; a separate isolated race correction must
fail closed before status-driven handoff can overtake a pre-existing user item,
while preserving normal same-runtime Auto behavior. No operator Auto acceptance
is claimed.
**2026-09-29 follow-up:** The isolated event-order correction was accepted and
integrated into primary `goal.ts`, `index.ts`, tests, and its README. All 125
orchestration package tests and pinned typecheck passed independently. A
persisted Plan may not auto-dispatch from a new runtime's idle event; after
server-confirmed idle the startup scan marks it blocked for explicit `/goal
build`, while a Plan execution actually observed in the current runtime can
 still hand off automatically. Parent reran the full twelve-package canonical
 repository QA and acceptance validator after integration. This is source-level
 fail-closed behavior; the
shared service has not loaded this revision, and the operator's original Goal
case and visible UI remain unproven.

**2026-09-28 restart correction:** The `/restart` next actions in the older
orchestration, cross-worktree, WSL and UI-evidence rows below are superseded by
the Goal visibility row. `/restart` restarts the service; the operator had to
recover the CLI after the agent exited it without a proven relaunch path.
Do not touch the operator's second-monitor window while recording this correction.
After the operator explicitly resumed the roadmap, read-only Windows bounds put
`OC | open-rig` at x=-1287..7, y=6..1405 on the left monitor; the foreground
window was an unrelated game, so no full-desktop capture or focus change was
made. A read-only exact-console-buffer check still showed `Goal: loading…`
for client PID 2344468. A new failing-before regression proved overlapping
footer/sidebar requests could invalidate the first Goal response indefinitely;
coalescing same-session in-flight reads plus reactive snapshot access now passes
rig-tools typecheck/**197/197 tests**. Fresh **v6** inventory regenerated 30
focused receipts and 16 native captures for 15 mapped sources; acceptance
validator and all twelve canonical QA packages/checks pass. WSL package
typecheck/**53/53 tests** passes. This does not prove the loaded Windows client
 has incorporated the new feed code or promote Goal host screenshots.
Subsequent real-client diagnosis found the **first native Goal-slot test had
silently rewritten bare `solid-js` to OpenTUI's reactive client import**. Removing
that test-only alias reproduced the actual `Goal: loading…` in a failing-before
render even with a responding RPC; importing `solid-js/dist/solid.js` directly
in `rig-tools/src/tui.tsx` made the regression pass. Pinned rig-tools typecheck
and **197/197 tests** pass again; fresh **v7** inventory (15 sources, 30
focused receipts, 16 native captures) validates. Full canonical QA for the v7
source passed all twelve curated packages and repository checks. A concurrent
standalone `--continue` TUI still showed Goal loading and
did not process later palette input while this Build turn was active, so it is
negative/inconclusive host evidence, not proof the latest fix is loaded in the
 original Windows client. The standalone Screen was stopped; user window stayed
 unfocused and unmoved.
After a separate server restart, the original Windows console disappeared.
A newly opened `OC | open-rig` client was foreground and read-only captured;
it still showed **Goal · loading**, **Active Subagents 0 / Loading child
sessions…**, and **Managed Screens 0 / Loading managed Screens…**. During that
capture, the authenticated session API showed this parent's direct child
running in another worktree in the same project, and the Goal RPC returned
`blocked/auto` with objective `finish the roadmap`. The 7/7 focused sidebar
tests and v7 QA therefore do not establish loaded-host behavior. No console
input or window movement was performed. A new operator-reported Anthropic
Opus request failed with an API error requiring the `anthropic-workspace-id`
header for a key not scoped to one workspace; provider configuration and the
account's actual workspace ID are being investigated before any secret or
header change. The accepted DeepSeek Flash read-only audit confirmed OpenCode
V2 `providers.anthropic.headers` supports the header; a first-party codex-usage
hook also accepts `anthropicWorkspaceId`. The selected service reads
`/home/brajam/.config/opencode/opencode.jsonc`; that global config has no
Anthropic provider override. One Anthropic credential is available, but
`auth list`, client environment names, and nonsecret config files disclose no
workspace ID. Per Anthropic's authentication docs, obtain the `wrkspc_…` ID
from Claude Console → Settings → Workspaces → ID. Once the operator supplies
that ID, add it only to the active global provider header, reload safely and
verify a minimal Opus request; do not fabricate a workspace or leak the key.
**Resolved:** the operator had configured the wrong Anthropic API key and
replaced it. The credential ID changed, no workspace header was added, and
later Build turns on Claude Opus 5.5 completed without the workspace error.

**2026-09-28 orchestrator replacement:** the operator moved orchestration to a
new Claude Opus 5.5 parent (context limit); DeepSeek Flash children do the
implementation and QA. Independent re-review: rig-tools `src` imports only
bare `solid-js`, `solid-js-client.d.ts` is gone, and the source-scanning guard
`test/solid-import.test.ts` exists. The **v8** inventory (15 mappings, 30
receipts, 16 native captures) has zero source-hash mismatches and zero missing
references. The parent-rerun acceptance validator passes 13 claims, and child
canonical QA passed all twelve packages (rig-tools **198/198**). After the
operator restarted the client, a read-only host capture showed Goal, Active
Subagents and Managed Screens rendering real state instead of `loading` for
the first time; the capture was not retained, so it promotes no claim. A first QA run
failed transiently in `file-manager`. Root cause: `run-bounded-command.sh`
aborted with 125 ("malformed or unreadable /proc tree") when a descendant's
`/proc` stat vanished mid-sample. The accepted fix treats that as exited (code
2) and still fails closed on malformed live entries. The new `vanishing-child`
self-test case failed before the fix and passes after it; shellcheck is clean.
It was integrated byte-identically (`ffbe9f85…`, self-test `158edaf6…`).
Canonical QA needs `~/.local/bin` on PATH for `shellcheck`. After integration,
two child QA runs gave byte-identical passes with no `statm`/`malformed`
lines, per-package counts total **791/791**, and a parent rerun passes all
twelve packages. Native renders are still not host evidence.

**2026-09-28 footer handoff wrap fix and v9 inventory:** the reviewed
`rig-tools/src/goal-handoff-control.ts` correction (`flexShrink: 0` on the
handoff box and `wrapMode: "none"` on its two texts) stops
`Goal · Handoff: Manual` from word-wrapping. Root cause: the handoff control
shrank and word-wrapped under flex pressure. The regression in
`test/goal-slot.test.ts` failed before the fix and passes after it; pinned
rig-tools typecheck and **199/199 tests** pass. Fresh **v9** inventory (15
mappings, 30 focused receipts, 16 native captures) validates and all twelve
curated packages pass (**792/792**). The garbled glyph before `esc interrupt`
was diagnosed read-only: the enabled rig footer contributors emit only U+00B7
and U+2026, so the glyph is most likely native OpenCode busy chrome or font
coverage — unconfirmed, and it needs a foreground specimen during a busy turn
with no active Goal.

### Parallel finish plan and live-proof gate (operator-requested)

Assign one **distinct background DeepSeek Flash child per open roadmap row**;
Claude Opus 5.5 is the parent reviewer/integrator. Ten is the hard admission
limit, so dispatch ten concurrently, then queue the remainder for the first
free slots. Concurrent writers use separate fresh worktrees; no child commits,
pushes, edits the operator's TUI, or launches nested agents. Each child returns
one scoped fix or bounded read-only finding. The parent independently reviews
and integrates, then **proves the feature works in the relevant real runtime**
before closing that row. Unit tests, native fixtures, an active server plugin,
or an unretained screenshot alone do not constitute live acceptance; if a
safe host interaction or approval is unavailable, the row remains blocked.
**Launch blocker:** on resuming the Opus 5.5 session for this plan, its first
Anthropic request failed with HTTP 400 `provider.invalid-request`: the account's
credit balance is too low. The session is reselected to Opus 5.5, but **zero
first-wave children launched**. Its previous Mimo model selection was not
Opus execution. Do not describe this plan as underway under Opus until credits
are restored or the operator authorizes a different parent model. DeepSeek
Flash is catalogued and worked for earlier children; available workers alone
do not replace an available Opus parent.

| Wave | Row | One-child assignment and required evidence |
|---|---|---|
| 1 | 140 | Audit owner-scoped child identity/reservation; prove a safe loaded positive and negative before claiming admission fixed. |
| 1 | 141 | Verify real same-project cross-worktree child under Active Subagents with retained host before/after action receipt; no client input. |
| 1 | 142 | Verify loaded WSL CLI status interaction with retained host receipt; no client input. |
| 1 | 144 | Audit each visible claim against validator-supported actions; promote only independently retained host pairs. |
| 1 | 146 | **Fix live Hermes observer integration**: screenshot shows `/hooks` with 0 events in every stage and the explicit prompt to enable the opt-in Hermes plugin. Determine actual enablement path, isolate any source correction, and prove a real provider-backed observer event and rendered panel; leave pending if credentials/host proof unavailable. |
| 1 | 147 | Identify actual busy glyph/codepoint with a safe real-host specimen; never modify the installed binary. |
| 1 | 153 | Trace Goal switch/admission ordering in an isolated live session; document unsupported V2 atomics honestly. |
| 1 | 154 | Verify live Goal footer, hover and settings with retained host action/render pairs, preserving window placement. |
| 1 | 152 | Read-only machine-specific Basic Memory opt-in/deny feasibility; reload only with operator approval after children drain. |
| 1 | 159 | Design disposable consumer/model-role canary and verify only non-spend source gates until authorized. |
| 2 | 160 | Plan bounded authenticated OAuth connector canaries and separate-session isolation; no spend without approval. |
| 2 | 161 | Design tool-error restart receipt; no restart until children drain and operator approves. |

Rows 143, 145, 150, 155–158 stay closed only for their stated bounded
evidence; the parent reopens any claim disproved by host evidence. Rows 148–149
lack a supported harmless probe; keep them unverified. Row 151 (commit/push)
requires separate explicit operator approvals. Old Goal/footer and sidebar
Todos remain acceptance gates, not duplicate implementation jobs.

| Original row | Priority / owner | Outcome and status | Next concrete action | Dependency and verification evidence |
|---|---|---|---|---|
| 140 · Orchestration mode | P0 · DeepSeek Flash / parent review | **Source fix integrated; loaded capacity unverified.** Configured capacity remains 10, not 2. The plugin denied a third launch at global 10/10 while a bounded service read showed two running sessions; that read alone cannot identify stale reservations. The reviewed correction reconciles restored active children only after positive session/parent/project identity and authoritative idle, with four concurrent workers and one 30-second deadline covering both lookup and wait. Hung lookup, late abort, and rejected persistence retain the reservation. Parent reran pinned typecheck, 133/133 orchestration tests and full twelve-package QA after integration. | After a safe service restart, compare tracked capacity with live sessions and genuine follow-ups; release only positively verified owned idle children and leave ambiguous bindings reserved. | `policy.ts` still enforces configured 10 globally; `rig-todo/src/dispatch.ts` retains unknown bindings fail-closed. The current running service has not yet proved this source-level fix, and `/api/session/active` absence alone never proves child completion. |
| 141 · Cross-worktree Active Subagents | P1 · DeepSeek Flash / parent host capture | **Live standalone row rendered; retained host pair open:** Directory-filter removal and native test accepted. Exact-HWND capture/project-directory retention and real-plugin traversal/symlink regression are integrated; pinned WSL typecheck/57 tests pass. A fresh separate standalone TUI selected this actual parent session while two isolated-worktree direct children were running and rendered `Active Subagents 2`, both task/model rows, and Managed Screens separately. No original-console frame or accepted causal pair exists. | Bind genuine child launch/finish to exact original-window before/after capture; Screen text alone cannot satisfy the validator. | Benign WinForms `PrintWindow` proves neither console rendering nor Goal/child acceptance; v3 validator lacks exact HWND and action receipt, so a child returned an accepted no-change rather than allowlisting `windows_capture`. |
| 142 · WSL interop CLI health | P1 · DeepSeek Flash / operator host interaction | **Standalone TUI interaction verified; host pair open:** Source fixed (57 WSL tests); a fresh standalone Screen session rendered the WSL2 sidebar ready and the actual `WSL2 status` palette action opened its status dialog with systemd/interop and available PowerShell fields. This is a real native client interaction, but the Screen hardcopy is text, not a digest-bound host PNG pair, and it is not the operator console. | Retain an exact-window before/action/after host pair with an action receipt tied to the real CLI command; do not relabel the read-only `wsl_status` server tool as that action. | The checker’s current five action IDs omit a causal WSL status action; a server plugin count alone cannot prove CLI interaction. |
| 143 · WSL CLI setup regression | Closed · parent | **Verified source guard:** Original setup failure reproduced before correction and 53/53 WSL tests passed after. | No new implementation; refer host runtime proof to row 142. | Parent-reviewed source and test; avoid another Todo for the same CLI interaction. |
| 144 · Visible UI acceptance | P1 · DeepSeek Flash / parent evidence review | **Audited without false promotion:** v9 inventory validates (15 mappings, 30 receipts, 16 native captures); 13 manifest claims, with `sidebar-coexistence` alone limited by a valid retained managed-Screen stop pair and eight other user-visible claims correctly planned/empty. The withdrawn OpenCode Web-panel claim is absent from the manifest; `integrated-browser` remains a separate planned retired-plugin claim. | Promote only supported claims from independently retained host render/action pairs; add scoped keyboard/pointer action support with tests before claiming palette, panel, navigation or status controls. Review retired-plugin claim separately. | Validator permits `screen_terminal`, `subagent`, `subagent_cancel`, `task_declare`, `todowrite` as action IDs. Native frames or unretained images cannot promote claims; do not mislabel a noncausal action as an interaction. |
| 145 · Isolated WSL2 bootstrap | Verified bounded · parent | **Closed for user-only verify:** Isolated full verify-only passed all eight stages; shared primary checkout rightly rejects group-writable toolchains. | Preserve the result and ACL; track privileged native GNOME and full apply as separate operator gates, not a duplicate bootstrap Todo. | Disposable checksum-pinned Node/npm and pilot; no primary apply or privileged host proof. |
| 146 · Hermes live `/hooks` | P0 · DeepSeek Flash / parent review | **Live negative and producer missing:** operator screenshot shows all five stages at `0 hooks` and the opt-in prompt. Read-only child traced plugin snapshot writer → RPC reader → panel and reported no Hermes Agent installation/process or enabled plugin in the selected Windows profile, while WSL reader defaults to `~/.hermes` with no shared telemetry override. Parent verified the empty snapshot branch and default path. Cross-language Python→TS wire check and package tests passed, but do not prove live producer. | Operator authorizes actual Hermes installation/profile and shared telemetry path, then a genuine provider-backed Hermes turn and retained panel/action evidence; keep blocked until then. | No repository source correction integrated; do not close from mocks, server plugin counts, or the panel's presence. Preserve operator window; separate paid provider and service-reload approvals apply. |
| 147 · Garbled busy glyph | P2 · DeepSeek Flash / operator host specimen | **Source diagnosis independently verified:** Read-only bounded inspection of installed OpenCode binary (SHA-256 `0ed7d854…`) shows the native `esc interrupt` busy-row spinner uses 40 ms block frames with U+25A0 and U+2B1D. The separate resource-monitor prints CPU/RAM with U+00B7. | During a natural busy turn on a confirmed foreground Open Rig window, inspect the actual glyph/fallback safely; compare supported host font coverage if available. | U+2B1D fallback/tofu remains a hypothesis without host pixels; no installed-binary modification or resource-monitor attribution. |
| 148 · Loaded `requiredClaimIDs` negative | Unsupported probe · parent | **Unavailable:** No supported harmless loaded-policy negative receipt. | Revisit only if a non-polluting negative probe is available. | Never create a bogus claim/task just to force denial. |
| 149 · Loaded near-miss / issue-write negative | Unsupported probe · parent | **Unavailable:** Outer-shell result did not prove policy mediation; no GitHub issue write was attempted. | Seek an explicitly safe mediated negative path before claiming a loaded result. | An actual external issue write is not an acceptable probe. |
| 150 · Historical orphan follow-ups | Unrecoverable · parent | **Closed with limitation:** Three earlier follow-ups cannot be reconstructed; same-generation restore correction and later owner-bound canary passed. | Retain the honest orphan record; use normal owner-bound follow-up on new children. | Post-fix historical retry returned `not due`; never backfill fictitious outcomes. |
| 151 · Commit / push | Operator approval · operator | **Blocked:** Dirty checkout remains unstaged and uncommitted. | After reviewing an exact scope, request commit approval; separately request push approval after the commit. | Neither approval is implied by this Build request. |
| 152 · Basic Memory cross-project | Operator / service dependency · operator + parent verification | **Project and portable-example permission corrections integrated:** Primary `opencode.json` denies 11 management/raw/schema/compatibility tools at project level and after Build wildcard; selected service exposes nine core tools plus list-projects (21→10). Portable example repeats all 12 denies after Build wildcard (including list-projects for its closed default), with failing-before checker and self-test; twelve-package canonical QA passes. Parent-run wrapper `--verify-only` prints `cross_project_access=disabled` for `computer-assistant`; two configured project names map to the same directory. | Machine-local opt-in, shared-service stop/reload, and truly distinct-project positive/negative proof require approval after children drain. | Keep checked-in `opencode.json` cross-project default closed; no portable `environment:true`. Catalog removal is effective exposure proof, not a direct denied invocation receipt; MCP `connected` alone is not cross-project proof. |
| 153 · Goal Plan→Build | P2 · DeepSeek Flash | **Unsafe restart handoff fails closed in source:** Prior fresh standalone Manual/Auto runs admitted Goal before one Build response; a concurrent BLUE user input took priority over queued ORANGE Goal. The plugin cannot inspect pre-restart inbox items, and a bounded stub showed `queue` wakes idle execution. Integrated current-runtime Plan execution guard; after the capacity integration pinned typecheck, 133/133 package tests and full QA pass. An earlier idle event cannot switch a persisted Plan; startup blocks it after authoritative idle for explicit `/goal build`. | Load the reviewed revision after children drain and verify a loaded fail-closed restart path in isolation, then trace the operator-specific ready Plan without claiming pre-restart automatic priority or unsupported atomicity. | Four startup waits bounded; records beyond the scan bound need another idle event. V2 exposes no cross-store atomic start-if-idle/CAS or final-answer veto. Source tests do not prove foreground Goal host acceptance. |
| 154 · Goal footer / hover / settings | P1 · operator host interaction / parent | **Standalone live client evidence; foreground pair open:** A fresh standalone TUI opened an existing completed session, rendered `Goal · cleared` in the sidebar and `Goal · Handoff: Manual` in the footer, opened the actual workflow settings palette, and toggled `Footer Goal summary: Off` to On; at 220 columns the footer rendered `Goal: cleared · no active objective`, while 170 columns clipped it responsively. The exact operator window still has zero UIA nodes and failed safe capture as invisible/minimized; no digest-bound Goal action/render pair or hover proof exists. | Finish the exact-window restore and honest action/capture receipts, then verify the original operator console without moving its placement; keep hover unproven if no safe pointer path. | Screen hardcopy is actual client text, not a retained PNG or foreground proof. No provider turn or operator-window input was sent. |
| 155 · Auto Goal question guard | Verified bounded · parent | **Closed for the supported tool boundary:** Loaded same-project Auto Build permission denied `question`; direct and aliased Code Mode calls failed, with Manual restored. | Keep regressions; do not open a duplicate Todo. | No V2 final-answer hook or semantic veto exists. |
| 156 · Downstream verify-only preflight | Verified bounded · parent | **Closed:** WSL false negative fixed; isolated eight-stage verify-only passes and unsafe writable consumer toolchains are still rejected. | Preserve primary ACL and fail-closed check; no downstream Gemma edit here. | Primary shared checkout verify still fails as intended on group-writable toolchains. |
| 157 · Learning gate | Verified bounded · parent | **Closed for nonempty receipt path:** Loaded read returned required=1/receipted=0, then a genuine reflection returned required=1/receipted=1/ready=true without a self-obligation. | Only test live conflict resolution if genuinely divergent path proposals arise. | Real-plugin tests cover conflict pairing; V2 atomic Todo/archive transaction and plain final-answer veto are unavailable. |
| 158 · Managed Screens | Verified limited · parent | **Closed for scoped sidebar transition:** Retained digest-bound host pair validates a managed Screen 1→0 stop and limited sidebar-coexistence. | Add a row-click/keyboard claim only if a requested outcome needs it and the evidence schema can represent the real action. | Start images are historical diagnostic only; do not cite them as a manifest host pair. |
| 159 · External consumer/model roles | Model-spend/apply approval · operator + DeepSeek Flash | **Dependent:** Independent read-only audit confirmed Ingenium's 11 namespaced identities and Sol/Luna/Astra medium/high/max refs differ from Open Rig's Plan/Build defaults. No disposable consumer selected-turn proof exists; the proposal made no provider request or consumer edit. | After authorization for a disposable profile, exact native/WSL target and bounded model spend, use the consumer's own identities and read assistant messages for the actually selected agent/model/variant and cost/finish. | Preserve generic policy, dirty consumer work and role overrides; config lookup or this parent's Opus per-session selection is not a consumer canary. If a real assistant message omits variant, keep variant proof unverified. |
| 160 · Codex OAuth connector | Authenticated-call approval · operator + DeepSeek Flash | **Read-only preflight passed:** Selected MCP connected; `chatgpt-mcp.sh --verify-only` resolves pinned native Node 22.22.2 and entrypoint, and `/api/model` lists `gpt-5.3-codex-spark` with `providerID=openai` and `enabled=true`, satisfying the configured-model filter. OAuth authentication and actual requests remain unproven; no image/search/chat or separate-session isolation receipt. | After bounded OAuth-backed spend approval, use direct chat, quick search and image calls; image output must be in a disposable project because the connector saves under `assets/generated`. Collect sanitized citation/PNG hashes and separate-session negative. | Enabled-model, wrapper verification and MCP connection do not prove authenticated live behavior; avoid credential material and do not conflate repo connector with generic model tools. |
| 161 · Tool-error restart proof | Operator restart approval · operator + DeepSeek Flash | **Read-only persistence trace accepted:** `tool-error/state` writes on genuine top-level tool errors, reloads on server plugin setup and retains exact-ack receipts. Unit restoration tests exist; no controlled obligation persisted across a selected-service restart with owner ack. | Prefer disposable isolated scratch service/profile proof; it still needs one bounded model-backed tool-failure turn. For selected live service proof, drain children and obtain explicit restart authorization, then verify before/after identical obligation ID and exact ack. | TUI restart alone does not reload server plugins; no restart or new obligation was made by the read-only worker. Do not conflate storage source/units with loaded restore receipt. |

**2026-09-29 host-action audit:** A genuine `subagent` launch could drive the
same-project Active Subagents data without moving a window, but current host
interaction records retain only a tool ID and free-text event, not a
child/project/worktree action receipt. Exact-window PNGs alone cannot establish
causality. `wsl_status` is a read-only server tool rather than the TUI's
`/wsl-status` command; no supported exact-target hover or Goal-settings action
was proven for the operator console. Leave rows 141, 142, 144 and 154 visible
claims pending until a qualifying child/action and bounded host pair exist;
never widen the allowlist by name alone.
An exact-title Windows window listing returned the operator's PID/HWND, but the
first in-memory `windows_capture` refused it as not visible/non-minimized before
producing a PNG. No input, focus, movement, retained image or visual claim
resulted; do not retry without a material visibility change.
**Shared-service preflight:** In-process runtime status reports 95/95 plugins
active, but cannot prove today's server source was loaded. The documented
launcher `service status` failed before contacting the service because its
default binary path does not exist in this WSL host; a protected installed-path
read was denied. No restart occurred. Reconcile the supported launcher binary
and active-client coordination before claiming loaded capacity or Auto behavior.
The allowlisted direct-binary `/api/info` read reached OpenCode v2.0.11, PID
3233, at `http://127.0.0.1:49374`; service reachability still does not prove
which plugin revision is loaded or make a shared restart safe.
**2026-09-29 operator correction:** Auto Goal remains active; continue
independent work rather than ending with a request to make the window visible.
The exact console has zero UIA nodes; the selected WSL plugin explicitly
disables raw PowerShell, so an attempted read-only raw state probe was rejected
without execution. A bounded exact PID/HWND/title preview-and-apply restore
method is delegated in an isolated worktree, limited to genuinely minimized
windows and saved placement. The unauthenticated active-session HTTP read
returned 401; no credentials were inspected and service restart stays unproven.
Two further bounded investigations now run in parallel: a validator worker
checks whether exact-HWND capture and a genuine action receipt can be accepted
without fake causality, and a read-only worker traces the selected shared
service restart identity. The documented isolated-pilot launcher reports
`stopped` even with the current binary path override; the selected default
service `/api/info` is running. Do not restart the wrong profile.
**Visible-desktop update:** A bounded in-memory full-screen Windows capture
showed the existing `OC | open-rig` console on the left monitor, with this
session's blocked Auto Goal and child sidebar; it was not retained as host
acceptance because the unrelated right-hand game and lack of a causal action
make it unsuitable. Same exact PID/HWND/title recapture then passed the old
visibility precondition but failed closed on overlapping-window detection
before returning a PNG. The generic z-order check rejects *any* overlapping
visible window, including a possible bottom taskbar; the actual occluder has
not been identified, so no exception or foreground/window movement was made.
Parent independently accepted the read-only host trace: the capture loop
rejects the first higher-z visible noncloaked rectangle overlap but exposes no
occluder identity; `windows.apps` cannot supply arbitrary z-order/bounds and
raw PowerShell is disabled. A disjoint isolated worker now adds bounded
PID/HWND/class/bounds diagnostics while preserving unconditional rejection.
An independent read-only worker also checks whether any already-supported,
identity-bound local TUI input path can operate this console: visible-window
UIA still visited zero nodes, the raw PowerShell option is disabled, and
browser/managed-Screen controls target different surfaces. Any new input
method must be preview-bound and refuse wrong foreground/changed identity;
do not mistake a separate standalone TUI action for operator-console input.
Parent accepted the input-path audit as a bounded negative: generic
`SendInput` is system-wide and foreground check/use can race with the
unrelated game; the retired temporary console-input route is not a supported
tool. No local original-console input was sent. Separately, the selected
`windows_capture` server plugin launches the checked-in PowerShell host file
afresh for every call. Once the occluder diagnostic is independently reviewed
and integrated, a guarded retry can identify the overlap through the *existing*
tool without a shared-service restart; this does not reload Goal/capacity
plugin source.
**2026-09-29 host reboot and lost isolated work (`/tmp` is tmpfs):** The host
rebooted (uptime ~7 minutes). Because every isolated child worktree was created
under `/tmp/opencode`, which is a volatile `tmpfs`, the **three completed
isolated patches were destroyed**: the occlusion-diagnostic helper change, the
pilot-vs-selected runbook rewrite, and the non-activating `SW_SHOWNOACTIVATE`
exact-window restore. Their worktrees are now `prunable` with "gitdir file
points to non-existent location"; the changes were uncommitted, so no git object
retains them, and the parent never inspected the diffs. They are therefore
**not integrated, not verified, and not recoverable** — the subagent-reported
hashes cannot be reconciled against anything. This supersedes every earlier
"finished / awaiting integration" statement about those three items.
Corrected runtime fact: the pre-reboot service PID **3233 is gone**; after the
reboot the shared service auto-restarted as **PID 3187** on the same
`127.0.0.1:49374`, OpenCode `2.0.11`, 95/95 plugins active, three MCPs
connected. The documented launcher `service status`/`api` path still fails
because its default binary is absent, and a bare unauthenticated `/api/info`
now returns HTTP 401, so the exact probe must go through the in-process runtime
API. New remediation rule: any work whose result must survive MUST NOT use
`/tmp`; use a persistent sibling worktree under `$HOME`/the repo (e.g.
`/home/brajam/repos/opencode-rig-<topic>`). The three lost tasks are re-dispatched
into persistent worktrees.
**2026-09-29 loaded-source observation:** After the parent integrated source,
the running service **hot-registered the new `windows_restore` tool** and its
read-only preview returned the designed fail-closed refusal on the operator's
real window (`selected Windows window is not genuinely minimized
(IsIconic=false, IsWindowVisible=True)`), with no mutation. This is concrete
evidence that the WSL interop plugin's on-disk source is live-loaded by the
shared service, so the earlier "source-only / not loaded" caveat is stale for
that plugin. It also confirms the console is currently visible and not
minimized (so an exact-window capture is at least no longer refused for
minimization). Orchestration-policy hot-reload and the bounded Auto self-resume
are **not yet independently confirmed live**; verify before claiming loaded
Auto behavior. Visible rows 141/142/144/154 still need a retained host pair.
**2026-09-29 live occluder identified:** A guarded read-only `windows_capture`
of the exact console returned, through the now-loaded diagnostic:
`occluded by another visible window; occluder pid=8824 hwnd=0x106C2
class=UnityWndClass bounds=(0,0,2560,1440)`. The blocker is therefore the
**unrelated Unity game** (not a taskbar) whose rectangle overlaps the console's
left-monitor rectangle. No PNG, focus, move, or input occurred; the guard is
correct and was not weakened. A retained console capture requires the operator
to move or minimize that game or reposition the console — an operator action,
since the guard cannot distinguish genuinely-occluded pixels from PrintWindow
content without weakening the fail-closed check.

**2026-09-29 operator toggle and schema-migration hardening:** Added an
operator-only `requireTodoDispatch` enforcement (default ON) so async
background-agent admission can be decoupled from per-Todo binding and follow
only `maxConcurrent`; with it OFF, launches are admitted up to capacity and
create no Todo binding, while binding-consistency, follow-up, task, capacity,
and commit/push gates still apply. `settings.ts` now also accepts a legacy
settings file that predates a later-added enforcement, defaulting the missing
field fail-closed, so a schema addition can no longer brick a live settings
file into the invalid lockout state. Verified: orchestration typecheck +
141/141, rig-tools typecheck + 200/200.
**2026-09-29 occluder update:** the exact-console capture is now refused by a
different overlapping window — a Chrome window (`Chrome_WidgetWin_1`,
pid 10896, bounds −2568,−2..8,1406) — replacing the earlier `UnityWndClass`
occluder. Rows 141/142/144/154 remain blocked on the operator moving the
overlapping window; the guard correctly fails closed and no PNG/input occurred.
**2026-09-29 occluder sequence (proves the guard, not a bug):** successive
exact-console captures were refused by, in order, `UnityWndClass`, then
`Chrome_WidgetWin_1`, then the always-on-top shell taskbar
`Shell_SecondaryTrayWnd`, and finally `RiotWindowClass` (pid 18020, bounds
0,0,2560,1440). The shell-taskbar case was a genuine over-strictness (PrintWindow
renders the window DC, so system chrome does not occlude it) and was fixed by
skipping `Shell_TrayWnd`/`Shell_SecondaryTrayWnd` in
`Assert-BrowserWindowUnoccluded` (wsl-interop 67/67). The remaining refusals are
real overlapping application windows, so the guard is working: the operator must
move/close the covering game/Chrome window before a retained console host pair
is possible. Rows 141/142/144/154 and the deferred push depend only on that.
**2026-09-29 read-only roadmap audit batch (rows 146/152/159/160/161):** five
bounded read-only audits were dispatched and independently spot-checked. New
facts worth keeping: (152) the machine-local opt-in command
`opencode service set env` is asserted in earlier notes but **not documented
anywhere in-repo** — only `opencode service get env` is recorded, so that path
stays unverified; the wrapper's opt-in is exactly lowercase `true`/`false` and
fails closed otherwise. (159) No reachable reader surfaces an assistant
message's `agent`/`model`/`variant`/cost — `session-context` projects a subset
and `codex-usage` drops `variant` — so a consumer selected-turn proof needs a
raw `message.list` read; consumer repos are `~/repos/ingenium` and
`~/repos/blackjack`. (160) Connector preflight is source-confirmed; the live
`/api/model` result is not retained anywhere. (161) Tool-error state is keyed
`tool-error/state`, IDs are `terr_<sha256>`, and `rig-tools` has no tool-error
code and cannot reload server plugins; unit restoration tests are same-process,
not a real `ctx.storage` round-trip. (146) No shared Hermes telemetry path
exists in config (the override appears only in docs/tests/source). All five stay
blocked on operator prerequisites/approvals.

**2026-09-29 release/CI:** `migration/opencode-v2` was pushed to commit
`a2b6549` through the QA and documentation gates. `main` is a protected branch
(no direct/leased push accepted), so the merge is via PR #5, which was blocked
because the `verify`/`verify-wsl2-source` CI jobs failed at canonical QA for a
missing `shellcheck` on the runner; both workflows now install it, and
`git-gates.ts` sends a plain fast-forward for an existing ref so a protected
branch still accepts a legitimate advance. Operator action: merge PR #5 once CI
is green.
CI additionally failed on a hard-coded absolute QA-runtime path in
`acceptance-evidence.json`; the manifest now uses repository-relative
`toolchains/node/...` executables (`provisioning: project`) and the validator
tolerates the absolute path recorded in existing artifacts by matching the
path suffix and digests.
The WSL source job also needed a portable `mmap.MAP_NORESERVE`
(`getattr(..., 0)`) in the bounded-command RSS fallback probe, plus `uv`/`uvx`
installed for the MCP-runtime checks.

## Implemented

The full implementation chronology and detailed evidence remain in the
[roadmap archive](roadmap-archive-2026-09-25.md).

- **`orchestration-policy`:** lifecycle, follow-up, cancellation, claim-gate, installed-binary, correction-ledger, configured-only concurrency, and reload-state fixes; canonical QA passed all 12 packages, and one loaded owner-bound cancellation received accepted follow-up.
- **Canonical QA on the current working tree:** the HEAD whitespace check initially overflowed its 256 KiB output cap on already-committed padded native frames. Narrow frame-only Git pathspec exclusions and failing-before disposable regressions were added; the full read-only canonical QA now passes all twelve curated packages and every listed check. The new Goal and learning/Todo integration still require their own subsequent checks.
- **`rig-tools`:** `/tools`, `/hooks`, and `/subagents` panels, bounded-retention vision capture, and Git gates; pinned Node 26.4 typecheck and 180/180 tests passed.
- **`rig-todo`:** `/tasks` board and history; pinned Node 26.4 typecheck and 59/59 tests passed.
- **`codex-usage`:** authoritative Provider Usage state and sanitized display; included in the green 12-package canonical QA run.
- **`source-control`:** native Source Control surface; typecheck and 30/30 tests passed.
- **`file-manager`:** guarded Explorer/editor and diff experience; focused Node 26.4 package checks passed 71/71 tests.
- **`repo-learning`:** durable observation and reflection components; typecheck and 78/78 tests passed at the recorded snapshot. Orchestration completion is not wired to its receipt check; live end-to-end learning, conflict resolution, and approved application remain open above.
- **`ponytail-adapter`:** pinned official Ponytail package through the v2 adapter; typecheck and 13/13 tests passed, with the runtime active in the selected service.
- **`codex-fallback`:** bounded configured fallback routing; included in the green 12-package canonical QA run.
- **WSL interop:** Windows UI Automation, browser, and PowerShell host; pinned Node typecheck and 42/42 tests passed.
- **Legacy integrated-browser retirement:** guarded config retirement is complete; the selected service reports the legacy plugin absent.
- **`bootstrap.sh`:** native/WSL2 journaled verify/apply workflow; behavior checks passed, with current live WSL acceptance blocked as recorded above.
- **QA runtime, launcher, and deploy:** checksum-pinned Node 26.4/npm 11.17, bounded launcher, and guarded plugin deployment; their self-tests passed in canonical QA.
- **Recovery CLIs:** target-bound OpenCode recovery and allowlisted orchestration-lockout recovery; both CLI self-tests passed in canonical QA.
- **Acceptance evidence:** standard-library validator and bounded host-capture schema are integrated; refreshed 15-source v9 ready inventory and historical foreground Screen-stop host pair validate. `sidebar-coexistence` is limited; eight visible claims remain planned.
- **Repository gates:** documentation coverage, canonical QA, Git safety, and progress tracking are integrated; the current state-bound QA preview/apply passed all 12 packages and the documentation gate passed at the same fingerprint above. Focused progress, coverage, and staged/unstaged whitespace checks pass.
- **Operator commit/push overrides:** Added separate operator-invoked `/commit` and `/push` commands that run outside the agent tool gates with `--no-verify`; commit stages all changes accepted by `git add -A`. The Git safety guide documents the boundary, and focused documentation coverage plus the Git safety policy check and self-test pass.
- **Bounded command runner:** timeout, output, and process-group guards; self-test passed in canonical QA.
- **WSL MCP and verifier fixes:** earlier WSL stages and plugin registration pass; the current apply boundary is tracked above.
- **`repo-onboarding` skill:** Added downstream OpenCode v2 onboarding guidance, usage documentation, catalog/deployment registration, 20-skill checks, and inventory coverage. `python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py` passed (exit 0; 20 skills); `python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs-self-test.py` passed (exit 0; 12 negative cases); `python3 platforms/linux/ubuntu/computer-use/scripts/setup-opencode-self-test.py` passed (exit 0); `python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage.py` passed (exit 0; 551 mapped files); `git diff --check` passed (exit 0). `bash platforms/linux/ubuntu/computer-use/scripts/verify-opencode-v2.sh` returned 1: the selected host binary is missing at `/home/brajam/.local/opt/opencode-v2/opencode`, its selected config still has 19 skills and lacks the ChatGPT MCP/connector, and its Explore model is stale; live acceptance remains unclaimed.
- **Operator-only `/settings` controls for six workflow enforcements with fail-closed persistence and fixed safety-core protection.** `rig-tools` controls `requireTaskDeclare`, `strictShellClassification`, `parentDelegationOnly`, `backgroundChildrenOnly`, `correctionLedgers`, and `memoryReconciliation`; all default ON, and missing, unreadable, or malformed `${XDG_CONFIG_HOME:-~/.config}/opencode/orchestration-policy-settings.json` resolves to all ON. `orchestration-policy` re-reads settings per hook, so valid changes apply without restart. The fixed core cannot be toggled: installed-binary/distribution-file protection, separate commit and push approvals, protected paths, exact staged scope, policy-index integrity, secret handling, and fail-closed settings. `orchestration-policy` typecheck and 90/90 tests; `rig-tools` typecheck and 186/186 tests; focused documentation coverage and `git diff --check` passed. Residual risks: `rig-tools` imports `orchestration-policy` source by relative path, coupling the plugin packages at source level; live service and UI interaction were not verified.
