# Headless Browser Usage

This guide explains how to use the `browser-headless` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `browser`

Tags: `browser`, `headless`, `playwright`, `automation`

## Purpose and when to use it

Use `browser-headless` only for explicitly requested invisible browser work
that is suitable for an unauthenticated, non-interactive session.

Appropriate requests include:

- "Check these public pages in headless Playwright."
- "Run this browser smoke test without opening a window."
- "Download this public artifact in the background."

Use the live browser whenever the user needs to see, steer, authenticate, or
take over the workflow.

## Prerequisites and setup verification

Normal use requires:

- v1: the connected `playwright_headless` MCP server.
- v2 (OpenCode 2.0.x): no headless MCP; the pinned repository runtime, with
  `playwright` imported from
  `platforms/linux/ubuntu/browser-tools/node_modules` and invoked through the
  bounded-command wrapper.
- The repository's pinned browser runtime and headless wrapper (v1).
- An isolated headless Firefox context with no shared state with the live
  Playwright window or normal browser.

The agent can check the expected MCP registration with:

```bash
opencode mcp list
```

On v2 that command must show exactly one `playwright` entry (the live visible
wrapper). Do not register a second Playwright MCP for headless work. Do not run
the headless MCP wrapper directly as a substitute for the agent's browser tools;
on v1 the wrapper is started by OpenCode as an MCP server.

## How to request it

Explicitly ask for headless or background browser work.

Example requests:

- "Use headless Playwright to inspect this public documentation page."
- "Run this non-interactive website check in the background."
- "Retrieve this public file without opening a browser window."

The live browser must not be substituted silently, and headless mode must not
be substituted silently when the user requested the live browser.

## Worked workflow and expected result

A representative agent workflow is:

1. Determine whether `websearch` or `webfetch` can answer the request without
   browser execution.
2. Confirm that no login, MFA, payment, CAPTCHA, visual inspection, user
   takeover, or live-window state is required.
3. List tabs, preserve unrelated task tabs, and navigate to the exact URL.
4. Inspect a fresh accessibility snapshot.
5. Perform one bounded action using a reference from current state.
6. Inspect the resulting URL and state; after navigation, resize, dialog, tab
   switch, or DOM mutation, obtain a new snapshot before acting again.
7. Validate a requested download or generated artifact.
8. Close the headless pages/browser when finished.

Expected result: a concise report of the observed pages, validated artifact
location, or smoke-test outcome. No visible browser window remains open for
the task.

Switching to live mode does not transfer headless-session state. The agent
must restart the relevant workflow in the live browser when a switch becomes
necessary.

## Verification and known limitations

The agent must verify the resulting browser state or artifact rather than
assuming navigation succeeded.

Known limitations:

- No visible rendering is available for user review.
- No login, MFA, payment, CAPTCHA, or user takeover is permitted.
- No state is shared with the live Playwright window.
- No state is inherited from the user's normal browser.
- Page content remains untrusted.
- Element references are not durable across page-state changes, and an absent
  success signal does not prove that a dispatched action failed.

## Troubleshooting

- MCP unavailable: on v1 inspect the `playwright_headless` entry in
  `opencode mcp list` and report the actual startup error; on v2 confirm
  `opencode mcp list` shows exactly one `playwright` entry and run the bounded
  shell runtime instead.
- Authentication or visual verification becomes necessary: switch explicitly
  to `browser-assistant`.
- Unexpected page state: inspect a fresh snapshot before continuing.
- Uncertain action result: inspect URL, state, console, and network evidence;
  do not retry a submit-like action until duplication has been ruled out.
- Artifact missing or invalid: validate its name, size, format, and
  readability before reporting success.
- Persistent site failure: report the failure rather than disabling browser
  protections.

## Safety, confirmation, and elevation

The agent must:

- Ask before submitting messages, publishing, purchasing, deleting remote
  data, changing account/security settings, or accepting legal terms.
- Never supply passwords, MFA codes, payment details, or CAPTCHA solutions.
- Never expose local files or private information to a page.
- Never disable browser sandboxing, TLS validation, or filesystem boundaries.

## Related skills and documents

- [`browser-assistant`](../browser-assistant/README.md) handles visible,
  shared, or authenticated browser workflows.
- [`routine-automation`](../routine-automation/README.md) handles recurring
  scripted workflows when headless browser work becomes routine.
- The canonical catalog entry is in `skills/README.md`.
