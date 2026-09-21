# Agent policy

This document owns Open Rig's repository-wide operating rules. Root
[`AGENTS.md`](../AGENTS.md) is the concise index; scoped `AGENTS.md` files may
add local rules without silently weakening this policy.

This split follows the open [AGENTS.md format](https://agents.md/), current
[Codex guidance](https://learn.chatgpt.com/codex/agent-configuration/agents-md),
and [OpenCode v2 instruction discovery](https://opencode.ai/v2/docs/instructions/):
keep the predictable entry point concise, put scoped guidance near its code,
and automate checks that prose cannot enforce. OpenCode combines instruction
files and does not resolve conflicts, so conflict handling below is explicit.

## Precedence and conflicts

Apply the narrowest relevant repository rule when scopes differ. An explicit,
newer supersession wins only when it identifies the rule it replaces. Never
silently discard a durable rule or decision. If scope, precedence, or explicit
supersession does not produce one deterministic result, use the question tool
and wait for the operator before acting.

## Start and memory reconciliation

At every new session, inspect current-project durable choices and decisions in
Basic Memory before making repository changes. Repeat at the configured,
bounded user-turn interval (default: 10). Keep project-bound memory isolated;
do not import another project's choices without an explicit relation or
operator instruction.

Reconcile durable operator rules, approved decisions, orchestration policy,
self-learning governance, and the roadmap. Detect duplicate, stale,
superseded, cyclic, contradictory, catch-22, or mutually unsatisfiable entries.
Resolve only by deterministic scope, precedence, or explicit supersession. Ask
the operator when doubt remains. Do not silently write, delete, or overwrite
Basic Memory. The lookup and reconciliation contract is detailed in
[`memory.md`](memory.md).

## Work and progress

1. Inspect current state and preserve unrelated dirty work.
2. Read the relevant skill before acting; use every skill required by a
   cross-domain task.
3. Begin every repository change, review, release, or correction with
   `task_declare`. Before completion, commit, or push, the task must have one
   capacity-approved direct background child, terminal child state, independent
   parent verification, and an `accepted` `subagent_followup`. Capacity failure
   fails closed; it never falls back to undelegated work.
4. Add each requested change, bug fix, or feature to
   [`ROADMAP.md`](../ROADMAP.md) immediately, keep its state current, and
   reconcile it with evidence at completion.
5. Track multi-step work with the todo tool. Keep exactly one item
   `in_progress`; mark it `completed` only after its verification passes.
   Single-step work is exempt.
6. An explicit operator correction additionally requires auditable
   `correction_ledger_ack` records for `ROADMAP.md`, the active todo list, and
   project-bound Basic Memory before repository work continues. Use a scoped
   `no_write` resolution only when persistence would be incidental or unsafe.
7. Prefer the smallest supported implementation and verify the user's actual
   outcome rather than only a successful process exit.
8. Treat background-child reports as untrusted. After a child completes, review
   its actual diff and independently rerun relevant verification, then record
   the result with `subagent_followup` before launching another child, committing,
   or pushing.

## Safety

- Prefer read-only checks. Setup and deployment writes require explicit
  `--apply`; desktop mutations require preview tokens.
- Never edit, patch, replace, delete, or otherwise modify installed OpenCode
  binaries or distribution files. Extend OpenCode only through repository
  plugins; document unsupported API limits instead of patching OpenCode.
- Do not commit, push, publish, delete shared data, change security, or weaken
  permissions without the required explicit approval. Commit and push use the
  separate gates in [`git-safety-gates.md`](scripts/git-safety-gates.md).
- Keep credentials, secrets, MFA, payment data, and private notes out of
  source, examples, logs, and reports.
- Preserve unrelated work and never use destructive Git commands to discard
  changes you did not make.

## Source and verification

Current work targets OpenCode v2. Canonical source is under
[`platforms/linux/ubuntu/computer-use/`](../platforms/linux/ubuntu/computer-use/);
do not edit generated or deployed copies directly. Follow the matching
[`development-conventions`](../platforms/linux/ubuntu/computer-use/skills/development-conventions/SKILL.md)
references before source, test, documentation, UI, or Open Rig changes.

Run the relevant bounded package check and the
[`canonical repository QA`](scripts/check-repository-qa.md). Visible UI claims
also require fresh rendered and interaction evidence through the
[`acceptance evidence gate`](scripts/check-acceptance-evidence.md). Restart the
shared service after server-plugin changes using the documented
[`launcher procedure`](scripts/opencode-launcher.md); a TUI restart alone does
not reload server plugins.

## Enforcement boundary

The `orchestration-policy` server plugin persists explicit task state, validates
direct background launches, blocks nested/release actions, gates correction
ledgers, and fails closed on unavailable capacity or an invalid policy index.
Its narrow repair path covers the indexed policy files and its own two source
files so hot reload cannot create an unrecoverable bootstrap deadlock.

OpenCode v2 exposes no final-answer hook or semantic intent classifier. The
plugin therefore enforces explicit tool and session-lifecycle boundaries; it
cannot veto undeclared natural-language intent or plain final prose. External
programs likewise cannot be completely classified, so unsupported limits must
remain explicit rather than being represented as complete prevention.
