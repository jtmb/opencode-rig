# Agent Orchestration Usage

This guide explains requests for the `agent-orchestration` skill. The
agent-facing rules remain in [SKILL.md](./SKILL.md); OpenCode does not load this
usage guide automatically.

Category: `automation`

Tags: `agents`, `orchestration`, `delegation`, `verification`, `git-safety`

## Purpose and when to use it

Use this skill for bounded coordination of configured subagents on every
repository change, review, correction, or release task. Each actionable todo
maps to exactly one background child; the full actionable todo batch is
dispatched in parallel within configured `maxConcurrent`. The parent remains
accountable for scope, decisions, reconciliation, independent verification, and
the final report, but does not implement delegated todos.
Planning, reconnaissance, implementation, and review use the identities
selected by the active project's OpenCode configuration. The reusable plugin
accepts project-defined and namespaced identities; never invent an identity the
active project does not support.
Open Rig's project profile maps `plan` and the read-only `architect` design
subagent to `openai/gpt-6-sol#max`, while `build`, `explore`, and `general`
select `openai/gpt-6-luna#max`. External repositories retain their own agent
and model choices.

Appropriate requests include:

- "Delegate independent documentation and test investigation, with no more
  than two subagents."
- "Have subagents inspect these separate modules, then reconcile the findings."
- "Use bounded parallel research, but do not let anyone commit or push."

Read-only conversational answers and bounded lookups with no repository outcome
do not require a task declaration or child.

## Prerequisites and setup verification

Before delegation, establish:

- The exact objective, acceptance criteria, and final decision owner.
- The project-bound Basic Memory standing directive, tagged
  `decision`/`preference`, reconciled at session start.
- The active project's `options.maxConcurrent` in `opencode.json`, supported
  from `1..10` and serving as the sole enforced child-concurrency admission
  gate. Respect any explicit lower task-specific user cap when planning.
- `agent_memory_capacity` is an optional, read-only host/cgroup diagnostic, not
  a launch prerequisite or admission limit.
- Non-overlapping file or investigation ownership and dependencies.
- One child for each actionable todo. Each todo's text must be a READABLE FULL
  TASK: description first, then the task detail, with NO session IDs anywhere
  in it. The todo's leading task text must exactly match the child's
  `subagent({ description })` value shown in the Active Subagents sidebar
  panel—same wording, no drift—so the operator can line the two up. Session IDs
  are parent-only tracking in the parent's plan-file child registry and
  follow-up records; they never appear in shared todo text. Pass shared
  contracts verbatim to every dependent child.
- The optional Open Rig `agent_memory_capacity` diagnostic from rig-tools. Its
  bounded estimate may be inspected when available, but it does not approve or
  gate launches; low, invalid, or unavailable results do not change configured
  admission.
- Current repository instructions, branch, status, and unrelated dirty work.
- The active `opencode.json` settings for agent identities and model choices.
  Do not claim a model is available without checking configuration.
- Primary permissions, which may restrict launched identities according to the
  active project's local configuration; the reusable plugin must not narrow
  that project-defined set globally.
- That the main agent owns config edits; this skill does not edit
  `opencode.json`.
- The checks that the main agent will independently run afterward.

Do not expose secrets or protected fields in prompts. Do not assume an agent,
MCP server, command, or integration exists unless the current environment
actually provides it.

## How to request it

Describe the bounded work, the delegation cap, and the approval boundaries in
ordinary language. For example:

- "Use at most ten concurrent child sessions to inspect these disjoint directories; return
  findings only and preserve my dirty work."
- "Use the project's configured identities for reconnaissance and
  implementation, then verify every claim yourself."
- "Delegate each actionable todo to exactly one background child in one parallel
  batch; keep each todo a readable full task aligned with its subagent
  description, track session IDs only in the parent registry, and follow up each
  child before any next launch or mutation."
- "Prepare changes through subagents, but ask separately before any commit and
  separately again before any push."

These are representative requests, not commands executed while writing this
guide.

## Worked workflow and expected result

1. Confirm delegation is authorized and set the hard cap. Read and reconcile
   the project-bound Basic Memory standing directive first. For a correction,
   acknowledge ROADMAP, the active todo, and project memory through
   `correction_ledger_ack` promptly, before launching children or mutating the
   repository; the fail-closed guard blocks parent and child mutations when an
   acknowledgement is missing.
