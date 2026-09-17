# Desktop Vision Usage

This guide explains how to use the `desktop-vision` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `desktop`

Tags: `desktop`, `gnome`, `screenshot`, `visual-verification`

## Purpose and when to use it

Use `desktop-vision` when visual confirmation is needed for:

- What is currently displayed.
- Whether a window opened, closed, gained focus, or changed.
- Which control appears selected or focused.
- A GUI error or unexpected application state.

Prefer accessibility data when a control can be identified by name. Use this
skill when appearance, layout, focus, or rendered output matters.

## Prerequisites and setup verification

Normal agent-initiated capture requires:

- GNOME on Wayland.
- The configured GNOME screenshot shortcut.
- The user-owned `ydotool` service and its private socket.

The agent should verify those prerequisites before attempting a capture:

```bash
systemctl --user is-active --quiet ydotool.service
test -S "${XDG_RUNTIME_DIR:?}/.ydotool_socket"
```

If that service, socket, or shortcut is unavailable, the agent must ask the
user to press the appropriate built-in screenshot key instead.

## How to request it

Ask in ordinary language. No direct user command is required.

Example requests:

- "Can you see what is on my screen right now?"
- "Verify visually that this installer window is closed."
- "Look at this dialog and tell me which button is focused."

The user does not need to name the skill. The agent loads `desktop-vision`
and follows its screenshot workflow.

## Worked workflow and expected result

The representative agent workflow is:

1. Record all existing files matching:

   ```text
   ~/Pictures/Screenshots/**/*.png
   ```

2. Announce the capture before triggering it.
3. Trigger the appropriate GNOME shortcut through the existing private
   `ydotool` service:

   ```bash
   SOCKET="${XDG_RUNTIME_DIR:?}/.ydotool_socket"
   systemctl --user is-active --quiet ydotool.service
   test -S "$SOCKET"
   YDOTOOL_SOCKET="$SOCKET" ydotool key 42:1 99:1 99:0 42:0
   sleep 2
   ```

   Active-window capture uses:

   ```bash
   SOCKET="${XDG_RUNTIME_DIR:?}/.ydotool_socket"
   systemctl --user is-active --quiet ydotool.service
   test -S "$SOCKET"
   YDOTOOL_SOCKET="$SOCKET" ydotool key 56:1 99:1 99:0 56:0
   sleep 2
   ```

4. Repeat the screenshot inventory and identify the one newly created PNG.
5. Read only that PNG.
6. Delete exactly that PNG immediately:

   ```bash
   rm -f "<the-viewed-file>"
   ```

Expected result: one new image is identified, inspected once, deleted
immediately, and summarized without retaining a screenshot.

## Verification and known limitations

The screenshot must show the claimed application or dialog state. An
apparently successful capture command is not proof that the relevant window
was visible or focused.

Known limitations:

- Stills only; this skill does not record video.
- Multi-display full-screen capture can span every display.
- Large or high-resolution images may be difficult to inspect.
- The stated fallback key combinations are GNOME-specific.
- An active-window key combination may capture another application if focus
  changed unexpectedly.

## Troubleshooting

- No new screenshot: wait two seconds, inventory again, and check the
  service/socket before retrying.
- Multiple new files: do not assume the newest file belongs to the current
  task; ask which file to inspect.
- Wrong window captured: re-establish application focus first, then capture
  again.
- Service unavailable: do not change permissions or install input software
  for this skill. Ask the user to press PrintScreen.
- Sensitive or unintended private content appears: stop, say so, and do not
  quote or retain it.

## Safety, confirmation, and elevation

This skill does not change applications, install software, or alter system
permissions. It nevertheless handles potentially sensitive visual information.

The agent must:

- Announce every capture before triggering it.
- Never attempt to observe a locked screen.
- Never capture while a PolicyKit authentication dialog, password field, MFA
  prompt, payment field, or CAPTCHA is open.
- Treat unexpected banking, authentication, or private-message content as
  do-not-repeat.
- Never store, commit, upload, or paste a screenshot elsewhere.

## Related skills and documents

- [`desktop-control`](../desktop-control/README.md) performs bounded GUI
  operations using visual verification.
- [`browser-assistant`](../browser-assistant/README.md) is preferred for
  interactive web pages when the accessibility snapshot is sufficient.
- The canonical catalog entry is in `skills/README.md`.
