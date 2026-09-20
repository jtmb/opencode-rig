---
description: Promote canonical repository skills to the active OpenCode v2 config and verify deployment.
agent: build
---

Promote canonical skills from this repository to the active isolated v2 config.

1. Read `AGENTS.md` and the `skill-maintenance` skill. Preserve unrelated dirty work.
2. Run `python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py`.
3. Apply with `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply`.
4. Verify with `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only`.
5. Confirm the health check reports the complete skill-link set.
6. Never edit deployed copies, delete preserved user files, or commit changes.
   Restart OpenCode after deployment.
