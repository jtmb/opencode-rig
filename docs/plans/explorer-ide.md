# Plan: Explorer as a full IDE editor

Status: Phase 0, Phase 1, and Phase 1.1 are implemented in the current
worktree; Phases 2–7 remain proposed. Owner: operator + assistant.
Repository copy of the plan (the Plan-mode original lives in
`~/.opencode/plan/`). Tracking note: `projects/opencode-rig/explorer-ide` in
the `computer-assistant` Basic Memory project. Decisions are recorded as
`decisions/adr-*` notes (see "Memory loop"). Phase 1.1 safety evidence and the
remaining release gates are recorded below and in `HANDOFF.md`; parser Phase 2
work has not started.

## Goal

Turn `plugins-v2/file-manager` (the docked **Explorer** panel) from a tree +
read-only viewer + plain editor into a real TUI IDE: multi-tab editing, syntax
highlighting across the common language set, project search and replace, file
operations, git integration, and external language services — without leaving
the OpenCode v2 TUI.

Explicitly not "another diff viewer": the diff route stays for reviewing
changes, while the Explorer becomes the place where files are actually read,
edited, created, and navigated.

## Constraints and non-goals

- **Plugin API is 2.0.7 and pre-stable.** Everything must be pinned to
  `@opencode/plugin` / `@opentui/*` 2.0.7 / 0.5.11 and re-tested on upgrade.
- **No LSP / diagnostics / formatter / editor-context API is exposed to
  plugins.** Verified by inspecting `@opencode/plugin` type definitions and the
  2.0.7 binary. Missing IDE services will be provided by bounded external
  subprocesses (opt-in), not live language servers.
- **No built-in editor route.** The host has `prompt.editor` (external editor)
  and an internal "active editor file or selection" prompt-context feature, but
  plugins cannot read or set either. The Explorer owns its editor.
- **No multi-cursor, no true split panes, no embedded terminal** in this plan
  (side-by-side is a later optional phase; multi-cursor is not offered by
  `TextareaRenderable`).
- **Saving uses `node:fs`** (the server file API is read-only). Containment,
  `.git` refusal, atomic writes, binary/large guards stay.
- **Never auto-save.** Dirty state, discard guards, and confirmations remain.
- **Mouse click handlers must not fight OpenTUI's selection system.** Terminal
  mouse capture (`"mouse": true`) is required and is already enabled.

## Research findings (evidence)

### OpenTUI editor primitives (0.5.11, installed)

`TextareaRenderable` (editable, used today) supports:

- `syntaxStyle` highlighting inside the editable buffer, plus `wrapMode`,
  selection/cursor colors, cursor styles, `tabIndicator`.
- Full programmatic editing/movement API: `setCursor`, `moveCursor*`,
  `gotoLine*`, `setSelection`, `selectAll`, `clearSelection`,
  `deleteSelection`, `insertChar/Text`, `delete*`, `undo()`, `redo()`.
- `onContentChange`, `onCursorChange`, `plainText`, `logicalCursor`,
  `visualCursor`, `cursorOffset`, `extmarks` (decorations), `traits`
  (`capture: escape|navigate|submit|tab`, `status`) for key ownership.
- Custom `keyBindings`/`keyAliasMap`.

**Phase 0 correction:** the editable buffer has no tree-sitter filetype hook in
0.5.11. `syntaxStyle` alone does not parse; the editor must compute highlights
with `getTreeSitterClient().highlightOnce(content, filetype)` and apply them via
`clearAllHighlights()` + `addHighlightByCharRange()`. The read-only `Code`
renderable does this internally through its `filetype` prop.

Available companion renderables: `CodeRenderable` (read-only highlighted code),
`LineNumberRenderable` (already used as `<line_number>`), `DiffRenderable`,
`TabSelectRenderable`, `SelectRenderable`, `ScrollBoxRenderable`,
`InputRenderable`, plus extmarks for gutter-style decorations.

Docs: <https://opentui.com/docs/components/textarea>,
<https://opentui.com/docs/components/code>,
<https://opentui.com/docs/components/line-number>,
<https://opentui.com/docs/reference/tree-sitter>.

