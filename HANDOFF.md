# Fresh Handoff

This file replaces the previous handoff. It was recreated on 2026-09-18 after
a read-only repository, runtime, deployment, and bug audit. It is the current
fresh-context transfer record; implementation changes remain uncommitted.

## Repository snapshot

- Repository: `/home/james/repos/opencode-rig`
- Branch: `migration/opencode-v2`
- HEAD: `7caeeec36a87058f6022b9b3a58208760a0321ae`
- HEAD message: `Build the Phase 1 Explorer editor core`
- Working tree: dirty with the uncommitted role-catalog/deployment work, Codex
  fallback stabilization, and Explorer Phase 1.1 safety changes; unrelated
  handoff and user work is preserved.
- Upstream: synchronized (`0` commits ahead, `0` behind)
- No commit, push, merge, or pull-request mutation was performed for this
  handoff.

## Runtime snapshot verified immediately before writing

- Explicit v2 binary: `~/.local/opt/opencode-v2/opencode`
- Explicit v2 version: `opencode v2.0.7`
- Explicit v2 health check: passed
- v2 pilot config: `~/.opencode-v2-pilot/config/`
- v2 pilot server config contains:
  - `plugins-v2/rig-tools`
  - `plugins-v2/rig-todo`
  - `plugins-v2/codex-fallback`
- v2 pilot CLI config contains:
  - `plugins-v2/source-control`
  - `plugins-v2/codex-usage`
  - `plugins-v2/file-manager`
  - `plugins-v2/rig-todo`
- The canonical `config/v2-plugin-roles.json` catalog now describes all six
  packages, both `rig-todo` roles, their entrypoints, and their target config
  files. Deployment and health verification consume the catalog.
- `deploy-plugins.sh --v2 --plugins all --verify-only`: passed; it verifies
  canonical package paths, role entrypoints, duplicate/malformed entries, and
  both `rig-todo` registrations.
- `verify-opencode-v2.sh`: passed; it confirmed the v2 binary, 16 skills, four
  commands, GitHub MCP, exactly one Playwright MCP, the catalog-driven package
  roles, six package shims, and the Aura theme.
- In the current agent shell, plain `opencode --version` resolves to
  `1.18.31` from `~/.opencode/bin/opencode`. The explicit v2 binary resolves to
  `2.0.7`. A v2 service is running. Do not assume that an arbitrary shell's
  plain `opencode` command selects v2; verify the path/version or use the
  explicit v2 launcher.
- `~/.bashrc` contains a v2 PATH line, but the current shell PATH still puts
  `~/.opencode/bin` first. This discrepancy remains a runtime/configuration
  item, not a reason to modify v1.
- v1 remains installed and must remain untouched for rollback.

## Active objective

Complete and safely ship the OpenCode v2 Explorer IDE in
`platforms/linux/ubuntu/computer-use/plugins-v2/file-manager`, while keeping
the v1 stack available for rollback.

Explorer requirements:

- real navigation and editing
- broad language highlighting
- project search and replace
- guarded create/rename/delete operations
- Git status and diff integration
- bounded external formatting and diagnostics
- no automatic saving
- no silent overwrite or destructive file operation
- side-by-side editors deferred to Phase 7

## Already present in the repository

The current v2 workspace has six packages:

| Package | Role | Current surface |
|---|---|---|
| `rig-tools` | server | desktop accessibility, input, windows, screenshots |
| `rig-todo` | server + CLI | `todowrite`, `todoread`, Todo sidebar |
| `codex-fallback` | server | Codex quota fallback routing |
| `source-control` | CLI | local Git and GitHub PR sidebar |
| `codex-usage` | CLI | Codex quota sidebar |
| `file-manager` | CLI | docked Explorer tree, tabs, viewer, editor |

Explorer Phase 0 and Phase 1 code is present at HEAD, with Phase 1.1 safety
stabilization added in the current worktree:

- manual Tree-sitter highlighting through `highlightOnce()` and explicit
  highlight ranges
- JSON/JSONC parser spike registration
- tabs with `{ path, content, original }`
- tab switching, save, save-all, close/discard guard, reopen, persistence,
  refresh, status line, and go-to-line
