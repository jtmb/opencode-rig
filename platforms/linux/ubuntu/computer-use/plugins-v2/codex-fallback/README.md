# Codex Fallback Router

This local OpenCode server plugin keeps sessions running when the ChatGPT
Codex subscription quota is exhausted. It watches the ChatGPT usage endpoint
and provider errors, then transparently continues the current turn on a
configurable fallback chain of any OpenCode providers and models. When the
quota resets, new turns return to the original model.

The plugin is provider-agnostic: chain entries are ordinary
`provider/model` IDs from `opencode models`, and per-agent configuration can
change, reorder, or disable fallback in `opencode.json` or agent Markdown.

## Requirements

- OpenCode 1.18.31 or a compatible 1.x build with server plugins.
- The sibling [`../codex-usage/`](../codex-usage/README.md) package, which
  provides the OpenAI OAuth credential reader and ChatGPT usage parser.
- Authenticated providers for every model listed in the fallback chain
  (`opencode auth login`). When the provider catalog is available,
  unauthenticated providers and unknown model IDs are skipped; if the catalog
  lookup itself fails, the plugin fails open and attempts the chain anyway.
- Node.js 22.6+ for development checks (`--experimental-strip-types`).

## Configuration

Register the plugin in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "file:///absolute/path/to/codex-fallback/src/index.ts",
      {
        "defaultChain": [
          "deepseek/deepseek-v4-flash",
          "deepseek/deepseek-v4-pro",
          "opencode/muse-spark-1.3-contributor-free"
        ],
        "proactive": true,
        "notify": true
      }
    ]
  ]
}
```

The chain applies to every agent. Restart OpenCode after changing
configuration; running sessions do not hot-reload plugins or config.

### Plugin options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultChain` | string[] | `[]` | Ordered `provider/model` fallback tiers used by agents without a per-agent override. The plugin is inactive for an agent until its effective chain is non-empty. Invalid entries and duplicates are dropped silently. |
| `proactive` | boolean | `true` | Check the Codex usage endpoint before a turn and switch before the request fails. Requires an OpenAI OAuth (ChatGPT/Codex) login; API-key providers are ignored. |
| `notify` | boolean | `true` | Show a short TUI toast when routing, switching, recovering, or exhausting the chain. At most one toast per subject per 15 seconds; silently skipped when no TUI is attached. |
| `triggerOn` | `"quota"` \| `"any-retryable"` | `"quota"` | `"quota"` reacts to usage-limit/quota signals. `"any-retryable"` also reacts to rate limits, 429s, and 5xx provider errors. A quota check that reports the limit reached can force a fallback even under `"quota"`. |
| `failureCooldownSeconds` | number | `300` | How long a failed model (primary or fallback tier) is skipped after a non-quota failure. |
| `sourceCooldownSeconds` | number | `10800` | How long the primary model is avoided when the usage endpoint reports no reset time. |
| `usageEndpoint` | string | `https://chatgpt.com/backend-api/wham/usage` | Override the quota endpoint, useful for local tests. |
| `usageCacheMs` | number | `60000` | Quota cache lifetime (minimum 1000). A failed OpenAI primary request forces one refresh. |
| `usageTimeoutMs` | number | `5000` | Quota request timeout (minimum 500). Failures fail open (no switch). |
| `debug` | boolean | `false` | Print `[codex-fallback]` decision logs to the OpenCode log. Warnings print with the same prefix even when disabled. |

Numeric options are floored; cooldowns must be at least 1 second.

### Per-agent configuration

Override the chain for one agent in `opencode.json`:

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
override the plugin options for that agent only; `mode: "off"` (or an empty
chain) leaves the agent on its configured model. The legacy `enabled: false`
alias is accepted and behaves like `mode: "off"`. The
`options: { codexFallback: ... }` form is equivalent; if both forms are
present, `options.codexFallback` wins.

OpenCode normally forwards unrecognized agent options to the provider. This
plugin captures `codexFallback` in its config hook and also deletes it in the
per-request `chat.params` hook, so the key never reaches a provider API.

