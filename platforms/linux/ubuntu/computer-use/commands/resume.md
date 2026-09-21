---
description: Resume from HANDOFF.md using the v2 health check and progress gate.
agent: build
---

Resume work from the repository handoff. The repository supports the managed
OpenCode v2 harness.

1. Read `HANDOFF.md` and `AGENTS.md` fully.
2. Read `README.md`, the computer-use README, skills README, and
   docs README as needed.
3. Run the read-only health check:
   `platforms/linux/ubuntu/computer-use/scripts/verify-opencode-v2.sh`
4. Inspect `git log --oneline -6`, `git status --short`, and the current branch.
5. Report branch, latest commit, worktree state, pending task, and blockers.
6. Track resumed multi-step work with the todo tool before acting; keep exactly
   one item in progress and verify before completing it.
7. Preserve unrelated dirty work and follow the confirmation gates.
8. For any requested commit or push, use the separate staged-scope and
   verified-destination gates in `docs/scripts/git-safety-gates.md`.
