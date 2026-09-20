# AGENTS.md — Open Rig index

This file is the repository's concise agent index. Follow every linked rule
that applies to the current path and task; do not duplicate those rules here.

## Rules

- [Agent policy](docs/agent-policy.md) — work flow, precedence, safety,
  progress, roadmap tracking, verification, and OpenCode binary protection.
- [Memory](docs/memory.md) — project-scoped Basic Memory lookup and durable
  rule/decision reconciliation.
- [Commit and push gates](docs/scripts/git-safety-gates.md) — separate explicit
  approval protocols for commits and pushes.
- [Development conventions](platforms/linux/ubuntu/computer-use/skills/development-conventions/SKILL.md)
  — source, test, documentation, UI, and Open Rig conventions.

## Important files

- [README.md](README.md) — architecture and user-facing entry point.
- [ROADMAP.md](ROADMAP.md) — mandatory requested-change and evidence ledger.
- [HANDOFF.md](HANDOFF.md) — current runtime state and continuation prompt.
- [documentation-map.json](documentation-map.json) — source-to-document rules.
- [Computer-use source](platforms/linux/ubuntu/computer-use/README.md) — canonical
  skills, plugins, configuration, scripts, and deployment boundaries.
- [Documentation index](docs/README.md) — detailed operational references.

## Verification

- [Canonical repository QA](docs/scripts/check-repository-qa.md)
- [Acceptance evidence gate](docs/scripts/check-acceptance-evidence.md)
- [Shared-service restart procedure](docs/scripts/opencode-launcher.md)

Only the root index exists today. A future nested `AGENTS.md` may add
subtree-specific links; it must not silently contradict a broader rule. If
scope, precedence, or explicit supersession does not resolve a conflict, use
the question tool before acting.
