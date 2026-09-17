# `playwright-mcp.sh` (Live Browser)

Launches the pinned Playwright MCP in a **visible, shared Firefox window**. This
is the `playwright` MCP that OpenCode registers project-only, and the browser
the user and agent steer together during a session.

```bash
./platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh
```

The script is normally launched by OpenCode as an MCP server, not by hand.

## What it does

1. Sets `umask 077` and `set -euo pipefail`.
2. Resolves:
   - `NODE_BIN` = `~/.local/share/fnm/aliases/default/bin`
   - `PROJECT` = the sibling `browser-tools/` directory
   - `MCP` = `<PROJECT>/node_modules/.bin/playwright-mcp`
   - `OUTPUT` = `/tmp/opencode/playwright`
3. Preflight: fails with a clear message if the fnm Node binary or the MCP
   executable is missing. The missing-MCP message explains how to provision it
   with [`setup-computer-assistant.sh`](setup-computer-assistant.md).
4. Creates `OUTPUT` and chmods it `700`.
5. Prepends the fnm Node directory to `PATH` and sets
   `PLAYWRIGHT_BROWSERS_PATH` to `<PROJECT>/browsers`, so the pinned Firefox is
   used rather than a system browser.
6. Replaces itself (`exec`) with the MCP:

   ```bash
   playwright-mcp \
     --browser firefox \
     --isolated \
     --image-responses omit \
     --output-dir /tmp/opencode/playwright
   ```

## Flags

| Flag | Meaning |
|------|---------|
| `--browser firefox` | Use Firefox |
| `--isolated` | A fresh, separate profile; no access to the user's normal Firefox profile, cookies, or tabs |
| `--image-responses omit` | Do not return screenshots as image content, keeping the model context small |
| `--output-dir` | Where transient browser output is written |

## Integration

- Registered as the MCP named `playwright` in the **project** `opencode.json`
  with `"type": "local"`, this wrapper as the command, and a 30 s timeout.
- Project-only: it must not appear in the global `~/.config/opencode`
  configuration.
- [`setup-computer-assistant.sh --verify-only`](setup-computer-assistant.md)
  confirms the entry resolves and `opencode mcp list` reports it connected.

## Failure behavior

| Condition | Result |
|-----------|--------|
| fnm Node missing | Prints the path and exits `1` |
| MCP runtime missing | Prints the path and a provisioning hint, exits `1` |
| Output directory cannot be created | `set -e` aborts with a non-zero exit |

The script never prints secrets and never falls back to a system browser.

## Security and isolation

- The isolated profile keeps the agent out of the user's normal browsing data.
- Image responses are omitted by default; page content is treated as untrusted.
- Transient output stays under `/tmp/opencode/playwright/` (`700`), which is
  cleared between tasks.
- If the user interacts with the live window, the agent must take a fresh
  snapshot before acting rather than assuming the page state is unchanged.

## Related

- [`playwright-headless-mcp.md`](playwright-headless-mcp.md) — the isolated
  invisible browser for explicitly non-interactive work.
- [`setup-computer-assistant.md`](setup-computer-assistant.md) — installs the
  runtime and registers the MCP.
- `browser-tools/README.md` — the pinned package.
