# Local Plugins

The repository ships two local OpenCode plugins. They are ordinary npm
packages that live in the repository and are loaded directly from source; they
are **not** deployed by the setup scripts and are **not** published to npm.

| Plugin | Kind | Directory | Purpose |
|--------|------|-----------|---------|
| [`codex-usage`](codex-usage.md) | TUI | `platforms/linux/ubuntu/computer-use/plugins/codex-usage/` | Collapsible sidebar panel showing the remaining weekly ChatGPT Codex subscription quota and its reset countdown |
| [`codex-fallback`](codex-fallback.md) | Server | `platforms/linux/ubuntu/computer-use/plugins/codex-fallback/` | Transparent failover from the Codex subscription to a configurable chain of any OpenCode providers when the quota runs out |

## TUI vs. server plugins

OpenCode has two distinct plugin surfaces, and these packages target one each.

- A **TUI plugin** runs inside the terminal UI. It can register sidebar slots,
  command-palette entries, slash commands, dialogs, toasts, and key-value
  storage, and it can subscribe to TUI events. `codex-usage` is a TUI plugin
  whose entry point is `src/tui.tsx`.
- A **server plugin** runs in the OpenCode server. It can hook config
  resolution, message assembly, outbound request parameters, and the event
  stream, and it can call the client API (sessions, providers, TUI). It has no
  rendering surface of its own. `codex-fallback` is a server plugin whose entry
  point is `src/index.ts`.

The two are registered in different files (see below), so enabling one does not
enable the other. They are designed to be used together: the sidebar tells you
when the subscription quota is nearly gone, and the router keeps the session
alive when it is exhausted.

## Registration

Both registrations are **user-owned** files. The setup scripts do not create or
verify them, and editing them requires a restart.

### `codex-usage` (TUI)

Register the source file in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/codex-usage/src/tui.tsx",
      { "refreshMs": 60000, "timeoutMs": 10000 }
    ]
  ]
}
```

### `codex-fallback` (server)

Register the plugin in the `plugin` array of `~/.config/opencode/opencode.jsonc`:

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

Both forms use the `[moduleURL, options]` tuple. The second element is passed to
the plugin factory as its raw options object and is normalized internally.
Omitting the options object is valid; every option has a default.

> The chain above is an example. There is no baked-in provider chain: until you
> register a non-empty `defaultChain` (or a per-agent chain), the router is
> inactive and the session stays on its configured model.

## Package layout and requirements

Both packages follow the same conventions:

- `package.json` declares `"type": "module"`, a `check` script, and a pinned
  `@opencode-ai/plugin` dependency (`1.18.31`). Pinning to the installed OpenCode
  minor keeps the plugin API surface stable.
- `src/` holds the TypeScript sources; there is no separate build step. OpenCode
  loads the `.ts`/`.tsx` sources directly.
- `test/` holds `node:test` suites executed with
  `node --experimental-strip-types`, so no bundler or transpiler is required.
- `tsconfig.json` enables `--noEmit` type checking.
- `codex-usage` additionally depends on the `@opentui/*` packages and
  `solid-js` for its JSX rendering.

`npm run check` runs `tsc --noEmit` followed by the test suite:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-fallback install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-fallback run check
```

Node.js 22.6 or newer is required for `--experimental-strip-types`. The
generated `node_modules/` directories are gitignored.

## Shared Codex usage layer

`codex-fallback` does not reimplement quota reading. Its `src/usage.ts` imports
directly from the sibling package:

```ts
import {
  fetchCodexUsage,
  overallWeeklyWindow,
  readOpenAICredential,
} from "../../codex-usage/src/usage.ts"
```

This means:

- The OpenAI OAuth credential reader and the ChatGPT usage parser have a single
  implementation, shared by the TUI panel and the router.
- The two packages must stay checked out together; `codex-fallback` cannot be
  installed independently of `codex-usage`.
- A change to the endpoint, headers, or response parsing in
  `codex-usage/src/usage.ts` affects both plugins and must be covered by both
  test suites.

`codex-fallback/src/usage.ts` wraps the shared parser in a small
`QuotaChecker` that reduces the snapshot to the three facts the router needs —
`limitReached`, `resetsAt`, and `planType` — and caches the result.

## Shared security model

Both plugins handle an OpenAI OAuth credential. Their posture is deliberately
narrow and identical in spirit:

- They read only the OpenAI **access token** (and account id) from OpenCode's
  normal data location (`$XDG_DATA_HOME/opencode/auth.json`, defaulting to
  `~/.local/share/opencode/auth.json`).
- They never read or expose the **refresh token**, never modify `auth.json`,
  and never log credentials. OpenCode itself owns token renewal.
- The token is sent only to the fixed ChatGPT usage endpoint
  (`https://chatgpt.com/backend-api/wham/usage`), or to an explicitly
  configured `usageEndpoint` override used for local tests.
- The quota value is never written into model context; it is displayed or used
  for routing only.
- Fallback turns are ordinary model requests to the providers you configure;
  the plugins do not proxy or intercept provider traffic beyond selecting the
  model and aborting a failed turn.

The usage endpoint is a ChatGPT backend endpoint used by Codex clients, not a
versioned public REST API. Both plugins validate the response and handle
service changes conservatively so a malformed reply is never shown as a
fabricated quota value.

## Failure isolation

Neither plugin may take the harness down with it:

- `codex-usage` publishes an error state but keeps displaying the last known
  snapshot for non-authentication failures, and times out rather than hanging.
- `codex-fallback` fails **open**: if the usage check or provider catalog lookup
  errors, it does not switch models and lets OpenCode's own behavior proceed.
- Plugin code runs in the server/TUI process, so an unhandled exception is a
  real risk. Both keep their network and client calls inside `try`/`catch` and
  never throw from event handlers.

Continue with [`codex-usage.md`](codex-usage.md) and
[`codex-fallback.md`](codex-fallback.md) for the full behavioral detail.