- bounded editor click-to-position helper with unit tests
- canonical-root path validation, disk fingerprints, conflict-safe atomic saves,
  revisioned dirty guards, bounded external-editor execution, and asynchronous
  generation guards; the bounded package check passes 39 tests

The detailed design remains in `docs/plans/explorer-ide.md`. Phase 1.1 is
verified in the current worktree; correctness stabilization is complete, but
Phase 2 asset work remains held for explicit approval.

## Confirmed bug-hunt findings

### Release-blocking

1. **Resolved in the current worktree: Codex fallback routing used unsupported
   model mutation.** `plugins-v2/codex-fallback/src/index.ts` now uses the
   supported `ctx.session.switchModel()` API and never assigns to the read-only
   `event.model`. The bounded fake-provider/session harness proves primary and
   tier advancement, duplicate suppression, recovery, variants, manual
   selection, and catalog fail-open behavior; a disposable v2.0.7 server also
   completed a local 429-primary → tier-1 turn.

2. **Resolved in the current worktree: Explorer save completion could mark
   newer edits saved.** `writeTab()` now captures a revisioned immutable
   snapshot and only advances the in-memory saved baseline when that exact
   revision completed. Newer edits remain dirty while the disk fingerprint is
   advanced to the snapshot that was actually written.

3. **Resolved in the current worktree: external editing could discard dirty
   content.** Dirty tabs are refused until saved or discarded, editor commands
   use bounded non-shell parsing, and reload occurs only after a successful
   zero-exit child process.

4. **Resolved for plugin-owned panel closes in the current worktree:** Escape
   checks every dirty tab using path-plus-revision guards before closing. The
   accepted paths-only persistence policy remains; unsaved content is never
   stored.

5. **Resolved in the current worktree: `.git` protection could be bypassed
   through path resolution.** A canonical-root path guard now rejects absolute,
   traversal, `.git`, outside-root symlink, directory, special-file, binary,
   invalid-UTF-8, and size-invalid paths for every Explorer file boundary.

### High priority

- Explorer atomic replacement now preserves mode bits, uses unique exclusive
  temporary names, flushes before rename, and cleans up on failure.
- Explorer save snapshots now use disk fingerprints and refuse external-edit
  conflicts rather than silently overwriting them.
- Search and highlight requests now have generation guards; `j` and `k` remain
  available to the focused search input instead of being consumed as list
  navigation.
- External-editor command parsing is bounded and does not invoke a shell.
- `rig-todo` mirror files lack an explicit owner-only permission policy, have no
  input-size limits, and use collision-prone temporary names.
- Source Control can publish stale refresh results after a session/project
  switch, does not scope all filesystem/VCS events, and can retain stale branch
  data after detached HEAD.
- Codex Usage needs session-switch generation guards and bounded timer values.
- `vision_capture` does not fully validate the screenshot file before reading
  and can report successful cleanup when deletion fails.
- CI currently exercises only three of the five rollback v1 plugin packages.
- v1 Source Control typechecking exceeds the normal bounded heap; a bounded
  `tsc --noEmit --skipLibCheck` run passed with a 272 MiB peak and should be
  evaluated as the resource-remediation path, not used to hide source errors.

## Required implementation order

### 0. Control-plane documentation

Create or replace the repository-root `ROADMAP.md` as the agent-facing work
ledger. Keep it distinct from this fresh-context handoff:

- `ROADMAP.md`: live work items, dependencies, acceptance gates, evidence,
  commits, and next actions.
- `docs/plans/explorer-ide.md`: detailed architecture and phase design.
- `HANDOFF.md`: concise current runtime/repository transfer material.

Each roadmap item must have a status, acceptance criteria, automated evidence,
live evidence, documentation state, and exact next action. Never mark a phase
complete without verification.

### 1. Registration, verification, CI, and documentation

- Define the six-package role catalog, including both roles for `rig-todo`.
- Make `deploy-plugins.sh` and `verify-opencode-v2.sh` consume/validate the
  role catalog.
- Add temporary-config tests for `all`, `server`, `cli`, single-package,
  dual-role, duplicate, malformed, and idempotent cases.
- Make health checks validate canonical package paths and role entrypoints.
- Add all five v1 packages to CI; keep checks bounded.
- Add missing v2 component READMEs and deep plugin references.
- Reconcile stale v1-default, pilot-only, cutover, and removed-memory text.