2. Inspect instructions and status; record exclusions and preserve dirty work.
3. Partition disjoint tasks and write complete prompts with expected evidence.
   Assign exactly one background child to each actionable todo. When launching,
   use the complete task description as the child's `subagent({ description })`
   string and write that description verbatim as the todo's leading task text;
   keep the task detail readable and put no session ID in the todo. Track
   session IDs only in the parent's plan-file child registry and follow-up
   records, while keeping the leading text verbatim with the same child shown
   in Active Subagents. Pass shared contracts verbatim to dependent children.
   Dispatch the full actionable todo batch in parallel;
   use the active project's configured identities for planning, reconnaissance,
   and implementation while preserving its local permissions.
4. Keep child concurrency within configured `maxConcurrent` (`1..10`), the sole
   enforced admission gate, and any explicit lower task-specific user cap. The
   optional `agent_memory_capacity` diagnostic is not launch approval: do not
   delay or reduce admission based on its result, or on its absence.
5. Run every child as an asynchronous/background session with
   `background: true`, including blocking dependencies and reviews, so the
   parent can continue or return control. Never launch a foreground subagent
   and do not poll background agents.
6. Re-read relevant files and reconcile every delivered completion against
   repository state; independently verify each result.
7. After each child reaches a terminal state, record an independent parent
   `subagent_followup` immediately after review and verification
   (`accepted`, `changes_required`, or `failed`) before any next launch, parent
   mutation, task completion, commit, or push. Do not defer or batch
   follow-up; make only non-delegated parent edits.
8. Use `task_complete` only after every child has terminal state, independent
   verification, parent follow-up, and all required correction ledgers are
   complete.
9. Report the tasks, capacity decisions, cap used, exact changes, verification
   results, and caveats.

Expected result: delegation reduces bounded work without transferring
ownership, overlapping edits, or weakening verification.

## Verification and known limitations

Subagent statements are leads, not evidence. The main agent must independently
inspect files, diffs, test output, and the final outcome. A report that says
"done" or "passed" is insufficient without a reproducible check.

All actionable todos in an approved batch launch asynchronously together;
shared contracts are passed verbatim to dependent children rather than
creating a serial parent implementation path. Parallel agents may still
produce inconsistent recommendations; resolve those by checking the source of
truth, not by averaging claims. Project `opencode.json` may define the active
agent identities and model choices.
Primary permissions may restrict identities according to the active project. A
cap limits concurrency and total delegated scope; it does not authorize broader
work or impose a global identity restriction.

`agent_memory_capacity` is an optional, read-only host/cgroup diagnostic that
returns bounded estimates or an explicit unavailable result. It does not gate
launches: configured `maxConcurrent` alone controls child-concurrency admission,
even when estimates are low, invalid, unavailable, or the tool is absent. Never
poll background sessions; process each completion when delivered.

OpenCode v2 has no semantic intent classifier or final-answer hook. Enforcement
therefore uses explicit `task_declare`, correction-ledger, child lifecycle,
follow-up, and `task_complete` boundaries; plain final prose cannot be vetoed.

## Troubleshooting

- Overlapping scope: stop, preserve the worktree, and re-partition by file or
  read-only responsibility.
- Incomplete prompt: stop the task and resend objective, boundaries, inputs,
  expected output, and verification requirements.
- Agent unavailable or denied: inspect the active project's configured agents
  and primary permissions; do not substitute an unsupported identity or bypass
  policy.
- Conflicting reports: inspect the repository and acceptance criteria directly.
- Unexpected dirty changes: do not reset, checkout, clean, restore, or delete;
  isolate requested edits and ask the user if scope is unclear.
- Failed verification: report the failure and investigate directly; do not rely
  on a subagent retry as proof.

## Safety, confirmation, and elevation

- Neither subagents nor the orchestrator may commit or push without separate,
  explicit user approval for each action.
- Commit approval does not imply push approval. Re-confirm final scope,
  destination, and exact mutation immediately before each action.
- Before an approved commit, verify staged paths and report the commit hash.
  Before an approved push, verify remote, branch, and outgoing commits, then
  report and verify the remote result.
- Never use destructive Git actions or discard unrelated dirty work.
- Do not delegate secrets, authentication, payments, protected fields,
  publication, deletion, permissions, or other irreversible actions.
- Do not elevate privileges or change security settings through delegation.

## Related skills and documents

- [`skill-maintenance`](../skill-maintenance/README.md) covers canonical skill
  creation, catalog synchronization, and validation.
- [`routine-automation`](../routine-automation/README.md) covers repeatable
  workflows and schedules, not agent delegation itself.
- [`github-operations`](../github-operations/README.md) covers GitHub reads and
  separately approved remote mutations.
- Repository policy is in `AGENTS.md`, and the canonical catalog is in
  `skills/README.md`; these paths are outside the deployed skill bundle.
