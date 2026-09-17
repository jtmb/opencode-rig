# Codex Usage Sidebar

This local OpenCode TUI plugin shows the remaining overall weekly ChatGPT Codex
subscription quota in the session sidebar, along with its reset countdown. When
the backend supplies the optional Luna Reserve bucket, the sidebar adds one
compact `Luna Reserve: NN% left` line. Short-window and other model-specific
counters remain hidden.

Luna Reserve is an optional backend-provided fallback allowance for selected
personal Plus and Pro accounts. The backend may omit the reserve bucket even
when the regular weekly window is exhausted; omission hides the row rather
than displaying a guessed zero balance.

When the quota runs out, the companion
[`../codex-fallback/`](../codex-fallback/README.md) server plugin can continue
sessions on a configurable provider chain.

## Requirements

- OpenCode 1.18.31 or a compatible 1.x build with TUI sidebar slots.
- An OpenAI OAuth login created by `opencode auth login`.
- Node.js 22.6+ for development checks.

API-key billing limits are not ChatGPT subscription limits and are not shown.

## Configuration

Register the source file in `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "file:///absolute/path/to/codex-usage/src/tui.tsx",
      {
        "refreshMs": 60000,
        "timeoutMs": 10000
      }
    ]
  ]
}
```

Restart OpenCode after changing TUI configuration. The sidebar panel is
collapsible and appears only when the session's active model uses the
OpenAI/Codex subscription. It disappears when another provider becomes active.
There is no loading placeholder: the panel appears only after real quota data
arrives.

The installed configuration polls once per minute while a qualifying model is
active and refreshes once when a Codex turn becomes idle. It does not poll while
another provider is active. The panel shows the last successful update time.
The command palette provides `Refresh Codex usage` and `Codex usage details`;
`/codex-usage` opens the details dialog.

## Security

The plugin reads the current OpenCode OpenAI OAuth access token from the normal
XDG data location and sends it only to the fixed ChatGPT usage endpoint. It does
not use or expose the refresh token, modify `auth.json`, log credentials, or add
quota data to model context. OpenCode remains responsible for token renewal.

The usage endpoint is a ChatGPT backend endpoint used by Codex clients, not a
versioned public REST API. Response validation and stale-data handling keep a
service change from being displayed as a fabricated quota value.
The TUI usage request opts into the backend's Luna Reserve bucket; the shared
client remains passive by default so the companion fallback plugin does not
change routing behavior.
See [Luna Reserve in Codex and ChatGPT Work](https://help.openai.com/en/articles/20001499-luna-reserve-in-codex-and-chatgpt-work)
for availability and account behavior.

## Checks

```bash
npm install
npm run check
npm run check:usage
```
