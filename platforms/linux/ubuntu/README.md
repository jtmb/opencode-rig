# Linux Ubuntu

OpenCode's Ubuntu integration is split into three cooperating components.

| Component | Directory | Responsibility |
|-----------|-----------|----------------|
| Computer use | [`computer-use/`](computer-use/) | GNOME control, skills, local plugins, memory, maintenance, setup, and live configuration |
| Browser tools | [`browser-tools/`](browser-tools/) | Direct-pinned Playwright package for explicitly requested headless Firefox; not an MCP or browser installer |
| GitHub tools | [`github-tools/`](github-tools/) | Historical migration note for the retired repository-owned runtime |

Native Ubuntu and isolated WSL2 OpenCode profiles use exactly three MCPs:
`basic-memory`, `github`, and `chatgpt`. The official GitHub binary is pinned and
installed below each selected OpenCode profile; the generic GitHub MCP and
optional Source Control child client both use the canonical wrapper and existing
authenticated `gh` session.

For visible browser QA from WSL, use the Windows-default-browser tools described
in the [`browser-assistant` guide](computer-use/skills/browser-assistant/README.md).
The direct-pinned Playwright package in `browser-tools/` is separate from the
MCP set and is reserved for explicitly requested headless Firefox tasks; it does
not download or provision a browser.

Run the read-only platform health check from the repository root:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
```

This is currently the only supported platform. Add future operating systems or
distributions as separate directories under `platforms/` rather than mixing
platform-specific scripts or runtimes into this Ubuntu implementation.
