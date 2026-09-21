# `codex-fallback` — OpenCode v2 server plugin

`codex-fallback` keeps a session running when an OpenAI Codex quota is
exhausted. It uses the OpenCode v2 session hooks and the supported
`ctx.session.switchModel()` API to continue the same turn on a configured
fallback chain. It does not mutate the read-only v2 hook model or replay user
messages itself.

- Source: `platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback/`
- Entry point: `src/index.ts`
- Component README: [`plugins-v2/codex-fallback/README.md`](../../platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback/README.md)
- Companion: [`codex-usage`](../../platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage/README.md) supplies the shared usage reader
  and parser.

Read [`plugins/README.md`](README.md) for the shared plugin security model and
the v2 registration/deployment rules.

## Registration

Use the v2 `plugins` array. The deployment script writes the canonical package
path and preserves the configured options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/plugins-v2/codex-fallback",
      "options": {
        "defaultChain": ["deepseek/deepseek-v4-flash", "opencode/big-pickle"],
        "agents": {
          "plan": { "mode": "off" }
        }
      }
    }
  ]
}
```

The plugin requires OpenCode v2.0.7 or a compatible v2 API. It is inactive
when the effective fallback chain is empty.

## Lifecycle and hooks

During `setup(ctx)`, the plugin:

1. normalizes plugin options and per-agent overrides from `ctx.options.agents`;
2. loads the bounded state file at `$XDG_DATA_HOME/opencode/codex-fallback.json`;
3. creates a quota checker over the shared `codex-usage` module;
4. reads the model catalog lazily through `ctx.model.list()`; and
5. registers `ctx.session.hook("context", ...)`,
   `ctx.session.hook("retry", ...)`, and a cleanup-only event subscription.

| v2 hook | Behavior |
| --- | --- |
| `context` | Records the source model, routes a cooling model, performs proactive quota routing, and recovers an expired source through `ctx.session.switchModel()`. |
| `retry` | Classifies the provider error, cools the failed model, switches to the next tier, and opts OpenCode into its normal retry machinery. |
| event subscription | Removes session bookkeeping after `session.deleted`; it does not initiate a second replay path. |
| cleanup | Aborts the event subscription and flushes state. |

The v2 `retry` hook receives the physical attempt number. The plugin stores a
bounded per-session failure token so duplicate callbacks for one attempt do not
perform a second switch. A later failed tier has a new attempt/model token and
advances normally.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultChain` | string[] | `[]` | Ordered `provider/model` fallback tiers. Use `provider/model#variant` to select a variant. |
| `agents` | object | `{}` | Per-agent overrides. Supported fields are `mode`, `chain`, `proactive`, `triggerOn`, `failureCooldownSeconds`, and `sourceCooldownSeconds`. |
| `proactive` | boolean | `true` | Check OpenAI OAuth quota before a turn and route before a request fails. |
| `triggerOn` | `"quota"` or `"any-retryable"` | `"quota"` | Route quota signals only, or also retryable rate-limit/5xx signals. |
| `failureCooldownSeconds` | number | `300` | Cooldown for a failed model when the failure is not quota-driven. Bounded to seven days. |
| `sourceCooldownSeconds` | number | `10800` | Source cooldown when a quota response has no reset timestamp. Bounded to seven days. |
| `usageEndpoint` | string | shared ChatGPT endpoint | Optional usage endpoint override. |
| `usageCacheMs` | number | `60000` | Quota cache lifetime, bounded to 1 second–24 hours. |
| `usageTimeoutMs` | number | `5000` | Quota request timeout, bounded to 500 ms–60 seconds. |
| `debug` | boolean | `false` | Enable informational `[codex-fallback]` logs. Warnings remain visible. |

`enabled: false` is accepted inside an agent override as an alias for
`mode: "off"`.

## Routing behavior

### Context routing

The `context` hook sees the model selected for the request but cannot assign to
`event.model`. It calls `ctx.session.switchModel({ sessionID, model })` when it
needs to change the session model. It records the source, active model, tier,
and optional variants in state.

If the current model differs from the plugin's recorded active route, the
selection is treated as manual: route bookkeeping is reset and the plugin does
not silently replace that model. A configured fallback tier is skipped when it
is cooling or unavailable in the model catalog. If the catalog lookup fails,
availability is unknown and the chain is attempted (fail-open behavior).

### Retry routing

For a matching failure from any registered/connected provider, the `retry` hook:

1. classifies quota, rate-limit, server, and abort signals;
2. recognizes provider-wide quota signals, including DeepSeek balance exhaustion
   and typed OpenCode Zen free/go usage exhaustion; the OpenAI quota endpoint is
   refreshed for an OpenAI primary when needed;
3. cools the failed model until a reported reset or bounded fallback timeout;
4. selects the next usable chain tier, wrapping the configured chain at most
   once so every tier has a path to another healthy tier; and
5. calls `ctx.session.switchModel()` before setting
   `{ retry: true, delay: 250 }`.

OpenCode owns the subsequent retry request. This is the supported v2 path for
continuing the current turn; the plugin does not abort, revert history, or call
an asynchronous prompt/replay API.

### Recovery

After a source cooldown expires, a later request on a fallback tier switches
back to the recorded source if that source is available. The source variant is
preserved. A failed fallback tier advances from its position in the chain.

## State and security

State is loaded once per plugin instance and written atomically with owner-only
permissions. It is debounced, pruned after expiry/TTL, and bounded to 1 MiB,
512 cooldown records, and 512 session records. The state file is not a shared
cross-process lock; concurrent servers use last-writer-wins semantics.

The plugin reads the OpenAI OAuth access token only through the shared usage
reader, sends it only to the configured usage endpoint, never reads or exposes
the refresh token, and never logs credentials. Fallback requests go through the
providers selected by the operator.

## Verification

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback run check
```

The package tests include a fake-provider/session-API harness covering:

- primary failover and tier-1-to-tier-2 advancement;
- duplicate retry suppression;
- cooldown expiry and source recovery;
- manual model selection;
- model variants; and
- fail-open catalog errors.

The repository v2 gates additionally run the package typecheck/tests and the
live catalog-driven deployment and health checks.
