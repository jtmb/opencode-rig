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

Standing orchestration directives are persisted in the project-bound
`computer-assistant` Basic Memory as `decision`/`preference` notes. Reconcile
that record at session start before planning or launching children; do not
substitute an unpersisted prompt copy for the durable directive.

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
   `task_declare`. The configured `orchestration-policy.options.maxConcurrent`
   is the only child-concurrency admission gate and accepts `1..10`. The
   host/cgroup `agent_memory_capacity` estimate is diagnostic only: its count,
   invalid or unavailable result, or absence must never reduce or block
   configured launch admission. Launch only asynchronous children using
   identities supported and selected by the active project configuration. The
   reusable orchestration plugin must not globally constrain agent or model
   identity. Before ordinary parent mutation, the task must have at least one
   direct background child, terminal child state, independent parent
   verification, and an `accepted` `subagent_followup`.
 4. Add each requested change, bug fix, or feature to
    [`ROADMAP.md`](../ROADMAP.md), the repository `roadmap.md` ledger, immediately, keep its state current, and
   reconcile it with evidence at completion.
 5. Track multi-step work with the todo tool. Keep exactly one item
    `in_progress`; mark it `completed` or `cancelled` only after its verification
    passes or the operator's cancellation is recorded. `task_complete` remains
    blocked while any actionable Todo is pending or `in_progress`.
   Single-step work is exempt. Delegate every actionable todo to exactly one
   background child. Each todo's text must be a READABLE FULL TASK: description
   first, then the task detail, with NO session IDs anywhere in it. The todo's
   leading task text must exactly match the child's `subagent({ description })`
   value shown in the Active Subagents sidebar panel—same wording, no drift—so
   the operator can line the two up. Session IDs are parent-only tracking in
   the parent's plan-file child registry and follow-up records; they never
   appear in shared todo text. Dispatch the entire actionable todo batch in
   parallel up to the configured `maxConcurrent` limit; the single parent
   `in_progress` marker is bookkeeping and must not serialize that batch.
   Concurrent writers isolate work in separate checkouts or worktrees and
   integrate through reviewed merges; pass any shared contract verbatim to
   every dependent child. The parent coordinates, verifies, and records
   follow-up, but does not implement a delegated todo.
6. An explicit operator correction additionally requires auditable
   `correction_ledger_ack` records for `ROADMAP.md`, the active todo list, and
   project-bound Basic Memory promptly after `task_declare` and before
   launching children or mutating the repository. The fail-closed guard blocks
   both parent and child mutations when an acknowledgement is missing. Use a
   scoped `no_write` resolution only when persistence would be incidental or
   unsafe; do not launch first and reconcile later.
7. Prefer the smallest supported implementation and verify the user's actual
   outcome rather than only a successful process exit.
8. Treat background-child reports as untrusted. After a child completes, review
   its actual diff and independently rerun relevant verification, then
   immediately record an independent parent `subagent_followup` for that child
   (`accepted`, `changes_required`, or `failed`) before anything else: another
   child launch, parent mutation, task completion, commit, or push. Every
   launched child must complete and receive follow-up before task completion,
   commit, or push. This follow-up boundary does not prevent launching an
   initial configured-limit-admitted asynchronous batch.
9. After the delegation-only restriction activates, the parent still reviews
   the child's actual diff and may run the approved repository control-plane QA
   gates when the policy allows. When that restriction blocks a parent-run
   check, the parent commissions an independent read-only QA child and reviews
   that child's evidence instead; it must not claim a parent rerun that the
   policy blocked. Never set `parentImplementationOptOutEnv` to bypass the
   restriction.

## Bounded tool output and diff review

Before calling `git_diff`, select the narrowest useful file or directory and
choose a realistic `maxBytes` for the expected output (the tool allows at most
250000 bytes); request only the context needed. For known hunks or current file
text, prefer targeted `grep` or `read`. If `git_diff` reports an output-bound
error, do not retry the identical call or infer that the diff is clean. Narrow
the path/context or inspect targeted text; if a complete diff is required,
deliberately raise `maxBytes` within the tool limit and inspect the returned
diff.

For `read`, start at line 1 when the file length is unknown or it may be short;
use targeted `grep` to locate known text, and use a later offset only after
confirming the file's line count. If an offset is out of range, do not retry the
same offset; restart from line 1 or locate the text with `grep`.

