# Open Rig roadmap

Updated 2026-09-25. This is the consolidated current-state ledger. The complete
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
- **Canonical QA:** state-bound preview and apply passed all 12 curated packages
  and canonical checks at worktree fingerprint
  `a8e6e2a3605f29af92b25a811220d69d399a820df938186b012030a7f17a5c43`
  (output SHA-256
  `00411da60bea72a0dcca436bb18e7d94a93af8cc535e31e1720cbf87d757ffc8`). The
  pre-archive fingerprint `16103fda8ac2b34a7450e2562ad986149df6de085c1443f18e862e2dc3565b24`
  is historical.
- **Acceptance inventory:** the v3 ready inventory has 14 source mappings,
  28 execution receipts, and 15 native test-render captures; the integrated
  acceptance checker returns OK. This inventory status does not promote visible
  claims; all nine remain planned pending retained host evidence.
- **Documentation verification:** the documentation gate passed with 462 mapped
  files and 173 changed at the same worktree fingerprint. Focused progress
  tracking, coverage, and staged/unstaged whitespace checks also pass.

## Remaining workstreams

| Workstream | Exact state | Blocker | Next action |
|---|---|---|---|
| TUI host evidence and visible-claim promotion | Pending; all nine visible claims remain `planned`. The latest attempted capture found the TUI window was not foreground. | No retained host rendered-visual plus interaction pair; native test-render captures are not host evidence. | Capture a foreground TUI render and an interaction that visibly changes it; retain both records and images and promote only after checker validation. |
| WSL2 bootstrap acceptance | Blocked at `wsl2-opencode`: earlier stages and plugin registration pass, while `wsl2-mcp-runtimes` is not reached. The shrinking bounded RSS budget is about 276 MiB with Node 22 Amaro WASM and the WSL workspace install. | Bounded-memory pressure; native privileged GNOME setup still requires interactive sudo. The shared ACL remains preserved. | Profile the Node 22/Amaro WASM and workspace-install peak, then retry the isolated apply without changing the shared ACL; request sudo only for the native privileged branch. |
| Hermes live `/hooks` panel with GPT-6 Luna | Deterministic mock-provider hook proof is complete; live GPT-6 Luna labels and rendered-panel evidence remain unverified. | No provider credentials; the rendered panel still needs retained host evidence. | When credentials and host capture are available, run the provider-backed hook flow and retain a render-plus-interaction pair; keep the live claim pending until then. |
| Question-mark icon reproduction | Not reproduced; no repository defect found. Attempts did not have the TUI in the foreground. | No specimen captured from a foreground TUI window. | If the glyph recurs, retain the foreground specimen and inspect that exact case; otherwise keep the no-reproduction result. |
| Loaded-policy negative: `requiredClaimIDs` | Unverified; no loaded-policy negative result is claimed. | No supported non-polluting probe is available. | Leave unverified until a supported harmless negative probe exists; do not synthesize a result. |
| Loaded-policy negative: read-only near-miss and issue-write | Unverified; the outer-shell near-miss did not prove loaded-policy mediation, and no issue-write attempt is claimed. | No supported non-polluting probe demonstrates either loaded negative without an external write. | Wait for a supported harmless policy probe; do not issue a live write or treat an outer-shell result as loaded-policy evidence. |
| Three historical orphan child follow-ups | The Hermes, scoped-issue, and WSL-feasibility follow-ups are unrecoverable; the same-generation restore fix is integrated and prevents recurrence of the stale-snapshot path. | The supported post-fix recovery retry returned `not due`; historical outcomes cannot be reconstructed without fabrication. | Preserve the orphan status without backfilling; use owner-bound follow-up and the integrated restore path for future children. |
| Separate commit and push approvals | Both approvals remain outstanding. This task staged nothing; pre-existing staged paths were present and are preserved. | No explicit commit or push approval; the existing index/worktree contains earlier work. | Keep the index unchanged. Request commit approval for an exact reviewed staged scope, then obtain separate push approval after commit. |

## Implemented

The full implementation chronology and detailed evidence remain in the
[roadmap archive](roadmap-archive-2026-09-25.md).

- **`orchestration-policy`:** lifecycle, follow-up, cancellation, claim-gate, installed-binary, correction-ledger, configured-only concurrency, and reload-state fixes; canonical QA passed all 12 packages, and one loaded owner-bound cancellation received accepted follow-up.
- **`rig-tools`:** `/tools`, `/hooks`, and `/subagents` panels, bounded-retention vision capture, and Git gates; pinned Node 26.4 typecheck and 180/180 tests passed.
- **`rig-todo`:** `/tasks` board and history; pinned Node 26.4 typecheck and 59/59 tests passed.
- **`codex-usage`:** authoritative Provider Usage state and sanitized display; included in the green 12-package canonical QA run.
- **`source-control`:** native Source Control surface; typecheck and 30/30 tests passed.
- **`file-manager`:** guarded Explorer/editor and diff experience; focused Node 26.4 package checks passed 71/71 tests.
- **`repo-learning`:** durable learning and reflection workflow; typecheck and 78/78 tests passed.
- **`ponytail-adapter`:** pinned official Ponytail package through the v2 adapter; typecheck and 13/13 tests passed, with the runtime active in the selected service.
- **`codex-fallback`:** bounded configured fallback routing; included in the green 12-package canonical QA run.
- **WSL interop:** Windows UI Automation, browser, and PowerShell host; pinned Node typecheck and 42/42 tests passed.
- **Legacy integrated-browser retirement:** guarded config retirement is complete; the selected service reports the legacy plugin absent.
- **`bootstrap.sh`:** native/WSL2 journaled verify/apply workflow; behavior checks passed, with current live WSL acceptance blocked as recorded above.
- **QA runtime, launcher, and deploy:** checksum-pinned Node 26.4/npm 11.17, bounded launcher, and guarded plugin deployment; their self-tests passed in canonical QA.
- **Recovery CLIs:** target-bound OpenCode recovery and allowlisted orchestration-lockout recovery; both CLI self-tests passed in canonical QA.
- **Acceptance evidence:** standard-library validator and bounded host-capture schema are integrated; the 14-source inventory checker passes while visible claims remain pending.
- **Repository gates:** documentation coverage, canonical QA, Git safety, and progress tracking are integrated; the current state-bound QA preview/apply passed all 12 packages and the documentation gate passed at the same fingerprint above. Focused progress, coverage, and staged/unstaged whitespace checks pass.
- **Operator commit/push overrides:** Added separate operator-invoked `/commit` and `/push` commands that run outside the agent tool gates with `--no-verify`; commit stages all changes accepted by `git add -A`. The Git safety guide documents the boundary, and focused documentation coverage plus the Git safety policy check and self-test pass.
- **Bounded command runner:** timeout, output, and process-group guards; self-test passed in canonical QA.
- **WSL MCP and verifier fixes:** earlier WSL stages and plugin registration pass; the current apply boundary is tracked above.
