# Computer-use scripts

| Script | Documentation | Purpose |
|---|---|---|
| `opencode-launcher.sh` | [`opencode-launcher.md`](opencode-launcher.md) | Run isolated V2 and open its built-in web UI |
| `opencode-launcher-self-test.py` | [`opencode-launcher.md`](opencode-launcher.md) | Exercise no-write probes, pass-through, and web compatibility |
| `setup-opencode.sh` | [`setup-opencode.md`](setup-opencode.md) | Verify or deploy the v2 skills, commands, and config |
| `check_opencode_web_qa_contract.py` | [`opencode-web-qa.md`](opencode-web-qa.md) | Check that the written OpenCode Web QA contract remains complete |
| `setup-plugin-dependencies.sh` | [`setup-plugin-dependencies.md`](setup-plugin-dependencies.md) | Verify or install the exact repository Ponytail dependency and core surface |
| `setup-plugin-dependencies-self-test.py` | [`setup-plugin-dependencies.md`](setup-plugin-dependencies.md) | Prove default resolution, missing-dependency failure, and bounded install planning |
| `setup-qa-runtime.py` | [`setup-qa-runtime.md`](setup-qa-runtime.md) | Verify or install the checksum-pinned checkout-local Node/npm QA runtime |
| `setup-qa-runtime-self-test.py` | [`setup-qa-runtime.md`](setup-qa-runtime.md) | Exercise archive safety, runtime isolation, and atomic no-replace install |
| `deploy-plugins.sh` | [`deploy-plugins.md`](deploy-plugins.md) | Register v2 packages in an isolated config |
| `deploy-hermes-plugin.py` | [`deploy-hermes-plugin.md`](deploy-hermes-plugin.md) | Verify or install the opt-in Hermes observer plugin into a profile |
| `deploy-hermes-plugin-self-test.py` | [`deploy-hermes-plugin.md`](deploy-hermes-plugin.md) | Exercise install, stale repair, symlink/repo refusal, and telemetry printing |
| `verify-opencode-v2.sh` | [`verify-opencode-v2.md`](verify-opencode-v2.md) | Read-only v2 health check |
| `setup-computer-assistant.sh` | [`setup-computer-assistant.md`](setup-computer-assistant.md) | Verify or configure Ubuntu computer-use dependencies |
| `mcp_runtime.py` | [`mcp_runtime.md`](mcp_runtime.md) | Own the canonical MCP policy, profile state, and runtime checks |
| `setup-mcps.sh` | [`setup-mcps.md`](setup-mcps.md) | Provision or verify canonical profile-aware MCP runtimes |
| `basic-memory-mcp.sh` | [`basic-memory-mcp.md`](basic-memory-mcp.md) | Launch bounded, profile-aware Basic Memory MCP |
| `check-plugin-resource-guards.py` | [`check-plugin-resource-guards.md`](check-plugin-resource-guards.md) | Enforce bounded v2 package checks |
| `check-git-safety-policy.py` | [`git-safety-gates.md`](git-safety-gates.md) | Validate the separate commit and push approval policy |
| `check-acceptance-evidence.py` | [`check-acceptance-evidence.md`](check-acceptance-evidence.md) | Validate portable runtime, visual, interaction, and subagent evidence |
| `check-acceptance-evidence-self-test.py` | [`check-acceptance-evidence.md`](check-acceptance-evidence.md) | Exercise passing and failing acceptance-evidence manifests |
| `check-repository-qa.py` | [`check-repository-qa.md`](check-repository-qa.md) | Run canonical fixed-argv repository QA evidence |
| `check-repository-qa-self-test.py` | [`check-repository-qa.md`](check-repository-qa.md) | Exercise focused QA failure diagnostics |
| `recover-orchestration-lockout.py` | [`orchestration-lockout-recovery.md`](orchestration-lockout-recovery.md) | Dry-run or audit an operator-authorized allowlisted policy recovery |
| `recover-orchestration-lockout-self-test.py` | [`orchestration-lockout-recovery.md`](orchestration-lockout-recovery.md) | Exercise recovery refusals, dry-run, backup, manifest, and audit behavior in disposable trees |
| `opencode-recovery.py` | [`opencode-recovery.md`](opencode-recovery.md) | Diagnose an explicitly selected V2 service or recover Basic Memory readiness without claiming `read_note` proof |
| `opencode-recovery-self-test.py` | [`opencode-recovery.md`](opencode-recovery.md) | Run the fixture-backed recovery CLI unittest suite through canonical QA |
| `run-bounded-command.sh` | [`run-bounded-command.md`](run-bounded-command.md) | Execute a bounded child command |
| `check-run-bounded-command-self-test.py` | [`run-bounded-command.md`](run-bounded-command.md) | Exercise bounded-command queueing, timeout, cleanup, and fail-closed behavior |
