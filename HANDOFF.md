# Current handoff

Updated 2026-09-25 for current runtime, QA, and acceptance reconciliation.

The consolidated current ledger is [`ROADMAP.md`](ROADMAP.md); the prior
roadmap is preserved byte-for-byte in
[`roadmap-archive-2026-09-25.md`](roadmap-archive-2026-09-25.md).

## Continuation prompt

```text
Continue in ~/repos/opencode-rig. Read AGENTS.md, ROADMAP.md, README.md, and
docs/README.md; inspect the dirty worktree and preserve unrelated changes.
Use the active task and todo ledger. Child sessions do not have authority to
declare or complete their parent task. Preserve unrelated changes. Track
multi-step work with the todo tool; keep exactly one item `in_progress` and
verify the actual result. Do not stage or unstage files, commit, push, deploy,
or restart services. Never print, persist, or place the GitHub token in argv.

UI acceptance is pending. The v3 manifest has 13 claims; all nine user-visible
claims remain `planned` with empty evidence. The native span PNGs are diagnostic
visualizations and native test-renderer transitions are test-only, not host
screenshots, live interactions, or pixel acceptance. Mapping 13, theme
switching, pagination, supporting-source digests, and authentic host proof are
incomplete. Do not run the capture generator until its fixture emits the
required run, phase, dispatch, transition, and monotonic-provenance fields.
Current details are in `docs/acceptance-evidence-2026-09-22.md` and
`docs/scripts/check-acceptance-evidence.md`.

Preserve native-GNOME privileged-host, fresh isolated WSL2 full-apply/action,
and bootstrap live-apply blockers. Keep work uncommitted and unpushed unless
the operator separately approves those actions.
```

## 2026-09-25 final reconciliation

- The operator withdrew Windows-default-browser OpenCode Web panel acceptance
  (“you dont need to use the web pannel we are in the TUI”); the TUI currently
  in use is the acceptance target. Brave HTTP Basic preflight remains historical
  and blocked, with no credentials entered. This supersedes earlier instructions
  to wait for another Web capture; that preflight is historical only.
- The active standard `~/.config/opencode/cli.json` has
  `attention.sound=false`, notifications enabled, mode `0600`, and SHA-256
  `ef0c503c09121e6cc30dcc71807334cfa07902dad7e8e76953363187bf2a1ad9`. Two
  live in-memory `vision_capture` observations showed the TUI clean after child
  completions; captures are not retained by tool design. Loaded policy denied
  an `apply:false` `binary_replace` against the installed OpenCode path with
  “installed OpenCode path is immutable”; stat remained 200,508,896 bytes,
  mode `0755`, SHA-256
  `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f`.
- Child follow-up root cause was pre-queue snapshot clobbering and no
  same-generation merge on restore. The integrated fix and regression hashes,
  12-package canonical QA pass, default-profile reload, post-reload runtime
  identity, and accepted interrupted-canary follow-up are recorded in the
  2026-09-25 section of `ROADMAP.md`. The three historical orphan reports
  (Hermes, scoped-issue, WSL-feasibility) remain unrecoverable after one post-fix
  retry returned `not due`; no audit was fabricated. Resumed already-reviewed
  children do not reopen follow-up obligations.
- Isolated Hermes `0.21.5` with the canonical plugin and a credential-free local
  mock provider produced an 11-event observer snapshot parsed ready by
  `rig-tools`. GPT-6 Luna labels and rendered `/hooks` panel remain unverified.
- Host-evidence schema v1 is integrated (checker, self-test, docs) with strict
  bounds, future-time/float-version/digest/path/symlink rejection, and a
  declared-not-proven origin. Acceptance-ready inventory still needs runtime
  and renderer catalogs, 14-source mappings (five stale digests; tasks-panel
  and hermes-hooks-panel unmapped), 28+ v2 receipts, 13 v3 native captures,
  theme-switch proof, pagination support digest, and integrated-scenario v3.
  Host capture retention is unavailable: raw PowerShell is disabled by default
  and `vision_capture` writes no file. Manifest version 3 stays pending with 13
  claims; all nine visible claims remain planned with empty evidence.
- The private WSL scratch snapshot verified. Apply passed prerequisites, config
  hash, Node 26.4/npm 11.17 QA runtime, isolated paths, and WSL OpenCode's 476
  package/plugin-registration checks, then failed at `wsl2-mcp-runtimes` with
  exit 134 during `prlimit` allocation after downloading CPython 3.12.13.
  Verify-only then failed on missing pilot `provisioned.json` and the
  `tsc-not-found` source self-test. Native privileged GNOME remains sudo-gated;
  the shared ACL remains preserved per the operator.
- Remaining: Hermes GPT-6 Luna labels/rendered panel, WSL MCP-stage memory
  blocker, icon no-repro (no repository defect found; capture path verified),
  acceptance-ready inventory program, and separate commit/push approvals not
  granted. No commit or push was performed. Post-archive state-bound canonical QA
  preview/apply and the documentation gate passed at worktree fingerprint
  `a8e6e2a3605f29af92b25a811220d69d399a820df938186b012030a7f17a5c43`; see the
  service identity section for the output digest.

