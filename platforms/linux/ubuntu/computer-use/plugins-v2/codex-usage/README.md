# Provider Usage (OpenCode v2)

This CLI plugin adds a compact provider-usage panel to the OpenCode v2 sidebar.
It shows Codex subscription limits, DeepSeek balance, Anthropic rate-limit
headroom from first-party inference response headers, and authoritative status
for other working providers.

## Registration

Register the package in the `plugins` array in v2 `cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/abs/path/to/plugins-v2/codex-usage",
      "options": {
        "refreshMs": 60000,
        "timeoutMs": 10000,
        "anthropicWorkspaceId": "wrkspc_example"
      }
    }
  ]
}
```

The package is already part of the canonical catalog and the example at
[`../../config/v2-cli.example.json`](../../config/v2-cli.example.json). Restart
OpenCode after changing registration or plugin source.

## Behavior

- Working provider rows appear from OpenCode's resolved runtime and connection
  state. Codex shows its weekly and optional Luna Reserve windows; DeepSeek
  shows the balance returned by its balance service.
- Anthropic request routing and rate-limit capture use provider-scoped session
  hooks. The plugin adds `anthropic-workspace-id` only to HTTPS requests on
  `api.anthropic.com` under `/v1/`, and only when one workspace is resolved from
  active API-key metadata or the explicit option below. Missing or conflicting
  workspace information is never guessed; the row reports measurement
  unavailable while provider readiness remains independent.
- Anthropic's Admin Usage report is a separate admin-credential API. Its token
  totals are not treated as a remaining-balance ratio; Anthropic rate-limit
  percentages come only from complete inference response limit/remaining
  headers. Unknown numeric measurements remain neutral.
- The header toggles between compact and expanded views; the collapsed setting
  is stored through v2 plugin storage.
- `Refresh provider usage` is available in the command palette.
- `/provider-usage` opens provider details; `/codex-usage` and `/usage-left` are
  aliases.
- Refresh and polling intervals are bounded, and cleanup disposes timers,
  subscriptions, and the shared store.

## Sidebar design ledger

The private local package exports its machine-readable sidebar contract at
`opencode-codex-usage-v2-local/design-ledger`. Local workspace consumers can
import it as JSON:

```js
import ledger from "opencode-codex-usage-v2-local/design-ledger" with { type: "json" }

if (ledger.schemaVersion !== 1) throw new Error("Unsupported Provider Usage ledger schema")
console.log(ledger.sidebar.themeRoles)
```

Consumers that prefer file-based JSON can read `design-ledger.json` directly
from the local package directory and parse it with `JSON.parse`. The package
remains private and is not published for registry installation. The integer
`schemaVersion` is the contract version; additive fields retain the version,
while incompatible field or meaning changes require a version bump.

Version 1 specifies one non-wrapping provider row ordered as provider label,
optional measurement, and status. The provider uses `text.default`, the
measurement always uses `text.subdued`, and status alone uses semantic roles:
`READY` uses `text.feedback.success.default`, `EMPTY` uses
`text.feedback.error.default`, and `COOLING`, `OFFLINE`, and `STALE` use
`text.subdued`. These are theme-role names, not literal palette values.

The optional middle value comes only from the sanitized provider usage row. A
current verified adapter value takes precedence; a retained last-good value is
shown only when explicitly paired with `STALE`. Missing or unverified values
are omitted, and `remainingRatio` never changes measurement color. At narrow
widths rows stay on one line and overflowing content truncates rather than
wrapping; the optional measurement may be omitted to preserve the provider and
status. For example, an illustrative row can read `OpenAI · Weekly 67% · READY`
or `DeepSeek · USD 12.50 · READY`.

Use `/provider-usage` for full provider details, verbose explanations,
diagnostics, reset times, and the shared updated timestamp. The compact sidebar
does not show wrapped detail text or an updated stamp.

## Options

| Option | Default | Meaning |
|---|---:|---|
| `refreshMs` | `60000` | Poll interval; values below 30 seconds are raised. |
| `timeoutMs` | store default | Usage-request timeout. |
| `anthropicWorkspaceId` | unset | Non-secret Anthropic workspace ID used only when active API-key metadata does not identify exactly one workspace. |

## Security

OpenCode's integration resolver supplies credentials to the server-side usage
checks. API keys and OAuth tokens are never logged, embedded in source, or sent
to model context. The workspace option is an identifier, not a credential. The
plugin does not call the separate Anthropic Admin Usage report endpoint or infer
remaining quota from its aggregate token totals. A usage/balance-check 429 marks
that measurement unavailable and does not change provider connectivity.

## Development check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage run check
```

The package uses the workspace's bounded typecheck and test commands. Usage
parsing and formatting are covered by the package tests; the v2 workspace
README documents the full seven-package check order.
