# `codex-fallback` — Server Failover Router

`codex-fallback` is a local **server plugin** that keeps sessions running when
the ChatGPT Codex subscription quota is exhausted. It watches the usage
endpoint and provider errors, then transparently continues the current turn on a
configurable fallback chain of **any** OpenCode providers. When the quota
resets, new turns return to the original model.

The plugin is provider-agnostic: chain entries are ordinary `provider/model`
ids from `opencode models`, and per-agent configuration can change, reorder, or
disable fallback in `opencode.json` or agent Markdown.

- Entry point: `src/index.ts`
- Source: `platforms/linux/ubuntu/computer-use/plugins/codex-fallback/`
- Companion: [`codex-usage`](codex-usage.md) provides the shared credential
  reader and usage parser

For registration and the shared security model, read
[`plugins/README.md`](README.md) first.

## Lifecycle and hooks

The plugin factory runs when OpenCode loads the server plugin. It:

1. Normalizes the raw options into `GlobalOptions`.
2. Creates a `StateStore` at `$XDG_DATA_HOME/opencode/codex-fallback.json`
   (default `~/.local/share/opencode/codex-fallback.json`) and **loads it once**.
3. Creates a `QuotaChecker` over the shared usage client.
4. Registers four hooks and a dispose function.

| Hook | Purpose |
|------|---------|
| `config` | Capture per-agent fallback config and configured models, then strip the `codexFallback` key from the merged config |
| `chat.message` | The routing brain: proactive quota switching, routing a cooling model, recovery, and bookkeeping |
| `chat.params` | Defensive removal of `codexFallback` from outbound request options |
| `event` | React to retry, error, and message events; clean up on session deletion |
| `dispose` | Flush persisted cooldown/session state |

