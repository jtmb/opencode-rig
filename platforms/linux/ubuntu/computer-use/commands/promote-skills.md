---
description: Promote canonical repository skills to OpenCode's global skill directory and verify the complete deployment.
agent: build
---

Promote the canonical OpenCode skills from this repository to the current
user's global OpenCode directory.

1. Read `AGENTS.md` and the `skill-maintenance` skill before acting.
2. Work from `~/repos/opencode-rig` and preserve unrelated dirty work.
3. Run the documentation validator before deployment:

   `python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py`

4. Deploy through the repository-managed, content-aware path only:

   `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply`

5. Verify source-to-global parity:

   `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only`

6. Run `opencode debug skill` and confirm the expected skills are discoverable.
7. Do not edit `~/.config/opencode/skills/` directly, delete preserved global
   files, commit changes, or weaken permissions. Report validation, deployment,
   discovery, and any real failure.

Remind the user that an already-running OpenCode session must be restarted to
load changed skill or command definitions.
