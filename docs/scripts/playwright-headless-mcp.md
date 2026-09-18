# `playwright-headless-mcp.sh` (Headless Browser)

> **v1 / rollback only.** The OpenCode v2 stack registers exactly one live
> `playwright` MCP; explicitly headless work runs through the repository
> Playwright runtime from the shell. This launcher remains for the v1 rollback
> stack.

Launches the pinned Playwright MCP in an **isolated, invisible Firefox**
browser. This is the `playwright_headless` MCP that OpenCode registers
project-only. It is used only when the user explicitly asks for headless or
background execution, or when the task is clearly non-interactive.

```bash
./platforms/linux/ubuntu/computer-use/scripts/playwright-headless-mcp.sh
```

The script is normally launched by OpenCode as an MCP server, not by hand.

## What it does

It mirrors [`playwright-mcp.sh`](playwright-mcp.md) with two differences:

- `OUTPUT` is `/tmp/opencode/playwright-headless` (a separate output directory
  from the live browser).
- The MCP is launched with `--headless`.

```bash
playwright-mcp \
  --browser firefox \
  --headless \
  --isolated \
  --image-responses omit \
  --output-dir /tmp/opencode/playwright-headless
```

The preflight, `umask 077`, `PATH` prepending, `PLAYWRIGHT_BROWSERS_PATH`
pinning, and `exec` behavior are identical to the live wrapper.

## Flags

| Flag | Meaning |
|------|---------|
| `--browser firefox` | Use Firefox |
| `--headless` | No visible window |
| `--isolated` | Fresh profile; no access to the user's normal Firefox profile |
| `--image-responses omit` | Omit screenshots from responses to keep context small |
| `--output-dir` | Separate transient output directory |

## Integration

- Registered as the MCP named `playwright_headless` in the **project**
  `opencode.json`, project-only.
- `setup-computer-assistant.sh --verify-only` confirms the entry resolves and
  `opencode mcp list` reports it connected.
- The two Playwright MCPs are independent processes with separate output
  directories and separate browser contexts, so using one does not disturb the
  other.

## Choosing between the two

| Situation | Use |
|-----------|-----|
| User needs to see, steer, authenticate, or take over the page | Live (`playwright`) |
| Explicit headless/background request | Headless (`playwright_headless`) |
| Read-only research without interaction | `webfetch`/`websearch`, neither browser |

Do not silently switch modes when one MCP fails to start; report the startup
error and let the user decide.

## Failure behavior

Same as the live wrapper: missing Node or missing runtime prints a path and
provisioning hint, then exits `1`. No fallback to a different browser or mode.

## Security and isolation

The headless browser is fully isolated from the user's normal Firefox profile
and has no visible surface. Page content is untrusted, and transient output
stays under `/tmp/opencode/playwright-headless/`.

## Related

- [`playwright-mcp.md`](playwright-mcp.md) — the visible shared browser.
- [`setup-computer-assistant.md`](setup-computer-assistant.md) — installs the
  runtime and registers both MCPs.
- `browser-tools/README.md` — the pinned package.
