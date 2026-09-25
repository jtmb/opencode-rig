# Browser Tools for Linux Ubuntu

Pinned Playwright JavaScript API for explicitly requested, isolated headless
Firefox tasks on Ubuntu. This package does not register an MCP or provide the
visible browser. The visible WSL browser workflow uses the user's Windows
default browser through the `wsl-interop` tools. This component was consolidated
from the former `~/repos/opencode-browser-tools/` directory.

## Source

- `package.json` declares the exact-pinned direct `playwright` dependency.
- `package-lock.json` pins the complete npm dependency graph.
- `node_modules/` is generated locally and ignored by Git. Browser binaries are
  separate from this package; it does not download or provision Chrome/Chromium.

There was no Git history or unique authored source in the former directory to
import beyond these manifests.

## Integration

Use this runtime only for an explicitly requested headless Firefox task:

```text
playwright from node_modules              # bounded headless Firefox script
```

The `browser-headless` skill runs a bounded Node script through
`run-bounded-command.sh`, launches an isolated Firefox context, and closes it
when finished. It does not start a visible browser or share state with the
user's Windows default browser. If the pinned package or an existing Firefox
executable is unavailable, stop and report the blocker rather than downloading
another browser. Transient output stays under `/tmp/opencode/`.

For visible interaction from WSL, use `wsl_browser_open`,
`wsl_browser_windows`, `wsl_browser_snapshot`, `wsl_browser_screenshot`, and the
`wsl_browser_click`, `wsl_browser_focus`, `wsl_browser_type`, and
`wsl_browser_press` actions. They use the current Windows default URL
association and fail closed when the WSL bridge is unavailable; do not
substitute headless Firefox or another browser.

Install the exact-pinned JavaScript package from the repository root when
headless Firefox has been explicitly requested:

```bash
npm --prefix platforms/linux/ubuntu/browser-tools ci --ignore-scripts
```

`--ignore-scripts` prevents package lifecycle hooks from downloading a browser.
Firefox must already be available in the active environment; this package
install does not provision it. Version changes must update `package.json` and
`package-lock.json` together. Visible Windows-browser QA is separate from this
npm package.
