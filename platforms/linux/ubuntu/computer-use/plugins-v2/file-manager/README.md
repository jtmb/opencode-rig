# File Manager / Explorer (OpenCode v2)

This CLI plugin provides the docked `session.panel` Explorer with a project
tree, quick-open, viewer, and explicit-save editor.

## Opening the Explorer

All of these commands open the same panel:

- `/explorer`
- `/editor`
- `/files`
- `Ctrl+Shift+E`

The slash aliases are registered by the reactive v2 keymap layer. Restart the
TUI after changing the local package or `cli.json`; a fresh OpenCode process
loads the configured package from `cli.json`.

## Safety behavior

- Project roots are canonicalized once; absolute paths, traversal, `.git`,
  outside-root symlinks, directories, special files, binary data, invalid
  UTF-8, and oversized files are rejected.
- Saves compare a content/stat fingerprint, preserve mode bits, write through a
  unique exclusive temporary file, flush it, and atomically replace the
  destination. A disk conflict is never silently overwritten.
- Tab revisions ensure an in-flight save cannot mark newer edits clean.
- Dirty active and background tabs require explicit guard confirmation before
  switching, reloading, discarding, or closing the panel.
- External-editor commands use bounded argument parsing with `spawn(...,
  { shell: false })`; failed editor processes do not reload the tab.
- Directory, file, search, and highlight requests use generations so stale
  asynchronous results cannot replace newer state.

Unsaved buffer contents are not persisted; only safe tab paths and the active
path are stored. Save or discard dirty tabs before closing the panel.

## Development check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/file-manager run check
```

The package tests cover 39 cases, including containment, symlink and `.git`
rejection, UTF-8/binary/size guards, atomic mode-preserving saves, disk
conflicts, revision-safe tab saves, dirty guards, command parsing, and request
generation invalidation.