## 2026-09-22 current verification status

- `acceptance-evidence.json` is intentionally pending for UI acceptance. Its
  pending inventory validates source paths only; it yields no rendered-visual
  or interaction claim paths.
- Existing package logs, deployment checks, service-health observations, and
  detached terminal text remain automated/operational or historical evidence.
  They do not establish rendered UI or host interaction acceptance.
- Existing native frames, spans, span-derived PNGs, and mock transitions are
  test-renderer diagnostics. They are not screenshots, host input, or pixel
  acceptance.
- The generator records invocation receipts and native test-run provenance, but
  the fixture does not yet emit the complete required phase/dispatch/transition
  contract. No new capture was generated.
- The copied-consumer self-test passed. The repository acceptance validator
  passed structurally for 13 claims and 3 background-subagent records; UI
  acceptance remains pending. Generator syntax passed, documentation coverage
  passed (462 mapped files, 8 changed), and staged plus unstaged diff checks
  passed. The generator was not run, and no current UI claim was accepted.

## 2026-09-24 current reconciliation

- Exact read-only service probes and focused source checks: the launcher
  no-write probes and installed-path protection are integrated; pinned Node
  26.4 passes typecheck and 67/67 tests. The loaded policy admitted exact
  read-only `git status` and bounded `git log --max-count=10` (10 commits).
  The no-write `api get /api/info` request to the exact installed binary
  returned PID `2407` before the latest clean selected-service restart. The
  independently reported restart changed it to PID `4722`; a fresh request
  through the exact installed CLI confirmed the same repository location,
  OpenCode `2.0.11`, and port `49374`. The restarted service reports 95/95
  plugins active, including WSL interop and `orchestration-policy`, with
  `integrated-browser` absent and Basic Memory, GitHub, and ChatGPT connected.
  A direct same-location `read_note` of
  `computer-assistant/decisions/open-rig-unified-ubuntu-architecture` succeeded.
  A separate outer
  `functions.shell` invocation of `git --no-pager -c core.hooksPath=/dev/null
  -c core.fsmonitor=false log --max-count=11 --oneline` returned 11 commits;
  whether that shell path was mediated through `execute.before` was not
  established, so it proves neither loaded-policy denial nor bypass. Live
  semantic negative proof for `github.issue_write`, `requiredClaimIDs`, and
  installed-binary mutation remains unproven; no issue-write attempt is
  claimed, and the conditional issue was not reproduced or filed. The latest
  parent state-bound `repo_qa_gate` preview/apply ran on the
  integrated cancellation source plus previous docs and passed all twelve
  curated packages and canonical checks (output SHA-256
  `00411da60bea72a0dcca436bb18e7d94a93af8cc535e31e1720cbf87d757ffc8`;
  worktree fingerprint
  `86655f74957254525382bc7f751c8e5c42be3bd88a9059804be9b2fd9aaf3511` binds
  that pre-documentation-edit snapshot only). The earlier fingerprint
   `beb851d7e227a356578e773f46dc81b558b30d2256cc9c7d01b503f0059aaf59` remains
   an older historical snapshot. These ROADMAP/HANDOFF edits then postdated the
   pass; the later post-archive canonical-QA and documentation-gate passes below
   supersede the rerun requirement. The canonical
  loader checks the declared executable's regularity/link path, executable bit,
  and SHA-256; it does not call `setup-qa-runtime.py --verify-only` or reject
  directory mode `0775`. The full WSL bootstrap remains separately blocked by
  the shared ACL preflight; the operator chose “Preserve access,” and no ACL or
  mode changes or runtime rebuild were made. That bootstrap blocker does not
  negate the canonical QA pass. Earlier progress tracking and focused
  documentation coverage passed for two files (462 mapped files, 2 changed);
  the staged documentation preview/apply passed for 462 mapped files and 173
  staged changes (output SHA-256
  `f7701a299fbc71620ba25b4c0262fa07abd2bcc27b2b3adb85eb612aba98548b`, including
  staged `docs/scripts/opencode-recovery.md`), with staged/unstaged whitespace
  checks for that earlier snapshot. For this documentation update, focused
  progress tracking, documentation coverage (462 mapped files, 2 changed), and
  staged/unstaged `git diff --check` passed without changing the index.
