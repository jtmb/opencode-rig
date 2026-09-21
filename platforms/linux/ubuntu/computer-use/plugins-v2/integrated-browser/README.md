# `integrated-browser` v2 plugin

`integrated-browser` is a dual-role OpenCode v2 plugin. Its server role owns a
temporary Playwright `BrowserContext` per OpenCode session and renders a headed
Chromium window outside OpenTUI. Its CLI role adds a fullscreen control panel;
the panel and the `integrated_browser` agent tool use the same session context.

## Quick start

The plugin reuses the pinned runtime in `platforms/linux/ubuntu/browser-tools`.
It does not install Chromium or any npm dependency.

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/integrated-browser run check
platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --plugins integrated-browser --apply
```

Provision the headed browser separately into the isolated OpenCode pilot cache:

```bash
XDG_CACHE_HOME="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/cache" \
  ./platforms/linux/ubuntu/browser-tools/node_modules/.bin/playwright install chromium
```

The pinned Playwright installer verifies its own browser artifact and prints the
exact revision and destination. Rollback is to close every integrated-browser
session, then remove only the Chromium, Chromium headless-shell, and FFmpeg
revision directories printed by `playwright install --dry-run chromium` from
that pilot cache; do not remove the cache root or the repository Firefox bundle.

Restart the OpenCode server and CLI after registration changes. Launch the
panel with **Integrated browser** from the command palette, `/browser`, or
`Ctrl+Alt+B`; choose an `http://` or `https://` URL.

## Configuration

Register the package in both roles:

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "/home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins-v2/integrated-browser",
      "options": {
        "runtimeRoot": "/home/james/repos/opencode-rig/platforms/linux/ubuntu/browser-tools"
      }
    }
  ]
}
```

```json
// cli.json
{
  "plugins": [
    {
      "package": "/home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins-v2/integrated-browser",
      "options": {}
    }
  ]
}
```

`runtimeRoot` defaults to the repository's sibling `browser-tools` directory.
Optional bounds are `maxSessions` (1–4), `maxTabs` (1–12),
`maxConsoleEntries` (1–100), `maxSnapshotChars` (256–24,000),
`maxScreenshotBytes` (1,024–2,000,000), `navigationTimeoutMs` (1,000–15,000),
and `defaultViewport` (320–1920 by 240–1080).

## Supported surface

- headed launch and explicit close, with cleanup on session deletion and plugin unload;
- URL navigation restricted to credential-free `http` and `https` URLs;
- bounded browser tabs, back, forward, reload, tab selection, and viewport sizing;
- bounded ARIA snapshots, console ring buffers, viewport JPEG screenshots, and accessible-role click/fill actions;
- typed RPC methods/events shared by the server and CLI roles.

Each session uses a non-persistent context. Cookies, storage, and pages are not
shared between OpenCode sessions; this context isolation is not an OS security
boundary. The external Chromium executable must already
be available to the pinned Playwright runtime; a missing runtime produces an
explicit bounded error and never triggers installation.

## Explicit non-goals

OpenCode v2.0.7 has no supported native webview or child-window embedding API,
so the browser is not rendered inside OpenTUI. This package does not attach to
normal browser profiles, load extensions, expose arbitrary JavaScript or CDP,
provide integrated debugger parity, permit unrestricted file access, modify
installed OpenCode binaries, or replace the existing Firefox Playwright MCP.

Live headed Chromium acceptance requires a separately provisioned Chromium
executable and a usable desktop session. On 2026-09-19, the pinned Chromium
153.0.8010.12 revision 1243 passed headed launch, navigation, screenshot, ARIA
snapshot, accessible-link interaction, fullscreen-controller, and cleanup
checks on this workstation.

## Development

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/integrated-browser run check
```
