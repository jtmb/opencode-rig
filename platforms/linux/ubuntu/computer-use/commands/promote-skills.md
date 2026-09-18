---
description: Promote canonical repository skills to the running OpenCode stack's skill directory and verify the complete deployment.
agent: build
---

Promote the canonical OpenCode skills from this repository to the running
harness: the v1 global directory `~/.config/opencode/`, or the v2 pilot config
directory under `~/.opencode-v2-pilot/config/`.

1. Read `AGENTS.md` and the `skill-maintenance` skill before acting. Determine
   the running stack: the v2 pilot runs `~/.local/opt/opencode-v2/opencode`
   with config under `~/.opencode-v2-pilot/`; a plain `opencode` session is v1.
2. Work from `~/repos/opencode-rig` and preserve unrelated dirty work.
3. Run the documentation validator before deployment:

   `python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py`

4. Deploy through the repository-managed, content-aware path for the running
   stack:

   v2: `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode-v2.sh --apply`

   v1: `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply`

5. Verify source-to-deployed parity:

   v2: `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode-v2.sh --verify-only`

   v1: `./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only`

6. Confirm the expected skills are discoverable: the v2 health check reports the
   16 skill links; for v1 run `opencode debug skill`.
7. Do not edit `~/.config/opencode/skills/` directly, delete preserved global
   files, commit changes, or weaken permissions. Report validation, deployment,
   discovery, and any real failure.

Remind the user that an already-running OpenCode session must be restarted to
load changed skill or command definitions.