- The primary `rig-tools` `/hooks` source integration is accepted: bounded
  server RPC feed, opt-in Hermes observer, and slash fullscreen panel. Pinned
  Node 26.4 `rig-tools` passes typecheck and 175/175 tests; Python observer tests
  pass 6/6. This proves source/package behavior only—not an installed Hermes
  plugin or deployment. In a disposable standalone WSL Screen, a GPT-6
  Luna#max scratch turn replied `ready`; `/hooks` showed five idle stages and
  0 events, `r` made no change, Escape closed it, and the Screen list was empty.
  This is limited interaction evidence, not an event update or rendered
  screenshot. The standalone WSL interop plugin failed; selected-repository
  `rig-tools` remains active with three MCPs connected. Hermes CLI/process/profile
  availability remains unverified. Primary `rig-todo` `/tasks`
  passes typecheck and 59/59 tests. The primary PNG-only validator is integrated
  and its focused self-test passes; the v3 manifest remains unchanged, with all
  nine visible claims planned and empty evidence.
- A separate isolated host-evidence schema candidate received parent follow-up
  `changes_required` and is not integrated. Findings: same-day future-timestamp
  hole, missing float-version regression, `_validate_host_evidence` rejects
  unverifiable origin, and it assumes `integrated_browser.screenshot` instead
  of the WSL connector. The primary PNG-only validator remains unchanged; the
  candidate is not described as complete.
- The exact two-file child-cancellation fix is integrated in primary source and
  matches the reviewed isolated candidate: `orchestration-policy/src/index.ts`
  SHA-256
  `eed7824ffcc2e3a616addf0b62da90c0fcffa729cf6046d4508a137159e37ff9` and
  `test/policy.test.ts` SHA-256
  `b1601319f28bde7161ed84163c81296fdf095f13a55d1292f06ba3321b3c0008`. It
  reserves 1/6 of the original 30-second budget for an owner-checked terminal
  re-fetch after a missed lifecycle event, preserving active-capacity, deletion,
  and idle safeguards. The isolated regression failed before at 1,211 ms and
  passed after at 602 ms against the reported 600 ms budget; isolated pinned
  Node 26.4 typecheck and 79/79 tests passed. Primary child package checks were
  blocked because child `task_declare` is parent-owned, so no primary package
  check is claimed; the parent's state-bound QA pass on integrated source plus
  previous docs is recorded above. The earlier live canary exercised the old
  policy: `subagent_cancel` timed out, `session_context` returned
  interrupted/inactive, and `task_status` initially showed stale active before
  direct parent reconciliation. After the clean restart loaded the primary fix,
  one disposable read-only child was owner-bound and cancelled:
  `subagent_cancel` returned observed `interrupted`; an independent
  `session_context` confirmed `parentID`, `savedOutcome`=`interrupted`, and
  `liveStatus`=`inactive`; `task_status` advanced to `awaiting_followup`, then
  the parent accepted `subagent_followup` after review with active and awaiting
  counts at zero. This is one loaded-policy owner-bound canary, not exhaustive
  race coverage. Earlier hot-reload-window child sessions remained unbound
  despite `session_context` showing `parentID`, and their `subagent_followup`
  returned `not due`; no historical follow-ups were fabricated. Loaded negative
  `requiredClaimIDs` proof remains unavailable. The recovery CLI uses v2
  `deepObject` `location[directory]` and
  passes 38/38. `basic_memory_recovery` verified `connected-awaiting_read_note`,
  then the parent directly read
  `computer-assistant/decisions/open-rig-unified-ubuntu-architecture`. The
  earlier ~245 MiB `prlimit` virtual-limit hypothesis remains unproven as the
  cause of the disconnect; no fix is attributed to it.
- An independently reported clean selected-service restart changed PID
  `2407` to `4722`; the exact installed CLI `/api/info` confirmed the selected
  repository location, OpenCode `2.0.11`, and port `49374` were unchanged. The
  service reports 95/95 plugins active, including WSL interop and
  `orchestration-policy`; legacy `integrated-browser` is absent. Basic Memory,
  GitHub, and ChatGPT are connected. The direct same-location architecture-note
  read succeeded. The guarded global retirement removed only canonical legacy
  entries; backup path, SHA-256 values, and preserved modes are recorded in the
  ROADMAP retirement row. Installed OpenCode binaries were not modified. This
  restart loaded the primary cancellation fix; the one loaded-policy canary and
  accepted parent follow-up are recorded above.
- The persisted rig-todo mirror was 66,211 bytes, above the
  `MAX_TODO_STATE_BYTES` limit of 65,536, and caused launch refusal
  `subagent todo mirror is unavailable or invalid` after restart. Only two
  completed verbose Todo histories were compacted to concise
  verified outcomes; all 42 item statuses and priorities and the full actionable
  task text were preserved. The mirror is now 56,858 bytes. The loaded-policy
  owner-bound canary above passed after this repair.
