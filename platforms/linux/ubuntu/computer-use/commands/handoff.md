---
description: Update HANDOFF.md with the current v2 session state.
agent: build
---

Refresh the repository handoff so a new OpenCode v2 session can continue.

1. Read `AGENTS.md` and `HANDOFF.md` fully; preserve its prompt, live-state,
   and Work In Progress structure.
2. Inspect branch, recent commits, `git status --short`, the v2 health check,
   changed sources, and checks already run.
3. Update generated sections with the active v2 components, exact verification
   status, blockers, and concrete next steps. Replace stale contradictions.
4. Run `python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage.py`.
5. Do not commit, push, or edit deployed copies. If the user later requests a
   commit or push, follow `docs/scripts/git-safety-gates.md`; commit approval
   and push approval are separate.
