# Repository learning (v2)

Repository learning observes bounded event metadata by default and exposes
read-only status, audit, artifact review, and pending reflection proposals. It
does not persist prompts, tool inputs or outputs, transcripts, or error text.

## Configuration

Configure the local plugin with the v2 plugin object form in the project
`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning",
      "options": {
        "enabled": true
      }
    }
  ]
}
```

`enabled` is the sole supported runtime option. It defaults to `true` when
omitted; only the literal boolean `false` opts out. A malformed value is
diagnosed and safely defaults to `true`. Unsupported option keys are ignored and
reported. The plugin reads this object from the v2 `ctx.options` setup context;
it does not use environment variables.

```json
{
  "package": "./platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning",
  "options": {
    "enabled": false
  }
}
```

When disabled, `/learn status` reports that observation is disabled by
configuration and `/learn audit` can inspect retained episodes. The server does
not subscribe to observation events or write plugin storage while disabled.

Safety bounds are fixed policy limits, not additional config options: up to 512
events per episode, 200 retained episodes, 64 pending sessions, 256 KiB of
pending event data, 512 KiB serialized state, and 30 days of retained history.
Idle heartbeats after 15 minutes are dropped. Event summaries contain only
bounded event names and counts/outcomes.

## Commands and review

- `/learn status` — report whether observation is active and how many episodes
  are retained.
- `/learn audit` — show a bounded read-only summary of recent episodes.
- `/learn-review` or `Ctrl+Alt+L` — open the separate artifact review panel.

Persistent `/learn pause` and `/learn resume` controls have been removed. The
project plugin option is the only operational opt-out. Existing schema-1 state
is migrated: a legacy `paused: true` value is ignored, valid bounded history is
retained, and the migration is reported in status/audit diagnostics and server
logs.

## Reflection and completion checks

At an idle boundary, a meaningful bounded episode creates a repository-scoped
obligation. The obligation contains only the episode's bounded summary, event
counts, boundary, and opaque repository/session/episode identifiers. It is
deduplicated across replay and retained for 30 days. Prompts, tool inputs and
outputs, transcripts, and error text are not copied into reflection storage.

On the next model context for that repository session, pending obligations are
appended as explicitly untrusted JSON evidence. The model can call the genuine
`repo_learning_reflect` tool with the exact obligation ID and digest, either
proposing one safe repo-relative change or explaining why no change is
justified. A receipt is stored only after matching `execute.before` and
successful `execute.after` hooks verify the actual session, agent, message, and
tool-call IDs. Passive events, RPC calls, and direct executor calls do not
produce receipts. Storage retains safe attribution metadata and proposal or
no-change digests, never the free-text proposal or rationale. Proposals remain
pending review and are never applied by this plugin.

The server RPC `RepoLearning.checkTaskCompletion({ sessionID })` returns whether
that session's obligations have receipts, along with missing and conflicting
obligation IDs. A conflicting proposal keeps the check not-ready. The RPC is a
stable integration point; orchestration-policy and task-completion enforcement
do not call it in this phase.

Learning and governance tool calls, including `repo_learning_reflect`, are
excluded from creating reflection obligations for themselves. Unrelated tool
failures remain observable and can create normal reflection obligations.

When `enabled` is `false`, the plugin does not subscribe to observation events,
load or write reflection state, register the reflection tool, or install
reflection context/execution hooks. The status/audit and completion-check RPCs
remain available; completion reports learning as disabled.

This phase implements bounded observation-to-reflection and execution-verified
receipts. It does not complete end-to-end self-learning: approved application,
the Basic Memory mirror, bootstrap integration, and live hook/tool acceptance
remain separate work. Synthesis, promotion, retrieval, and optimization are not
active on the task path.

## Check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning run check
```