### 2. Codex fallback stabilization

- Build a fake-provider routing test around the supported v2 session API.
- Prove one failed primary turn completes on the first fallback tier.
- Prove a failed fallback advances exactly once to the next tier.
- Prove cooldown expiry recovers to the source model.
- Preserve model variants and respect explicit manual model choices.
- Replace unsupported event mutation and remove dead routing/configuration state.
- Bound timers, state parsing, and persisted state writes.

If v2 cannot safely resume a failed turn through its supported API, document the
limitation and disable that behavior rather than retaining an unverified replay
mechanism.

### 3. Explorer Phase 1.1 safety stabilization

- Centralize lexical and canonical path checks.
- Refuse traversal, absolute paths, `.git`, outside-root symlinks, directories,
  invalid UTF-8, and unsafe restored paths.
- Canonicalize the project root once.
- Add disk fingerprints and explicit conflict handling.
- Save immutable snapshots, preserve mode bits, use exclusive unique temporary
  files, flush writes, and clean up safely.
- Scope discard guards to a tab/revision and check every dirty tab before panel
  close.
- Make external-editor reload conditional on a clean/safely-confirmed tab and a
  successful child result.
- Add generation guards for directory loads, search, reload, and highlighting.
- Flush pending path persistence during cleanup.

### 4. Harden the other v2 packages

Add lifecycle, failure, timeout, stale-result, permission, and cleanup tests for
Source Control, Codex Usage, Todo, and rig-tools before adding more Explorer
features.

### 5. Explorer Phases 2–7

- **Phase 2:** pinned checksum-verified parser fetch, ignored generated assets,
  provenance manifest, full approved language mapping, and large-file fallback.
- **Phase 3:** file find/replace, editing operations, undo/redo free of the host
  `ctrl+z` binding, active-line/bracket decorations, and complete mouse behavior.
- **Phase 4:** bounded cancellable `rg` search, exact result navigation, dry-run
  multi-file replace, confirmation, fingerprint revalidation, and rollback-safe
  atomic writes.
- **Phase 5:** exclusive create, guarded rename, trash-backed delete, reveal,
  collapse-all, Git status, per-file diff, and gutter markers.
- **Phase 6:** bounded formatter/diagnostic runner with project-detected defaults,
  per-project disable, output pane, and diagnostics extmarks.
- **Phase 7:** side-by-side editors, per-language indentation, OSC52 copy path/
  selection, prompt-context export, and persistent project layout. Folding is
  blocked unless OpenTUI exposes a safe non-destructive hidden-range primitive.

## Safety and operating rules

- Preserve v1 binaries, config, data, and processes.
- Track every multi-step resumed task with the `todo tool`; keep exactly one
  item in progress and mark items complete only after verification passes.
- Do not reset, checkout, or discard unrelated user changes.
- Do not silently overwrite files or delete data.
- All file operations require containment, `.git` refusal, confirmations where
  applicable, and preservation of originals.
- Parser assets are fetched by a pinned, checksum-verified setup path and are
  ignored by Git.
- Formatters and diagnostics are bounded, cancellable, and never block the TUI.
- Do not use shell interpolation for external commands.
- Do not capture or handle passwords, MFA, payment details, or OAuth dialogs.
- Do not merge or retarget any pull request without explicit approval.
- Use `run-bounded-command.sh` for resource-heavy checks.
- Do not ask the operator to run validation; verify through tools, tests,
  filesystem assertions, and screenshots when GUI evidence is required.

## Memory workflow

Basic Memory is the local `computer-assistant` project under
`~/Documents/computer-assistant/basic-memory/`.

- Before a phase: use `recent_activity`, then narrow `search_notes`/
  `build_context`/`read_note` for the Explorer project and relevant ADRs.
- During a phase: record only explicit durable decisions or newly verified
  gotchas; never store secrets or whole conversations.
- After a phase: edit the existing Explorer project note with status, evidence,
  retrospective, and next action; supersede obsolete observations instead of
  duplicating them.
- Memory capture is explicitly approved only; do not create automatic session
  summaries.
- No Basic Memory note was changed while creating this handoff.

## Verification gate for future work

Before declaring a change complete, run the relevant bounded package checks and
the repository gates:

```text
bash -n platforms/linux/ubuntu/computer-use/scripts/*.sh
shellcheck platforms/linux/ubuntu/computer-use/scripts/*.sh
python3 -m py_compile platforms/linux/ubuntu/computer-use/scripts/*.py
check-skill-docs.py
check-plugin-resource-guards.py
check-progress-tracking.py
check-doc-coverage.py
setup-opencode-v2.sh --verify-only
verify-opencode-v2.sh
deploy-plugins.sh --v2 --plugins all --verify-only
```

Run package checks for every changed package through the bounded wrapper. For
Explorer behavior, use disposable projects, assert disk contents and modes,
inspect screenshots autonomously, and remove every fixture, screenshot, and
temporary process afterward.

The role-catalog/deployment gate, Codex fallback API stabilization, and
Explorer Phase 1.1 safety gate are complete in the current worktree, but are
not committed. The next agent should review the combined diff and preserve the
separation from v1 and unrelated user work. Do not start parser Phase 2 until
explicitly approved.

## Complete implementation plan

This is the full ordered plan for the remaining work. Each stage is intended
to land as an independently reviewable commit or small commit series. A later
stage must not mask an earlier safety or runtime failure.

### Stage A — establish the work ledger and reconcile the baseline

1. Add repository-root `ROADMAP.md`.
   - Record the objective, current verified runtime, branch, and phase status.
   - Give every work item an ID, status, owner, dependencies, acceptance
     criteria, automated evidence, live evidence, documentation status, commit,
     and next action.
   - Keep the roadmap operational; keep architecture in
     `docs/plans/explorer-ide.md`; keep fresh-context transfer information in
     this file.
2. Reconcile the current documentation.
   - Correct stale v1-default and pre-cutover statements.
   - Correct stale pilot and removed-`assistant-memory.py` statements.
   - Add the missing v2 Codex Usage and File Manager component READMEs.
   - Rewrite the v2 Codex Fallback README for the v2 API, not the old 1.x API.
   - Add deep plugin references and update indexes/documentation mappings.
   - Keep `HANDOFF.md` current for environment-defining changes.
3. Add a canonical v2 plugin role catalog.
   - `rig-tools`: server
   - `rig-todo`: server and CLI
   - `codex-fallback`: server
   - `source-control`: CLI
   - `codex-usage`: CLI
   - `file-manager`: CLI
   - Include package path, role entrypoint, and expected configuration file.
4. Make deployment and verification consume the role model.
   - `all` must register both `rig-todo` roles.
   - `server` and `cli` must select their exact role sets.
   - Single-package deployment must register every role owned by that package.
   - Verify canonical real paths, role entrypoints, duplicate entries, and
     malformed entries.
5. Add deployment self-tests using temporary config directories.
   - verify-only on missing configs
   - apply from empty configs
   - idempotent apply
   - `all`, `server`, `cli`, and every individual package
   - dual-role Todo registration
   - duplicate and wrong-role entries
   - relative and non-canonical package paths
   - invalid JSON/JSONC handling
6. Close the rollback verification gap.
   - CI must check all five v1 packages, all six v2 packages, and custom tools.
   - Keep every typecheck and test command behind the adaptive bounded wrapper.
   - Resolve the v1 Source Control heap issue with a documented bounded
     compiler configuration such as `skipLibCheck`, while retaining strict
     checking for project source.

**Stage A gate:** documentation, role-catalog, deployment self-tests, all
package registrations, and all CI package checks agree; a fresh temporary
deployment cannot omit the Todo panel.

### Stage B — repair v2 plugin correctness before Explorer expansion

#### B1. Codex Fallback — complete in the current worktree; not committed

1. Build a fake-provider integration harness around the OpenCode 2.0.7 session
   API.
2. Test the supported `ctx.session.switchModel()` path and determine precisely
   how it interacts with `session.hook("retry")`.
3. Remove mutation of read-only `event.model`.
4. Prove these cases:
   - quota failure on the primary completes the same user turn on tier 1;
   - tier 1 failure advances once to tier 2;
   - a duplicate failure event does not duplicate a replay or switch;
   - a cooldown prevents reuse of the failed tier;
   - expiry or reported reset returns a new turn to the source model;
   - manual model selection is not treated as a plugin-generated route;
   - model variants survive switching where supported;
   - provider catalog failure fails open without taking down the session.
