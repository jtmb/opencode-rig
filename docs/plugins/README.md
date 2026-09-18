# Local Plugins

The repository ships five local OpenCode plugins. They are ordinary npm
packages that live in the repository and are loaded directly from source; they
are **not** deployed by the setup scripts and are **not** published to npm.

| Plugin | Kind | Directory | Purpose |
|--------|------|-----------|---------|
| [`codex-usage`](codex-usage.md) | TUI | `platforms/linux/ubuntu/computer-use/plugins/codex-usage/` | Collapsible sidebar panel showing weekly ChatGPT Codex quota and optional Luna Reserve remaining usage |
| [`codex-fallback`](codex-fallback.md) | Server | `platforms/linux/ubuntu/computer-use/plugins/codex-fallback/` | Transparent failover from the Codex subscription to a configurable chain of any OpenCode providers when the quota runs out |
| [`source-control`](source-control.md) | TUI | `platforms/linux/ubuntu/computer-use/plugins/source-control/` | Working-tree changes and the current branch's GitHub pull request in the session sidebar |
| [`tui-settings`](tui-settings.md) | TUI | `platforms/linux/ubuntu/computer-use/plugins/tui-settings/` | Settings overlay for appearance, display, plugins, source control, and sidebar positioning |
| [`file-manager`](file-manager.md) | TUI | `platforms/linux/ubuntu/computer-use/plugins/file-manager/` | Full-screen project tree, quick-open, and an in-TUI editor with explicit saves |

## OpenCode v2 ports

OpenCode 2.0.x uses a new plugin API, so the plugins have parallel ports under
`platforms/linux/ubuntu/computer-use/plugins-v2/` rather than edits to the v1
packages. The v2 workspace has its own `node_modules`, tsconfig base, and
[README](../../platforms/linux/ubuntu/computer-use/plugins-v2/README.md), and
each package registers through the object form in `opencode.jsonc` (server) or
`cli.json` (CLI). v1 remains the default until the migration cutover.

| v2 package | Kind | Replaces |
| --- | --- | --- |
| `rig-tools` | server | v1 `tools/desktop.ts` + `tools/vision.ts` custom tools |
| `codex-fallback` | server | v1 `codex-fallback` |
| `source-control` | CLI | v1 `source-control` |
| `codex-usage` | CLI | v1 `codex-usage` |
| `file-manager` | CLI | v1 `file-manager`, now a docked `session.panel` instead of a full-screen route |

There is no `tui-settings` port: v2's built-in `/settings` covers appearance,
display, plugins, and keybinds, and its Source Control presets move into the
v2 `source-control` plugin.

## TUI vs. server plugins

OpenCode has two distinct plugin surfaces, and these packages target one each.

- A **TUI plugin** runs inside the terminal UI. It can register sidebar slots,
  command-palette entries, slash commands, dialogs, toasts, and key-value
  storage, and it can subscribe to TUI events. `codex-usage` is a TUI plugin
  whose entry point is `src/tui.tsx`.
- `source-control` is also a TUI plugin. It uses the VCS client for local
  status, the built-in diff route for file activation, and a bounded child MCP
  client for optional GitHub pull-request status. Its `src/options.ts`
  normalizes the registration options, re-reads the runtime kv overrides on
  each poll tick, and runs the one-time minimized-start migration.
- `tui-settings` is a TUI plugin that renders a `Settings` row and a drill-down
  overlay over the host `DialogSelect`/`DialogAlert` components. It edits host
  display keys, dispatches the built-in theme and plugin managers, tunes the
  `source-control` runtime keys, and positions the harness sidebar panels.
- `file-manager` is a TUI plugin that registers a full-screen `files` route and
  an `Explorer` row. It loads the project tree lazily through
  `client.file.list`, searches with `client.find.files`, renders files with
  `line_number` + `code` highlighting, and edits with a `textarea` that saves
  atomically through `node:fs` under a `realpath` containment check.
- A **server plugin** runs in the OpenCode server. It can hook config
  resolution, message assembly, outbound request parameters, and the event
  stream, and it can call the client API (sessions, providers, TUI). It has no
  rendering surface of its own. `codex-fallback` is a server plugin whose entry
  point is `src/index.ts`.

The TUI plugins are registered in `tui.json`, while the server plugin is
registered in `opencode.jsonc` (see below), so enabling one does not enable the
others. The Codex sidebar and router are designed to work together; source
control is independent and adds local and GitHub working-tree context.

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

### `source-control` (TUI)