### Syntax highlighting coverage

- Bundled tree-sitter parsers are only **javascript, typescript, markdown
  (+inline/injections), zig** (`@opentui/core/assets/`).
- `addDefaultParsers()` / `TreeSitterClient.addFiletypeParser()` accept extra
  descriptors `{ filetype, aliases?, wasm, queries: { highlights, injections? } }`
  with **local asset paths** (or URLs at build time). The docs document a
  build-time `update-tree-sitter-assets.ts` pattern with pinned releases.
- Therefore "highlight everything" is feasible by vendoring pinned
  `tree-sitter-<lang>.wasm` + `highlights.scm` files and registering them at
  plugin setup. Phase 0 must confirm path resolution from a plugin package.

### Host / plugin integration facts

- `context.file` (read-only list/find), `context.client.vcs`, `context.data.*`,
  `context.ui.{slot,panel,router,dialog,toast,tabs,keymap,storage,theme,renderer}`.
- Plugins can spawn processes (the current external-editor action does), which
  enables `rg`, `git`, formatters, and linters.
- Keymap layers must be registered inside `append: "app"` slot renders
  (2.0.7 behavior), as the current plugins do.
- Mouse: row hit-testing can land on the container or a text child and events
  bubble; the once-per-event guard pattern is now in place.

### Basic Memory (installed 0.23.2, bounded MCP)

- Supports markdown notes with `observations`/`relations`, semantic + metadata
  search, `build_context` graph traversal, `edit_note` incremental updates, and
  a schema system for consistent note types.
- Recommended practice (official docs): search before writing/answering,
  capture decisions as they happen, edit rather than duplicate, keep notes
  linked, and put standing instructions in `AGENTS.md`/skills.
- ADR pattern: a schema note (`status`, `context`, `decision`, `consequences`,
  `supersedes`) satisfied by observations; validate with `schema validate`.
- Harness capture (session hooks / summaries) is an established pattern we can
  mirror later with an OpenCode server-plugin hook.
- Docs: <https://docs.basicmemory.com/raw/how-to/project-documentation.md>,
  <https://docs.basicmemory.com/raw/reference/ai-assistant-guide.md>,
  <https://docs.basicmemory.com/raw/integrations/claude-code.md>.

## Architecture

Keep the single `plugins-v2/file-manager` package (docked `session.panel`) and
grow it in layers with pure, testable models:

```
file-manager/
  src/
    tui.tsx        panel layout: tab strip, tree, editor/preview, status bar, output
    model.ts       tree/filetype/path/containment (existing, extended)
    mouse.ts       once-per-click activation (existing)
    tabs.ts        open-tab model: content, original, dirty, active path, closed stack
    edit.ts        indent/dedent/comment/duplicate/move-line, find/replace, go-to-line
    search.ts      project content search (rg) parsing + replace planning
    git.ts         status letters + `git diff --unified=0` gutter computation
    tools.ts       bounded external subprocess runner (format, diagnostics)
    parsers.ts     generated manifest + addDefaultParsers registration
  parsers/         vendored wasm + highlights.scm + provenance (generated)
  scripts/         fetch/generate parser assets (pinned, checksum-verified)
  test/            node --test for every pure module
```

- **Tab strip** above the editor; tree stays left (resizable width); status bar
  at the bottom shows path, dirty marker, `L:C`, filetype, and diagnostics
  count. An output/diagnostics pane toggles under the editor.
- **Editor** = `TextareaRenderable` with theme-derived `SyntaxStyle`, line
  numbers, active-line highlight, bracket match, and gutter extmarks
  (git/diagnostics). Read-only preview = `CodeRenderable`.
- **Persistence** via `context.storage.store`: open tabs, active tab, editor
  preferences (tab size, wrap, format-on-save, diagnostics-on-save).
- **Settings** are panel-local (host `/settings` remains for host options).

## Phases

Each phase is a bounded change: pure tests + bounded package checks + live
keyboard verification (via the `desktop_input` tool) + screenshots + docs gate
+ a memory ADR/status update. Phases land separately.

