# Linux Ubuntu

OpenCode's Ubuntu integration is split into three cooperating components.

| Component | Directory | Responsibility |
|-----------|-----------|----------------|
| Computer use | [`computer-use/`](computer-use/) | GNOME control, skills, local plugins, memory, maintenance, setup, and live configuration |
| Browser tools | [`browser-tools/`](browser-tools/) | Pinned Playwright MCP package for live and headless Firefox |
| GitHub tools | [`github-tools/`](github-tools/) | Checksum-pinned official GitHub MCP native runtime |

The computer-use setup script provisions all components. Its Playwright and
GitHub MCP wrappers resolve their generated runtimes relative to this platform
directory, so the components must remain siblings.

Run the read-only platform health check from the repository root:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
```

This is currently the only supported platform. Add future operating systems or
distributions as separate directories under `platforms/` rather than mixing
platform-specific scripts or runtimes into this Ubuntu implementation.
