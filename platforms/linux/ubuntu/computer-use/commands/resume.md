---
description: Resume from HANDOFF.md — read the handoff in full, run the health check, report status, and continue the pending task.
agent: build
---

Resume the assistant's work from the repository handoff.

1. Read `HANDOFF.md` in full first. It is the primary resume source: the
   copy-paste prompt, the known live state, and the Work In Progress plan.
   Do not start any other work before reading it.
2. Then read these files, in order:
   - `AGENTS.md`
   - `README.md`
   - `platforms/linux/ubuntu/computer-use/README.md`
   - `platforms/linux/ubuntu/computer-use/skills/README.md`
   - `docs/README.md`
3. Run the read-only health check:

   `platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only`

   If it passes, do not reinstall. If it fails, diagnose the specific failed
   check before repairing anything.
4. Inspect the live state read-only: `git log --oneline -6`,
   `git status --short`, and the current branch.
5. Give a concise status: branch, latest commit, worktree state, the pending
   task, and any blockers.
6. Track the resumed work with the todo tool: create the list before acting,
   keep exactly one item in progress, and mark items completed only after
   their verification passes.
7. Continue the Work In Progress task from the handoff. Load the skill that
   matches it before acting, make the smallest bounded change, and verify the
   real result. If the pending work is complete or ambiguous, ask what to do
   next instead of guessing.
8. Preserve unrelated dirty work and user files. Keep the confirmation gates for
   consequential actions, and never handle passwords, MFA, payment details, or
   CAPTCHAs.