### Phase 0 — spikes (DONE 2026-09-18)

1. **Parser registration works.** `client.addFiletypeParser({ filetype, wasm,
   queries: { highlights } })` after `client.initialize()` registers a parser
   with the host's shared client; the read-only viewer then highlights JSON
   through its `Code` renderable. Spike assets came from
   `/tmp/opencode/parsers/json/` (tree-sitter-json v0.24.8; wasm sha256
   `d2119fb9…`, highlights sha256 `05115244…`); Phase 2 replaces this with the
   pinned fetch script and generated manifest.
2. **Editor highlighting works via a manual pipeline.** On open/edit,
   `highlightOnce(buffer.getText(), filetype)` returns `[start, end, capture]`
   tuples; the editor clears and re-applies them as `addHighlightByCharRange`
   ranges, resolving captures with a dotted-name fallback
   (`string.special.key` → `string` → `default`). Re-highlight is debounced
   (120 ms) on content change, and a missing parser falls back to plain text.
3. **Key ownership works, with one conflict.** Typing inserts text (no command
   interception), Backspace/Escape behave, and highlighting survives edits.
   **Gotcha:** `ctrl+z` is the host's `terminal.suspend` binding and suspended
   the TUI instead of undoing. Phase 3 must bind editor undo/redo to free
   chords (for example `alt+z`/`alt+shift+z`) or override that host binding.
4. **Mouse:** ydotool cannot drive the GNOME pointer on this machine, so
   click-to-position/selection in the editor still needs the operator's manual
   check.
5. **Files:** `src/parsers.ts` and the editor highlight pipeline in
   `src/tui.tsx` land as the Phase 2/3 foundation, with `.json`/`.jsonc` added
   to `filetypeFor`. Evidence: highlighted viewer and editor screenshots; no
   writes to tracked files (the test edit was discarded).

### Phase 1 — editor core (DONE 2026-09-18)

- `tabs.ts` model: open/activate/replace/close/reopen, dirty baselines,
  closed-path stack, safe persistence serialization, and malformed-state
  filtering.
- Tab strip + `alt+left`/`alt+right` switching; `ctrl+s` save,
  `ctrl+shift+s` save-all, `alt+w` close with a two-step discard guard, and
  `alt+t` reopen closed; dirty indicators remain visible in the strip/status.
- Status bar shows path, dirty state, `L:C`, and filetype; `ctrl+g` opens a
  bounded go-to-line dialog.
- Persist open paths and active path per session through `context.storage`;
  restoration reloads files safely and refresh uses a replace path so clean
  tabs actually reflect disk changes.
- Editor click-to-position now maps primary-button coordinates to bounded
  logical rows/columns; the pure mapping has unit coverage. This machine's
  ydotool virtual pointer did not produce observable GNOME clicks, so physical
  pointer delivery remains an environment limitation rather than an untested
  code path.
- Tests: 27 file-manager tests pass. Live verification covered two-file
  editing, tab switching, save, save-all, dirty-close/discard preservation,
  reopen, persistence, go-to-line, JSON highlighting, and tree refresh using
  temporary files; tracked files are clean.

Exit criteria met: two temporary files were edited and saved, another dirty
edit was discard-guarded without changing disk content, and the tab strip and
status bar were verified in screenshots.

### Phase 1.1 — safety stabilization (DONE in the current worktree)

- `src/safety.ts` now canonicalizes the project root once and centralizes
  lexical/canonical containment, `.git` and symlink checks, regular-file,
  binary, UTF-8, and size validation for tree entries, search results, restored
  paths, reads, saves, and external-editor targets.
- Saves capture `{ path, content, diskFingerprint, mode, revision }`, refuse
  stale disk fingerprints, use unique exclusive temporary files, flush and
  atomically replace the destination, preserve mode bits, and clean up every
  temporary file. Tab metadata updates even when newer edits remain dirty.
- Dirty guards include path and revision for tab switching, reload/refresh,
  discard, reopen, and panel close. Paths-only persistence remains unchanged;
  unsaved content is never written to storage.
