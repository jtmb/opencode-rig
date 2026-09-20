# Provider usage sidebar — OpenCode v2 CLI plugin

The `codex-usage` package renders a **Provider Usage** panel for the four
configured provider families used by Open Rig:

- **Codex** — verified subscription quota windows from the ChatGPT usage API;
- **DeepSeek** — verified currency balances and availability from DeepSeek's
  documented `GET /user/balance` endpoint; and
- **OpenCode Go** — the optional subscription provider identified by the live
  `opencode-go` provider ID; and
- **OpenCode Zen** — the OpenCode Console/Zen provider identified by the live
  `opencode` provider ID.

For OpenCode Go and OpenCode Zen, the panel reports the verified provider
catalog state and any bounded local fallback cooldown. It does not display a
balance, percentage, subscription state, or limit unless that value comes from
a verified runtime source.

## Interaction

The panel is registered from `cli.json` and is visible independently of the
active session model. Its header is mouse- and keyboard-activatable. The
command palette provides **Refresh provider usage** and **Provider usage
details**; `/provider-usage` opens the same details dialog, while
`/codex-usage` and `/usage-left` remain aliases.

The expanded sidebar groups each provider's status and verified measurements
together. Short, stable status labels (`READY`, `EMPTY`, `COOLING`, `OFFLINE`,
or `STALE`) align at the right edge; Codex weekly and reserve windows stay
directly under Codex rather than appearing after unrelated providers. Detail
text is indented below its provider, and one shared update line closes the
panel.

Polling defaults to 60 seconds and is bounded to at least 30 seconds. Codex and
DeepSeek refresh independently, so one unavailable provider does not erase the
other provider's last verified values. Network and response failures preserve
last-good values; missing or invalid authentication is reported without
showing a stale authenticated result.

## Data and security

The plugin reads only the OpenAI OAuth access/account fields and the DeepSeek
API key required for their fixed usage endpoints. It never reads the OpenAI
refresh token, logs credentials, changes `auth.json`, or sends one provider's
credential to another provider. DeepSeek amounts are bounded and sanitized
before display. The fallback state reader is read-only, size-bounded to 1 MiB,
and considers at most 512 cooldown entries.

The optional `deepSeekEndpoint` plugin option exists for compatible test
transports. Production configuration should retain the documented
`https://api.deepseek.com/user/balance` default. No OpenCode Go or Zen
account endpoint is called by this plugin.

## Verification

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage run check
```

The protected package README remains the historical Codex-specific component
reference. This document is the current multi-provider behavior reference.