- The isolated `~/.opencode-wsl2-pilot` profile is provisioned; nine
  browser-source paths pass pinned Node typecheck and 42/42 interop tests.
  `verify-wsl2.sh --source`, `verify-wsl2.sh --live`, and PowerShell AST checks
  also pass as limited evidence. A full isolated WSL
  bootstrap attempt, `./bootstrap.sh --platform wsl2 --verify-only`, exited 1;
  `--apply` exited 4 at its QA-runtime stage before any WSL pilot writes.
  Read-only POSIX ACL metadata showed inherited named-user `rwx` ACLs from
  `/home/brajam/repos` across source/data and runtime (458 directories,
  1,924 files; group-writable); ignored `toolchains/` and `toolchains/node/`
  directories are mode `0775`, and the regular runtime manifest is mode `0674`.
  Outer-only chmod would change collaborator access. The operator chose
  “Preserve access”; no ACL/mode changes or runtime rebuild were made, and no
  cause is attributed to the permission state. The repository `opencode.json`
  SHA-256 `7e4a58a418d98fdc34f60830375da4405e2bf0b1900690af8036e55ce64b362f`
  and Git status digest were unchanged. This blocks claiming a full WSL
  bootstrap; canonical QA separately passed on the integrated source and
  previous docs (see above). The subsequent post-archive QA and documentation
  gate passes are recorded in the Service identity section. The operator
  withdrew Windows-default-browser
  OpenCode Web panel acceptance on 2026-09-25 (“you dont need to use the web
  pannel we are in the TUI”); the historical HTTP Basic preflight remains
  blocked/historical with no credentials entered, and the live TUI is the
  acceptance target (see the 2026-09-25 final reconciliation). The earlier WSL
  `browser.open` returned `requestAccepted`; the HTTP Basic sign-in snapshot was
  cancelled without password entry, later Brave title/UIA text `OpenCode` was
  capped/truncated at 200 nodes, and the exact-window screenshot failed
  occlusion. These are historical preflight observations, not pending Web
  authentication or acceptance requirements. The private-snapshot WSL scratch
  apply passed prerequisites, config hash, Node 26.4/npm 11.17 QA runtime,
  isolated paths, and WSL OpenCode's 476-package/plugin-registration checks,
  then `wsl2-mcp-runtimes` exited 134 at `prlimit` memory allocation after
  downloading CPython 3.12.13; verify-only later failed on missing pilot
  `provisioned.json` and the `tsc-not-found` source self-test (details in the
  2026-09-25 section). All nine visible claims remain planned; native
  glyph/sidebar evidence remains pending.
- Native icon diagnosis was accepted read-only: U+FFFD in TTY output is not
  evidence of a rendered '?' glyph. The icon clone completed without a patch;
  it could not confirm a Windows screenshot canonical-base64 root cause. An
  unknown Windows foreground window makes read-only capture unsafe, and no
  OpenCode TUI glyph screenshot exists. No screenshot or host glyph evidence is
  claimed; the visible claim remains planned. All nine visible acceptance
  claims remain `planned` with empty evidence.

## 2026-09-23 reconciliation (historical context)

- The parent independently ran canonical `repo_qa_gate` `apply` after fixing
  the `HANDOFF.md` progress marker to include the `todo tool`; all twelve
  curated package checks passed. This repository-QA result does not accept UI
  claims.
- The primary GitHub issue-write guard and exact read-only launcher-probe
  correction pass the Node 26.4 typecheck and 67/67 tests; parent canonical QA
  passed all twelve curated packages. The source/test correction is accepted;
  no issue was created. A parent loaded-policy probe admitted the exact
  `/opt/opencode` launcher `api get /api/info` probe and read-only `git status`,
  but the selected `/opt/opencode` binary was missing. No `/api/info` response
  or service-identity result was obtained. An isolated candidate review
  confirmed `ctx.vcs.status()` as a supported plugin-context API, not an
  automatically exposed model tool. The policy admits a separately surfaced
  read-only VCS-status path and allows only the fixed bounded
  `git --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false log --max-count=10 --oneline`
  probe. The Node 26.4 candidate package check passed typecheck and 67/67 tests;
  focused progress/documentation checks passed, and the command returned nine
  commits. A live loaded-policy status/log probe remains pending; no restart,
  deployment, issue write, or installed-binary edit was performed.
- Current selected-location `opencode_runtime_status` reports OpenCode
  `2.0.11`, 95/95 plugins active, including `ponytail` and
  `opencode-rig.integrated-browser`; ChatGPT and GitHub MCPs are connected. The
  2026-09-23 Basic Memory MCP status was `Connection closed`; an authenticated
  recovery child was then in progress. That earlier recovery CLI probe lacked
  authentication; current authenticated OpenCode CLI service/API results are
  recorded above. No current Basic Memory `read_note` was run. The earlier
  Ponytail `MODULE_NOT_FOUND` cause remains unknown.
  Older 94/94 and 95/94/1-failed snapshots, plus Playwright-MCP connection text,
  are historical. The canonical role catalog and workspace omit
  `integrated-browser`, but deployed-config/runtime retirement remains Pending.
- A parent live negative `task_complete` call was refused with 17 actionable
  Todos. That verifies Todo-based completion blocking, not source owner-gate
  absence; owner-gate-absence proof remains Pending while
  `opencode-rig.orchestration-policy` is active. On 2026-09-23 the parent
  verified the canonical native Basic Memory marker and completed a successful
  direct authenticated `read_note`; those are historical observations only.
  That earlier recovery CLI probe lacked authentication; current authenticated
  OpenCode CLI service/API results are recorded above. No current Basic Memory
  `read_note` was run.
