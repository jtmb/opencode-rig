---
description: Deploy the local OpenCode v2 plugins to an isolated config directory.
agent: build
---

Deploy the local OpenCode v2 plugins from this repository. Ask the user for the
config directory and package selection before acting.

1. Read `AGENTS.md` and `docs/scripts/deploy-plugins.md` first.
2. Work from `~/repos/opencode-rig` and preserve unrelated dirty work.
3. Preview with:
   `./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh [--config-dir <dir>] --plugins <selection> --verify-only`
4. Select `both`, `all`, `server`, `cli`, or a catalog package name.
5. Review the preview, then repeat the exact command with `--apply`; keep the
   verification pass enabled and do not change options.
6. If `codex-fallback` has no configured chain, report that it remains inactive
   until `defaultChain` is configured (or offer `--chain a/b,c/d`).
7. Report target config files and remind the user to restart OpenCode.
8. Do not commit, edit deployed skill copies, or overwrite unrelated config.
   Existing plugin entries and options stay intact. If the deployment changes
   repository files, follow `docs/scripts/git-safety-gates.md`; never infer
   commit or push approval from deployment approval.
