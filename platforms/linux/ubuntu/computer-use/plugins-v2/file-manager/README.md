# File Manager / Explorer (OpenCode v2)

This CLI plugin provides a fullscreen `session.panel` Explorer using the same
two-pane workflow as OpenCode's diff viewer. Its tree includes every safe local
repository file: changed files open as working-tree diffs, unchanged files open
as syntax-highlighted source, and deleted files remain available as diff-only
virtual entries. Quick-open and the guarded explicit-save editor remain
available.

## Opening the Explorer

All of these commands open the same panel:

- `/explorer`
- `/editor`
- `/files`
- `Ctrl+Alt+X` (the default; `Ctrl+Alt+E` is reserved by OpenCode's built-in
  `session.line.down` binding)

Set the plugin option `bind` to a nonempty key string to override the default.
The slash aliases and sidebar entry remain available if the desktop or IBus
claims the shortcut. The aliases are registered by the reactive v2 keymap layer. Restart the
TUI after changing the local package or `cli.json`; a fresh OpenCode process
loads the configured package from `cli.json`.

The clickable Explorer sidebar entry is anchored before `sidebar.content`, so
it remains the first content section when another plugin replaces that slot.
Every entry point requests fullscreen presentation.

## Viewer controls

- `Tab` switches focus between the repository tree and content.
- `n` / `p` select the next or previous visible file; `]` / `[` select diff
  hunks.
- `a` toggles all changes or one selected file; `v` toggles split/unified diff;
  the clickable header control does the same. Added and deleted files always
  use the full-width unified layout because they have only one side. `t`
  toggles the tree.
- `d` selects working tree, main branch, or last-turn changes; `m` marks a file
  reviewed; `?` opens help.
- `/` searches all repository files. `e`, `o`, `Ctrl+S`, and `Ctrl+Shift+S`
  retain the guarded editor, external-editor, save, and save-all behavior.

## Safety behavior

- Project roots are canonicalized once; absolute paths, traversal, `.git`,
  outside-root symlinks, directories, special files, binary data, invalid
  UTF-8, and oversized files are rejected.
- The desktop tree is enumerated by the CLI process through the local
  `PathGuard`, not through the server file-list response. Enumeration pins the
  root and target directories, refuses to follow and omits every symlink,
  rejects special-file entries, excludes `.git`, bounds entry count,
  name/path/text bytes and depth, and
  fails closed if a directory or entry changes while it is being listed.
- Saves compare a content/stat fingerprint, preserve mode bits, write through a
  unique exclusive temporary file, flush it, and atomically replace the
  destination. A disk conflict is never silently overwritten.
- Tab revisions ensure an in-flight save cannot mark newer edits clean.
- Dirty tabs stay open during ordinary file and tab navigation. Explicit guard
  confirmation remains for closing, discarding, reloading, refreshing, and
  leaving the panel.
- External-editor commands use bounded argument parsing with `spawn(...,
  { shell: false })`; failed editor processes do not reload the tab.
- Directory, file, search, and highlight requests use generations so stale
  asynchronous results cannot replace newer state.

Unsaved buffer contents are not persisted; only safe tab paths and the active
path are stored. Save or discard dirty tabs before closing the panel.

This is intentionally a local desktop Explorer. When the CLI is connected to a
remote OpenCode server, the server location must be mounted at the same local
path for the tree to represent it. Otherwise local tree enumeration will fail
or show the local path while server-backed quick-open reflects the remote
location; remote filesystem transport is not implemented by this plugin.

## Development check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/file-manager run check
```

The package tests cover the repository/diff merge model, bounded local directory enumeration,
tab/safety, generation, command, and mouse helpers. They also cover safe
one-line cell truncation, selected-row/tab presentation, and the complete
filetype mapping, and production-used OpenTUI presentation components through
`testRender`, `captureCharFrame`, `captureSpans`, and `mockMouse` when native
OpenTUI rendering is available. In the current Node 22 environment those
rendered tests skip with the exact error `OpenTUI native FFI is not available
for this runtime yet`; the component harness remains in place for the host
runtime. Parser assets are looked up under `$RIG_PARSERS_DIR`, or the
deterministic `$XDG_CACHE_HOME/opencode-rig/parsers` managed cache. The
canonical launcher sets both paths under the selected pilot cache so setup and
runtime agree. Missing or
failed registrations are reported, the UI distinguishes recognized filetypes
from unavailable parsers, and plain text remains the fallback. The tree-sitter
worker smoke test also skips when native worker support is unavailable. Tests
never download assets. Install or verify the pinned managed assets explicitly:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/file-manager run parsers:install
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/file-manager run parsers:verify
```

Both commands are bounded and never download; installation requires the exact
locked `tree-sitter-wasm@2.0.1` package already installed. Use `--target DIR`
for a test or controlled cache location, and `--verify-only` to avoid writes.
The committed `parsers.manifest.json` records the source language, editor
filetype, aliases, and SHA-256 for every copied WASM/query file; the installer
checks the package version and every hash before, during, and after copying.
JavaScript/JSX, TypeScript/TSX, Markdown, and Zig are supplied by OpenTUI
0.5.11 and are not copied or re-registered by this package.

OpenTUI 0.5.11 reports highlight ranges as JavaScript/UTF-16 string offsets,
which the editor validates and passes through by default. Setting
`RIG_TREE_SITTER_OFFSETS=characters` selects the same behavior explicitly. A
future or alternate worker that reports UTF-8 byte offsets can instead use
`RIG_TREE_SITTER_OFFSETS=bytes` to convert those ranges before applying them.
