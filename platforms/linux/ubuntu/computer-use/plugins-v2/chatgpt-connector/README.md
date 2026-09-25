# ChatGPT connector

The `chatgpt-connector` server plugin reuses OpenCode's active OpenAI OAuth
connection and exposes the same bounded capabilities through plugin tools and
the local `chatgpt` MCP server.

## Tools

| OpenCode tool | MCP tool | Purpose |
|---|---|---|
| `chatgpt_generate_image` | `generate_image` | Generate an image and save it under `assets/generated` in the invoking project. |
| `chatgpt_web_search` | `web_search` | Run a quick search or bounded research and return source links. |
| `chatgpt_chat` | `chat` | Continue a private conversation scoped to the active account and OpenCode session. |

The plugin registers RPC `chatgpt.execute`. The MCP adapter uses the invoking
session's validated project location for image output and session context. Chat
history is in-memory, bounded, and isolated by account, project, and session.

## Authentication and privacy

The connector resolves the active OpenAI OAuth credential through the local
OpenCode v2 service. It does not start another sign-in flow, accept an API key,
fall back to an API key, or store credentials in repository configuration.
OpenCode must have an active OAuth connection for the connector to operate.

The canonical `agents/chatgpt-private.md` profile is copied to the selected
global config's `agents/` directory by `setup-opencode.sh`. It is opt-in and
does not change the repository or global default agent. The
`scripts/chatgpt-private.sh` launcher uses a dedicated neutral workspace outside
the checkout, so private conversations do not inherit a repository's agent
instructions or configuration.

## MCP scope

Native Ubuntu, isolated WSL2, and the portable project configuration use the
same three-server set: `basic-memory`, `github`, and `chatgpt`. The former
project-only Playwright MCP and Chrome-for-Testing provisioning are removed.
WSL browser actions use the Windows-default-browser connector with
Playwright-like tools in place of that MCP; live browser capability remains
unverified until bounded probes pass. `scripts/chatgpt-mcp.sh` launches the
connector with the selected profile's pinned Node.js runtime.

## Checks and evidence

Run the focused connector checks with:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/chatgpt-connector run check
```

The package tests and typecheck cover the local adapter and fake backend. They
do not establish hosted capability availability for an account. Image
generation, search and returned citations, OAuth resolution, and private-chat
continuity remain unverified live until bounded probes pass after integration.

The typecheck uses a measured package override: 55% of effective available
memory for its process-tree cap and 80% of that budget for V8. The runner still
enforces the cap, leaving 45% of effective available memory outside its budget.
