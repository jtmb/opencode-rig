# `file-manager`

`file-manager` is a local OpenCode TUI plugin that adds a full-screen `files`
view and an `Explorer` sidebar row. It provides a lazy, ignore-aware project
tree, quick-open search over the project index, a syntax-highlighted read-only
viewer, and an in-TUI editor with explicit atomic saves.

## Registration and placement

The plugin is registered in the user-owned `~/.config/opencode/tui.json`, or in
a project's `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/file-manager/src/tui.tsx",
      { "order": 60 }
    ]
  ]
}
```

`deploy-plugins.sh --plugins file-manager` writes the equivalent tuple without
disturbing existing entries. TUI plugins load at startup, so OpenCode must
restart after registration or source changes.

The `Explorer` row registers in the additive `sidebar_content` slot at order
`60`, below Source Control (`50`) and above the built-in context panel (`100`).
The row, `/files`, the palette command `Open file manager`, and the
`Ctrl+Shift+E` keybind all navigate to the `files` route. The route renders as
an absolutely positioned `100% x 100%` overlay at `zIndex 2500`, the same
full-screen pattern as the built-in diff viewer.

The route receives the originating `sessionID` as a param so it resolves the
session directory with `api.state.session.get(id)?.directory`, falling back to
`api.state.path.directory`. The containment root is `api.state.path.worktree`.

## Tree and quick-open

The tree starts at the project root and loads one directory at a time through
`client.file.list({ directory, path })`. That endpoint returns direct children
with `name`, `path`, `absolute`, `type`, and an `ignored` flag derived from the
root `.gitignore`/`.ignore`; the plugin hides ignored entries. Expanded
directories are cached in a map and flattened for rendering, so only visible
rows are drawn.

Quick-open debounces input by 150 ms and calls
`client.find.files({ query, type: "file", limit: 200 })`, which is ignore-aware
and index-backed. Results are normalized, deduplicated, and stripped of `.git`
paths.

`file.watcher.updated` refreshes the loaded directories. If the event matches
the open file, the plugin reloads it when it is clean and warns instead of
clobbering unsaved edits when it is dirty.

## Viewer and editor

The viewer renders the file through `<line_number><code/></line_number>`. The
`code` renderable highlights using the bundled tree-sitter grammars for
JavaScript/TypeScript/TSX, Markdown, and Zig; other filetypes fall back to plain
text. A `SyntaxStyle` is built from the active theme's syntax colors.

Pressing `e`/`i` switches to the editor, a `<textarea>` wrapped in
`<line_number>`. Edits are tracked through `onContentChange`; the buffer is read
back with `editBuffer.getText()` at save time. `Ctrl+S` writes atomically: a
temporary file in the same directory followed by `rename`. `Esc` returns to the
view; when the buffer is dirty the first `Esc` warns and the second discards.

## Path containment and limits

Every read and save resolves the candidate with `realpath` and requires it to
remain under the worktree (`isContained`). `.git/**` is refused, as are symlink
escapes. Files above `MAX_EDIT_BYTES` (512 KiB) and files containing a NUL byte
open read-only. Saves occur only on an explicit `Ctrl+S`.

## External editor

The `o` action suspends the renderer (`api.renderer.suspend()`), spawns
`$VISUAL` or `$EDITOR` with the file path and inherited stdio, resumes the
renderer on exit, and reloads the file.

## Package checks

The package pins OpenCode `1.18.31`, OpenTUI `0.5.11`, and Solid `1.9.12`. Its
`typecheck` and `test` scripts use `run-bounded-command.sh`, which calculates a
fresh budget from current memory, serializes checks, applies a timeout, and
refuses to run without a limiter.

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins/file-manager install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/file-manager run check
```

`src/model.ts` is the pure model and is covered by `node:test`: path
normalization and containment, protected `.git` paths, directory-first sorting,
ignored filtering, tree flattening, filetype mapping, dirty/binary/oversize
guards, quick-open normalization, and index wrapping. `src/opentui.d.ts`
augments the JSX intrinsics for the `line_number` renderable. The route,
viewer, editor, saves, and external editor are verified live after a restart.