- The v3 acceptance manifest contains 13 claims; all nine user-visible claims
  remain planned with empty evidence. Rendered UI and interaction acceptance,
  mapping 13, theme switching, pagination, supporting-source digests, and
  native/WSL acceptance remain Pending.
- The 2026-09-24 `/hooks` source integration is accepted in primary `rig-tools`:
  bounded server RPC feed, opt-in Hermes observer, and slash fullscreen panel.
  Pinned Node 26.4 `rig-tools` passes typecheck and 175/175; Python observer
  tests pass 6/6. This is source/package evidence only, not an installed Hermes
  plugin or live host UI acceptance. `rig-todo` `/tasks` is integrated in
  primary source/tests and passes 59/59; the PNG validator is also integrated in
  primary with its focused self-test passing. All nine visible claims remain
  planned; rendered-visual and live interaction acceptance remains pending.
  At that historical snapshot, child-cancellation review remained
  `changes_required` and the combined cancellation/claim-gate integrator was
  active awaiting follow-up. The newer current reconciliation above records
  one accepted loaded-policy owner-bound canary; earlier hot-reload-window
  sessions remain unbound and were not backfilled with fabricated follow-ups.
  Icon diagnosis is terminal and accepted, but no host glyph evidence exists;
  keep visible UI acceptance pending.
- Focused progress tracking passed, as did the change-aware worktree
  documentation check for the recovery-manager source, plugin workspace README,
  and handoff; staged and unstaged `git diff --check` also passed. The configured
  staged-only documentation gate failed because staged
  `rig-tools/src/tool-catalog.ts` requires the untracked
  `docs/scripts/opencode-recovery.md`; related documentation-index edits are
  unstaged. Do not stage the guide or claim a staged-gate pass. Preserve
  pre-existing staged and unstaged work; this reconciliation did not stage,
  commit, push, deploy, restart, or modify installed binaries.
- The configured-only orchestration capacity correction is integrated in the
  primary source and documentation. `maxConcurrent` alone gates child
  concurrency; host/cgroup estimates are diagnostic only. The primary Node 26.4
  package check passed typecheck and 64/64 tests. Focused progress and
  documentation checks passed, and canonical `repo_qa_gate` apply passed all
  twelve curated package checks. Parent live probes admitted launches beyond
  the diagnostic memory estimate and refused the 11th child at 10/10. Earlier
  statements that live loaded-policy proof was Pending are historical and
  superseded; no deployment or restart is claimed for this documentation update.

## Decisions and ownership

- Canonical generic Ubuntu source is
  `platforms/linux/ubuntu/computer-use/`. WSL keeps Windows interop and isolated
  profile state, delegates generic MCP/plugin behavior to Ubuntu, and must not
  duplicate or symlink canonical source.
- Portable `opencode.json` owns exactly `basic-memory`, `github`, and `chatgpt`.
  All three MCPs are connected in the latest selected-service runtime; see the
  current reconciliation above.
- The direct root `opencode.json` owns project plugins, MCPs, and permissions;
  the WSL browser tool is registered there and its open request was
  permission-mediated. Preserve existing entries when updating it; do not
  create nested `.opencode/opencode.jsonc`, which may override project config.
  Guarded global retirement
  changed only the canonical legacy entries; original/live hashes and preserved
  modes are recorded in ROADMAP.md.
- The repository's new GPT-6 source role split assigns Build/Explore/General
  `openai/gpt-6-luna#max` and Plan/Architect `openai/gpt-6-sol#max` (Architect
  is a read-only planning/design subagent). Native selected-profile setup and
  the isolated WSL seed/verify paths exercise these roles; existing sessions
  keep their selected model. The older GPT-5.6 acceptance captures remain
  historical; parent-authorized profile deployment/restart is still required
  before claiming live model resolution on either platform.
- GitHub uses official local `github-mcp-server` `1.12.1`, archive
  `github-mcp-server_Linux_x86_64.tar.gz`, SHA-256
  `e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b`.
  The wrapper obtains a transient token only from the existing authenticated
  `gh` session and passes it only in the child environment.
- `orchestration-policy.options.maxConcurrent` in project `opencode.json` is the
  only child-concurrency admission gate and accepts `1..10`. Host/cgroup
  `agent_memory_capacity` estimates are diagnostic only; their result or
  availability never reduces or blocks configured admission.
- OpenCode owns the sole native MCP sidebar row. `rig-tools` contributes only
  additive Active Subagents; `rig-todo` contributes Todo independently. Active
  Subagents uses one shared background and no selected-card surfaces.
