# `rig-todo` v2 plugin

OpenCode v2 (2.0.7) ships no `todowrite`/`todoread` tool, but the harness's
progress-tracking rule requires one. This package restores the pair as a server
plugin, adds a retained-history sidebar panel, and provides a fullscreen `/tasks`
Kanban.

## Tools (server)

- `todowrite` — replaces the session todo list with the supplied list and
  returns a markdown summary. The complete list is sent on every call. At most
  one item may be `in_progress`; extra `in_progress` items are demoted to
  `pending`. Every list change is also appended to the durable archive.
- `todoread` — returns the current session list.
- `todo_history` — read-only, paged history query. `view: "todos"` returns the
  latest recorded state per item; `view: "events"` returns raw transition
  records. Filters: `text`, `status`, `kind`, `from`/`to`, `page`, `limit`
  (max 50), and for events a `beforeSeq` continuation cursor. Scoped to the
  invoking session.

Items are `{ content, status, priority? }` with
`status: pending | in_progress | completed | cancelled` and
`priority?: high | medium | low`.

## Panel (CLI)

`tui.tsx` contributes a panel after `sidebar.content` with a `- Todo n/m` header
and the item list using fixed-width markers (`[x]` completed, `[~]` in
progress, `[ ]` pending, `[-]` cancelled), matching the tool summary format.
The outside-slot placement keeps Todo visible when the content slot is replaced.
Clicking the header collapses or expands it. The panel hides itself when the
list is empty.

The server plugin mirrors the authoritative `ctx.storage` entry into a small
JSON file at
`${XDG_DATA_HOME:-~/.local/share}/opencode/rig-todo/<sessionID>.json`
(atomically written; removed with the session). Both processes share the launch
environment, so the CLI panel can read it without an RPC channel. Corrupt or
missing files render as an empty list.

### Durable archive

`src/archive.ts` keeps an append-only transition log beside that mirror at
`${XDG_DATA_HOME:-~/.local/share}/opencode/rig-todo/archive/`:

- Every accepted transition is recorded once, keyed by a stable per-item id.
  Identity comes from `src/identity.ts`, not the task text: matching first binds
  every exact-text occurrence (duplicates included), then reuses the id at the
  same slot for an in-place content edit, then assigns fresh ordinals. Inserting
  or reordering items therefore keeps unchanged items' ids. A content-only edit
  is a `content_changed` event, a status change is `status_changed`, a
  priority-only change (including removal) is `priority_changed`, and a dropped
  item is `removed`. History is never pruned or overwritten.
- A replacement is **accepted only after its transitions are durably appended**.
  If the archive write fails, `todowrite` refuses the replacement, reports the
  failure, and leaves the previous list unchanged. Per-session writes are
  serialized so a concurrent call cannot read a stale list and drop a
  transition.
- The log rotates into bounded segment files; a single batch is split by
  serialized UTF-8 byte size (`ARCHIVE_SEGMENT_BYTES`) and event count
  (`ARCHIVE_SEGMENT_EVENTS`), so a segment file never exceeds what readers scan.
  An event larger than `ARCHIVE_MAX_EVENT_BYTES` is rejected before anything is
  written.
- Reads are bounded: a page walks the newest segments only, stops at `maxScan`
  parsed transitions, and reports `truncated`. Segments wholly newer than a
  `beforeSeq` cursor are skipped without a file read, and the cursor is derived
  from the last scanned event, so even a filtered page with zero matches can
  continue to older matches. The materialized "latest per item" view reports
  when its scan was bounded instead of implying completeness.
- A corrupt or stale manifest is rebuilt from the immutable segments before it
  is reused, so a failed manifest write (an unlisted rotated segment or a
  `nextSeq` behind the on-disk tail) cannot reuse a sequence number or hide a
  tail. Malformed lines are skipped, never thrown. Deleting a session removes
  only its `ctx.storage` entry, its identity map, and the sidebar mirror; the
  archive survives, so a deleted or compacted session keeps its full history.

**Partial-write limit:** the archive and `ctx.storage` cannot be committed
atomically. Because the archive is written first, an accepted transition is
never silently lost; a crash between the archive append and the list/identity
write can instead over-record a transition for a list that was not accepted,
and a stale identity map can reassign ids on the next write. Those cases are
documented, not hidden.

The panel's `history` control (shown when completed history exists) opens an
opt-in, paged archive view. Every archived row wraps its complete task text —
no row is ellipsized — and the default current-work view is unchanged.

### Fullscreen `/tasks` board

Run `/tasks` to open a dedicated session panel with four status columns:
In Progress, To Do, Completed, and Cancelled. At widths below 112 columns the
board shows one selected column at a time; left/right switches columns and
up/down moves the selection. Wider panels show all columns together. The board
refreshes current tasks every second and follows the active theme.

Choose **History** or press `h` to browse retained latest-state rows, including
completed, cancelled, and removed tasks. Each page shows eight items with the
newest updates first; `n`/right moves older and `p`/left moves newer. Reads scan
at most 5,000 transitions and state when that bound is reached. Press `r` to
refresh, `f` to toggle panel size, and `Esc` to close.

**Mouse:** the panel's collapse toggle is clickable, which requires terminal
mouse capture (`"mouse": true` in `cli.json`). On a fresh setup, restart
OpenCode after enabling the setting.

## Registration

Register the package in **both** places:

```jsonc
// opencode.jsonc (server tools)
{ "plugins": [{ "package": "/abs/path/to/plugins-v2/rig-todo", "options": {} }] }
```

```jsonc
// cli.json (sidebar panel)
{ "plugins": [{ "package": "/abs/path/to/plugins-v2/rig-todo", "options": {} }] }
```

The loader resolves the root `server.ts` shim for the server role and `tui.tsx`
for the CLI role, so one package directory serves both.

## Checks

```bash
npm run check
```

`src/store.ts` holds the pure normalization, invariant, and summary logic;
`src/state.ts` holds the mirror path, serialization, and parsing logic;
`src/identity.ts` holds stable per-item id assignment; `src/archive.ts` holds
the durable append-only transition store and its paged queries;
`src/recording.ts` holds the fail-closed, per-session-serialized write path.
`test/store.test.ts`, `test/state.test.ts`, `test/identity.test.ts`,
`test/recording.test.ts`, and `test/archive.test.ts` cover them.
`test/tui.test.ts` and `test/rendered-fixture.ts` cover the panel, including the
opt-in history view. `test/tasks.test.ts`, `test/commands.test.ts`, and
`test/tasks-rendered.test.ts` cover the fullscreen board, `/tasks` command,
history paging, keyboard interactions, and narrow/wide layouts.
The native fullscreen renderer test runs on Node 26.4+ or Bun 1.3+; older Node
versions skip that rendered assertion.
