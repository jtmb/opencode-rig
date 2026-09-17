# GitHub Operations Usage

This guide explains how to use the `github-operations` skill. The agent-facing
rules remain in [SKILL.md](./SKILL.md); OpenCode does not automatically load
this usage guide when the skill is loaded.

Category: `applications`

Tags: `github`, `mcp`, `repositories`, `issues`, `pull-requests`, `automation`

## Purpose and when to use it

Use `github-operations` to inspect GitHub repositories, code, issues, pull
requests, checks, or releases, and to prepare or perform explicitly approved
remote changes.

Appropriate requests include:

- "Summarize the open issues in this GitHub repository."
- "Review pull request 42 and report blocking concerns."
- "Check why the latest GitHub Actions run failed."
- "Create a draft pull request from this branch after showing me the diff."

## Prerequisites and setup verification

The repository setup installs the pinned official GitHub MCP Server at
`platforms/linux/ubuntu/github-tools/bin/github-mcp-server` and registers the
project-local `github` MCP through
`platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh`.

Before OpenCode starts, provide a credential either by setting
`GITHUB_PERSONAL_ACCESS_TOKEN` or `GH_TOKEN` in its environment, or by logging
in with the `gh` CLI (`gh auth login`), which the wrapper reads automatically.
Use a fine-grained PAT restricted to the needed repositories with read-only
permissions for normal MCP use. Do not place the token in `opencode.json`, a
repository file, chat, or task memory.

The agent can verify installation and connection without displaying a token:

```bash
platforms/linux/ubuntu/github-tools/bin/github-mcp-server --version
opencode mcp list
```

The expected installed release is `v1.12.1`. A missing credential produces an
intentional fail-closed authentication error instead of opening an unexpected
login flow.

## How to request it

Ask in ordinary language and name the exact repository or GitHub URL whenever
possible.

Example requests:

- "Use GitHub to list open pull requests in owner/repository."
- "Compare issue 17 with the current implementation."
- "Show me the failed checks on this pull request."
- "Prepare an issue comment, but do not publish it."

Read-only requests normally use MCP tools. GitHub Actions, releases, and remote
mutations may use the authenticated `gh` CLI because the MCP wrapper exposes a
deliberately limited read-only tool surface.

## Worked workflow and expected result

A representative pull-request inspection is:

1. Confirm the owner, repository, and pull request number.
2. Read pull request metadata, changed files, commits, and relevant checks.
3. Inspect only the repository content needed to assess the change.
4. Report findings by severity with canonical GitHub links.
5. Leave reviews, comments, labels, merge state, and branches unchanged.

For a requested remote mutation, the agent first presents the exact target and
content, asks immediately before the final action, performs it once after
confirmation, and re-reads the resulting remote object.

Expected result: the user receives verified GitHub state or one specifically
approved remote change plus its canonical URL.

## Verification and known limitations

The default MCP surface is restricted to `context`, `repos`, `issues`, and
`pull_requests`, with read-only and lockdown modes enabled. This reduces context
size, blocks MCP write tools, and filters some untrusted public issue content.

Known limitations:

- The wrapper resolves its credential when the MCP starts; running sessions do
  not reload environment variables or MCP configuration, so restart OpenCode
  after logging in or changing a token.
- Read-only mode does not reduce the token's underlying account permissions.
- Lockdown mode is a best-effort content filter, not a security boundary.
- GitHub Actions, releases, discussions, projects, and security toolsets are not
  exposed by the default MCP wrapper; the agent may use `gh` when requested.
- Organization SSO and policy can restrict an otherwise valid credential.

## Troubleshooting

- MCP says authentication is not configured: run `gh auth login`, or start a
  fresh OpenCode process with `GITHUB_PERSONAL_ACCESS_TOKEN` or `GH_TOKEN`
  already set.
- `401` or `403`: check token expiration, selected repositories, permissions,
  organization SSO authorization, and organization MCP policy without printing
  the token.
- Tools are missing: verify the request belongs to one of the four configured
  toolsets. Do not silently broaden the MCP surface.
- Repository content is hidden: lockdown mode may filter public contributions
  from users without push access.
- Mutation is unavailable: use a reviewed, authenticated `gh` command only for
  an explicit user request and retain the normal confirmation gate.

## Safety, confirmation, and elevation

Authentication, token creation, SSO authorization, OAuth/App authorization, and
permission changes require the user's participation and immediate approval.
The agent never asks for, reads, types, logs, or stores the credential.

The agent also asks immediately before publishing or sending GitHub content,
merging, pushing, triggering deployments or workflows, deleting remote data, or
changing repository/account/security settings. Local installation is
user-owned and needs no administrator elevation.

## Related skills and documents

- [`browser-assistant`](../browser-assistant/README.md) supports visible GitHub
  web workflows when the user must take over authentication.
- [`task-memory`](../task-memory/README.md) may retain approved workflow choices
  but never credentials or private repository content.
- [`skill-maintenance`](../skill-maintenance/README.md) maintains this skill and
  its catalog registration.
- The canonical catalog entry is in `skills/README.md`.
