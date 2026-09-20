# Learn Observe (repo-learning, observation only)

Automatic, summaries-only observation of agent sessions. New `repo-learning`
state starts observing; an explicit `/learn pause` persists across process
restarts until the user previews and confirms `/learn resume` with its
short-lived token.

The recorder stores **structured episode summaries only** — never raw
transcripts, tool output, or credentials. Synthesis, promotion, active
retrieval, Basic Memory writes, and rule optimization remain disconnected
compiler/test surfaces.

## Behavior and bounds

- **Automatic bounded observation**: the live adapter converts supported OpenCode events
  to fixed `kind`, `name`, `sessionID`, `timestamp`, and `ok` metadata. It
  never forwards prompts, tool inputs, tool outputs, transcripts, or error
  text. The recorder rejects unknown fields fail-closed.
- **Repository isolation**: the server accepts an event only when its direct
  location/project metadata or a fresh session lookup matches the plugin's
  repository. Unrelated server-wide session events are discarded.
- **Boundary redaction**: known secrets in detail and summaries are replaced
  with `[REDACTED:<kind>]`; every redactor input is capped at **64 KiB UTF-8
  bytes**; pending sessions retain counters and bounded kind names, never event
  detail or transcripts.
- **Raw input bounds**: event names are at most **128 UTF-8 bytes**, event
  session IDs at most **128 UTF-8 bytes**, event detail at most **1024 UTF-8
  bytes**, and command text at most **512 UTF-8 bytes**. Oversized input is
  reported as a deterministic drop; malformed input is rejected.
- **Pending bounds**: at most **64 pending sessions**, **512 accepted events
  per session**, **32 distinct `kind:name` values per session**, and **256
  KiB** of accounted UTF-8 event-envelope bytes. A new session or event that
  would cross a bound is dropped and reports its machine-readable reason;
  existing pending sessions are not evicted implicitly.
- **Episode bounds**: at most **200 episodes**, with oldest-first eviction;
  episode IDs are at most **256 UTF-8 bytes**, session IDs at most **128 UTF-8
  bytes**, summaries at most **2000 UTF-8 bytes**, and `toolCalls`/`errors`
  at most **512** each.
- **Storage bound**: serialized state is measured in UTF-8 bytes and may not
  exceed **512 KiB**. Parsing enforces the 200-episode cap, exact schemas,
  nested count caps, nested string caps, and rejects unknown transcript fields.
- **Retention**: episodes expire after **30 days**
  (`EPISODE_RETENTION_MS`). Load, state reads, `/learn status`, and `/learn
  audit` prune expired episodes and persist the cleaned state through the
  recorder's `persistState` hook; audit never formats an expired episode.
- **Idle-aware**: execution heartbeats arriving after a **15-minute** idle gap
  are dropped without adding pending cost. Failed/completed execution outcomes
  are never classified as heartbeats.

## Pause/resume approval gate

`/learn pause` and `/learn resume` are the only live mutations. A preview requires the caller's
`sessionID` and `agentID` and returns a cryptographically random, opaque
32-byte base64url token held only by the recorder. The server-held record binds
that token to:

- the exact caller session and agent;
- the canonical pause intent; and
- the canonical current state digest, including pending-session counters.

Tokens expire after **5 minutes**, are single-use (including a failed theft
attempt), and are rejected on replay, expiry, caller mismatch, intent mismatch,
or stale state. There are at most **64** outstanding previews; the oldest is
evicted deterministically when a new preview needs a slot. Caller session IDs
are capped at **128 UTF-8 bytes** and agent IDs at **256 UTF-8 bytes**. Apply
also requires `approval: true` (the neighboring RLE gates' `apply: true` alias
is accepted). The direct API shape is:

```ts
const preview = recorder.previewPauseChange(true, sessionID, agentID)
recorder.applyPauseChange(
  { expectToken: preview.expectToken, approval: true },
  sessionID,
  agentID,
)
```

The command shim receives the same caller context as its third argument for a
preview and must receive `{ approval: true }` in that context for apply:

```ts
const preview = recorder.learnCommand("/learn pause", nowMs, { sessionID, agentID })
recorder.learnCommand(`/learn pause ${token}`, nowMs, { sessionID, agentID, approval: true })
```

`/learn status` and `/learn audit` do not mutate the pause flag or episode
content. Retention cleanup is the only persistence side effect of those reads.
Applying pause clears all pending sessions before persistence, so a later idle
event cannot flush pre-pause observations. Event-stream/storage failures stop
observation and are surfaced by the next `/learn` command instead of being
treated as healthy recording.

## Active boundary

- `platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/src/redact.ts`
- `platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/src/storage-state.ts`
- `platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/src/recorder.ts`
- `platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/test/recorder.test.ts`

Operational state uses plugin `ctx.storage`. The live server registers only
metadata observation plus status, audit, pause, and resume. The CLI registers a
read-only review panel. Shared Basic Memory namespaces, cross-repo promotion,
active retrieval, and per-rule optimization effects are intentionally absent
from the runtime path.

## Verify

Run the complete package check from the repository root:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning run check
```