5. Remove or implement dead state and options: `routing`, unused agent model
   collection, ineffective notification behavior, and obsolete v1 hook logic.
6. Bound usage timers, catalog refresh, persisted state parsing, and state-file
   size. Keep state owner-only and atomic.

If the supported v2 API cannot safely resume a failed turn, the fallback must
fail closed for that behavior and document the limitation. Unsupported event
mutation is not an acceptable fallback implementation.

#### B2. Source Control

- Add refresh generation/context tokens so results from an old session or
  directory cannot overwrite current state.
- Scope `filesystem.changed` and `vcs.branch.updated` events to the active
  location where event metadata permits.
- Clear branch/remote/PR state on detached HEAD and context changes.
- Make manual refresh toasts reflect actual success or failure.
- Bound all configurable intervals and GitHub page sizes.
- Test local failure retention, stale result rejection, branch changes,
  detached HEAD, GitHub timeout, malformed MCP responses, and cleanup.

#### B3. Codex Usage

- Re-synchronize the active session model whenever the sidebar session changes.
- Use generation guards around message sync and usage refresh.
- Bound refresh intervals, timeout values, and timer scheduling.
- Preserve last-good values on network errors, but surface initial/auth errors.
- Test session switching, account switching, rate limiting, timeout, malformed
  responses, and disposal.

#### B4. Todo

- Create the mirror directory with owner-only permissions and ensure the file
  mode remains owner-only.
- Use unique exclusive temporary files, not only PID-based names.
- Cap todo count and content size before storage and mirroring.
- Guard polling against stale session reads and clean up timers/subscriptions.
- Test session deletion, corrupt mirrors, concurrent writes, permissions, and
  oversized input.

#### B5. rig-tools

- Serialize screenshot captures to avoid overlapping before/after directory
  snapshots.
- Require a regular file, stable path, valid PNG signature, and bounded size
  before reading.
- Report unlink failure instead of claiming successful deletion.
- Bound desktop traversal inputs at the TypeScript schema layer as well as in
  the Python script.
- Test timeout, max-buffer, malformed screenshot, multiple-new-file, and
  cleanup-failure paths.

**Stage B gate:** every plugin has lifecycle/failure tests, the fallback uses
only supported v2 routing behavior, and live tool/panel checks show no stale
cross-session state.

### Stage C — Explorer Phase 1.1 safety stabilization (complete in current worktree; not committed)

#### C1. Centralize path safety

- Canonicalize the project root once, including a symlinked root.
- Reject absolute paths, empty/invalid names, traversal segments, and every
  `.git` component after both lexical and canonical normalization.
- Reject symlinks that resolve outside the project or into `.git`.
- Reject directories, special files, invalid UTF-8, binary content, and files
  over the edit/read thresholds.
- Apply the same validation to tree entries, search results, restored tabs,
  save paths, external editor paths, and future file operations.

#### C2. Make saving race-safe

- Capture an immutable `{path, content, diskFingerprint, mode}` snapshot before
  each write.
- Write to an exclusive uniquely named temporary file in the destination
  directory.
- Preserve the original mode, flush the file where supported, atomically
  replace the destination, and clean up on every failure.
- Mark only the written snapshot as saved. If newer edits exist, retain them as
  dirty.
- Refuse or explicitly confirm a write when the disk fingerprint changed since
  the tab was opened or last saved.
- Never silently overwrite a changed disk file.

#### C3. Make dirty-state lifecycle complete

- Track dirty/discard confirmation by tab path plus content revision.
- Guard switching/reloading/refreshing an active or background dirty tab.
- Check every dirty tab before closing or unmounting the panel.
- Preserve the accepted paths-only persistence policy; do not persist unsaved
  content unless a new explicit decision approves it.
- Flush pending storage updates during cleanup.

#### C4. Fix external editing and asynchronous races

- Parse editor commands without unsafe shell interpolation, or use a bounded
  explicit command/argument configuration.
- Do not reload after spawn failure or non-successful exit.
- Require a clean tab or an explicit dirty-buffer decision before reloading.
- Add request generations to directory loads, disk reloads, search, and syntax
  highlighting so old asynchronous results cannot update new state.
- Keep search text input from receiving navigation keybindings intended for the
  result list.

