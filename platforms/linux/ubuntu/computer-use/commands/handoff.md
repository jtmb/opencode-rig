---
description: Update HANDOFF.md with the current session state and regenerate the fresh-chat prompt.
agent: build
---

Refresh the repository handoff so a new OpenCode session can continue this work.

1. Read `AGENTS.md` and `HANDOFF.md` fully before acting, and preserve the
   file's structure: the copy-paste prompt block, the known live state, and the
   Work In Progress section.
2. Inspect the current state read-only:
   - `git log --oneline -6`, `git status --short`, and the active branch
   - every source changed since the handoff was recorded (code, configs,
     commands, plans) and whether its checks were run
3. Update the generated parts of `HANDOFF.md` to match reality:
   - the copy-paste prompt: skill/MCP/plugin counts, global commands, the
     health check, and the current task pointer
   - known live state: branch, latest local commit, clean or dirty worktree,
     and deployed components
   - Work In Progress: completed work, durable decisions (user choices and
     research conclusions), the current task with concrete next steps,
     verification status, blockers, and risks
   Replace stale statements instead of appending contradictions, and keep it
   concise: decisions and next actions, not a transcript.
4. If mapped sources changed this session, confirm their documentation is
   updated in the same work.
5. Verify the gate:

   `python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage.py`

6. Report the handoff diff summary and remind the user to restart OpenCode and
   paste the prompt block into the fresh session.
7. Do not commit, push, or edit deployed copies under `~/.config/opencode/`.
