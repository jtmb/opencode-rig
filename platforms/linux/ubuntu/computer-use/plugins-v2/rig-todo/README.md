# `rig-todo` v2 server plugin

OpenCode v2 (2.0.7) ships no `todowrite`/`todoread` tool, but the harness's
progress-tracking rule requires one. This package restores the pair as a server
plugin.

## Tools

- `todowrite` — replaces the session todo list with the supplied list and
  returns a markdown summary. The complete list is sent on every call. At most
  one item may be `in_progress`; extra `in_progress` items are demoted to
  `pending`.
- `todoread` — returns the current session list.

Items are `{ content, status, priority? }` with
`status: pending | in_progress | completed | cancelled` and
`priority?: high | medium | low`.

## State

Lists are stored through `ctx.storage` under `todos/<sessionID>` and are removed
when the session is deleted. v2 has no built-in todo panel, so the list is
model-facing only; a sidebar panel is a possible future addition.

## Registration

Register the package in the server `plugins` array in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    { "package": "/abs/path/to/plugins-v2/rig-todo", "options": {} }
  ]
}
```

The package has a root `server.ts` shim and resolves `@opencode/plugin` from the
shared `plugins-v2/node_modules`.

## Checks

```bash
npm run check
```

`src/store.ts` holds the pure normalization, invariant, and summary logic;
`test/store.test.ts` covers it.
