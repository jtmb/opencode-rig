# orchestration-policy (v2)

This server plugin enforces generic orchestration safeguards at supported
OpenCode v2 hook and tool boundaries. It rejects foreground subagents and
launches over the effective concurrency ceiling. `maxConcurrent` is the hard
ceiling, bounded at ten; the operator can select single-subagent admission. Host/cgroup
`agent_memory_capacity` estimates are diagnostic only. The consuming project
remains responsible for choosing its agent and model identities.

It also injects the active policy into model context, denies nested delegation
and commit/push gate tools for tracked child agents, and tracks child lifecycle
events until each child becomes idle. A low, invalid, or unavailable memory
estimate never vetoes or delays launch admission. Child sessions are bound only
to a pending direct launch and a validated `session.created` event or single
serialized session ID.

One task may own repeated batches of background children. Up to the configured
`maxConcurrent` value (1–10) may run concurrently, regardless of the diagnostic
memory estimate; there is no one-child-total task gate. When a tracked child
becomes idle or is deleted, the parent session gets a persisted follow-up
obligation. Further child launches,
task completion, `repo_commit`, or `repo_push` are denied until the parent
reviews the untrusted child report,
independently verifies the work, and records an `accepted`, `changes_required`,
or `failed` result through `subagent_followup`. A child session cannot clear its
parent's obligation. Pending parent/child pairs and completed audit records live
in plugin storage. Later snapshots from the same task generation merge newly
recorded children; follow-up audit snapshots are computed inside the serialized
storage-write queue. Unknown child status after a service reload is resolved
through the supported session API before the obligation is created. Restored
active children are checked by exact session, parent, and project identity;
up to four concurrent `session.wait` checks share a 30-second per-child
get-and-wait deadline. Only confirmed idle frees admission and creates a
follow-up; a failed lookup, expired deadline, mismatched identity, or failed
durable lifecycle write leaves capacity reserved.
The parent can use `subagent_cancel` for an active direct child. Capacity remains
reserved until an idle, deletion, or terminal lifecycle event is observed and
the follow-up state is persisted; a fixed 30-second timeout leaves the child
active and capacity reserved.

Failed tools in an active top-level task create at most a bounded,
content-redacted obligation keyed by an opaque call digest. Duplicate hook
deliveries coalesce, and the obligation state is restored from plugin storage
after a service restart. `tool_error_ack` explicitly acknowledges one failure,
the bounded set, or corrupt persisted state; read-only work remains available,
but task completion (and commit/push) stays blocked until recovery. Child-tool
failures remain child follow-up evidence rather than becoming parent tool-error
obligations. Exact read-only Git status and diff commands plus one fixed,
count-bounded Git log command are allowed; other shell commands remain
conservatively classified as mutation surfaces because external command intent
cannot be classified completely.

When `enforceAgentIndex` is enabled by a project-local configuration, every
model context first checks for the regular, non-symlink Open Rig owner source
before validating that project's policy index;
recognized repository mutation tools fail closed on drift. Installed OpenCode
paths are also denied for recognized mutation tools. Shell commands and
external programs cannot be perfectly classified, so the injected policy and
repository checks remain necessary rather than claiming complete operating-
system sandboxing. The project-local index can use its bounded repair path to
avoid a fail-closed deadlock. An external consumer without the Open Rig owner
source does not inherit Open Rig-specific `AGENTS.md` links or
`docs/agent-policy.md` requirements, even when it sets
`enforceAgentIndex: true`. Leave this option disabled for unrelated projects
that do not need its generic safeguards.

