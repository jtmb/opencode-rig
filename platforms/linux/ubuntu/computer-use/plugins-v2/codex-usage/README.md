# Codex Usage (OpenCode v2)

This CLI plugin adds a compact Codex quota panel to the OpenCode v2 sidebar.
It reads the managed OpenAI OAuth access-token entry through the shared usage
reader, shows the weekly window and optional Luna Reserve window, and keeps the
last good values visible when a refresh fails.

## Registration

Register the package in the `plugins` array in v2 `cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/abs/path/to/plugins-v2/codex-usage",
      "options": { "refreshMs": 60000, "timeoutMs": 10000 }
    }
  ]
}
```

The package is already part of the canonical catalog and the example at
[`../../config/v2-cli.example.json`](../../config/v2-cli.example.json). Restart
OpenCode after changing registration or plugin source.

## Behavior

- The panel appears only when the active session uses a Codex subscription model
  and a valid usage snapshot is available.
- The header toggles between compact and expanded views; the collapsed setting
  is stored through v2 plugin storage.
- `Refresh Codex usage` is available in the command palette.
- `/codex-usage` opens exact limits and reset times in a dialog; `/usage-left`
  is an alias.
- Refresh and polling intervals are bounded, and cleanup disposes timers,
  subscriptions, and the shared store.

## Options

| Option | Default | Meaning |
|---|---:|---|
| `refreshMs` | `60000` | Poll interval; values below 30 seconds are raised. |
| `timeoutMs` | store default | Usage-request timeout. |

## Security

The shared reader accesses only the OpenAI OAuth access token and account id
needed for the fixed usage endpoint. It never reads or exposes the refresh
token, changes `auth.json`, logs credentials, or places quota values in model
context. A missing or malformed credential produces an error state rather than
invented usage data.

## Development check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage run check
```

The package uses the workspace's bounded typecheck and test commands. Usage
parsing and formatting are covered by the package tests; the v2 workspace
README documents the full seven-package check order.
