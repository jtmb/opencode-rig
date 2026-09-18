---
description: Deploy the local OpenCode plugins, and optionally the bootstrap scripts, to the global config, a repository, or the v2 config directory.
agent: build
---

Deploy the local OpenCode plugins from this repository to an OpenCode
installation. Ask the user where the deployment should go before acting.

1. Read `AGENTS.md` and `docs/scripts/deploy-plugins.md` before acting; for a
   v2 target also read `docs/scripts/setup-opencode-v2.md`.
2. Work from `~/repos/opencode-rig` and preserve unrelated dirty work.
3. Use the `question` tool to ask for the deployment target:
   - `Global` — register for every project under `~/.config/opencode` (v1).
   - `A specific repository` — register in that repository's `.opencode/`
     directory (v1).
   - `OpenCode v2 config directory` — register the `plugins-v2` packages under
     `~/.opencode-v2-pilot/config`, or a path the user names.
4. If the user chose a repository, use the `question` tool again to confirm the
   absolute path. Offer the current repository as an option and let the user
   type another path.
5. Use the `question` tool to ask which plugins to register:
   - v1: `both` (the Codex quota and fallback pair), `all` (including
     source-control, tui-settings, and file-manager), or one named plugin.
   - v2: `both` (the Codex pair), `all` (all six packages), `server`, `cli`, or
     one of `rig-tools`, `rig-todo`, `codex-fallback`, `source-control`,
     `codex-usage`, `file-manager`. `tui-settings` is retired in v2.
6. Use the `question` tool to ask whether to also deploy the bootstrap scripts
   (a verbatim copy of `computer-use/scripts/` into the target). This applies to
   v1 targets only.
7. Preview the exact change, read-only:

   v1:
   `./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope <global|project> --project <path-if-project> --plugins <selection> [--bootstrap] --verify-only`

   v2:
   `./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --v2 [--config-dir <dir>] --plugins <selection> --verify-only`

8. Review the preview, then repeat the same command with `--apply` and let its
   verification pass run. Do not change any option between the preview and the
   apply.
9. If `codex-fallback` is being added without a configured chain, tell the user
   it stays inactive until `defaultChain` is set, or offer `--chain a/b,c/d`.
10. Report the target config files and any copied scripts, and remind the user to
    restart OpenCode so the plugin registration takes effect.
11. Do not commit, do not edit deployed skill copies, and do not overwrite
    unrelated configuration. Existing plugin entries and their options must
    stay intact.