State is read at startup only. Editing the JSON file while OpenCode runs has no
effect until restart; see [Manually resetting routing](#manually-resetting-routing).

## Module map

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Plugin factory, hooks, routing decisions, abort/revert/replay, toasts |
| `src/config.ts` | Option normalization, chain parsing, per-agent overrides, key stripping |
| `src/chain.ts` | Provider catalog, tier availability, cooldown-aware tier picking |
| `src/detect.ts` | Failure classification (quota / rate-limit / other / aborted) and trigger rules |
| `src/model.ts` | `ModelRef`, `provider/model` key parse/format, message model extraction |
| `src/state.ts` | Persisted cooldowns and session records with atomic, debounced writes |
| `src/usage.ts` | `QuotaChecker` wrapper over the shared `codex-usage` usage client |
| `test/*.test.ts` | Unit tests for every module above |

## Configuration

Register the plugin in the `plugin` array of `~/.config/opencode/opencode.jsonc`
(see [`plugins/README.md`](README.md#registration)). The chain applies to every
agent unless overridden.

### Plugin options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultChain` | string[] | `[]` | Ordered `provider/model` tiers for agents without an override. The plugin is inactive for an agent until its effective chain is non-empty. Invalid entries and duplicates are dropped silently. |
| `proactive` | boolean | `true` | Check the usage endpoint before a turn and switch before the request fails. Requires an OpenAI OAuth login; API-key providers are ignored. |
| `notify` | boolean | `true` | Show a short TUI toast on routing, switching, recovery, or exhaustion. At most one toast per subject per 15 s. |
| `triggerOn` | `"quota"` \| `"any-retryable"` | `"quota"` | `"quota"` reacts to usage/quota signals. `"any-retryable"` also reacts to rate limits, 429s, and 5xx errors. A quota check that reports the limit reached can force fallback even under `"quota"`. |
| `failureCooldownSeconds` | number | `300` | How long a failed model (primary or fallback tier) is skipped after a non-quota failure. |
| `sourceCooldownSeconds` | number | `10800` | How long the primary model is avoided when the usage endpoint reports no reset time. |
| `usageEndpoint` | string | `https://chatgpt.com/backend-api/wham/usage` | Override the quota endpoint (useful for local tests). |
| `usageCacheMs` | number | `60000` | Quota cache lifetime (minimum 1000). A failed OpenAI primary request forces one refresh. |
| `usageTimeoutMs` | number | `5000` | Quota request timeout (minimum 500). Failures fail open (no switch). |
| `debug` | boolean | `false` | Print `[codex-fallback]` decision logs to the OpenCode log. Warnings print with the same prefix regardless. |

Numeric options are floored to integers; cooldowns must be at least 1 second.
`normalizeOptions()` treats any value other than `false` as `true` for the
booleans and any value other than `"any-retryable"` as `"quota"` for
`triggerOn`, so a typo degrades to the conservative default rather than
crashing.

> The README's example chain names specific providers; there is no hardcoded
> default chain. Register your own chain or the plugin does nothing.

### Per-agent configuration

Override one agent's chain in `opencode.json`:

```jsonc
{
  "agent": {
    "build": {
      "codexFallback": {
        "mode": "chain",
        "chain": ["provider-a/model-x", "provider-b/model-y"]
      }
    },
    "plan": {
      "codexFallback": { "mode": "off" }
    }
  }
}
```

The same fields can live in agent Markdown frontmatter:

```md
---
description: Reviews code without edits
mode: subagent
model: openai/gpt-5.3-codex-spark
codexFallback:
  mode: chain
  chain:
    - deepseek/deepseek-v4-flash
    - opencode/muse-spark-1.3-contributor-free
---

You are a strict reviewer.
```

Per-agent fields: `mode` (`"chain"` or `"off"`), `chain`, `proactive`,
`triggerOn`, `failureCooldownSeconds`, and `sourceCooldownSeconds`. Values
override the plugin options for that agent only.

Precedence and aliases (`config.ts`):

- `options.codexFallback` wins over a top-level `codexFallback` key when both
  are present.
- `enabled: false` is accepted as a legacy alias for `mode: "off"`;
  `enabled: true` implies `mode: "chain"` when no mode is given.
- The agent's configured `model` is also captured, so a failed turn can be
  routed back to it even if the session record is missing.

**Key stripping.** OpenCode normally forwards unrecognized agent options to the
provider. The `config` hook calls `stripAgentFallback()` to delete the key from
both `agent.<name>.codexFallback` and `agent.<name>.options.codexFallback`, and
the `chat.params` hook deletes it again from the per-request `options` as a
defense in depth. The `codexFallback` key never reaches a provider API.

### Resolving the effective configuration

`resolveEffective(agentName, fallbacks, options)` combines global defaults with
the agent override:

- `chain` = override chain, else `defaultChain`.
- **Disabled** when `mode === "off"`, or when a `chain` was provided but parsed
  to zero entries and no mode was set.
- `enabled` = not disabled **and** the chain is non-empty.
- `proactive`, `triggerOn`, `failureCooldownSeconds`, and
  `sourceCooldownSeconds` each fall back to the global value when not overridden.

If the effective chain is empty, the plugin is a no-op for that agent and the
session stays on its configured model.

## How routing works

There are four distinct paths. All of them keep per-session bookkeeping in the
persisted session record (`agent`, `source`, `active`, `tier`) and in memory
(`sessionAgent`, `switching`, `switchedAt`, `toastAt`).

### 1. Proactive routing (`chat.message`, before dispatch)

When a user message arrives on a model whose provider is `openai` and the
agent's effective config has `proactive` enabled:

1. `quota.check(false)` consults the cached usage snapshot.
2. If it reports `limitReached`, the primary model is put in cooldown until the
   reported reset time, or `sourceCooldownSeconds` from now when no reset time
   is available.
3. The first available chain tier is selected and written to the outgoing
   message model, so the request never fails on quota.
4. The session record's `source` is set to the primary model and `active` to the
   tier. A toast announces the switch.

If no tier is available, a toast says so and the message is left unchanged.

### 2. Routing a cooling model (`chat.message`)

If the model attached to an incoming message is already in cooldown (for
example a queued message or a resumed session), the plugin picks a tier and
rewrites the message. It starts after the current model's position when the
current model is itself a chain tier, so progress down the chain is monotonic.
It records the original model as `source` when it is not already a tier.

### 3. Reactive switching (`event`)

The plugin subscribes to several failure signals:

| Event | Details extracted |
|-------|-------------------|
| `session.status` with `status.type === "retry"` | `sessionID`, retry `message` |
| `session.error` | `sessionID`, `properties.error` |
| `message.updated` for an assistant message with `info.error` | `sessionID`, `info.error`, model from `info` |
| `session.deleted` | Drops in-memory and persisted session state |

`handleFailure()` then:

1. Skips if a switch is already in flight for the session.
2. Resolves the agent and effective config; ignores the failure if fallback is
   disabled.
3. Classifies the failure (see below). Aborts and unrecognized shapes are
   ignored.
4. Ignores failures within `SWITCH_GRACE_MS` (2 s) of a completed switch, to
   avoid switch loops.
5. Resolves the failed model from the event, the session record's `active`, its
   `source`, or the agent's configured model, in that order.
6. Ignores a stale non-quota failure for a model that is already cooling when
   the session is already active on a chain tier.
7. Decides whether to trigger. A failed model that is itself a chain tier always
   advances the chain. For a failed OpenAI primary, it forces a quota check and
   triggers if the check reports the limit reached.
8. Sets a cooldown on the failed model: until the reset time (quota-driven) or
   `sourceCooldownSeconds` for the primary with no reset time, otherwise
   `failureCooldownSeconds`.
9. Picks the next available tier and switches.

### 4. Recovery

When a session's current model is a chain tier and the source model is not
cooling and is still available in the provider catalog, the next message is
rewritten back to the source model and a "Codex restored" toast is shown.
Because the primary's cooldown runs until the quota reset time, recovery
happens automatically on the next turn after the reset, provided the session's
source is known and still present in the catalog.

## Switching mechanics (abort, revert, replay)

A switch is not a simple model change: it must stop the failed turn, remove its
partial history, and re-issue the user's message on the new model. This is the
most delicate part of the plugin.

`switchSession()` performs, in order:

1. **Abort.** `session.abort` stops the run.
2. **Settle.** Wait `POST_ABORT_DELAY_MS` (150 ms).
3. **Revert.** Call `session.revert` on the last user message id, up to
   `REVERT_ATTEMPTS` (3) times, `REVERT_RETRY_DELAY_MS` (250 ms) apart. Revert is
   best-effort: if it never succeeds the plugin proceeds anyway and logs
   "replay only".
4. **Replay.** `session.promptAsync` with the agent, the target model, and the
   reconstructed parts.
5. **Record and announce.** Store `active`/`tier` and toast.

Only the last user message is replayed, and only `text`, `file`, and `agent`
parts are reconstructed. Synthetic and ignored text parts and empty text are
dropped; a file part requires `mime` and `url`; an agent part requires `name`.
If no replayable user message is found, the switch is abandoned with a warning.

### Constants

| Constant | Value | Role |
|----------|-------|------|
| `CATALOG_CACHE_MS` | 60000 | Provider catalog cache lifetime |
| `POST_ABORT_DELAY_MS` | 150 | Delay after abort before revert |
| `REVERT_ATTEMPTS` | 3 | Revert attempts before proceeding without cleanup |
| `REVERT_RETRY_DELAY_MS` | 250 | Delay between revert attempts |
| `SWITCH_GRACE_MS` | 2000 | Failures this close to a switch are ignored |
| `TOAST_MIN_INTERVAL_MS` | 15000 | Minimum spacing per toast subject |

## Failure classification

`detect.ts` turns an error or retry message into a `FailureInfo` with a kind:

| Kind | Signals |
|------|---------|
| `quota` | `usage_limit`, `usage_limit_reached`, `insufficient_quota`, `quota exceeded`, "exceeded your current quota", "out of usage", "hit your … usage limit", "billing hard limit", weekly/daily/monthly/5-hour limit reached, free/gousage |
| `rate-limit` | HTTP 429, `rate_limit`, "too many requests", `resource_exhausted`, overloaded, service unavailable, "try again later/in" |
| `aborted` | `MessageAbortedError`, "aborted" |
| `other` | Anything else with extractable text or a status |

Text is extracted from strings, `Error` instances, and record-shaped errors
(`name`, `message`, `data.message`, `data.responseBody`, or a JSON fallback).
Status codes are read from `statusCode`, `status`, `code`, and nested
`data.statusCode`/`data.status`.

`shouldTrigger()` rules:

- `aborted` and unknown failures never trigger.
- `quota` always triggers.
- Under `"any-retryable"`, `rate-limit` triggers, and so does any status of 429
  or ≥ 500.
- Under the default `"quota"`, other retryable failures are left to OpenCode's
  own retry logic.

An OpenAI primary whose failure does not classify as quota still forces a live
quota check; if that check reports the limit reached, the switch triggers even
under `"quota"`.

## Provider catalog and tier selection

`getCatalog()` calls `provider.list` and caches the result for 60 s. If a
lookup fails, it returns the stale cached catalog rather than dropping
availability information.

`catalogFromProviderList()` builds:

- `connected`: provider ids from `data.connected`.
- `models`: a map of provider id → known model ids from `data.all[].models`.

`isTierAvailable()` is **permissive when the catalog is unknown**: if there is
no catalog at all (for example the lookup failed on first use), every tier is
considered available so the plugin fails open and still attempts the chain.
With a catalog, a tier requires its provider to be connected and its model id
to be known.

`pickTier()` walks the chain from a start index and returns the first tier that
is neither cooling nor unavailable, plus a list of skipped tiers with reasons
(`cooldown` or `unavailable`). If a fallback tier itself fails, the next
failure advances past it (`chainIndex + 1`).

## State persistence

`state.ts` stores routing state as:

```json
{
  "version": 1,
  "cooldowns": {
    "openai/gpt-5.3-codex-spark": { "until": 0, "reason": "usage-limit", "setAt": 0 }
  },
  "sessions": {
    "<sessionID>": { "agent": "build", "source": "openai/...", "active": "deepseek/...", "tier": "deepseek/...", "updatedAt": 0 }
  }
}
```

- Path: `$XDG_DATA_HOME/opencode/codex-fallback.json`, default
  `~/.local/share/opencode/codex-fallback.json`.
- **Atomic writes** via a PID-and-counter temp file followed by `rename`, with
  `mode 0600`. Parent directories are created as needed.
- **Debounced** writes (250 ms) with an `unref`'d timer so a pending save cannot
  hold the process open. `dispose()` flushes synchronously.
- **Tolerant loading**: unparseable or malformed state becomes an empty store
  rather than an error.
- **Pruning** on load and on `cooling()`/`cooldownUntil()`: cooldowns are
  dropped one hour after expiry, session records after seven days.
- **Concurrency**: two OpenCode servers sharing the file use last-writer-wins
  semantics. There is no cross-process lock.

### Manually resetting routing

Stop OpenCode and delete
`~/.local/share/opencode/codex-fallback.json`, or remove the model's `cooldowns`
entry and any session entries pointing at it. State is loaded once at startup,
so edits made while OpenCode runs do nothing until restart.

## Quota checking

`src/usage.ts` wraps the shared client in a `QuotaChecker`:

- `quotaFromSnapshot()` reduces the shared snapshot to `limitReached`,
  `resetsAt` (converted from seconds to epoch milliseconds), `planType`, and
  `fetchedAt`.
- `limitReached` is true when the snapshot has a `reachedType`, the overall
  `codex` bucket is `limitReached` or `allowed === false`, or the weekly window
  is at ≥ 100 % used.
- Successful results are cached for `usageCacheMs`; failures are cached for
  `min(usageCacheMs, 15 s)` to avoid hammering a failing endpoint.
- Concurrent checks are de-duplicated.
- Any failure returns `undefined` and the caller **fails open** (no switch).

## Notifications and logging

- `toast()` respects `notify`, suppresses repeats per subject within
  `TOAST_MIN_INTERVAL_MS`, and swallows errors when no TUI is attached
  (headless runs). Toasts cover routing, switching, recovery, and exhaustion.
- Decisions are logged with the `[codex-fallback]` prefix. `debug` gates the
  informational lines; warnings (switch failures, missing replay, load errors)
  always print.

## Tests

`npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-fallback run check`
runs `tsc --noEmit` plus the `node:test` suites. Coverage includes:

- Catalog construction, first-available tier selection, advancing past a failed
  tier, and exhaustion reporting.
- Chain parsing with validation/de-duplication and per-agent config parsing.
- Collection of agent fallbacks/models and stripping of plugin keys.
- Global option normalization and per-agent override precedence.
- Failure classification: quota, insufficient quota, rate limits, 5xx, aborts,
  empty/malformed errors, and nested status codes.
- Model key format/parse/rejection and model extraction from both message
  shapes.
- State persistence across reloads, pruning, and corrupt-state tolerance.
- Quota derivation from the weekly window, `reachedType` handling, caching, and
  fail-open behavior.

## Troubleshooting

Start OpenCode with `--print-logs --log-level DEBUG` and search for
`[codex-fallback]` lines (enable the `debug` option).

| Symptom | Likely cause | Resolution |
|---------|--------------|-----------|
| No fallback happens | Effective chain empty; provider unauthenticated; failure did not match the trigger mode | Confirm the chain is non-empty, run `opencode models`, and check `triggerOn`. Under `"quota"`, transient rate limits are left to OpenCode's retry logic. |
| Wrong provider selected | Tiers are used in order; a tier can be skipped | Check `provider.list().connected`, known model ids, and cooldowns in the state file. |
| Primary stays on fallback | Source cooldown runs until the reported reset or `sourceCooldownSeconds`; recovery also needs a known source | Wait for the reset, lower `sourceCooldownSeconds`, or reset state. |
| Tier fails immediately after a switch | Failures within 2 s of a switch are ignored | Send the message again to advance the chain. |
| Revert warnings | `session.revert` unavailable | The switch proceeds with replay-only; history may retain the failed turn. |
| Headless `opencode run` never switches | The process exits before the async replay finishes | Use an interactive TUI session or `opencode serve`; the replay is only delivered while the server is alive. |
| Recovery does not happen | Session source unknown or source no longer in the catalog | Check the state file; the source is recorded on first routing. |

## Security

See the [shared security model](README.md#shared-security-model). The plugin
reads only the OpenAI access token and account id, sends them only to the fixed
usage endpoint (or the configured override), never reads the refresh token,
never modifies `auth.json`, and never logs credentials. Fallback turns are
normal model requests to the providers you configure.
