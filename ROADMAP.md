# OpenCode v2 Explorer Roadmap

Updated 2026-09-18 on `migration/opencode-v2`.

This is the agent-facing work ledger. The architecture and feature phases live
in [`docs/plans/explorer-ide.md`](docs/plans/explorer-ide.md); the fresh runtime
transfer record lives in [`HANDOFF.md`](HANDOFF.md).

## Objective and verified baseline

Complete the v2 Explorer IDE in
`platforms/linux/ubuntu/computer-use/plugins-v2/file-manager` while preserving
the installed v1 stack for rollback. The active harness is the isolated v2.0.7
pilot (`~/.local/opt/opencode-v2/opencode`, state under
`~/.opencode-v2-pilot/`). The v2 health check passed before this work; the
current worktree also passes the Explorer safety and repository gates below.

`HANDOFF.md` contains a pre-existing fresh handoff rewrite. It is intentionally
not included in this ledger's implementation changes unless the handoff itself
needs an environment update.

## Work items

Each item records its status, dependencies, acceptance criteria, automated and
live evidence, documentation state, commit state, and exact next action.

### A0 — control-plane ledger

- **Status:** complete for this work session.
- **Owner:** assistant.
- **Dependencies:** none.
- **Acceptance:** this ledger remains distinct from the design plan and handoff;
  every active item has an explicit verification gate and next action.
- **Automated evidence:** repository health and git state inspected on
  2026-09-18; v2 health check passed.
- **Live evidence:** v2.0.7 pilot service and isolated configuration remain in
  place; v1 binary/configuration were not changed.
- **Documentation:** this file added; handoff preserved as pre-existing work.
- **Commit:** not committed yet.
- **Next action:** keep this ledger current as each bounded item is verified.

### A1 — v2 plugin role catalog and deployment gate

- **Status:** complete for this work session; not yet committed.
- **Owner:** assistant.
- **Dependencies:** A0.
- **Acceptance:** one canonical catalog describes all six packages, both roles
  of `rig-todo`, role entrypoints, and target config files; deployment and the
  v2 health check consume it; temporary-config tests cover selection,
  dual-role, duplicate, malformed, non-canonical, invalid-JSONC, and idempotent
  cases.
- **Automated evidence:** `bash -n`, ShellCheck, Python compilation,
  `check-skill-docs.py`, `check-plugin-resource-guards.py`,
  `check-progress-tracking.py`, `check-doc-coverage.py`, all four negative
  self-tests, and `deploy-plugins-self-test.py` passed on 2026-09-18.
- **Live evidence:** `setup-opencode-v2.sh --verify-only`,
  `verify-opencode-v2.sh`, and `deploy-plugins.sh --v2 --plugins all
  --verify-only` passed against the running pilot. The live config includes
  `rig-todo` in both server and CLI roles with canonical package paths.
- **Documentation:** canonical catalog, deployment and health-check references,
  self-test guide, component README, CI step, and this ledger are updated.
- **Commit:** not committed yet.
- **Next action:** keep the role-catalog/deployment changes separately
  reviewable and uncommitted until an explicit commit request; do not stage
  unrelated handoff or Explorer work.

### B1 — Codex fallback v2 API stabilization

- **Status:** complete in the current worktree; not yet committed.
- **Owner:** assistant.
- **Dependencies:** A1.
- **Acceptance:** fallback routing uses only the supported v2 session API and
  fake-provider tests prove one-turn failover, tier advancement, cooldown,
  recovery, variants, manual-model protection, and fail-open catalog errors.
- **Automated evidence:** bounded package `npm run check` passed with 31 tests;
  the new fake-provider/session harness covers primary failover, tier
  advancement, duplicate suppression, cooldown recovery, variants, manual
  selection, catalog fail-open behavior, and oversized state rejection.
- **Live evidence:** a disposable OpenCode v2.0.7 standalone server sent a
  local fake provider's quota failure on `fake/source`, then successfully sent
  the retry to `fake/tier-1` through `ctx.session.switchModel()`; no user
  credentials or configuration were changed.
- **Documentation:** v2 component and deep plugin references, migration
  handoff, and this ledger now describe the supported session-switch path.
- **Commit:** not committed.
- **Next action:** retain the supported routing implementation, review the
  combined uncommitted diff, and keep the v1 stack untouched.

### C1 — Explorer Phase 1.1 safety stabilization

- **Status:** complete in the current worktree; not yet committed.
- **Owner:** assistant.
- **Dependencies:** A1, B1.
- **Acceptance:** centralized path safety, race-safe saves, disk conflict
  handling, complete dirty-tab guards, safe external-editor reloads, and
  generation guards prevent data loss or out-of-root writes.
- **Automated evidence:** bounded file-manager check passed with 39 tests on
  2026-09-18, including canonical-root containment, symlink/`.git` rejection,
  UTF-8/binary/size guards, atomic mode-preserving saves, disk conflicts,
  revision-safe saves, dirty guards, command parsing, and generation
  invalidation. The repository shell, Python, documentation, deployment,
  and v2 health gates also passed.
- **Live evidence:** a disposable v2.0.7 client displayed `/editor`, `/files`,
  and `/explorer` in slash completion. A client attached to the isolated
  existing v2 session opened the updated `Files` panel and rendered its project
  tree and editor. A disposable file remained byte-for-byte unchanged after
  an unsaved edit attempt and was removed afterward.
- **Documentation:** `docs/plans/explorer-ide.md`, the v2 workspace README,
  and `plugins-v2/file-manager/README.md` record the safety contract and
  aliases; `HANDOFF.md` records the resolved release blockers.
- **Commit:** not committed.
- **Next action:** hold Phase 2 parser work until explicitly approved; review
  and commit this independently reviewable safety change without staging v1
  or unrelated user work.

### D–I — Explorer feature phases 2–7

- **Status:** not started; held behind explicit Phase 2 approval after the A1,
  B1, and C1 gates.
- **Owner:** assistant.
- **Dependencies:** C1.
- **Acceptance:** follow the phase gates in `HANDOFF.md` and
  `docs/plans/explorer-ide.md`; never add parser assets or editor power while a
  known safety or runtime blocker remains.
- **Automated evidence:** Phase 0 and Phase 1 evidence is recorded in the
  handoff and Basic Memory; later phases have none.
- **Live evidence:** Phase 1 is complete; later phases are not started.
- **Documentation:** design plan is current; each phase must update its deep
  references and this ledger.
- **Commit:** none for later phases.
- **Next action:** do not start Phase 2 language assets without explicit
  approval, even though the A1, B1, and C1 gates now pass.
