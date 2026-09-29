---
name: visual-standards-conventions
description: "Visual design and UI standardization rules for overlays, cards, and page layouts"
---

# Visual Standards Conventions

## 🔴 HARD RULEs
- All new overlays must use constrained default sizing: w-11/12 max-w-7xl max-h-[90vh]
- No new overlays should use fullScreen mode
- Status cards must distinguish process state from application state.
- Use the surface's canonical semantic color variables instead of hard-coded
  status colors.

## 🔴 Orchestration Visual Validation
- Follow the repository's assigned visual gate. Changed browser routes require
  a rendered desktop/mobile check and an interaction audit; non-UI work does
  not invent a visual gate.
