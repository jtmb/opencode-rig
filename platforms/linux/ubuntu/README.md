# Linux Ubuntu

OpenCode's Ubuntu integration is split into three cooperating components.

| Component | Directory | Responsibility |
|-----------|-----------|----------------|
| Computer use | [`computer-use/`](computer-use/) | GNOME control, skills, local plugins, memory, maintenance, setup, and live configuration |
| Browser tools | [`browser-tools/`](browser-tools/) | Pinned Playwright MCP package for live and headless Firefox |
| GitHub tools | [`github-tools/`](github-tools/) | Optional checksum-pinned Source Control child-client runtime; not the generic MCP |

The computer-use setup script provisions the canonical local components and
hosted GitHub declaration. Its Playwright wrapper resolves the generated native
runtime relative to this platform directory; the optional Source Control child
wrapper is separate and is not registered as the generic GitHub MCP.

Run the read-only platform health check from the repository root:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh --verify-only
```

This is currently the only supported platform. Add future operating systems or
distributions as separate directories under `platforms/` rather than mixing
platform-specific scripts or runtimes into this Ubuntu implementation.
