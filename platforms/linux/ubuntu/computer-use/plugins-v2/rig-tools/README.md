# rig-tools (v2)

OpenCode v2 server plugin registering the harness desktop and vision tools
through `ctx.tool.transform`. It wraps
[`scripts/desktop-control.py`](../../scripts/desktop-control.py) with bounded
`execFile` calls (30 s timeout, 256 KiB output cap) and the preview/apply token
flow, and implements `vision_capture` through the private ydotool screenshot
shortcut.

## Tools

| Tool | Kind | Purpose |
|------|------|---------|
| `desktop_apps` | read-only | List accessible AT-SPI applications |
| `desktop_tree` | read-only | Dump one application's useful accessible elements |
| `desktop_find` | read-only | Find elements by name and/or role |
| `desktop_windows` | read-only | List top-level windows (frames, dialogs, alerts) with app, states, bounds, and completeness |
| `desktop_act` | mutation | Invoke an action, focus an element, or replace field text; preview + token |
| `desktop_input` | mutation | Send one key/chord or printable ASCII text through ydotool; preview + token bound to the focused window |
| `vision_capture` | read-only | Screenshot as an image attachment; the PNG is deleted after reading |

## Bounds and safety

- Argument construction lives in `src/desktop.ts` (`buildDesktopArgs`) so it is
  testable without AT-SPI; `src/index.ts` registers the tools; `src/vision.ts`
  holds the screenshot logic.
- Every tool call spawns `python3` with an argument array (no shell
  interpolation) and surfaces exit codes, stderr, timeouts, and output-cap
  overruns distinctly.
- Mutations preview by default; `apply: true` requires the preview
  `expectToken`, and a token without `apply` is refused.
- `desktop_input` allowlists modifiers and named keys, caps text at 256
  printable ASCII characters, binds its token to the focused window, sends
  exactly one ydotool invocation per apply, and never handles passwords or
  other secrets.
- `vision_capture` must be announced before use and is refused while a
  credential dialog is open.
- `desktop_windows` reports `complete: false` when its traversal bounds
  truncate the scan.

## Registration

Registered from the `plugins` array in the v2 `opencode.jsonc`:

```jsonc
{ "package": "/abs/path/to/plugins-v2/rig-tools", "options": {} }
```

## Checks

```bash
cd platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools
npm run check   # typecheck + node --test, both through run-bounded-command.sh
```