- Todo layout contract: render actionable rows only, with current `in_progress`
  work first and then `pending` work. Hide all completed and cancelled body
  history behind one truthful aggregate count; do not render completed or
  cancelled description rows. Header counts, markers, storage, and tool
  semantics remain unchanged, and session IDs never appear in Todo text.
  The previously recorded package tests are automated evidence only. The
  detached text capture and native frame/span artifacts are not accepted UI
  evidence under the current pending manifest.
- Provider Usage starts collapsed with the `- Provider Usage` header and its
  count retained. Provider names are bold, rows have no bullets, semantic
  status is right-aligned, wrapped detail is dim, and measurement emphasis is
  amber. Absent summaries have no dangling separator. Detailed refresh errors
  stay in `/provider-usage`, not the compact sidebar.
- Provider Usage authority now belongs to the server role: it resolves
  authoritative provider/integration/connection/runtime state plus metadata-only
  activity and sends only sanitized `provider.usage.snapshot` rows. Working
  providers always render, including OpenCode Zen when authoritative runtime
  readiness says it is ready without a quota adapter. An offline provider is
  visible only when authoritative OpenCode session/model activity proves use in
  the preceding inclusive two-hour window; after that it disappears. Disabled
  and absent providers never render, and model inventory, credentials, or a
  fixed provider list cannot substitute for recent activity. Aliases deduplicate
  under the configured display name. The prior UI review's provider rows and
  refresh result are retained as historical implementation context only; they
  are not current acceptance evidence because the prior manually-authored
  manifest is invalid.
- Provider Usage refresh contract: the periodic server poll defaults to 60
  seconds and is never shorter than 30 seconds; RPC/manual refresh is
  server-throttled; credential, provider, and integration events may force an
  immediate refresh; and concurrent requests coalesce. The 30-second floor
  applies to the periodic poll, not each adapter probe.
- Explorer correction: `file-manager/src/tui.tsx` uses the defensive
  theme-derived fallback, and the fresh Node 26.4 package check exercises the
  full panel with a minimum theme. Prior corrected-client Explorer
  open/navigation/diff-toggle/close observations are historical implementation
  context only, not current UI acceptance evidence.
- Orchestration portability correction: the current reusable policy/package
  removes global agent/model allowlists, permits consuming-project identities
  such as `@execution/ingenium-*`, and supports a project-controlled `1..10`
  ceiling. Its earlier focused package result is 48/48; the memory-based
  admission behavior from that snapshot is superseded by the configured-only
  correction below. The prior cross-repository denial and three-child
  observation still require fresh live regression and clean deployed
  revalidation.
- Configured-only orchestration capacity correction: the primary source admits
  up to configured `maxConcurrent` (`1..10`) regardless of low, invalid, or
  unavailable host/cgroup estimates, and starts the estimate asynchronously as
  diagnostics. The primary Node 26.4 package check passed typecheck and 64/64
  tests; canonical QA passed all twelve curated packages. Parent live probes
  admitted launches beyond the diagnostic estimate and refused the 11th child
  at 10/10. Earlier pending-proof wording is historical and superseded; no
  deployment or restart is claimed for this documentation update.
- Bootstrap lockout recovery is documented at
  `docs/scripts/orchestration-lockout-recovery.md`. It is an operator-only
  override for a demonstrable lockout with no supported session/task/repair
  route, limited to four indexed policy files, with an external backup and
  append-only audit. Never disable the plugin or edit its storage; reload and
  verify the plugin and run normal checks after recovery.
- The current v3 acceptance inventory is pending. Its source inventory can
  validate structurally, but the validator exposes no claimable visual or
  interaction paths for native test-renderer artifacts. Keep visible claims
  planned until authentic host proof is supported and retained.
- `./bootstrap.sh` is the single cross-platform entry point. It is read-only by
  default, applies additively with a journal, preserves repository
  `opencode.json` bytes, uses only the existing authenticated `gh` session, and
  keeps WSL2 state separate from the native top-level script. It now verifies
  the separate checksum-pinned Node `26.4.0` QA runtime in ignored
  `toolchains/node/`; apply provisions that checkout-local path without
  changing the profile-owned Node `22.22.2` runtime. Native privileged setup
  and fresh full WSL2 apply acceptance remain pending.
- Installed OpenCode/OpenTUI binaries are immutable. The 2026-09-24 screenshot
  of ALSA card/PCM diagnostics flooding the active parent TUI after three
  General children finished supersedes the earlier no-diagnostics capture. The
  active standard `~/.config/opencode/cli.json` was restored with an exact
  state-bound replacement; readback confirms valid JSON, the V2 CLI schema URI,
  notifications `true`, sound `false`, and mode `0600`. Setup only seeds a
  missing `cli.json`, while rig-tools deployment `--apply` sets sound false; the
  cause of the observed reversion is not established. Fresh rendered
  child-completion and native fd-2 verification remains pending; any rendered
  test must capture fd-2 rather than letting it overwrite the TUI.