- External editor commands are bounded and parsed without a shell. A spawn
  failure or non-zero exit leaves the current tab untouched.
- Directory, file, search, and highlight requests use generation tokens. The
  search input no longer consumes `j`/`k` as result navigation; result movement
  uses explicit Alt+arrow bindings.
- Tests: 39 file-manager tests pass, including disposable-project path,
  symlink, `.git`, UTF-8, binary, size, atomic-save, mode, conflict, revision,
  dirty-guard, command-parser, and stale-generation regressions.

The v2 command layer opens the panel with `/explorer`, `/editor`, `/files`, or
`Ctrl+Shift+E`. The v1 stack and its configuration remain rollback-only.

### Phase 2 — language coverage (1 day + asset build)

- Build script `scripts/fetch-parsers` (pinned versions, SHA-256 verified,
  provenance files) generating `src/parsers.ts` + `parsers/`; assets are
  fetched at setup, not committed (operator decision 5).
- Target languages (decided): json/jsonc, yaml, toml, bash/sh, python, go,
  rust, sql, html, css/scss, xml, c/cpp, java, ruby, php, lua, dockerfile, ini,
  diff; js/ts/markdown/zig are already bundled.
- Extend `filetypeFor` mapping (extension + basename such as `Dockerfile`).
- Large-file policy: highlight only under a threshold; plain text above it.
- Tests: mapping, manifest integrity, fallback.
- Exit: screenshots of 3+ languages highlighted; assets documented + pinned.

### Phase 3 — editing power (1–2 days)

- File-level find/replace (regex optional), incremental highlight of matches.
- Indent/dedent, comment toggle, duplicate line, move line up/down.
- Select-all/word navigation, bracket matching, active-line highlight.
- Mouse click-to-position and wheel scroll (respect selection).
- Tests: pure edit operations + find/replace planning.
- Exit: keyboard-driven demo + screenshot.

### Phase 4 — project search and replace (1 day)

- `rg`-backed content search with a results list, jump-to-result, and
  case/glob filters; bounded, cancellable.
- Multi-file replace: preview manifest (old→new), explicit confirmation,
  atomic per-file writes, and a dry-run mode.
- Tests: rg output parsing, replace planning, containment.
- Exit: search the repo, open a hit, preview a replace; screenshot.

### Phase 5 — file operations + git (1 day)

- Create file/folder, rename, delete (confirmations; refuse `.git`; preserve
  originals on rename failure), reveal active file, collapse-all, refresh.
- Git: status letters in the tree (existing vcs client), gutter markers from
  `git diff --unified=0`, "open diff for this file" dispatch.
- Tests: path/name validation, rename/delete planning, diff parsing.
- Exit: create/edit/rename/delete in a temp project + gutter screenshot.

### Phase 6 — external language services (1–2 days)

- Bounded subprocess runner (timeout, output cap, cancellation, no shell
  interpolation) reused by formatters and linters.
- Project-detected defaults (operator decision 2): format-on-save when a
  formatter is detected (prettier/biome/black/rustfmt/gofmt/shfmt) and
  diagnostics-on-save when a linter is detected (tsc/eslint/ruff/shellcheck),
  with a per-project disable in editor settings. Results appear in the output
  pane and as gutter extmarks.
- Tests: command selection, output parsing, failure/timeout handling.
- Exit: format + diagnostics demo; screenshot; no UI stalls.

### Phase 7 — polish (later; side-by-side confirmed in scope)

- Side-by-side editors (two textareas), per-language indent defaults,
  code folding (tree-sitter query), "copy path/selection", prompt-context
  export, and a persistent project session.

## Memory loop: decisions and continuous improvement

This is part of the deliverable, not an afterthought. The `computer-assistant`
Basic Memory project is the durable record for this work.

### Note taxonomy

- `projects/opencode-rig/explorer-ide` — living project note: goal, phase
  roadmap with status, current state, next action, acceptance evidence, open
  questions. Updated (`edit_note`) at every phase boundary.
