# Archived: Playwright MCP

This page is retained only as a historical reference to the retired
Playwright-MCP launcher. The launcher and its project-only MCP registration were
removed; this is not a setup or usage guide, and its old launch instructions
must not be followed.

The current portable project and native/WSL global profiles declare exactly
`basic-memory`, `github`, and `chatgpt`. WSL browser interactions use the
Windows-default-browser tools in `wsl-interop` (bounded UI Automation against
the Windows OS default browser), not the retired headed Chromium plugin or a
Playwright MCP. Live browser acceptance for that WSL path remains pending.

For current policy, see [`mcp_runtime.md`](mcp_runtime.md) and the
[v2 plugin guide](../plugins/README.md). Separate browser skills remain distinct
from MCP registration.
