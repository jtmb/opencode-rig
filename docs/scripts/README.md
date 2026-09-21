# Computer-use scripts

| Script | Documentation | Purpose |
|---|---|---|
| `opencode-launcher.sh` | [`opencode-launcher.md`](opencode-launcher.md) | Run isolated V2 and open its built-in web UI |
| `opencode-launcher-self-test.py` | [`opencode-launcher.md`](opencode-launcher.md) | Exercise launcher pass-through and web compatibility |
| `setup-opencode.sh` | [`setup-opencode.md`](setup-opencode.md) | Verify or deploy the v2 skills, commands, and config |
| `setup-ponytail-plugin.sh` | [`setup-ponytail-plugin.md`](setup-ponytail-plugin.md) | Safely install/update the official Ponytail package behind the v2 adapter |
| `setup-ponytail-plugin-self-test.py` | [`setup-ponytail-plugin.md`](setup-ponytail-plugin.md) | Prove failed activation restores the prior package and config |
| `deploy-plugins.sh` | [`deploy-plugins.md`](deploy-plugins.md) | Register v2 packages in an isolated config |
| `verify-opencode-v2.sh` | [`verify-opencode-v2.md`](verify-opencode-v2.md) | Read-only v2 health check |
| `setup-computer-assistant.sh` | [`setup-computer-assistant.md`](setup-computer-assistant.md) | Verify or configure Ubuntu computer-use dependencies |
| `mcp_runtime.py` | [`mcp_runtime.md`](mcp_runtime.md) | Own the canonical MCP policy, profile state, and runtime checks |
| `setup-mcps.sh` | [`setup-mcps.md`](setup-mcps.md) | Provision or verify canonical profile-aware MCP runtimes |
| `basic-memory-mcp.sh` | [`basic-memory-mcp.md`](basic-memory-mcp.md) | Launch bounded, profile-aware Basic Memory MCP |
| `playwright-mcp.sh` | [`playwright-mcp.md`](playwright-mcp.md) | Launch the canonical profile-aware Playwright MCP |
| `check-plugin-resource-guards.py` | [`check-plugin-resource-guards.md`](check-plugin-resource-guards.md) | Enforce bounded v2 package checks |
| `check-git-safety-policy.py` | [`git-safety-gates.md`](git-safety-gates.md) | Validate the separate commit and push approval policy |
| `check-acceptance-evidence.py` | [`check-acceptance-evidence.md`](check-acceptance-evidence.md) | Validate portable runtime, visual, interaction, and subagent evidence |
| `check-acceptance-evidence-self-test.py` | [`check-acceptance-evidence.md`](check-acceptance-evidence.md) | Exercise passing and failing acceptance-evidence manifests |
| `check-repository-qa.py` | [`check-repository-qa.md`](check-repository-qa.md) | Run canonical fixed-argv repository QA evidence |
| `check-repository-qa-self-test.py` | [`check-repository-qa.md`](check-repository-qa.md) | Exercise focused QA failure diagnostics |
| `run-bounded-command.sh` | [`run-bounded-command.md`](run-bounded-command.md) | Execute a bounded child command |
| `check-run-bounded-command-self-test.py` | [`run-bounded-command.md`](run-bounded-command.md) | Exercise bounded-command queueing, timeout, cleanup, and fail-closed behavior |
