# Codex Fallback Router (OpenCode v2)

This local OpenCode **server** plugin keeps a session running when an OpenAI
Codex quota is exhausted. It watches quota/provider failures and uses the
supported v2 `ctx.session.switchModel()` API plus the `retry` hook to continue
the same turn on an ordered fallback chain. When the source cooldown expires,
a later turn can return to the original model.

Chain entries use `provider/model` IDs from `opencode models`. A model variant
may be appended as `provider/model#variant`; variants are preserved when the
plugin switches or recovers a session.

## Requirements

- OpenCode v2.0.7 or a compatible v2 release with the v2 plugin API.
- The sibling [`../codex-usage/`](../codex-usage/README.md) package, which
  provides the OpenAI OAuth credential reader and usage parser.
- Authenticated providers for the configured fallback models. If the model
  catalog is unavailable, the plugin fails open and still attempts the chain.
- Node.js 22.6+ for development checks (`--experimental-strip-types`).

## Configuration

Register the plugin in the v2 `plugins` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/codex-fallback/src/index.ts",
      "options": {
        "defaultChain": [
          "deepseek/deepseek-v4-flash",
          "deepseek/deepseek-v4-pro",
          "opencode/muse-spark-1.3-contributor-free"
        ],
        "proactive": true,
        "agents": {
          "plan": { "mode": "off" }
        }
      }
    }
  ]
}
```

The plugin is inactive for an agent with an empty effective chain. Restart or
reload the v2 server after changing plugin configuration.

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultChain` | string[] | `[]` | Ordered fallback tiers. Invalid entries and duplicate model IDs are ignored. |
| `proactive` | boolean | `true` | Check OpenAI OAuth quota before a turn and switch early when it is exhausted. |
| `agents` | object | `{}` | Per-agent overrides supplied through plugin options. |
| `triggerOn` | `"quota"` or `"any-retryable"` | `"quota"` | Select quota-only or broader retryable failure routing. |
| `failureCooldownSeconds` | number | `300` | Cooldown for a failed model when no quota reset is known. |
| `sourceCooldownSeconds` | number | `10800` | Fallback cooldown for a source quota failure without a reset time. |
| `usageEndpoint` | string | ChatGPT usage endpoint | Optional quota endpoint override for tests or compatible services. |
| `usageCacheMs` | number | `60000` | Successful quota-cache lifetime; bounded to 1 second–24 hours. |
| `usageTimeoutMs` | number | `5000` | Quota request timeout; bounded to 500 ms–60 seconds. |
| `debug` | boolean | `false` | Print routing decisions with the `[codex-fallback]` prefix. |

Cooldown and timeout values are floored and bounded. The plugin does not show
TUI notifications; server-side decisions are logged instead.

### Per-agent overrides

Per-agent settings are nested under the plugin's `agents` option because v2
plugins do not receive the old mutable global config hook:

```jsonc
{
  "plugins": [
    {
      "package": "file:///absolute/path/to/codex-fallback/src/index.ts",
      "options": {
        "defaultChain": ["fake/tier-1", "fake/tier-2"],
        "agents": {
          "build": {
            "mode": "chain",
            "chain": ["fake/tier-1#fast", "fake/tier-2#deep"]
          },
          "plan": { "mode": "off" }
        }
      }
    }
  ]
}
```

Supported per-agent fields are `mode`, `chain`, `proactive`, `triggerOn`,
`failureCooldownSeconds`, and `sourceCooldownSeconds`. `enabled: false` remains
accepted as an alias for `mode: "off"`.

## Routing behavior

1. The `context` hook records the source model, routes a cooling model, checks
   proactive quota when enabled, and requests model changes through
   `ctx.session.switchModel()`; it never mutates the read-only `event.model`.
2. The `retry` hook classifies the failure, cools the failed model, switches to
   the next available tier, and sets `{ retry: true, delay: 250 }`. OpenCode's
   normal retry machinery performs the next request on the selected model.
3. A duplicate retry event for the same physical attempt is ignored. A failed
   fallback tier advances exactly once to the next tier.
4. When a source cooldown expires, a later context request can switch from a
   fallback tier back to the recorded source model.
5. A model selected manually outside the plugin's active route resets the
   route bookkeeping and is not silently replaced.

The provider catalog comes from `ctx.model.list()`. Known unavailable tiers are
skipped. If catalog lookup fails, availability is unknown and the chain is
attempted rather than taking down the session.

Routing state is stored at `$XDG_DATA_HOME/opencode/codex-fallback.json`, or
`~/.local/share/opencode/codex-fallback.json`. Writes are atomic, debounced,
owner-only (`0600`), size-bounded, and pruned on load. State is loaded once per
plugin instance.

## Security

The plugin reads the OpenAI OAuth access token only through the shared
`codex-usage` reader and sends it only to the configured usage endpoint. It
never reads or exposes the refresh token, modifies `auth.json`, or logs
credentials. Fallback turns are normal requests to the providers configured by
the operator.

## Checks

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback run check
```

The integration suite uses a fake provider catalog and fake session API to
exercise primary failover, tier advancement, duplicate suppression, cooldown
recovery, manual model selection, variants, and catalog fail-open behavior.