- `decisions/adr-<slug>` — one Architecture Decision Record per significant
  choice (schema: `status`, `context`, `decision`, `consequences`,
  `supersedes`), linked to the project note.
- `gotchas/<slug>` — host/API limits and workarounds (keymap layer placement,
  mouse capture, parser path resolution, textarea traits).
- `feedback/<date>-<topic>` — operator UX feedback captured nearly verbatim,
  linked to the decision/project note (e.g. "explorer must not be a diff").

### Per-phase workflow

1. **Before:** `recent_activity` + `search_notes` and `build_context` on the
   project note and open ADRs; do not re-decide settled questions.
2. **During:** record each design choice as an ADR as it is made; add a
   `gotchas` note when an API limit is discovered; capture operator feedback
   when given.
3. **After:** `edit_note` the project note with phase status, what shipped,
   acceptance evidence, and the next action; supersede any ADR the phase
   invalidates.

### Continuous improvement

- Phase retrospectives as observations on the project note ("what worked / what
  to change"), reviewed at the next session start.
- ADR statuses (`proposed`/`accepted`/`superseded`) are searchable metadata;
  keep stale ADRs superseded rather than deleted.
- Define and validate schemas once (`bm schema validate adr`) so every record
  is consistent; the schema note itself lives in the knowledge base.
- Standing instructions: extend `AGENTS.md` and the `task-memory` skill with
  the read-before/record-after discipline and a `references/decision-records.md`
  template; the skill already keeps the no-secrets and ask-before-deleting rules.
- Future: a server-plugin session-idle hook that drafts a summary note for
  review is explicitly **not** adopted (operator decision 6); memory capture is
  strictly explicit.

## Verification and documentation

- Every phase: `npm --prefix .../file-manager run check` through the bounded
  wrapper; repository gates (shellcheck for new scripts, py_compile, doc
  coverage change-aware, progress tracking, resource guards, setup checks);
  `git diff --check`.
- Live verification: drive the panel with `desktop_input` key chords, verify the
  filesystem with `read`/`diff` in a **temp project**, screenshot with
  `vision_capture`, then clean up.
- Docs: update `plugins-v2/file-manager/README.md`, `plugins-v2/README.md`,
  `docs/plugins/README.md`, the component README, `docs/memory.md` (if the
  memory workflow changes), `documentation-map.json` if new sources appear, and
  `HANDOFF.md` (handoff rule). New scripts need `docs/scripts/<stem>.md`.

## Risks

- **Pre-stable APIs** (2.0.7): textarea/extmark/traits shapes can change →
  pin exactly, isolate behind small modules, keep fallbacks, re-test on upgrade.
- **Parser assets**: licensing (mostly MIT), size, and path resolution in the
  worker → Phase 0 spike, provenance + checksums, size caps; fallback to the
  bundled four languages plus plain text.
- **Performance**: large files/repos → highlight thresholds, lazy tree loads,
  cancellable `rg`, bounded subprocesses.
- **Key conflicts** with the host and prompt editor → traits + keymap layers,
  Phase 0 verification.
- **File safety**: atomic saves, dirty/discard guards, confirmations, dry-run
  bulk replace, never auto-save, never touch `.git` or outside the worktree.
- **Scope creep**: phases are independently shippable and clearly optional.

## Operator decisions (2026-09-18)

1. **Parsers:** the full language list — json/jsonc, yaml, toml, bash/sh,
   python, go, rust, sql, html, css/scss, xml, c/cpp, java, ruby, php, lua,
   dockerfile, ini, diff, plus the bundled js/ts/markdown/zig.
2. **Format/diagnostics:** project-detected default — run automatically when a
   formatter/linter config is found, with a per-project disable. Still bounded,
   cancellable, and never blocking the UI.
3. **File operations:** create, rename, and delete are in scope, guarded by
   confirmations, `.git` refusal, and no silent overwrites.
4. **Side-by-side editors:** in scope for Phase 7 after the single editor
   lands.
5. **Parser assets:** fetched by a pinned, checksum-verified script and
   generated into the package; assets are not committed to Git.
6. **Memory capture:** strictly explicit; no automatic summary notes.
