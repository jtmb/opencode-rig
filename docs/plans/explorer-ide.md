# Explorer recovery and acceptance plan

Status: the v2 `file-manager` baseline is active and live-accepted with a docked
tree, viewer, tabs, explicit-save editor, and safety guards. This document does
not claim that every planned IDE feature or syntax family has visual evidence.

## Current contract

Explorer opens with `/explorer`, `/editor`, `/files`, or `Ctrl+Alt+X`. It must
keep project-root containment, `.git` and outside-root symlink refusal, binary/UTF-8/size
guards, dirty revisions, disk fingerprints, conflict-safe atomic saves, and
paths-only persistence. Unsaved buffer contents must never be silently saved or
persisted.

## Recovery sequence

1. **Reproduce:** use a disposable project and record OpenCode v2 version,
   package revision, terminal size, theme, and configured `cli.json` entry.
2. **Render audit:** open the panel from each alias and capture fresh screenshots
   of the tree, empty state, viewer, editor, tabs, dirty state, save feedback,
   conflict state, and narrow-terminal layout. Check clipping, focus, contrast,
   labels, and panel bounds. A successful process exit is not visual evidence.
3. **Click audit:** manually verify tree selection, file activation, tab
   switching, editor cursor placement, scrolling, and any buttons with a real
   pointer. The previous virtual-pointer limitation means a rendered screenshot
   alone does not prove click delivery. Record untested interactions honestly.
4. **Keyboard audit:** verify aliases, `Ctrl+S`, save-all, close/discard guard,
   reopen, go-to-line, tab navigation, and escape behavior in a disposable
   project. Confirm dirty content survives rejected close/reload actions.
5. **Safety audit:** attempt traversal, outside-root symlink, `.git`, binary,
   oversized, invalid UTF-8, stale-disk, and concurrent-edit cases. Confirm no
   tracked or user file changes outside the disposable root.
6. **Automated gate:** run the package check through
   `scripts/run-bounded-command.sh`, the v2 health/deployment checks, and the
   documentation/resource gates. Clean temporary projects and screenshots.

## Accepted baseline and remaining evidence

- **Language coverage:** 21 pinned, manifest- and SHA-256-verified managed
  parser assets plus OpenTUI-bundled JavaScript, JSX, TypeScript, TSX, Markdown,
  and Zig mappings are implemented; plain text is the fallback. Automated
  parser checks pass. A disposable live run proved tree/editor rendering,
  pointer selection and file activation, directory expansion, tabs, cursor
  placement, edit/discard protection, narrow layout, and `Ctrl+S`, then restored
  the fixture hash. Representative screenshots for every syntax family remain
  outside the accepted baseline.

## Planned increments

- **Editing power:** find/replace, indentation, line operations, bracket and
  active-line affordances; acceptance requires keyboard and click audits.
- **Project search/Git context:** bounded, cancellable search; preview manifests;
  explicit confirmation and atomic writes for multi-file changes.
- **External tools:** opt-in, bounded subprocesses with no shell interpolation,
  visible output, and failure-safe state.

No LSP, formatter, embedded terminal, multi-cursor, or full IDE parity should be
claimed until the host API and the rendered/interaction audits support it.
