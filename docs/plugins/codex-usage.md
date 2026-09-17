# `codex-usage` — TUI Quota Sidebar

`codex-usage` is a local **TUI plugin** that shows the remaining overall weekly
ChatGPT Codex subscription quota and its reset countdown in the session
sidebar. When the backend returns the optional Luna Reserve bucket, it adds a
single compact remaining-percentage row. It otherwise hides the short-window
(5h) and other model-specific counters.

- Entry point: `src/tui.tsx`
- Plugin id: `local.codex-usage`
- Source: `platforms/linux/ubuntu/computer-use/plugins/codex-usage/`
- Companion: [`codex-fallback`](codex-fallback.md) continues sessions when the
  quota is exhausted

For registration and the shared security model, read
[`plugins/README.md`](README.md) first.

## Behavior at a glance

- The sidebar panel appears **only** when the session's active model is an
  OpenAI/Codex subscription model *and* a real quota snapshot has arrived.
  There is no loading placeholder, so the panel never shows fabricated data.
- The panel is collapsible (mouse click, or Enter/Space when focused). The
  collapsed state is persisted per user in TUI key-value storage under
  `local.codex-usage.collapsed`.
- It polls once per minute while a qualifying model is active, and refreshes
  once more when a Codex turn becomes idle.
- It does not poll while another provider is active.
- It shows the last successful update time so stale data is obvious.
- If Luna Reserve data is present, the body adds one compact `Luna Reserve` row;
  the details dialog includes its remaining percentage and reset countdown.
- When the quota runs out, the sidebar's job is done; switching is the fallback
  router's job.