## How it works

1. **Proactive routing.** On each user message (`chat.message`), if the turn
   uses the OpenAI OAuth model and the cached Codex usage check reports the
   limit reached (a `reachedType`, or the overall bucket marked `limitReached`
   or `allowed: false`), the message model is rewritten to the first available
   chain tier before dispatch. The weekly window's ≥ 100 % usage counts only
   when the overall bucket carries neither flag, so explicit `allowed: true`
   reserve usage keeps the primary model. The primary model enters cooldown
   until the reported reset time, or `sourceCooldownSeconds` when no reset time
   is available.
2. **Reactive switching.** The plugin subscribes to `session.status` retry,
   `session.error`, and `message.updated` events (and clears per-session
   bookkeeping on `session.deleted`). Quota signals (or any retryable failure
   when configured) abort the run, revert the failed turn, and replay the last
   user message on the next tier. Revert is best-effort: after three attempts
   the replay proceeds without cleanup, and if no replayable user message is
   found the switch is abandoned. Only `text`, `file`, and `agent` parts are
   replayed; synthetic and empty text parts are dropped.
3. **Chain and cooldowns.** Tiers are validated against the provider catalog
   (`provider.list`: connected providers and known model IDs), which is cached
   for 60 seconds and kept stale if a lookup fails. Cooling tiers and
   unavailable providers are skipped; if a fallback tier itself fails, the
   next tier is tried. If the whole chain is unavailable the session stays put
   with an explanatory toast, and the debug log records the exhausted chain.
4. **Recovery.** When the primary model's cooldown expires (the reset
   timestamp from the usage endpoint when available), the next message routes
   back to it automatically, provided the session's source model is known and
   still present in the provider catalog.

Routing state is persisted at
`~/.local/share/opencode/codex-fallback.json` (or under `XDG_DATA_HOME`).
Cooldowns are pruned one hour after expiry and session records after seven
days; writes are debounced, owner-only (`0600`), and atomic. Two OpenCode
servers sharing the file use last-writer-wins semantics.

## Troubleshooting

Start OpenCode with `--print-logs --log-level DEBUG` and look for
`[codex-fallback]` lines (enable the `debug` option). Decisions are logged:
failures received, tiers skipped, switches, recoveries, and exhausted chains.

- **No fallback happens.** Confirm the agent's effective chain is non-empty,
  the provider is authenticated (`opencode models`), and the failure matched
  the trigger mode. Under the default `triggerOn: "quota"`, transient rate
  limits are left to OpenCode's own retry logic. A primary model that fails
  without a quota signal is not switched.
- **Wrong provider selected.** Chain entries are used in order; a tier can be
  skipped when its provider is not in `provider.list().connected`, the model
  ID is unknown, or the tier is cooling down.
- **Primary model stays on fallback.** The source cooldown lasts until the
  reset reported by the usage endpoint, or `sourceCooldownSeconds`. Recovery
  also requires the session source to be known.
- **Reset routing manually.** Stop OpenCode and delete
  `~/.local/share/opencode/codex-fallback.json`, or remove both the model's
  `cooldowns` entry and any session entries pointing at it. State loads once at
  plugin startup, so edits while OpenCode runs have no effect until restart.
- **Headless runs.** `opencode run` may exit as soon as the original request
  errors, before the asynchronous replay finishes; the replay is only
  delivered while the server is alive. Interactive TUI sessions and
  `opencode serve` instances complete the switch normally.
- **A tier fails immediately after a switch.** Failures within two seconds of
  a switch are ignored to avoid switch loops; send the message again to advance
  the chain.

## Security

The plugin reads the OpenAI OAuth access token from the normal OpenCode data
location and sends it, with the `ChatGPT-Account-Id` header, only to the fixed
ChatGPT usage endpoint (or the configured `usageEndpoint`). It never reads or
exposes the refresh token, does not modify `auth.json`, and never logs
credentials. Fallback turns are normal model requests to the providers you
configure.

## Checks

```bash
npm install
npm run check
```
