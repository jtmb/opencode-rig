# Desktop Control Usage

This guide explains how to use the `desktop-control` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `desktop`

Tags: `desktop`, `at-spi`, `gui`, `gnome`

## Purpose and when to use it

Use `desktop-control` to inspect and operate accessible GNOME applications by
control name and role rather than screen coordinates.

Appropriate requests include:

- Opening, focusing, closing, or configuring a desktop application.
- Activating a named button or menu action.
- Entering non-sensitive text in an editable field.
- Diagnosing whether an application exposes a usable accessibility control.
- Verifying a GUI result before and after a bounded action.

Do not use it for interactive browser pages when the Playwright browser
skills are available.

## Prerequisites and setup verification

Normal use requires:

- GNOME with toolkit accessibility enabled.
- AT-SPI Python support.
- `desktop-vision` for visual verification.
- The repository's `desktop-control.py` utility.

The agent should inspect current applications read-only before acting:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py apps
```

A missing application means that either the app is not running, its
accessible name differs, or it exposes no usable AT-SPI data.

## How to request it

Ask in ordinary language.

Example requests:

- "Open Calculator and verify that it appears."
- "Close this document without saving only if no unsaved-work prompt appears."
- "Enter this mailing address in the currently open compose field."
- "Find the visible Open button in this application."

The user does not need to know AT-SPI roles, traversal limits, or action
names. The agent selects those details.

## Worked workflow and expected result

A representative agent workflow is:

1. Capture and inspect the current desktop with `desktop-vision`.
2. Inventory applications.
3. Inspect only the relevant application or element:

   ```bash
   python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py tree --app EXAMPLE_APP
   python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py find --app EXAMPLE_APP \
     --name "Open" --role "push button" --showing
   ```

4. Preview a mutation without `--apply`; inspect the target and copy its
   short-lived `target_token` from the structured result.
5. Repeat the same precisely identified mutation promptly with
   `--expect-token TOKEN --apply`.
6. Inspect fresh accessible state and capture the desktop again to verify the
   visible result. Do not retry a generic action until its outcome is known.

A representative focus example is:

```bash
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py focus \
  --app EXAMPLE_APP --name "Address" --showing
python3 ~/repos/opencode-rig/platforms/linux/ubuntu/computer-use/scripts/desktop-control.py focus \
  --app EXAMPLE_APP --name "Address" --showing \
  --expect-token 'TOKEN_FROM_PREVIEW' --apply
```

Expected result: one named control is affected, the post-action screenshot
shows the intended change, and no other application or document is changed.

## Tools and command behavior

The repository utility has these commands:

- `apps`: list accessible applications.
- `tree`: inspect useful elements from one application.
- `find`: locate elements by accessible name and/or role.
- `action`: invoke an advertised accessibility action.
- `focus`: move keyboard focus to an element.
- `set-text`: replace text in an editable field.

Important behavior:

- Inspection commands are read-only.
- `tree` and `find` return a `traversal` status plus `results`. A false
  `traversal.complete` identifies whether depth, node count, or both truncated
  the observation.
- Mutations reject truncated searches and require both explicit `--apply` and
  the matching token from a complete, fresh preview.
- Preview tokens expire after 30 seconds and are bound to the previewed
  operation. If the operation or target's path, name, role, or bounds change,
  inspect and preview again.
- `action` accepts an app-dependent action name and defaults to `click`; the
  `SKILL.md` example using `default.activate` is not universal.
- Generic `action` output says `dispatched` and `outcome: unverified`; a fresh
  observation is required before retrying or continuing.
- `focus` waits for the accessible focused state. `set-text` first verifies
  focus, then requires exact text readback. A timeout reports uncertainty
  rather than claiming success.
- Ambiguous matches stop and list candidates. The agent must select one with
  one-based `--nth N`.
- `--include-text` does not expose protected-field names, descriptions, or
  text.

## Verification and known limitations

The agent must verify the visible consequence. A successful command response
does not prove that GNOME raised, focused, edited, or dismissed the intended
window.

Known accessibility limitations include:

- Some GTK controls expose only a window frame.
- Custom canvases and sandboxed apps may expose little useful data.
- An advertised dialog action can succeed while leaving the dialog open.
- `default.activate` can be accepted without raising a window.
- Screenshot pixels cannot be treated as click coordinates under fractional
  scaling.

When accessibility data are insufficient, use documented keyboard navigation
through the existing private `ydotool` service and visually verify the result.
Coordinate input is a last resort.

## Troubleshooting

- Application absent: check spelling, launch the normal application as the
  normal user, wait for it to appear, then inspect again.
- Too many matches: add `--role`, `--showing`, exact-name matching, or
  `--nth N`.
- Truncated search: increase `--max-depth` or `--max-nodes` as reported and
  inspect the full candidate set before mutating.
- Stale token: run the dry-run preview again and promptly use its new token.
- Element cannot accept focus or text: choose another accessible control or
  documented keyboard path.
- Action succeeds but nothing changes: inspect focus and the fresh screenshot,
  then try the application's supported alternative.
- Sensitive or ambiguous closure prompt: stop and ask before risking unsaved
  work.

## Safety, confirmation, and elevation

The agent must:

- Perform one bounded action at a time.
- Ask before a consequential send, publication, purchase, deletion, security
  change, permission grant, legal acceptance, or other consequential action.
- Never read or write a password field.
- Never inspect or operate a PolicyKit authentication dialog.
- Preserve unsaved work and stop when the safe choice is unclear.
- Never run a graphical application as root.
- Never run an uncontrolled click or keyboard loop.

## Related skills and documents

- [`desktop-vision`](../desktop-vision/README.md) provides visual inspection.
- [`app-setup`](../app-setup/README.md) handles application installation and
  acceptance testing.
- [`system-troubleshooting`](../system-troubleshooting/README.md) diagnoses
  application-launch and desktop-layer failures.
- The canonical catalog entry is in `skills/README.md`.