Luna Reserve is an optional backend-provided fallback allowance for selected
personal Plus and Pro accounts. It is separate from regular usage and is not
guaranteed merely because the regular window is exhausted. If the backend does
not return a `gpt-reserve` bucket, the plugin omits the row instead of showing
an inferred zero balance. See [Luna Reserve in Codex and ChatGPT Work](https://help.openai.com/en/articles/20001499-luna-reserve-in-codex-and-chatgpt-work)
for the vendor's availability and usage notes.

## Module map

| File | Responsibility |
|------|----------------|
| `src/tui.tsx` | TUI plugin entry point: sidebar panel, commands, dialog, options, event wiring |
| `src/store.ts` | `UsageStore`: state machine, refresh scheduling, timeout, rate-limit backoff, subscriptions |
| `src/usage.ts` | Shared credential reader and usage client/parser (also imported by `codex-fallback`) |
| `src/model.ts` | Detects the active model from message objects and whether it is a Codex subscription model |
| `src/format.ts` | Pure formatting helpers for the panel and the details dialog |
| `scripts/check-usage.ts` | Standalone one-shot CLI that fetches and prints the quota |
| `test/usage.test.ts` | Tests for parsing, credential reading, formatting, and model detection |

`src/usage.ts` is the shared boundary. Changes there affect both plugins; see
[Shared Codex usage layer](README.md#shared-codex-usage-layer).

## The store state machine

`createUsageStore()` in `src/store.ts` owns all interaction with the usage
endpoint. It exposes `getState()`, `subscribe(listener)`, `refresh(force?)`,
and `dispose()`.

The published state is:

```ts
type UsageState = {
  status: "loading" | "ready" | "error"
  snapshot?: CodexUsageSnapshot
  message?: string
  retryAt?: number
}
```

`refresh()` behaves as follows:

1. **Disposed guard.** If `dispose()` has been called, it returns the current
   state without doing work.
2. **In-flight de-duplication.** A second call while a refresh is running
   returns the same promise instead of starting another request.
3. **Rate-limit backoff.** If `nextAllowedAt` is in the future, it publishes an
   `error` state with the existing snapshot and a backoff message, and returns.
   `nextAllowedAt` is set from the `Retry-After` header when the endpoint
   returns HTTP 429.
4. **Freshness throttle.** Without `force`, a snapshot younger than
   `MIN_REFRESH_MS` (15 s) is reused as-is. The TUI's `force` refresh is used
   for the idle refresh and the command, but the throttle still protects the
   endpoint from rapid repeated calls.
5. **Fetch.** It reads the credential, installs an `AbortController` with the
   configured timeout, and calls `fetchCodexUsage`.
6. **Publish.**
   - Success publishes `{ status: "ready", snapshot }` and clears the backoff.
   - Failure is normalized by `cleanError()` (timeout and unknown errors become
     `network`). An `auth` failure clears the snapshot; other failures keep the
     previous snapshot so the panel can show stale-but-real data with a warning.
   - A rate-limit error sets `nextAllowedAt` from the error's `retryAt`.

Timeout defaults to 10 000 ms and is floored at 1 000 ms by `boundedNumber()`.
`dispose()` sets the disposed flag, aborts any in-flight request, and clears
listeners; it is called from the plugin's `api.lifecycle.onDispose`.

### Account changes

The store remembers the last `accountId`. If the credential's account id
changes between refreshes (for example after a re-login), it publishes a
`loading` state so the panel does not briefly show another account's quota.

## Credential reading

`readOpenAICredential()` in `src/usage.ts` reads OpenCode's auth file:

- Path: `$XDG_DATA_HOME/opencode/auth.json`, defaulting to
  `~/.local/share/opencode/auth.json`.
- The `openai` entry must have `type === "oauth"`. API-key logins are rejected
  with an `auth` error, because API-key billing limits are not subscription
  limits.
- `access` must be a non-empty string.
- If `expires` is present and already in the past, the read fails with a message
  asking the user to renew the OpenAI login.
- The account id is taken from `accountId` or `accountIdOverride` if present,
  otherwise decoded from the access token's JWT payload at the
  `https://api.openai.com/auth` claim (`chatgpt_account_id`). No signature
  verification is performed; the token is used only as supplied by OpenCode, and
  the account id is only sent back to the same vendor.

Missing files, invalid JSON, and missing fields all produce a `CodexUsageError`
with code `auth`, never an exception that escapes the store.

## Request and response

`fetchCodexUsage()` sends a `no-store` GET to
`https://chatgpt.com/backend-api/wham/usage` with these headers:

| Header | Value |
|--------|-------|
| `Accept` | `application/json` |
| `Authorization` | `Bearer <access token>` |
| `ChatGPT-Account-Id` | the derived account id |
| `Originator` | `opencode_codex_usage` |
| `User-Agent` | `opencode-codex-usage/0.1.0` |
| `x-openai-codex-luna-reserve` | `1` for the TUI usage request so eligible accounts can return the reserve bucket |

The shared `fetchCodexUsage()` client leaves this opt-in disabled by default;
the TUI store and the diagnostic script enable it, while `codex-fallback`
continues using the passive request.

Status handling:

| Status | Code | Behavior |
|--------|------|----------|
| 401 / 403 | `auth` | Login is no longer authorized; clear the snapshot |
| 429 | `rate-limit` | Parse `Retry-After` (seconds or HTTP date) and back off |
| other non-2xx | `network` | Report the status |
| unreadable body | `response` | Report unreadable data |

### Parsing

`parseUsagePayload()` turns the payload into a `CodexUsageSnapshot`:

- The overall bucket comes from `rate_limit` (or `rateLimit`) and is given the
  id `codex` and name `Overall`.
- Extra buckets come from `additional_rate_limits` / `additionalRateLimits`,
  keyed by `metered_feature`, `limit_id`, or an `extra-N` fallback.
- Newer response shapes are also accepted through `rateLimits` and
  `rateLimitsByLimitId`.
- Each bucket parses `primary_window`/`primary` and
  `secondary_window`/`secondary`. A window needs a `used_percent` (or
  `usedPercent`) to exist; percentages are clamped to 0–100.
- Window length is derived from `limit_window_seconds` (rounded up to minutes)
  or `windowDurationMins`; `windowLabel()` maps 300 → `5h`, 10080 → `Weekly`,
  43200 → `Monthly`, and otherwise derives days/hours/minutes.
- Reset time is `reset_at` / `resetsAt` (epoch seconds) or `reset_after_seconds`
  converted to an absolute time.
- Credits (`credits`), unlimited flag, and reset-credit count are captured, as
  is `rate_limit_reached_type` / `rateLimitReachedType`.
- If no window parses at all, the whole response is rejected as `response` —
  the panel would rather show nothing than a wrong number.

`overallWeeklyWindow()` (shared) selects the bucket with id `codex`, then its
window whose `windowMinutes === 10080`, falling back to the `secondary` window.
`lunaReserveWindow()` selects the bucket named or identified as `gpt-reserve`
and prefers its weekly window. The reserve row is omitted when that bucket is
absent; no value is inferred from the overall quota.
`codex-usage` uses it to decide visibility and to render; `codex-fallback` uses
it to decide whether the limit is reached.

## UI composition

`UsagePanel` is registered into the `sidebar_content` slot with `order: 150`.

Reactive inputs:

- `state` from `store.subscribe`.
- `activeModel`, seeded from `latestSessionModel()` over the session's messages.
- `collapsed` from `api.kv.get(COLLAPSED_KEY, false)`.
- `now`, updated by a 30 s interval so countdowns and "updated N ago" stay
  current.
- `theme` from `api.theme.current`.

Event subscriptions:

| Event | Effect |
|-------|--------|
| `session.next.model.switched` (matching session) | Update `activeModel` |
| `message.updated` (matching session) | Update `activeModel` from the message |
| `session.idle` (qualifying model) | `store.refresh(true)` once |

A `createEffect` refreshes immediately whenever the active model becomes a
Codex subscription model. The poll interval refreshes only while the active
model qualifies. All intervals and subscriptions are released in `onCleanup`.

`visible()` requires all three of: a Codex subscription model, a snapshot, and
an overall weekly window. The header shows `- Codex Usage` or `+ Codex Usage`;
the body shows the `Weekly limit` row, an optional one-line `Luna Reserve` row,
an optional "Last refresh failed; showing saved values." warning, and the
last-updated line. Colors are green → warning at ≤20 % remaining → error at
≤10 % remaining.

### `isCodexSubscriptionModel()`

In `src/model.ts`, a model qualifies if its **provider id** is `openai` or
contains `codex` (case-insensitive). The model id is not inspected. This is
why the panel disappears when another provider becomes active.

## Commands

`api.command.register()` adds two entries under the `Codex` category:

| Title | Value | Slash | Action |
|-------|-------|-------|--------|
| `Refresh Codex usage` | `codex-usage.refresh` | — | Force a refresh and toast the result |
| `Codex usage details` | `codex-usage.details` | `/codex-usage` (alias `/usage-left`) | Show the details dialog |

The details dialog uses `api.ui.DialogAlert` and the text from
`formatDetails()`, which includes overall percent left/used, the relative and
exact overall reset time, an optional Luna Reserve remaining percentage and
countdown, any refresh error, and the last update time.

## Options

| Option | Type | Default | Minimum | Effect |
|--------|------|---------|---------|--------|
| `refreshMs` | number | 60000 | 30000 | Sidebar poll interval while a qualifying model is active |
| `timeoutMs` | number | 10000 | 1000 (store) | Per-request timeout before aborting |

Non-numeric or non-finite values are ignored and the default is used. The
plugin floors `refreshMs` at `MIN_REFRESH_MS` (30 s).

## Error presentation

- Non-auth refresh failures keep the previous snapshot and add a warning line.
- Auth failures clear the snapshot, so the panel (and the details dialog) show
  the explanatory message instead of a stale value.
- Rate limits back off until the parsed retry time and report the backoff.

## Security

See the [shared security model](README.md#shared-security-model). In short: the
plugin reads only the access token, talks only to the fixed usage endpoint,
never logs or stores credentials, and keeps quota data out of model context.

## Checks

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage run check:usage
```

- `check` = `tsc --noEmit` plus the `node:test` suite.
- `check:usage` runs `scripts/check-usage.ts`, which reads the live credential
  and prints the formatted snapshot (or an error message) once. It is a manual
  diagnostic, not part of CI.

The test suite covers window parsing (including model-specific extras and Luna
Reserve), clamping of unexpected percentages, rejection of responses without
windows, reserve-header opt-in, credential reading without JWT decoding,
countdown formatting, and model detection from both message shapes.

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---------|--------------|-----------|
| No panel at all | Active model is not OpenAI/Codex, or no snapshot yet | Switch to the subscription model; run `Refresh Codex usage` |
| No Luna Reserve row | The backend did not return the optional `gpt-reserve` bucket | This is expected for accounts without Luna Reserve access; the plugin does not infer a balance |
| "OpenAI login not found" | No `opencode auth login` for OpenAI | Run `opencode auth login` |
| "requires an OpenAI OAuth login" | API-key login instead of OAuth | Log in with the ChatGPT/Codex subscription |
| "needs renewal" | Access token expired | Use OpenAI in OpenCode or log in again |
| Panel shows saved values with a warning | Last refresh failed (network/response) | Check connectivity; the panel will recover on the next successful poll |
| "backing off after rate limiting" | Endpoint returned 429 | Wait for the retry window; reduce `refreshMs` pressure if needed |
| Panel does not update | OpenCode was not restarted after registration | Restart OpenCode |

The plugin falls back gracefully on endpoint changes: an unexpected shape is
reported as a validation error rather than displayed as a number.
