---
name: desktop-control
description: Inspect and operate GNOME desktop applications through AT-SPI, using desktop screenshots to verify each GUI action. Use when the user asks to click, type, open, close, configure, or otherwise interact with a desktop application or dialog. Do not use for browser pages when Playwright tools are available.
metadata:
  schema-version: "1"
  category: "desktop"
  tags: "desktop,at-spi,gui,gnome"
---

# Desktop Control

Operate GNOME applications with an observe-act-verify loop. Prefer named
AT-SPI controls over screen coordinates; this desktop uses fractional
scaling, so screenshot pixels are not reliable click coordinates.

## Workflow

1. Load `desktop-vision`, announce a capture, and inspect the current UI.
2. Inventory accessible apps:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py apps
```

3. Inspect only the relevant app or element:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py tree --app gnome-text-editor
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py find --app gnome-text-editor \
  --name "Open" --role "push button" --showing
```

4. Preview a mutation without `--apply` and inspect the selected target. The
preview emits a short-lived `target_token`; repeat the same mutation promptly
with that exact token and `--apply`:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py action --app APP --name NAME \
  --action default.activate --showing
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py action --app APP --name NAME \
  --action default.activate --showing --expect-token 'TOKEN_FROM_PREVIEW' --apply

python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py set-text --app APP --role text \
  --showing --text "harmless text"
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py set-text --app APP --role text \
  --showing --text "harmless text" --expect-token 'TOKEN_FROM_PREVIEW' --apply
```

When several elements match, the tool refuses and prints candidates.
Select one with `--nth N`; do not guess.
Use an action name advertised by `tree` or `find`; names vary by app.
If `traversal.complete` is false, increase the reported depth or node bound and
inspect again. Mutation commands reject truncated searches rather than choosing
from an incomplete candidate set.

5. Treat a generic accessibility action as dispatched but unverified. Take a
fresh observation before retrying or continuing; this avoids duplicate actions
when the first outcome is uncertain. `focus` verifies the focused state, and
`set-text` verifies focus plus exact text readback, but both still require
visible verification when appearance or window state matters.
6. Capture again and verify the visible result. Do not infer success from a
zero exit code alone.

## Application launch

Use the installed desktop launcher where possible (`gtk-launch ID`) or
the package-owned executable as the normal user. Never run a GUI as root.
Wait for the app to appear in `desktop-control.py apps` before querying it.

## Fallbacks

- Some custom canvases and sandboxed apps expose little AT-SPI data.
  Use documented keyboard navigation (Tab, arrows, Enter, Escape) and
  GNOME shortcuts through the existing user-owned `ydotool` service.
- Coordinate clicks are a last resort and require a fresh screenshot,
  known scaling transform, and immediate visual verification. Never map
  screenshot pixels directly on this fractionally scaled desktop.
- If the target remains inaccessible, describe the exact manual action
  needed instead of clicking blindly.

## Safety boundaries

- Ask immediately before sending/publishing a message, making a purchase,
  accepting legal terms, deleting data, changing account/security settings,
  granting permissions, or confirming any other consequential action.
- Normal reversible navigation and edits explicitly requested by the user
  do not need repeated confirmation.
- Never read or write password fields. Ask the user to complete passwords,
  MFA, payment details, and CAPTCHAs themselves.
- Protected fields are redacted by `desktop-control.py`; `--include-text`
  never returns their text, accessible name, or description.
- Never inspect or operate a PolicyKit authentication dialog. Wait until the
  user reports that credential entry is complete, then inspect fresh state.
- Preserve unsaved work. Before closing a window, inspect for unsaved-state
  prompts and stop if the correct choice is unclear.
- Tokens are target-freshness guards, not authorization. They expire after 30
  seconds and never replace a required confirmation gate.
- Perform one bounded action at a time, then verify. Never run an
  uncontrolled click loop.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
