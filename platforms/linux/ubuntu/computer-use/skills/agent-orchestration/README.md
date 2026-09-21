# Agent Orchestration Usage

This guide explains requests for the `agent-orchestration` skill. The
agent-facing rules remain in [SKILL.md](./SKILL.md); OpenCode does not load this
usage guide automatically.

Category: `automation`

Tags: `agents`, `orchestration`, `delegation`, `verification`, `git-safety`

## Purpose and when to use it

Use this skill for bounded coordination of built-in subagents on every
repository change, review, correction, or release task.
Planning and reconnaissance use `explore`. Implementation and multi-step
execution normally use `general`, but Build retains access to all configured
subagents and may select an appropriate configured subagent. Never invent custom
worker, reviewer, or explorer agent IDs.

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
- The user-specified subagent cap, or the conservative default of two, never
  exceeding three concurrent child sessions. The cap is enforced by this
  procedure because no verified max-concurrency configuration field exists.
- Non-overlapping file or investigation ownership and dependencies.
- The Open Rig `agent_memory_capacity` tool from rig-tools. Before every batch,
  ask it whether host and cgroup memory supports the requested count X. Its
  contract returns an approved child count or an explicit unavailable/error
  result.
- Current repository instructions, branch, status, and unrelated dirty work.
- The active `opencode.json` settings for `agents.explore` and
  `agents.general`, which may override model choices. Use Luna when selected by
  configuration or requested by the user.
- Plan/reconnaissance primary permissions, which may restrict launched IDs to
  `explore`. Build primary permissions must retain access to all configured
  subagents; they must not be reduced to `general`.
- That the main agent owns config edits; this skill does not edit
  `opencode.json`.
- The checks that the main agent will independently run afterward.

Do not expose secrets or protected fields in prompts. Do not assume an agent,
MCP server, command, or integration exists unless the current environment
actually provides it.

## How to request it

Describe the bounded work, the delegation cap, and the approval boundaries in
ordinary language. For example:

- "Use at most three concurrent child sessions to inspect these two disjoint directories; return
  findings only and preserve my dirty work."
- "Use explore for reconnaissance and general for implementation, then verify
  every claim yourself."
- "Prepare changes through subagents, but ask separately before any commit and
  separately again before any push."

These are representative requests, not commands executed while writing this
guide.

## Worked workflow and expected result

1. Confirm delegation is authorized and set the hard cap.
2. Inspect instructions and status; record exclusions and preserve dirty work.
3. Partition disjoint tasks and write complete prompts with expected evidence;
   use `explore` for planning/reconnaissance and normally `general` for
   implementation while retaining Build access to all configured subagents.
4. Before each batch, including replacements or additional batches, request
   capacity for X from `agent_memory_capacity`. Launch no more than the lower
   of its approved count, the user cap, and three concurrent child sessions.
   If the tool is missing or unavailable, fail closed rather than falling back
   to undelegated work or guessing.
5. Run every child as an asynchronous/background session with
   `background: true`, including blocking dependencies and reviews, so the
   parent can continue or return control. Never launch a foreground subagent
   and do not poll background agents.
6. Re-read relevant files and reconcile every delivered completion against
   repository state; independently verify each result.
7. Record an accepted `subagent_followup` after independent review, make only
   the requested parent edits, and use `task_complete` after verification.
8. Report the tasks, capacity decisions, cap used, exact changes, verification
   results, and caveats.

Expected result: delegation reduces bounded work without transferring
ownership, overlapping edits, or weakening verification.

## Verification and known limitations

Subagent statements are leads, not evidence. The main agent must independently
inspect files, diffs, test output, and the final outcome. A report that says
"done" or "passed" is insufficient without a reproducible check.

Independent tasks can run asynchronously, but dependent tasks cannot. Parallel
agents may still produce inconsistent recommendations; resolve those by
checking the source of truth, not by averaging claims. Project `opencode.json`
may override `agents.explore` and `agents.general`, including model choices.
Plan/reconnaissance permissions may restrict IDs to `explore`; Build retains
access to all configured subagents. A cap limits concurrency and total
delegated scope; it does not authorize broader work.

The capacity check is mandatory before every batch. `agent_memory_capacity`
accepts requested child count X, checks host and cgroup memory, and returns an
approved count or an explicit unavailable/error result. If it cannot be called,
the repository task remains blocked. Never poll background sessions; process
each completion when delivered.

OpenCode v2 has no semantic intent classifier or final-answer hook. Enforcement
therefore uses explicit `task_declare`, correction-ledger, child lifecycle,
follow-up, and `task_complete` boundaries; plain final prose cannot be vetoed.

## Troubleshooting

- Overlapping scope: stop, preserve the worktree, and re-partition by file or
  read-only responsibility.
- Incomplete prompt: stop the task and resend objective, boundaries, inputs,
  expected output, and verification requirements.
- Agent unavailable or denied: inspect configured built-in agents and primary
  permissions; do not substitute a custom agent ID or bypass policy.
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