When `memoryProject` is configured, every new session starts with a due rule
reconciliation. The hook reads only regular, non-symlink Markdown files below
the configured `memoryDirectory`, selects `decision` and `preference` notes
with a configured project-binding tag, and injects their bounded contents as
untrusted reference data. This avoids a second Basic Memory process and its
service-environment/startup races. Recognized repository mutations remain
blocked until `rule_reconciliation` records an audit. The check becomes due
again after the configurable user-turn interval. The latest audit and its
binding digests are persisted in plugin storage and restored on reload with
digest revalidation: an unchanged digest preserves the remaining cadence, while
changed, malformed, or unavailable state fails closed and marks the check due
again. A reported conflict cannot complete until a successful question-tool call
is observed. The plugin never writes, deletes, or overwrites Basic Memory. A
lookup failure also requires question-tool escalation and an explicit operator
resolution; it cannot be marked aligned.

## Parent implementation delegation

Parent implementation delegation is enabled by default, independently of the
background-child setting. After `task_declare`, parent implementation
mutations remain blocked even after an accepted child follow-up; children may
implement the delegated work under the existing task, correction-ledger,
installed-binary, and nested-agent limits. Parent coordination remains available
through task tools, Todo, rule reconciliation, question, follow-up, QA, and
read-only tools. The `AGENTS.md`, `docs/agent-policy.md`, and orchestration
source repair paths require an active task and, for correction tasks, completed
ledger acknowledgements. They bypass the ordinary parent-ready and due-memory
checks only to let the enforced policy repair its own fail-closed bootstrap.
The `ROADMAP.md` bootstrap write is available only while the enforced index is
invalid, requires a declared task, and still requires rule reconciliation.

The environment opt-out is to declare an environment variable name in this plugin's
project-local `options` and set that variable in the OpenCode server process
environment:

```jsonc
{
  "plugins": [{
    "package": "/absolute/path/to/plugins-v2/orchestration-policy",
    "options": {
      "parentImplementationOptOutEnv": "OPEN_RIG_ALLOW_PARENT_WORK"
    }
  }]
}
```

With that explicit declaration, the exact string `OPEN_RIG_ALLOW_PARENT_WORK=true`
opts out of parent delegation-only enforcement. The exact string `false` or an
unset variable keeps delegation-only enforcement enabled. Any other value,
including an empty string or case/whitespace variant, is malformed: the plugin
logs a configuration-verification error, reports it in model context, keeps
parent mutations blocked, and leaves the other safety hooks loaded. The
`delegationOnly` option is not supported and cannot override this contract.
Malformed values keep parent delegation enforced. The environment and plugin
options are read once during setup, so their changes take effect after the
server plugin reloads or restarts.

## Operator workflow settings

The operator-only **Open Rig workflow settings** command in the CLI palette
controls six workflow enforcements without editing `opencode.json`:

| Setting | Default | OFF behavior |
|---|---:|---|
| `requireTaskDeclare` | ON | Repository mutations do not require an active `task_declare`; child launch and task-completion lifecycle operations still require their task state. |
| `strictShellClassification` | ON | A bounded allowlist of simple read-only commands (`df`, `du`, `file`, `id`, `ls`, `pwd`, `readlink`, `realpath`, `stat`, `uname`, `whoami`, `wc`) is allowed through as read-only. Unknown commands, shell operators, dynamic argv, and compound commands remain mutation surfaces. |
| `parentDelegationOnly` | ON | A declared parent task does not need an accepted child follow-up before parent implementation mutations. The existing exact `parentImplementationOptOutEnv=true` contract remains respected; malformed environment values keep delegation enforced. |
| `backgroundChildrenOnly` | ON | Child sessions may be launched in the configured foreground or background mode. |
| `correctionLedgers` | ON | Correction-task mutations do not require roadmap, Todo, and project-memory ledger acknowledgements. |
| `memoryReconciliation` | ON | Due-memory mutation blocking and automatic memory snapshot injection are both disabled. |

