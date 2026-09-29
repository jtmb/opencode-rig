# Interactive Surface Patterns

## Interactive element

- Give every actionable control a visible label and accessible name.
- Expose disabled, busy, selected, and error states instead of relying on color.
- Keep focus order and keyboard activation usable.
- Use native controls before adding custom event handling.

## Overlay or dialog

- Use constrained sizing (`w-11/12 max-w-7xl max-h-[90vh]`) rather than a
  full-screen dialog by default.
- Provide an accessible name, a visible close action, and a keyboard escape
  path where supported.
- Keep content scrollable without trapping focus outside the dialog.

## Content viewer

- Distinguish rendered content from source text.
- Preserve plain-text fallback and do not execute untrusted markup.
- Keep long content bounded and expose loading, empty, and failure states.

## Surfaces

Interactive surfaces should follow this structure where applicable:
```
Heading
Primary action or filter (if applicable)
Bounded content list
Detail or confirmation view (conditional)
```
