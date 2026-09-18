# `file-manager` TUI plugin

`file-manager` adds an `Explorer` row to the OpenCode session sidebar and a
full-screen `files` view with a lazy, ignore-aware project tree, quick-open
search, a syntax-highlighted viewer, and an in-TUI editor with explicit atomic
saves.

## Registration

Register the source entry in the user-owned `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/file-manager/src/tui.tsx",
      { "order": 60 }
    ]
  ]
}
```

Or use the repository deployment script:

```bash
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --scope global --plugins file-manager --verify-only
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh \
  --scope global --plugins file-manager --apply
```

Restart OpenCode after changing the registration or plugin source.

## Opening the view

- The `Explorer` row in the sidebar (order `60`, below Source Control).
- `/files` or the command palette entry `Open file manager`.
- The `Ctrl+Shift+E` keybind (a plugin default; it may collide with another
  binding, in which case use the row or `/files`).

## Keys

| Context | Keys | Action |
|---------|------|--------|
| Tree | `↑`/`↓` or `k`/`j` | Move the selection |
| Tree | `Enter` | Open a file, or expand/collapse a directory |
| Tree | `→`/`l`, `←`/`h` | Expand, or collapse/go to parent |
| Tree | `e` | Open the selected file in the editor |
| Tree | `o` | Open the selected file in `$EDITOR`/`$VISUAL` |
| Tree | `/` or `Ctrl+P` | Quick-open search |
| Tree | `r` | Refresh the loaded directories and the open file |
| View | `e`/`i` | Edit the open file |
| View | `o` | Open in an external editor |
| Edit | `Ctrl+S` | Save atomically |
| Edit | `Esc` | Return to view (press twice to discard unsaved changes) |
| Search | type, `↑`/`↓`, `Enter`, `Esc` | Search, move, open, cancel |
| Any | `Esc` | Back one level; from the tree it closes the view |

## Safety

- Reads and saves use `node:fs`, so every path is resolved with `realpath` and
  must stay under the project worktree; `.git/**` and symlink escapes are
  refused.
- Files above 512 KiB and binary files open read-only.
- Saves happen only on an explicit `Ctrl+S` and write through a temporary file
  plus `rename`.
- The external editor suspends the renderer while it runs and reloads the file
  afterwards.
- The tree hides gitignored entries and loads one directory at a time through
  `client.file.list`.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `order` | `60` | Sidebar order for the `Explorer` row when no kv override exists. |

## Checks

```bash
npm install
npm run check
```

`src/model.ts` is the pure model (path containment, protected paths, tree
flattening, filetype mapping, dirty/binary/size guards, quick-open
normalization) and is covered by `node:test`. The route, tree, viewer, editor,
and saves are verified live after a restart.