Press `Ctrl+P` and select **Open Rig workflow settings** to view persisted
values. Select **Orchestration mode** for **Parallel (default)** or
**Single-subagent**. Parallel fills configured capacity; single-subagent admits
one child at a time. Changing mode never cancels running or already admitted
children: a reduced limit drains naturally before the next launch. This explicit
operator choice supersedes the standing all-parallel-only directive for admission
concurrency; it changes none of the other enforcement settings or fixed gates.
These are the two dispatch topologies this Open Rig policy can enforce. Common
agent-workflow patterns also include ordered sequential pipelines, agent
handoffs, group chat and manager-led coordination ([Microsoft Agent Framework
overview](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/));
single-subagent limits admission to one child but does not claim to implement
pipeline ordering or those other workflow protocols.
The workflow-enforcement prompt accepts `<setting> on|off` or
`mode parallel|single-subagent`; the command
has no slash alias. OpenCode v2.0.7 exposes no native Open settings dialog
extension point, so this is the sole Rig workflow-settings surface. State is
stored outside the repository at
`${XDG_CONFIG_HOME:-~/.config}/opencode/orchestration-policy-settings.json`.
The version-1 schema accepts exactly the six boolean values and an optional
`orchestrationMode` enum (`parallel` or `single-subagent`). Older files default
to parallel. Writes use a
private mode-0600 temporary file and atomic rename. Missing state defaults every
workflow setting to ON; malformed, oversized, symlinked, unreadable, or
repository-local state is rejected and every workflow setting fails closed to
ON, and invalid settings block new child admissions and parent progress until
repaired through the operator palette. Settings never accept credentials or arbitrary
fields.

The server plugin re-reads and validates this file before each tool enforcement
hook and each prompt/context hook, so valid palette changes take effect on
the next hook without a restart. The environment-variable override above and
ordinary `opencode.json` plugin options remain setup-time values and require a
server-plugin reload or restart. If any workflow setting is OFF, the palette
prompt shows a reduced-posture banner and model context names every OFF setting.

The fixed safety core is not represented by writable settings and is displayed
as always ON: installed OpenCode binaries and distribution files, protected
paths, policy-index validation when configured, separate commit and push
approval gates with exact staged-scope checks, secret handling, and
fail-closed settings behavior. Attempts to toggle a fixed safety entry are
refused by the workflow-settings command with the reason.

### Dispatch before progress

An active parent task must dispatch every unbound actionable Todo while effective
capacity is free before recognized implementation mutations, `goal_report(progress)`
or automatic Goal continuation. The shared preflight reads the bounded authoritative
Todo snapshot, validates child/reservation bindings, counts active, pending and
reserving children, and reports the unbound count, free slots, mode and configured
ceiling. It rechecks at Goal continuation time so a newly eligible Todo cannot be
skipped by an earlier progress report. Invalid Todo/settings state fails closed.
Pending follow-up and correction-ledger obligations retain priority. Full capacity
allows progress without demanding an impossible launch. Existing exact Todo ownership
and parent-follow-up rules still apply. Reads, Todo coordination, direct launches,
policy/roadmap repair and genuine `goal_report(blocked)` remain available.

V2 has no final-answer hook or semantic intent classifier. These tool and explicit
Goal-continuation checks cannot veto plain final prose or arbitrary external programs.