- Native GNOME screenshots use the private ydotool shortcut. When that backend
  is unavailable on WSL2, `vision_capture` delegates only the bounded in-memory
  PNG operation to the checked-in Windows PowerShell host.

The accepted Basic Memory decision is
`computer-assistant/decisions/open-rig-unified-ubuntu-architecture`.

## Implemented source and current package results

- Basic Memory is pinned to `0.23.2`, with the local default
  `computer-assistant` project and FastMCP prerelease support.
- Historical Playwright MCP/browser-runtime records cite MCP `0.0.80`, Node
  `22.22.2`, and browser revision `1243` with native/WSL profile isolation.
  They do not describe the current MCP set; the direct-pinned headless Firefox
  package is not an MCP and is not the Windows-default-browser QA path.
- GitHub policy, profile-owned path selection, checksum download, exact archive
  allowlist, executable/version validation, local declarations, `gh` wrapper,
  WSL profile exports, and Source Control environment forwarding are implemented.
- `mcp-runtime-self-test.py` passes checksum, archive-shape, version, symlink,
  profile-isolation, token-redaction, and inherited-control rejection cases.
- `setup-opencode-self-test.py` passes with separate isolated and active-native
  CLI fixtures; verify fails on an unsafe active profile, apply preserves
  notifications while disabling sound, and both targets then pass.
- **Previously recorded rendering tests:** the 2026-09-22 `codex-usage`
  package output reported typecheck and 63/63 tests, including provider
  visibility and activity cases. These are automated results only; the native
  capture artifacts and detached terminal text do not establish UI acceptance.
- Provider Usage's previously recorded package checks include server/TUI
  snapshot assertions and two-hour activity cases. No current live rendered or
  host-interaction claim is accepted by the pending manifest. Native privileged
  host and isolated WSL full-apply/bootstrap boundaries remain separate.
- The root bootstrap contract and guide are implemented as a package/source
  surface; no fresh full WSL2 apply or rendered bootstrap evidence is claimed.
- The checkout-local QA runtime is pinned to the official Node `26.4.0` archive,
  Node executable, and npm `11.17.0` CLI digests. The archive was previously
  verified and installed under ignored `toolchains/node/`; earlier `--verify-only`
  and PATH-only npm checks passed. Installer, CI, and bootstrap integration are
  in place. Focused runtime, repository-QA, bootstrap, documentation, and
  rig-tools checks passed for earlier snapshots. An earlier canonical QA stopped
  after runtime/acceptance preflight when concurrent `chatgpt-connector`
  integration raised the workspace count to 13; the prior WSL deployment
  self-test also found its in-progress package missing `server.ts`. Those
  blockers were resolved for the subsequent prior QA pass, which passed all
  twelve curated packages. The later WSL bootstrap preflight failure is recorded
  in the current reconciliation; it does not establish canonical QA failure.
   The post-archive parent state-bound canonical QA preview/apply passed all
   twelve curated packages, and the documentation gate passed 462 mapped files
   with 173 changed at worktree fingerprint
   `a8e6e2a3605f29af92b25a811220d69d399a820df938186b012030a7f17a5c43`. Fresh
   full WSL2 bootstrap and rendered acceptance remain pending; limited
   source/live checks are recorded above.
- `source-control` typecheck and all 30/30 tests pass. Prior client pointer
  behavior is not current UI acceptance evidence.
- `repo-learning` typecheck and all 78 tests pass. Live read-only status is
  `observing` with zero retained episodes; audit reports none retained.
- `orchestration-policy` passes 48/48 tests; its portability regressions accept
  namespaced identities and arbitrary consuming-project models without global
  allowlists. This is the earlier package snapshot; the configured-only
  concurrency correction has its own current verification record above. Seven
  concurrent children launched under project `maxConcurrent: 10` in the earlier
  live snapshot. The corrected primary Node 26.4 package check passes typecheck
  and 64/64 tests. Fresh cross-repository regression and loaded-policy proof
  remain pending.
- The primary `rig-todo` check passed typecheck and 59/59 tests on pinned Node
  26.4.0, including the isolated native renderer fixture for `/tasks` board and
  history interactions. This is automated evidence only; it is not live UI
  acceptance.
- The previously recorded `file-manager` package output reports 71/71 tests
  under Node 26.4.0, including narrow identity rendering and the minimum-theme
  panel. The earlier corrected-client interaction review is historical only.
- The 2026-09-22 snapshot recorded Basic Memory, GitHub, and Playwright healthy
  with OpenCode `2.0.11`, PID `2652683`, and 94/94 active plugins. It is
  historical and superseded by the 2026-09-23 runtime status above.
- The active standard CLI readback confirms notifications remain enabled and
  attention sound is disabled after the exact file edit. The earlier real-child
  no-ALSA capture is historical and superseded by the 2026-09-24 screenshot.
  Fresh active-window TUI plus native fd-2 evidence after a real child
  completion remains pending.