#### C5. Add regression tests and live acceptance

- save while editing during an in-flight write
- external disk modification conflict
- mode preservation and temporary-file cleanup
- traversal and symlink-to-`.git` rejection
- dirty background tab on panel close
- editor spawn failure with dirty content
- stale search/highlight result rejection
- Unicode cursor/highlight offsets
- restored invalid paths

Use disposable projects only. Assert disk bytes, modes, and tab state directly;
use screenshots for the visible panel state; remove fixtures afterward.

**Stage C gate:** no known Phase 0/1 safety issue can lose unsaved content or
write outside the allowed project scope.

Evidence for the Stage C gate: the bounded file-manager check passed with 39
tests; repository shell/Python/documentation/deployment gates passed; the v2
health check passed; slash completion exposed `/explorer`, `/editor`, and
`/files`; and a live v2 client rendered the updated `Files` panel against the
isolated session. A disposable file retained its original disk bytes after an
unsaved edit attempt and all fixtures/processes created for that check were
removed. No v1 file, configuration, or process was changed.

### Stage D — Explorer Phase 2: language coverage

1. Add a pinned parser manifest containing, for every language, source URL or
   commit, version, SHA-256, expected size, aliases, filetype, license/SPDX
   metadata, and highlight-query source.
2. Implement a setup/deployment fetcher that:
   - downloads only pinned assets;
   - verifies checksum and size before installation;
   - writes into an ignored generated parser directory;
   - installs the manifest/assets atomically;
   - fails closed on mismatch;
   - never requires network access during normal verification.
3. Remove the Phase 0 `/tmp/opencode/parsers` dependency and environment
   override.
4. Cover the approved language set:
   JSON/JSONC, YAML, TOML, Bash/sh, Python, Go, Rust, SQL, HTML, CSS/SCSS,
   XML, C/C++, Java, Ruby, PHP, Lua, Dockerfile, INI, and diff, alongside the
   bundled JavaScript/TypeScript/Markdown/Zig parsers.
5. Map both extensions and basenames such as `Dockerfile`, `Makefile`, and
   shell/config filenames where the parser supports them.
6. Apply a highlight threshold below the edit-size threshold; large editable
   files must remain usable as plain text.
7. Test manifest integrity, missing assets, checksum mismatch, aliases,
   fallback-to-plain-text, large files, and Unicode highlight offsets.

**Stage D gate:** three or more representative languages are visibly
highlighted in the live Explorer, the asset manifest is reproducible and
verified, and no generated parser asset is tracked by Git.

### Stage E — Explorer Phase 3: editing power

- Add a pure `edit.ts` module for line and selection operations.
- Implement file find/replace with literal matching first and an explicitly
  bounded regex mode only if safe execution can be guaranteed.
- Implement indent/dedent, comment toggle, duplicate line, move line up/down,
  select all, word navigation, and safe deletion behavior.
- Add active-line and bracket-match decorations without corrupting the buffer.
- Bind undo/redo to free chords such as `alt+z` and `alt+shift+z`; never rely on
  host-owned `ctrl+z` while it remains `terminal.suspend`.
- Track per-tab cursor, selection, scroll, and edit/view state.
- Complete click-to-position with display-column handling for tabs, wide
  characters, and Unicode; add bounded wheel scrolling without breaking
  selection.
- Test every pure operation, selection boundary, empty buffer, Unicode case,
  and undo/redo binding.

**Stage E gate:** a keyboard-driven edit demo completes entirely inside the
Explorer, with a screenshot and pure tests for every editing operation.

### Stage F — Explorer Phase 4: project search and replace

1. Add a reusable bounded subprocess runner with:
   - argument arrays only;
   - timeout;
   - output and match caps;
   - cancellation and process-tree cleanup;
   - adaptive memory limit.
2. Use `rg --json` for content search. Parse only bounded match records and
   reject paths through the centralized safety layer.
3. Support case sensitivity and glob filters without shell expansion.
4. Navigate to exact file, line, and Unicode-correct column.
5. Build a multi-file replacement plan showing every old/new range and file.
6. Require dry-run preview and explicit confirmation.
7. Revalidate each file fingerprint before writing; refuse dirty/open conflicts
   unless explicitly resolved.
8. Write each file atomically with mode preservation and retain rollback copies
   until the complete operation succeeds.