The delegation gate covers the plugin's recognized direct mutation tools and
recognized Code Mode `execute` calls, including shell, npm, repository commit
and push, desktop, Docker, patch/edit/write, binary replacement, task
completion, and GitHub repository-write wrappers. Read-only GitHub calls remain
available without a task. Direct `github.issue_write` and Code Mode calls that
contain only an issue write are external mutations: they require an active
declared task, all three correction-ledger acknowledgements for correction tasks,
and any configured due-memory reconciliation. This external-only path skips the
project-local policy-index, protected-path, and parent implementation-delegation
gates because it does not write to the checkout. It does not skip task,
correction-ledger, or memory-reconciliation requirements. A Code Mode call that
combines an issue write with a local write or dynamic shell command uses the
ordinary mutation gates; quoted strings and comments that merely resemble tool
calls remain read-only. GitHub Code Mode calls that create or update Git refs or
commits (including branch/file writes, file deletion, PR merges, and PR branch
updates) are treated as commit/push operations and must use the separate
`repo_commit` or `repo_push` approval gates. Read-only Git status and diff
commands are available, as is exactly
`git --no-pager -c core.hooksPath=/dev/null -c core.fsmonitor=false log --max-count=10 --oneline`;
all other Git log argv and shell commands remain mutations. OpenCode v2's plugin
context also exposes read-only `ctx.vcs.status()`, but does not automatically
register it as a model or Code Mode tool. Other shell commands are conservatively
treated as mutation surfaces, except for two exact OpenCode identity probes:
`opencode-launcher.sh service status` and `opencode-launcher.sh api get
/api/info`. A direct configured installed binary is allowed only for the exact
`api get /api/info` argv. Default protected paths include
`$HOME/.opencode/bin/opencode` without allowlisting arbitrary home-directory
executables. These checks reject quoting, extra arguments, shell operators, and
dynamic argv; they do not authorize service restart or installed binary writes.
Use the configured `repo_qa_gate` and
`repo_documentation_gate` for bounded QA and documentation checks.
`repo_commit` and `repo_push` receive no special release-task exemption: the
separate staged-scope, QA/documentation evidence, and explicit approval gates
continue to apply when parent delegation is opted out. Direct child launch and
task completion remain control-plane operations and retain their own
task/follow-up gates. This source behavior still requires a live loaded-policy
check before claiming runtime acceptance.

This is hook-level coverage, not an operating-system sandbox. Arbitrary external
programs and unrecognized or aliased/obfuscated Code Mode calls cannot be
classified completely. OpenCode v2 has no final-answer hook or semantic
classifier, so natural-language intent and plain final prose cannot be blocked.

