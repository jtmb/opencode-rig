# OpenCode Web QA

OpenCode Web requires live browser evidence in addition to the host-independent
checks in [canonical repository QA](check-repository-qa.md). This checklist
applies to visible OpenCode Web claims and is completed against the user's
configured Windows default browser through the WSL browser connector.

The connector must expose agent-callable operations to open, inspect, capture,
and interact with the actual default-browser window. Use its ordinary
authenticated browser session. Do not copy credentials, cookies, tokens, or a
browser profile into WSL or evidence. If the connector opens an unauthenticated
profile or cannot expose screenshots, accessibility, interaction, and startup
errors, record the blocker; do not bypass login.

Chrome for Testing and a project Playwright MCP are not Web QA tools. Native
terminal captures, synthetic renderers, HTTP probes, and successful process
startup do not substitute for the rendered browser evidence below.

## Capture procedure

1. **Identify the target service before opening the page.** Record the exact
   OpenCode Web URL and port, then verify the intended service directly through
   its authenticated `/api/info` response or the coordinated service-health
   procedure. Record the reported OpenCode version and a stable service identity
   (for example, the service instance/PID and listening port). Do not assume that
   two local ports refer to the same process or deployment.
2. **Open the real default browser.** From WSL, use the connector to open the
   configured Windows default browser and navigate to the target URL. Confirm
   that the ordinary authenticated session reaches the expected OpenCode Web
   workspace. Record only an authentication result (`authenticated` or
   `blocked`); do not retain account names, page-private content, or auth data.
3. **Inspect startup.** Observe the initial load and any reload needed to reach
   the ready state. Capture browser-console errors, uncaught page errors, failed
   startup/resource requests exposed by the connector, and visible error
   overlays. Explicitly check for
   `BrowserAttachments context must be used within a context provider` in the
   rendered page and startup diagnostics. Keep errors bounded and sanitized.
4. **Capture rendered and accessible evidence.** Take a fresh screenshot of the
   actual rendered browser window/page through the Windows connector and save a
   separate accessible/ARIA snapshot from the live page. Neither may be a
   native terminal capture, a test-renderer visualization, or an image recreated
   from the accessibility tree. Do not include private conversation contents
   unless specifically approved for retention.
5. **Exercise an interaction.** In a disposable workspace/session, perform at
   least one meaningful browser interaction (for example, open or select a
   conversation, open and close a page-owned panel, or submit a harmless probe
   in a disposable conversation). Record the action and the visible resulting
   state. An interaction claim is incomplete if the connector reports dispatch
   but the page does not show the resulting state.
6. **Recheck the result and errors.** Confirm the page remains usable after the
   interaction, review startup/page errors again, and distinguish browser-client
   failures from service/API failures. A clean result applies only to the exact
   service, URL, browser session, version, and capture time recorded below.

## Evidence identity and freshness

Keep a short evidence record alongside the retained screenshot and snapshot:

| Field | Required value |
|---|---|
| Capture identity | Unique run ID and capture time in UTC |
| Service | Exact Web URL/port, OpenCode version, and service instance identity verified directly |
| Browser | Windows default-browser name/version and WSL connector identity/version |
| Authentication | `authenticated` or `blocked` only; never account names or credentials |
| Software under test | Repository/service revision or other verified client-build identity |
| Rendered evidence | Screenshot path, capture method, and SHA-256 digest |
| Accessible evidence | Live accessible/ARIA snapshot path and SHA-256 digest |
| Startup/error evidence | Bounded sanitized console/page-error/resource-failure summary, including the explicit BrowserAttachments check |
| Interaction | Exact user-visible action and observed resulting state |

Evidence is fresh only when captured from the service and browser state under
test after the relevant Web/client or service startup/restart. Re-run it after
the target changes; an old screenshot or a different port/version cannot
accept a current claim. Bind each screenshot, accessible snapshot, error
summary, and interaction result to the same run ID, service identity, version,
and UTC timestamp. Record evidence digests and references, not private page
content or authentication material.

## Reported BrowserAttachments crash and pending acceptance

The supplied screenshot shows
`BrowserAttachments context must be used within a context provider` on an older
local OpenCode **2.0.10** port. The separately reported active **2.0.11** service
at port `49375` is a different version/endpoint until independently verified
during the run. Do not attribute the screenshot's cause to that service, infer
that it reproduces or fixes the crash, or patch an installed OpenCode binary.
Capture and report the exact current endpoint, version, screenshot, accessible
snapshot, interaction, and startup diagnostics before drawing a conclusion.

Live acceptance is pending two independent prerequisites:

1. an authenticated Windows default-browser session exposed to this WSL
   connector; and
2. service-owner coordination to identify and authorize the exact 2.0.11 Web
   endpoint before testing it.

Until both are available, leave rendered OpenCode Web acceptance pending. Do not
replace it with Chrome for Testing, a project Playwright MCP, or an assumption
based on another port.

## Portable documentation-contract check

Run the optional static check with Python's standard library:

```bash
python3 docs/scripts/check_opencode_web_qa_contract.py --root .
```

It checks that the roadmap, repository-QA instructions, and this guide retain
the minimum Web QA contract. It is read-only, needs no Windows/browser
connection, and is not live-browser evidence or a new mandatory Linux QA gate.
