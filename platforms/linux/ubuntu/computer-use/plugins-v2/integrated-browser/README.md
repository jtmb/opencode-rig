# `integrated-browser` v2 plugin — retired

This package is retained as historical source only. It is retired from active
server and CLI roles and excluded from the current plugin workspace. It is not
an active browser or QA path.

For existing configurations, follow the
[integrated-browser retirement procedure](../../../../../../docs/plugins/README.md#removal-and-troubleshooting).
That procedure removes only canonical server/CLI registrations and preserves
unrelated entries and this historical source package.

Current browser guidance:

- For visible browser work and QA from WSL, use the Windows-default-browser
  tools described in the [`browser-assistant` guide](../../skills/browser-assistant/README.md).
- The direct-pinned Playwright package in
  [`browser-tools`](../../../browser-tools/README.md) is reserved for explicitly
  requested headless Firefox tasks. It is not an MCP and does not provision a
  browser.

## Historical implementation

The former server role created a temporary Playwright `BrowserContext` per
OpenCode session and opened headed Chromium outside OpenTUI. The former CLI role
provided a fullscreen panel, sharing the session context with the
`integrated_browser` agent tool. Its bounded feature set included credential-free
HTTP(S) navigation, browser tabs and controls, ARIA snapshots, console entries,
viewport screenshots, and accessible-role click/fill actions. Contexts did not
share cookies, storage, or pages between OpenCode sessions; this was not an OS
security boundary.

At retirement, OpenCode v2.0.7 had no supported native webview or child-window
embedding API. The package did not attach to normal browser profiles, load
extensions, expose arbitrary JavaScript or CDP, provide integrated debugger
parity, permit unrestricted file access, or modify installed OpenCode binaries.

On 2026-09-19, a headed Chromium 153.0.8010.12 revision 1243 passed launch,
navigation, screenshot, ARIA snapshot, accessible-link interaction,
fullscreen-controller, and cleanup checks on this workstation. This is
historical acceptance evidence for the retired package only.