- Historical WSL screenshot-fallback source checks passed 119 shared-tool tests
  and 36 WSL interop tests. The bounded 2026-09-22
  `vision_capture(mode=window)` privacy check through trusted `powershell.exe`
  returned an unrelated Windows media window and was correctly rejected as TUI
  visual evidence; image bytes remained in memory and no screenshot file was
  retained. The fresh 2026-09-24 parent window capture failed with
  `Windows screenshot data is not canonical base64`; current live screenshot
  proof remains pending, with no repair claimed.

## Current live state and remaining boundaries

- The earlier profile verification recorded the GitHub MCP as connected through
  the existing authenticated `gh` session. Current MCP connection status is
  recorded in the 2026-09-24 reconciliation above; prior Playwright text is
  historical.
- The configured-only orchestration correction uses `maxConcurrent: 10` as the
  sole admission ceiling; host/cgroup estimates are diagnostic only. Parent
  live probes verified admission beyond the estimate and refusal of child 11 at
  10/10. The loaded service now reports `orchestration-policy` active. Current
  semantic negative proof for `github.issue_write`, `requiredClaimIDs`, and
  installed-binary mutation, plus loaded-policy denial of the `--max-count=11`
  near-miss, remains unproven; the outer shell returned 11 without establishing
  `execute.before` mediation (see current reconciliation above).
- After the parent completed deployment and restart, this subagent reran
  read-only `deploy-plugins.sh --plugins all --verify-only` for both the active
  and pilot targets; both exited 0. That earlier health snapshot reported
  OpenCode `2.0.11`, PID `2652683`, at port `49375`, 94/94 active plugins, and
  three healthy MCPs; the latest runtime counts and connections are recorded
  above.
- The previously recorded detached 200-column TUI text capture is text-only and
  historical. The retained v3 native frames, spans, test PNGs, and mock events
  are test diagnostics, not screenshot, host-interaction, or pixel-acceptance
  evidence. The manifest keeps every visible claim pending.
- Native-GNOME privileged desktop prerequisites still need interactive sudo.
  The operator withdrew Windows-default-browser OpenCode Web panel acceptance on
  2026-09-25 (“you dont need to use the web pannel we are in the TUI”); the
  historical HTTP Basic preflight remains blocked/historical with no credentials
  entered, and the live TUI is the acceptance target (see the 2026-09-25
  reconciliation). The earlier permission-mediated WSL `browser.open` returned
  `requestAccepted`, and the exact-window capture was occluded; those are
  historical preflight observations, not pending Web authentication or
  acceptance. The private-snapshot WSL scratch apply reached
  `wsl2-mcp-runtimes` and exited 134 at `prlimit` memory allocation after the
  CPython 3.12.13 download; see the 2026-09-25 reconciliation for the preceding
  successful steps and verify-only failures. Separately, full WSL bootstrap is
  blocked at the checkout-local QA-runtime stage by the preserved shared ACL;
   post-archive canonical QA and documentation-gate passes are recorded in the
   service identity section; the shared ACL remains preserved. WSLg,
  PowerShell 7, fresh full apply/actions, Windows action-apply, and native visual
  evidence remain pending. The unrelated media-window result was rejected as
  TUI visual evidence.
- Current acceptance provenance and blockers are recorded in
  `docs/acceptance-evidence-2026-09-22.md`. Mapping 13, theme switching,
  pagination, supporting-source digests, and authentic host proof remain
  outstanding. Native privileged-host, fresh isolated WSL2 full apply/action,
  bootstrap live-apply, and cross-repository portability regression remain
  separate boundaries.
- All work is uncommitted and unpushed.

## Service identity and verification boundary

- The clean selected-service restart changed PID `2407` to `4722`; exact
  installed-CLI `/api/info` confirmed the same repository location, OpenCode
  `2.0.11`, and `127.0.0.1:49374`. It reports 95/95 plugins active, WSL interop and
  `orchestration-policy` active, `integrated-browser` absent, and all three
  MCPs connected. The guarded retirement backup, original/live config hashes,
  and preserved modes are recorded in ROADMAP.md; installed binaries are
  untouched.
- The latest state-bound `repo_qa_gate` preview and apply passed all twelve
  curated packages and canonical checks at worktree fingerprint
  `a8e6e2a3605f29af92b25a811220d69d399a820df938186b012030a7f17a5c43` (output
  SHA-256 `00411da60bea72a0dcca436bb18e7d94a93af8cc535e31e1720cbf87d757ffc8`).
  The documentation gate passed 462 mapped files with 173 changed at the same
  fingerprint. The prior pre-archive fingerprint
  `16103fda8ac2b34a7450e2562ad986149df6de085c1443f18e862e2dc3565b24` is
  historical. The
  isolated WSL bootstrap remains separately blocked by the preserved shared
  ACL; canonical QA's loader does not perform that bootstrap mode check. This
  documentation update makes no deployment or configuration change and does
  not stage files. Do not commit or push unless the operator separately approves
  each action; commit and push approvals remain separate.
