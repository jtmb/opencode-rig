---
name: desktop-vision
description: Let the assistant see a GNOME or WSL/Windows desktop through the bounded vision_capture tool. Native GNOME uses its trusted screenshot shortcut; WSL uses an in-memory PNG from the checked-in Windows host. Use when the user says see the screen, screenshot, look at my display, what's on my screen, verify visually, or when GUI work needs eyes on the result.
metadata:
  schema-version: "1"
  category: "desktop"
  tags: "desktop,gnome,wsl,windows,screenshot,visual-verification"
---

# Desktop Vision

Give the assistant eyes on the active desktop. Announce every capture and use
`vision_capture` when available. Native GNOME triggers its trusted screenshot
shortcut, reads the one new PNG, and deletes it. WSL2 delegates only the capture
operation to the checked-in bounded Windows host and returns an in-memory PNG;
it creates no screenshot file.

## Why this flow

Since GNOME 41 the `org.gnome.Shell.Screenshot` D-Bus API is private:
arbitrary callers get `AccessDenied: Screenshot is not allowed`
(verified on this machine, Shell 50). Do not try unsafe mode,
extensions, or permission changes to bypass it.

This machine already has a user-owned `ydotool` service and the owner
approved agent-initiated captures. Sending GNOME's configured screenshot
shortcut through that service works and keeps the capture inside GNOME's
built-in screenshot implementation. Announce every capture first. Never
install, enable, or broaden input permissions just for this skill.

On WSL2, the tool does not require ydotool. It validates the expected Windows
PowerShell executable and checked-in host source, calls only the fixed
`windows.screenshot` RPC, caps PNG bytes at 6 MiB, and verifies canonical
base64 plus dimensions before returning the image attachment.

## Identify the new file safely

Before triggering a capture, use the Glob tool for
`~/Pictures/Screenshots/**/*.png` and retain that path set. Repeat the
same Glob after capture. The capture is the single path present only in
the second result.

- Never select "the newest file" blindly; it may be the user's own image.
- If no new path appears, wait two seconds and Glob once more.
- If more than one new path appears, ask which one to inspect.

## Capture (agent-triggered default)

Prefer the `vision_capture` tool with `mode: "screen"` or `mode: "window"`.
The following native commands document the GNOME backend and are not a second
choice when the tool is available.

Full desktop (Linux evdev: Left Shift + Print):

```bash
SOCKET="${XDG_RUNTIME_DIR:?}/.ydotool_socket"
systemctl --user is-active --quiet ydotool.service
test -S "$SOCKET"
YDOTOOL_SOCKET="$SOCKET" ydotool key 42:1 99:1 99:0 42:0
sleep 2
```

Active window (Linux evdev: Left Alt + Print):

```bash
SOCKET="${XDG_RUNTIME_DIR:?}/.ydotool_socket"
systemctl --user is-active --quiet ydotool.service
test -S "$SOCKET"
YDOTOOL_SOCKET="$SOCKET" ydotool key 56:1 99:1 99:0 56:0
sleep 2
```

If `ydotool`, its private socket, or its user service is unavailable on native
GNOME, do not modify the system. Ask the user to use a built-in shortcut. On
WSL2, let `vision_capture` use its bounded Windows backend instead:

| Keys | Captures |
|---|---|
| `PrintScreen` | Interactive picker: selection, window, or full screen |
| `Shift+PrintScreen` | Full screen immediately |
| `Alt+PrintScreen` | Active window immediately |

Files land in `~/Pictures/Screenshots/` as timestamped PNGs.

## View, then delete

View the single new path identified from the pre/post Glob sets with the
Read tool (it renders images). Immediately afterwards, delete only that
exact path:

```bash
rm -f "<the viewed file>"
```

The WSL2 backend returns the image attachment directly from memory. There is no
path to inventory or delete; do not write the attachment back to disk merely to
inspect it.

## Privacy rules

- Agent-initiated captures are allowed on this machine during relevant
  GUI work. Announce each capture before triggering it.
- Screenshots are viewed once. Native files are deleted right after; WSL image
  bytes remain in memory. Never store, commit, upload, or paste them elsewhere.
- Never try to observe a locked screen. Treat visible passwords, keys,
  tokens, and private messages as do-not-repeat: use them for the task
  at hand, never quote them back.
- Never capture while a PolicyKit authentication dialog or another credential
  field is open. Wait for the user to report completion before observing again.
- If the screen shows anything the user clearly didn't intend to share
  (e.g. banking, someone else's private messages), say so and stop.

## Limits

- Stills only. Within this skill, `ydotool` may be used only for the two
  screenshot shortcuts above. General GUI input belongs to the separately
  loaded `desktop-control` skill and its stricter observe-act-verify rules.
- Multi-monitor `Shift+PrintScreen` spans all displays; prefer
  `Alt+PrintScreen` when one window is what matters.
- Very large/HiDPI shots may be hard to read; use a window shot.
- The command examples are GNOME-only. WSL2 uses the checked-in Windows host;
  other desktops use that session's own screenshot UI while preserving the
  same privacy and retention discipline.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
