# orchestration-policy (v2)

This server plugin enforces Open Rig policy at supported OpenCode v2 hook and
tool boundaries. It rejects foreground subagents, disallowed child agents or
models, launches over the configured concurrency ceiling, and launches that
exceed current host/cgroup memory capacity. The hard maximum is three children.

It also injects the active policy into model context, denies nested delegation
and commit/push gate tools for allowed child agents, and tracks child lifecycle
events until each child becomes idle. Invalid, unavailable, or zero memory
capacity fails closed: the launch is denied rather than admitted optimistically.
Child sessions are bound only to a pending direct launch and a validated
`session.created` event or single serialized session ID.

One task may own repeated batches of background children. Up to three may run
concurrently when both configured and live memory capacity permit; there is no
one-child-total task gate. When a tracked child becomes idle or is deleted, the
parent session gets a persisted follow-up obligation. Further child launches,
task completion, `repo_commit`, or `repo_push` are denied until the parent
reviews the untrusted child report,
independently verifies the work, and records an `accepted`, `changes_required`,
or `failed` result through `subagent_followup`. A child session cannot clear its
parent's obligation. Pending parent/child pairs and completed audit records live
in plugin storage; unknown child status after a service reload is resolved
through the supported session API before the obligation is created.

When `enforceAgentIndex` is enabled, every model context validates the regular,
non-symlink root `AGENTS.md` index and `docs/agent-policy.md`; recognized
repository mutation tools fail closed on drift. Installed OpenCode paths are
also denied for recognized mutation tools. Shell commands and external
programs cannot be perfectly classified, so the injected policy and repository
checks remain necessary rather than claiming complete operating-system
sandboxing. A drifted index may still be repaired through a bounded edit to
`AGENTS.md` or `docs/agent-policy.md`, avoiding a fail-closed deadlock.

When `memoryProject` is configured, every new session starts with a due rule
reconciliation. The hook reads only regular, non-symlink Markdown files below
the configured `memoryDirectory`, selects `decision` and `preference` notes
with a configured project-binding tag, and injects their bounded contents as
untrusted reference data. This avoids a second Basic Memory process and its
service-environment/startup races. Recognized repository mutations remain
blocked until `rule_reconciliation` records an audit. The check becomes due
again after the configurable user-turn interval. A reported conflict cannot
complete until a successful question-tool call is observed. The plugin never
writes, deletes, or overwrites Basic Memory. A lookup failure also requires
question-tool escalation and an explicit operator resolution; it cannot be
marked aligned.

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/plugins-v2/orchestration-policy",
      "options": {
        "backgroundOnly": true,
        "maxConcurrent": 3,
        "allowedAgents": ["explore", "general"],
        "allowedModels": [
          "openai/gpt-5.6-luna#max",
          "openai/gpt-5.6-sol#xhigh",
          "openai/gpt-6-astra#max"
        ],
        "enforceAgentIndex": true,
        "reconciliationIntervalTurns": 10,
        "memoryProject": "computer-assistant",
        "memoryDirectory": "/home/james/Documents/computer-assistant/basic-memory",
        "memoryBindings": ["open-rig", "opencode-rig"],
        "memoryReserveMiB": 512,
        "memoryPerAgentMiB": 256
      }
    }
  ]
}
```

`allowedModels` is optional; omitting it accepts the selected child agent's
configured model. `enabled` defaults to `true`; `backgroundOnly` defaults to
`true`; `maxConcurrent` defaults to `3` and cannot exceed `3`.
`reconciliationIntervalTurns` defaults to `10` and accepts `1` through `100`.
Reconciliation is enabled only when `memoryProject` and the absolute
`memoryDirectory` are both set; `memoryBindings` contains one or more project
tags. At most 512 directory entries, 32 matching notes, 64 KiB per note, and
4,000 injected characters per note are accepted. Symlinks and duplicate
permalinks fail closed. `enforceAgentIndex` defaults to `false` so a globally
loaded plugin does not impose Open Rig's index on unrelated projects.

## Explicit task tools and state machine

Repository work is enforced through explicit tools; plain language is not a
substitute for any of them:

- `task_declare` starts one parent task (`change`, `review`, `release`, or
  `correction`).
- `task_status` returns the persisted task record, including every bound child,
  per-child lifecycle/review state, and correction ledgers.
- `subagent` must be the direct tool call. Children run in the background; the
  policy admits as many as the live capacity allows, up to three concurrently.
  Each child must complete before the parent reviews it with
  `subagent_followup`.
- `correction_ledger_ack` records `updated` or scoped `no_write` evidence for
  `ROADMAP.md`, the active todo, and project-bound memory on correction tasks.
- `task_complete` records verified completion after at least one accepted
  follow-up, follow-up for every other launched child, and, for corrections,
  all three ledger acknowledgements.
- `rule_reconciliation` clears a due project-memory gate after the bounded
  lookup and any required question-tool escalation.

The parent state is `waiting` after declaration, `ready` after any child is
idle/deleted and its follow-up is `accepted`, and `completed` only after every
bound child is reviewed and `task_complete` runs. A `changes_required` or
`failed` follow-up permits replacement or supplemental children; it does not
unlock ordinary parent mutation. Correction workers remain blocked until all
required ledger acknowledgements exist, while non-correction workers may
perform the declared task's repository work.

## Fail-closed and API boundaries

Malformed or unavailable capacity, unmatched child-session events, invalid
restored records, policy-index drift, protected installed paths, traversal
targets, nested delegation, and execute-wrapped subagent launches are denied
or ignored without granting additional authority. An absolute `ROADMAP.md`
edit is the narrow bootstrap exception for repairing an invalid policy index,
but it still requires a declared task. Policy repair is limited to the indexed
policy files and the orchestration policy sources.

OpenCode v2 exposes no final-answer hook or semantic classifier. This plugin
cannot veto natural-language intent or plain final prose; enforcement is
limited to the explicit tool hooks, session lifecycle events, persisted state,
and injected policy instructions. Commit and push remain separate explicit
tool gates.

Run `npm run check --workspace orchestration-policy` from `plugins-v2/`.
