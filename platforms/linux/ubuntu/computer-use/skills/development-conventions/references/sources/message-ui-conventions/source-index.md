---
name: message-ui-conventions
description: "Generic message-like UI standards for sync operations, visible progress indicators, and explicit interfaces."
---

# Message-like UI Conventions

## 🔴 HARD RULEs
- Background sync must run as separate jobs with a visible status surface.
- UI must show progress during sync, never appear unavailable.
- Progress display must be explicit, not hidden or ambiguous.
- Interface must be explicit — no guessing required (importance: 6)

## 🔴 HARD RULEs
- Pass caller-owned identifiers and folders through unchanged unless the API
  explicitly defines a default.
- Document settings and apply them consistently at every relevant boundary.
- Parse structured message formats with a maintained parser rather than a
  handwritten partial grammar.
- Keep failed or empty assistant responses on a safe sentinel path without
  crashing the surrounding sync loop or exposing private reasoning fields.