For a missing-path error, read the tool's explicit `Did you mean` or suggested
paths and use the suggested existing path, or search/`grep` for the real
filename, instead of retrying guessed variants. Do not guess config filenames:
npm's builtin config is `.npmrc`, while `~/.npmrc` may simply not exist.

For `python_sandbox`, pass `timeoutMs` as an integer count of milliseconds
(for example, `20000`), not a string suffixed with `ms`; check the advertised
tool signature/schema before calling.

Inside Code Mode (`execute`), only the tools listed by the Code Mode catalog and
returned by `search` are callable, and outer-harness tools are not automatically
exposed there: the outer `grep` tool is not `tools.grep`. Before calling, look
up the exact catalog path and signature with `search` and confirm every required
key; never infer a Code Mode tool, or its required arguments, from an outer
tool's name. On 2026-09-22 an `execute` call used an unknown `tools.grep` and
then a `tools.text_fold` call that was missing its required `text` key; neither
dispatch was a clean or empty result.

For any bounded-tool error, do not repeat the identical request or interpret it
as empty/clean; check the advertised schema and correct the scope, range,
offset, timeout, or output limit first, or use a targeted alternative. When an
operator correction exposes reusable tool guidance, record it in this policy
and `ROADMAP.md`; a `tool_error_ack` alone is not durable guidance.

Delegation launches must use the direct `subagent` tool: one explicit
background launch per call. Never wrap a child launch inside `execute` or any
other Code Mode call; such a wrapped launch is rejected as a dispatch error and
is not a valid delegation. Parent implementation remains blocked after an
accepted follow-up, so use the control-plane QA gates or an independent
read-only QA child rather than a forbidden parent run or shell workaround.

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

OpenCode Web claims additionally require the authenticated Windows-default-
browser screenshot, accessible snapshot, startup/error review, and fresh
service/browser identity evidence in the
[`OpenCode Web QA guide`](scripts/opencode-web-qa.md). Keep live Windows,
browser-authentication, and service-coordination blockers explicit; portable
repository QA does not claim that live Web acceptance ran.

## Enforcement boundary

The `orchestration-policy` server plugin persists bounded task, child, and
correction-ledger state; validates direct background launches; gates child
follow-up, task completion, commit/push, tool-error acknowledgement, installed
OpenCode paths, and the policy index; validates configured `maxConcurrent` from
`1..10`; and fails closed on an invalid policy index. Host/cgroup
`agent_memory_capacity` estimates are diagnostic only and do not gate launches.
Pending actionable Todos block task completion, commit, and push with a bounded
remaining count. A genuinely absent
Todo state is allowed; malformed or unreadable Todo state blocks those
operations.

Concurrent writers isolate work in separate checkouts or worktrees and
integrate changes through reviewed merges. The plugin does not claim path-level
cross-task write locking. Hooks are ownership and approval guidance, not an
operating-system sandbox: arbitrary external programs, shell aliases, and
unrecognized tool calls cannot be completely controlled.

The plugin allows npm script metadata, a narrow set of exact read-only Git
status/diff commands, and one fixed, count-bounded `git log` argv with paging,
hooks, and fsmonitor disabled. OpenCode v2's plugin context exposes read-only
`ctx.vcs.status()`, but this API is not automatically surfaced as a model tool.
Other shell commands remain conservatively classified as mutations unless
specifically recognized by a supported tool boundary.

The operator-conducted recovery in
[`docs/scripts/orchestration-lockout-recovery.md`](scripts/orchestration-lockout-recovery.md)
is the accepted override only for a demonstrable bootstrap lockout where no
supported session, task, or repair path can mutate the allowlisted policy
files. It requires explicit operator authorization, a recorded reason, retained
backup and audit, plugin reload verification, and the normal checks. Never
disable this plugin or edit its storage; routine work still uses declared tasks
and delegated, independently verified children.

OpenCode v2 exposes no final-answer hook or semantic intent classifier, so the
plugin cannot force final-answer generation or veto plain final prose. Pending
actionable Todos block explicit task completion, commit, and push operations
instead. External programs likewise cannot be completely classified, so
unsupported limits must remain explicit rather than being represented as
complete prevention.
