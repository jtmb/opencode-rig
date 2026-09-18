# `rig-todo` v2 plugin

OpenCode v2 (2.0.7) ships no `todowrite`/`todoread` tool, but the harness's
progress-tracking rule requires one. This package restores the pair as a server
plugin and adds a sidebar panel so the list is visible while working.

## Tools (server)

- `todowrite` — replaces the session todo list with the supplied list and
  returns a markdown summary. The complete list is sent on every call. At most
  one item may be `in_progress`; extra `in_progress` items are demoted to
  `pending`.
- `todoread` — returns the current session list.

Items are `{ content, status, priority? }` with
`status: pending | in_progress | completed | cancelled` and
`priority?: high | medium | low`.

## Panel (CLI)

`tui.tsx` contributes a `sidebar.content` panel with a `- Todo n/m` header and
the item list (`✔` completed, `◐` in progress, `○` pending, `✕` cancelled).
Clicking the header collapses or expands it. The panel hides itself when the
list is empty.

The server plugin mirrors the authoritative `ctx.storage` entry into a small
JSON file at
`${XDG_DATA_HOME:-~/.local/share}/opencode/rig-todo/<sessionID>.json`
(atomically written; removed with the session). Both processes share the launch
environment, so the CLI panel can read it without an RPC channel. Corrupt or
missing files render as an empty list.

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
`test/store.test.ts` and `test/state.test.ts` cover them.
