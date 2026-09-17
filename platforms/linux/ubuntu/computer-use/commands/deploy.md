---
description: Deploy the local OpenCode plugins, and optionally the bootstrap scripts, to the global config or a repository.
agent: build
---

Deploy the local OpenCode plugins from this repository to an OpenCode
installation. Ask the user where the deployment should go before acting.

1. Read `AGENTS.md` and `docs/scripts/deploy-plugins.md` before acting.
2. Work from `~/repos/opencode-rig` and preserve unrelated dirty work.
3. Use the `question` tool to ask for the deployment target:
   - `Global` — register for every project under `~/.config/opencode`.
   - `A specific repository` — register in that repository's `.opencode/`
     directory.
4. If the user chose a repository, use the `question` tool again to confirm the
   absolute path. Offer the current repository as an option and let the user
   type another path.
5. Use the `question` tool to ask whether to also deploy the bootstrap scripts
   (a verbatim copy of `computer-use/scripts/` into the target).
6. Preview the exact change, read-only:

   `./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope <global|project> --project <path-if-project> [--bootstrap] --verify-only`

7. Review the preview, then repeat the same command with `--apply` and let its
   verification pass run. Do not change any option between the preview and the
   apply.
8. If `codex-fallback` is being added without a configured chain, tell the user
   it stays inactive until `defaultChain` is set, or offer `--chain a/b,c/d`.
9. Report the target config files and any copied scripts, and remind the user to
   restart OpenCode so the plugin registration takes effect.
10. Do not commit, do not edit deployed skill copies, and do not overwrite
    unrelated configuration. Existing `plugin` entries and their options must
    stay intact.
