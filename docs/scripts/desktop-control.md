# `desktop-control.py`

Inspect and operate accessible GNOME application widgets through AT-SPI. It is
the primary "hands" tool for desktop work: it prefers named, accessible
controls over screen coordinates, which is essential on a fractionally scaled
Wayland desktop where screenshot pixels are not reliable click targets.

It also lists top-level windows (`windows`) and can send one bounded key or
text action through the private ydotool service (`input`) when accessibility
data is insufficient.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py apps
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py tree --app firefox
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py find --app firefox --name "Search" --role entry
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py windows --showing
python3 platforms/linux/ubuntu/computer-use/scripts/desktop-control.py input --kind key --key ctrl+s
```

Read-only commands are the default. Mutating commands (`action`, `focus`,
`set-text`, `input`) require a fresh preview token and `--apply`.

## Requirements

- `python3-pyatspi` (installed by
  [`setup-computer-assistant.sh`](setup-computer-assistant.md)).
- GNOME toolkit accessibility enabled.

If `pyatspi` cannot be imported, the script exits immediately with an
installation hint. It suppresses `DeprecationWarning` so AT-SPI noise does not
pollute output.

## Commands

### `apps` (read-only)

Lists accessible applications as JSON objects with `name`, `role`, and
`children` (child count). This is the standard health check that AT-SPI works.

### `tree` (read-only)

Dumps the useful elements of one application.

| Option | Default | Meaning |
|--------|---------|---------|
| `--app` (required) | — | Application name |
| `--max-depth` | 12 | Traversal depth bound |
| `--max-nodes` | 1000 | Traversal node bound |
| `--all` | off | Include nodes with no name and no actions |
| `--include-text` | off | Include a text preview for non-sensitive text widgets |

Output is `{ "traversal": {...}, "results": [...] }`.

### `find` (read-only)

Finds elements by accessible `--name` and/or `--role`, with the same
`--max-depth` (30) / `--max-nodes` (5000) bounds and `--include-text`. It
requires at least one of name/role.

### `windows` (read-only)

Lists top-level windows — `frame`, `window`, `dialog`, `alert`, and chooser
roles — across every application, or one `--app`. Each entry carries the owning
`app`, name, role, `states`, `bounds`, and derived `showing` and `active`
flags, so it is the way to find the active window, confirm whether a window
opened or closed, or choose the app for a later `action`.

| Option | Default | Meaning |
|--------|---------|---------|
| `--app` | all apps | Restrict the scan to one application |
| `--showing` | off | Only windows that are both `showing` and `visible` |
| `--max-depth` | 4 | Traversal depth bound per application |
| `--max-nodes` | 2000 | Traversal node bound per application |

Output is `{ "complete": bool, "scanned_apps": N, "windows": [...] }`.

### `action` (mutation)

Invokes an advertised accessibility action (`--action`, default `click`) on the
matched element.

### `focus` (mutation)

Moves keyboard focus to the matched element and waits up to `--wait-seconds`
(default 2) for the `focused` state.

### `set-text` (mutation)

Replaces an editable field's text with `--text`, then waits for a readback
match.

### `input` (mutation)

Sends exactly one bounded input action through the user-owned ydotool service:

- `--kind key --key <chord>` presses and releases one chord. Modifiers are
  `ctrl`, `shift`, `alt`, `super`, and `meta`; the non-modifier key must be a
  letter, digit, or named key (`Return`, `Escape`, `Tab`, `BackSpace`,
  `Delete`, arrows, `Home`/`End`, `PageUp`/`PageDown`, `F1`–`F12`, common
  punctuation names).
- `--kind type --text <text>` types up to 256 printable ASCII characters with
  escape interpretation disabled; control characters are refused, so `Return`,
  `Tab`, and arrows must be sent as explicit keys.

A preview returns a `target_token` bound to the payload **and** the currently
active window; the token expires after 30 seconds and becomes stale if the
focused window changes. `--apply --expect-token` sends exactly one `ydotool`
invocation through the socket at `$YDOTOOL_SOCKET` or
`$XDG_RUNTIME_DIR/.ydotool_socket` and reports the dispatch as unverified.

`action`, `focus`, `set-text`, and `input` all share the `--expect-token`/
`--apply` workflow described below.

## Element matching

Every command that targets an element accepts the same matcher arguments
(`add_match_args`):

| Option | Meaning |
|--------|---------|
| `--app` (required) | Application name; exact match wins, otherwise a case-insensitive substring match. Ambiguity is an error listing candidates. |
| `--name` | Accessible-name match; substring by default, exact with `--exact-name` |
| `--role` | Exact AT-SPI role name (case-insensitive) |
| `--showing` | Keep only elements that are both `showing` and `visible` |
| `--nth N` | Select the Nth match (1-based). Supplying it explicitly is tracked separately. |
| `--max-depth` / `--max-nodes` | Traversal bounds |

`choose_match()` enforces discipline around selection:

1. The traversal must be **complete** (not truncated by depth or node count);
   otherwise it exits and tells you to increase the bound. A mutation may never
   target an element that was not fully searched.
2. If there are no matches, it exits.
3. If `--nth` is out of range, it exits with the valid range.
4. If there are multiple matches and `--nth` was not given explicitly, it
   prints up to 20 summaries and exits, asking you to re-run with `--nth N`.

This prevents an accidental click on the wrong element when the name is
ambiguous.

## Sensitive fields

`sensitive` is true when the role contains `password` or the element reports the
`protected` state. For sensitive elements:

- `node_info()` redacts `name` and `description` to
  `[redacted protected field]`.
- Text previews are omitted.
- Name matching treats the element's name as empty, so a secret cannot be used
  to locate a field by its value.
- `set-text` refuses outright with "refusing to write a password field".

## Traversal bounds

`walk()` is a breadth-first traversal that records each visited node's path
(`0/1/2`), depth, role, states, actions, and bounds. It reports:

- `complete` — not truncated by depth or node count.
- `visited`, `truncated_by_depth`, `truncated_by_nodes`.

Bounds are intentionally conservative defaults, and the token workflow refuses
mutations on an incomplete traversal.

## Dry-run target tokens

Mutation commands implement a preview-then-apply gesture that binds the action
to the exact element that was previewed:

1. Without `--apply`, the command prints a JSON object containing the target's
   info, a `target_token`, and `apply_requires: "--expect-token TARGET_TOKEN --apply"`.
2. The token is `<nanosecond timestamp>:<sha256>` where the hash covers the
   element's path, name, role, bounds, and the verb being invoked.
3. With `--apply`, `--expect-token` is **required** and the token is validated:
   the fingerprint must match the current element, the token must be no more
   than 30 seconds old, and it cannot be from the future. A stale token or a
   changed target is an error.

This ties a mutation to a freshly observed element and fails safely if the UI
changed in between.

`input` uses the same gesture with a payload-and-context fingerprint: the token
covers the action payload (kind plus key or text) and the currently active
window's app and title. It is invalidated by a window change and by age, and
each apply performs exactly one ydotool invocation.

## Verification behavior

- `action` reports `"outcome": "unverified"` and a `next_step` telling you to
  take a fresh observation; a dispatch return value is not proof the UI changed.
- `focus` waits for the `focused` state and reports `"outcome": "verified"`. If
  focus is accepted but the state never appears, it errors and warns that the
  outcome is unknown.
- `set-text` focuses first, sets the contents, then waits for a readback equal to
  the requested text. A mismatch is an error, not a silent success.
- `input` dispatches exactly one ydotool action and reports
  `"outcome": "unverified"` together with the focused window it was bound to;
  confirm the result with a fresh screenshot before continuing.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Command completed |
| `1` | Runtime error (no match, ambiguous match, incomplete traversal, refused action, unverified outcome, etc.) via `SystemExit` |
| `2` | Argument parsing error (for example `find` with neither `--name` nor `--role`) |

## Output

All output is JSON, which keeps it machine-readable and stable. Actionable
fields include `path`, `depth`, `name`, `role`, `description`, `states`,
`actions`, and `bounds`. `bounds` are desktop coordinates in
`[x, y, width, height]`; they are useful for diagnostics but should not be used
to synthesize clicks.

## Notes and limitations

- AT-SPI exposes window frames reliably, but some GTK4 controls, custom
  canvases, and sandboxed apps expose few or misleading nodes and actions. Prefer
  named controls and documented keyboard navigation as a fallback.
- `default.activate` on a window frame may be accepted without raising the
  window. Verify with a fresh observation before retrying.
- Unsaved-change sheets may advertise actions that do nothing; use visible
  keyboard-focus controls and verify dismissal.
- This script only reads and drives the accessibility tree and, for `input`, the
  private ydotool service. It does not take screenshots; pair it with the
  `desktop-vision` skill for visual proof.
- `input` fails closed when the ydotool service or its private socket is
  unavailable; it never changes input permissions or device access, and it
  never sends passwords or other secrets.
- Related: [`assistant-memory.md`](assistant-memory.md),
  [`setup-computer-assistant.md`](setup-computer-assistant.md).