9. Test malformed `rg` output, cancellation, timeout, output overflow, path
   containment, stale fingerprints, partial failure, and rollback.

**Stage F gate:** a repository search opens a result, and a replacement can be
previewed, confirmed, verified on disk, or safely cancelled without silent
partial changes.

### Stage G — Explorer Phase 5: file operations and Git

- Create files with exclusive creation; never overwrite an existing path.
- Create directories only after confirmation and safe-name validation.
- Rename only to a nonexistent destination; preserve the original if any step
  fails; refuse `.git`, traversal, symlink escapes, and cross-device surprises.
- Delete through bounded trash integration (`gio trash`) where available;
  never silently fall back to permanent deletion.
- Confirm every create, rename, and delete and show an old-to-new manifest.
- Add reveal-active-file, collapse-all, deterministic refresh, and selection
  restoration.
- Add Git status letters in the tree using the existing VCS client or bounded
  Git calls.
- Parse bounded `git diff --unified=0` output into gutter markers.
- Open a diff for the exact active file; do not assume the host's generic diff
  route can target the desired path.
- Test name/path validation, confirmation cancellation, trash failure, rename
  failure, Git parsing, untracked/renamed files, and stale refreshes.

**Stage G gate:** create/edit/rename/delete and Git gutter behavior work in a
disposable Git project, with originals preserved on every failure path.

### Stage H — Explorer Phase 6: external language services

1. Reuse the bounded subprocess runner.
2. Detect project-local formatter/linter configuration and choose defaults:
   - Prettier or Biome
   - Black or Ruff
   - rustfmt
   - gofmt
   - shfmt
   - TypeScript/ESLint
   - Ruff
   - ShellCheck
3. Run format-on-save only when a trusted project configuration is detected and
   the project setting is not disabled.
4. Format through stdin or a guarded temporary file before committing the save.
5. If formatting fails, retain the buffer and offer explicit save-without-format.
6. Run diagnostics after save with timeout, output caps, cancellation, and no UI
   blocking.
7. Parse diagnostics into an output pane and gutter extmarks with bounded
   message/path lengths.
8. Persist the per-project `auto`/`off` choice without modifying project config.
9. Test command detection, arguments, timeout, malformed output, nonzero exit,
   formatter failure, diagnostic mapping, and disposal.

**Stage H gate:** format and diagnostics demonstrations complete without a TUI
stall, and disabling the project feature prevents subprocess execution.

### Stage I — Explorer Phase 7: polish and deferred split view

- Add two independently focused editor panes using two textareas and explicit
  per-pane tab/view state.
- Add per-language indentation defaults and safe tab rendering.
- Add copy path and copy selection through OpenTUI OSC52 when supported.
- Add prompt-context export as copied, formatted text because v2 exposes no
  plugin API to inject host editor context.
- Persist project paths, active tabs, pane layout, and preferences, but not
  unsaved buffer contents under the current explicit persistence decision.
- Investigate folding only behind a feasibility gate. OpenTUI 0.5.11 currently
  exposes no safe hidden-range/folding primitive; do not emulate folding by
  destructively changing the edit buffer.

**Stage I gate:** side-by-side editing preserves independent cursors, tabs,
dirty state, and save guards; unsupported host capabilities remain documented
as blocked rather than simulated unsafely.

## Per-stage completion loop

For every implementation stage:

1. Read the current roadmap item and relevant Basic Memory notes.
2. Make the smallest bounded source change.
3. Add pure tests before or with behavior changes.
4. Run changed-package checks through `run-bounded-command.sh`.
5. Run repository shell, Python, resource, progress, documentation, setup, and
   v2 health gates relevant to the change.
6. Perform live verification in a disposable project or fake-provider harness.
7. Capture visual evidence only when UI behavior is part of acceptance; never
   retain screenshots.
8. Update component docs, deep docs, `ROADMAP.md`, and the approved Basic
   Memory project/ADR notes. Replace obsolete facts instead of duplicating
   them.
9. Assert the filesystem and runtime post-state directly.
10. Ensure temporary files, processes, fixtures, and screenshots are removed and
    the repository remains clean.
11. Commit and push the independently reviewable change to the working branch.
    Do not merge or retarget a pull request without explicit approval.