## Configuration

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/plugins-v2/orchestration-policy",
      "options": {
        "maxConcurrent": 10,
        "enforceAgentIndex": false,
        "reconciliationIntervalTurns": 10,
        "memoryProject": "project-memory",
        "memoryDirectory": "/path/to/project-memory",
        "memoryBindings": ["project-binding"],
        "memoryReserveMiB": 512,
        "memoryPerAgentMiB": 256
      }
    }
  ]
}
```

Legacy `allowedAgents` and `allowedModels` options are ignored for backward
compatibility and should be removed from consuming configurations; identity
selection belongs to the consuming project's OpenCode configuration.
`enabled` cannot disable safety hooks; `enabled: false` is reported as a
configuration error while enforcement remains active. `backgroundOnly: false`
is ignored with a configuration warning; use the Ctrl+P **Open Rig workflow
settings** entry to change `backgroundChildrenOnly` instead. `maxConcurrent`
defaults to `10` and accepts `1` through `10`. Set it in
the orchestration-policy `options` object in the active project `opencode.json`;
it is the only child-concurrency admission gate. `memoryReserveMiB` and
`memoryPerAgentMiB` tune host/cgroup diagnostic estimates only; estimates never
reduce or block configured launch admission.
`reconciliationIntervalTurns` defaults to `10` and accepts `1` through `100`.
Reconciliation is enabled only when `memoryProject` and the absolute
`memoryDirectory` are both set; `memoryBindings` contains one or more project
tags. At most 512 directory entries, 32 matching notes, 64 KiB per note, and
4,000 injected characters per note are accepted. Symlinks and duplicate
permalinks fail closed. `enforceAgentIndex` defaults to `false`; enable it for
the canonical Open Rig checkout to enforce its policy index. External projects
may also enable it, but the Open Rig index check is active only when the bounded
owner-source marker is present.

## Scope and portability

This package is reusable across OpenCode projects. It does not maintain an
agent or model allowlist: the consuming project's configuration selects the
agent identity, and the resolved provider/model/variant is passed through.
Namespaced identities such as `@execution/example-worker` are valid, as are
provider/model values that are unknown to Open Rig. The configured
`maxConcurrent` value is the sole project concurrency gate. Host/cgroup capacity
estimates are diagnostic information and cannot reduce the configured count or
deny a launch.

`enforceAgentIndex` is an opt-in Open Rig project guard, not a global plugin
rule. When enabled, the active project is checked only when it contains the
canonical orchestration-policy source path; an unrelated project that globally
loads this plugin is not required to adopt Open Rig's `AGENTS.md` index. The
owner project still fails closed on missing or invalid indexed policy files,
with only the documented narrow repair path available. Keep this option
disabled for unrelated projects.

## Explicit task tools and state machine

Repository work is enforced through explicit tools; plain language is not a
substitute for any of them:

- `task_declare` starts one parent task (`change`, `review`, `release`, or
  `correction`). Optional `requiredClaimIDs` persist a bounded set of
  acceptance-evidence claim IDs for this task only.
- `task_status` returns bounded task, child lifecycle/review, and correction-ledger
  state; it does not expose ownership-scope fields.
- `subagent` must be the direct tool call. Children run in the background; the
  policy admits up to configured `maxConcurrent` (1–10) concurrently, regardless
  of the host/cgroup estimate.
  Each child must complete before the parent reviews it with
  `subagent_followup`.
- `correction_ledger_ack` records `updated` or scoped `no_write` evidence for
  the configured correction ledgers on correction tasks.
- `task_complete` records verified completion after at least one accepted
  follow-up, follow-up for every other launched child, and, for corrections,
  all three ledger acknowledgements. For tasks with `requiredClaimIDs`, it also
  requires a readable canonical version-3 `acceptance-evidence.json`, a known
  `complete` claim for every ID, and evidence references to regular
  non-symlink files beneath the project root. Visible claims need both
  `rendered_visual` and `interaction` references and cannot conflict with a
  pending UI inventory; unscoped tasks do not read or depend on the manifest.
  This task guard checks reference safety and existence; it does not hash or
  substantiate referenced evidence (including host screenshots) or run the
  independent `check-acceptance-evidence.py` validator.
- `tool_error_ack` records explicit recovery for bounded top-level tool-error
  obligations; sanitized diagnostic text is never an authority or raw log.
- `rule_reconciliation` clears a due project-memory gate after the bounded
  lookup and any required question-tool escalation; repeated calls after the
  gate is already clear are idempotent no-ops.

## Durable Goal and Plan→Build handoff

`plan_ready` is available only to a top-level Plan session. It records the
completed Plan's objective, concrete acceptance criteria, and implementation
plan; prose alone does not arm the handoff. Goal state is durable and scoped to
the session. `/goal <objective>` starts one, `/goal` views it, and `/goal pause`,
`/goal resume`, and `/goal clear` control it. The original objective remains
fixed until the Goal is cleared.

Handoff defaults to Manual per session. After a ready Plan succeeds, run
`/goal build` to request the server-side Build handoff; selecting Build only in
the local composer does not change the server session. Auto requests the
handoff after a successful Plan and server-observed idle state. Both paths
check for observed queued user input. The selected model and variant are
restored when OpenCode accepts them; otherwise Build's configured model remains
selected. Server execution and status events drive Auto handoff and continuation
without a connected TUI. Manual agent-selection events do not enqueue a Plan.
After a plugin restart, an older ready Auto Plan cannot prove its durable inbox
is empty: the startup check blocks it when idle and requires an explicit
`/goal build` when safe. A current-runtime execution still uses Auto normally;
an early idle event cannot automatically dispatch the older persisted Plan.

For a same-project Build session, Auto handoff removes `question` from the model
context, rejects direct calls in `execute.before`, and denies the `question`
action through per-session permission evaluation. V2 permission checks also
apply to nested Code Mode calls, including aliased or computed access. Invalid
or unreadable Goal state fails closed; Manual and Plan retain access. If a
durable-rule conflict or memory lookup fails, Auto Build stays blocked until
the operator switches the session to Manual before asking. No settings bypass
enables Build questions under Auto.

`goal_report` records model-reported progress, blockers, and completion evidence;
it does not independently verify that criteria are true. Completion requires
reported evidence for every Plan criterion and a successful `task_complete`
whenever a repository task is active. Automatic continuation requires explicit
progress evidence and a successful Build turn, with no queued user input. No
continuation is scheduled after a failed, interrupted, or no-progress turn.
Pausing or clearing invalidates the Goal marker and cancels a queued prompt when
the TUI can reach the inbox.

With Auto handoff, a Goal the plugin itself blocks on a transient, retryable
failure — a dispatch-preflight failure or a failed handoff queue — is re-driven
from the next observed idle for a bounded number of attempts. Each attempt
increments a persisted per-Goal budget that a repeated idle event cannot reset;
when the budget is exhausted the Goal stays blocked with a distinct reason that
names `/goal resume`. Model-reported blockers, missing approvals or credentials,
unsupported runtimes, Manual handoff, and restart fail-closed recovery never
auto-resume.

The driver uses `ctx.session.wait`, status and inbox events, and a fresh
`ctx.session.get`; it cannot see inbox items queued before event subscription.
V2 has no documented atomic “switch/enqueue only if idle and inbox-empty”
operation, so a user input can race the final server check. An isolated Manual
run also produced a Build turn before its queued Goal prompt and another after;
exactly-once handoff remains unverified until that initiating event is traced.

## Checkout isolation and roadmap continuity

Concurrent writers isolate work in separate checkouts or worktrees and
integrate through reviewed merges. The plugin does not arbitrate task writers by
filesystem path. Hooks are ownership and approval guidance, not an
operating-system sandbox; arbitrary external programs and unrecognized calls
cannot be completely controlled.

`task_complete`, `repo_commit`, and `repo_push` read the session's bounded Todo
state and refuse the operation while any item is `pending` or `in_progress`,
reporting the remaining count. The context hook adds one bounded reminder while
actionable Todos remain. Completed and cancelled items do not block these
operations. A genuinely absent Todo state is allowed, while malformed or
unreadable state fails closed. The parent still needs accepted child follow-up
and correction-ledger acknowledgements, and the separate commit/push approval
gates remain in force.

Before a direct background launch, policy durably reserves exactly one
actionable Todo with a matching description and stable id. The per-session
writer lease serializes `todowrite`, dispatch, and release. Successful launches
bind their child id; failures release only after the durable snapshot is
written and read back. Ambiguous duplicates or failed release keep the launch
guard active.

Before task completion, commit, or push, policy calls
`RepoLearning.checkTaskCompletion({ sessionID })`. Missing reflection receipts,
unresolved proposal conflicts, unavailable RPC, and malformed replies block
the operation. Recognized Code Mode calls are gated too; GitHub Code Mode
commit/push remains denied in favor of separate approval gates.

The parent state is `waiting` after declaration, `ready` after any child is
idle/deleted and its follow-up is `accepted`, and `completed` only after every
bound child is reviewed and `task_complete` runs. A `changes_required` or
`failed` follow-up permits replacement or supplemental children; it does not
unlock ordinary parent mutation. Correction workers remain blocked until all
required ledger acknowledgements exist, while non-correction workers may
perform the declared task's repository work.

## Fail-closed and API boundaries

Unmatched child-session events, invalid restored records, policy-index drift,
protected installed paths, traversal targets, nested delegation, and
execute-wrapped subagent launches are denied or ignored without granting
additional authority. Invalid or unavailable host/cgroup estimates remain
diagnostic and do not change admission. A project-local index may
define a narrow bootstrap exception for repairing its invalid policy index, but
it still requires a declared task. Policy repair remains limited to the indexed
policy files and the orchestration policy sources.

OpenCode v2 exposes no final-answer hook or semantic classifier, so this plugin
cannot force final-answer generation or veto plain final prose. It gates
explicit task completion and retains the separate commit/push approval gates.
Enforcement is limited to supported tool hooks, session lifecycle events,
persisted state, and injected policy instructions.

## Development and verification

From this package directory, run:

```bash
npm run check
```

The check runs bounded TypeScript typechecking followed by the complete test
suite. From the workspace root, the equivalent command is
`npm run check --workspace orchestration-policy` from `plugins-v2/`.