Register the source file in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/source-control/src/tui.tsx",
      { "github": true }
    ]
  ]
}
```

The deployment script also supports `--plugins source-control` and
`--plugins all`. Registration is user-owned and takes effect after restart.

### `tui-settings` (TUI)

Register the source file in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/tui-settings/src/tui.tsx",
      { "order": 10 }
    ]
  ]
}
```

The deployment script also supports `--plugins tui-settings` and
`--plugins all`. Registration is user-owned and takes effect after restart.

### `file-manager` (TUI)

Register the source file in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/file-manager/src/tui.tsx",
      { "order": 60 }
    ]
  ]
}
```

The deployment script also supports `--plugins file-manager` and
`--plugins all`. Registration is user-owned and takes effect after restart.

> The chain above is an example. There is no baked-in provider chain: until you
> register a non-empty `defaultChain` (or a per-agent chain), the router is
> inactive and the session stays on its configured model.

### Environment-backed credentials

OpenCode loads a project `.env` automatically. Reference its values in
`opencode.json` with `{env:VARIABLE_NAME}`; do not add an `envFile` key or put
the secret value in JSON. The complete project example is
[`config/opencode.example.jsonc`](../../platforms/linux/ubuntu/computer-use/config/opencode.example.jsonc),
with a safe template at
[`config/.env.example`](../../platforms/linux/ubuntu/computer-use/config/.env.example).

For example, an API-key provider can be configured as:

```jsonc
{
  "provider": {
    "deepseek": {
      "options": { "apiKey": "{env:DEEPSEEK_API_KEY}" }
    }
  }
}
```

The GitHub wrapper can receive the same kind of reference through a local MCP
`environment` entry; its token variable is documented in
[`github-mcp.md`](../scripts/github-mcp.md). OpenAI/Codex OAuth is intentionally
different: run `opencode auth login`, and the plugins read only the managed
`~/.local/share/opencode/auth.json` access-token entry. They do not read OAuth
tokens from `.env` or the refresh token.

## Package layout and requirements

The packages follow the same conventions:

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
- `source-control` additionally depends on the `@opentui/*` packages,
  `solid-js`, and the pinned `@modelcontextprotocol/sdk` for its bounded stdio
  GitHub client.
- `tui-settings` additionally depends on the `@opentui/*` packages and
  `solid-js` for its sidebar row and host-dialog overlay.
- `file-manager` additionally depends on the `@opentui/*` packages and
  `solid-js`; it uses `node:fs` for reads and atomic saves.
- Every plugin's `typecheck` and `test` scripts run through the repository's
  adaptive resource guard so a check cannot take down its OpenCode parent.

`npm run check` runs `tsc --noEmit` followed by the test suite:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-usage run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-fallback install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/codex-fallback run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/source-control install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/source-control run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/tui-settings install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/tui-settings run check
npm --prefix platforms/linux/ubuntu/computer-use/plugins/file-manager install
npm --prefix platforms/linux/ubuntu/computer-use/plugins/file-manager run check
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

The two Codex plugins handle an OpenAI OAuth credential. Their posture is
deliberately narrow and identical in spirit:

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

`source-control` does not read OpenCode OAuth credentials. Its GitHub section
starts the repository's `github-mcp.sh` wrapper only through a transient,
adaptive-memory user service, or a bounded `prlimit` fallback when the user
systemd manager is unavailable. That wrapper remains read-only, lockdown
protected, and limited to repository, issue, and pull-request tools. If no
safe current-memory budget or authentication is available, the local panel
continues and the GitHub row stays hidden.

The usage endpoint is a ChatGPT backend endpoint used by Codex clients, not a
versioned public REST API. Both plugins validate the response and handle
service changes conservatively so a malformed reply is never shown as a
fabricated quota value.

## Deploying the plugins

The repository ships a `/deploy` command and a `deploy-plugins.sh` script that
register the plugins with an OpenCode installation. Registration references this
checkout with `file://` URLs; the plugin sources are not copied.

- **Global** deploys to `~/.config/opencode/tui.json` (TUI) and
  `~/.config/opencode/opencode.jsonc` or `.json` (server).
- **Project** deploys to `<repo>/.opencode/tui.json` (TUI) and
  `<repo>/.opencode/opencode.json` (server).
- `--bootstrap` additionally copies the provisioning scripts into the target.

Run `/deploy` for an interactive, question-driven flow, or invoke the script
directly. Both default to read-only verification; writes require `--apply`.
Neither overwrites existing `plugin` entries or their options, and both refuse
to rewrite a config that contains JSONC comments (they cannot be preserved by a
plain JSON edit).

Full behavior, options, targets, and exit codes are documented in
[`docs/scripts/deploy-plugins.md`](../scripts/deploy-plugins.md).

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
