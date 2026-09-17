# Game Playtest Usage

This guide explains how to request `game-playtest`. Agent operating rules
remain in [SKILL.md](./SKILL.md). OpenCode loads `SKILL.md` on demand; this
README, provenance, and license are not loaded automatically.

Category: `browser`

Tags: `games`, `playtesting`, `playwright`, `canvas`, `webgl`

## Purpose and when to use it

Use this skill for browser-game smoke tests, gameplay QA, canvas/WebGL visual
checks, HUD and overlay review, responsive sanity checks, console-error review,
and reproducible bug reports. It uses the repository's Playwright Firefox tools
and verifies player-visible postconditions rather than assuming an input worked.

The workflow is adapted from OpenAI's public Game Studio playtest concepts for
this repository. See [PROVENANCE.md](./PROVENANCE.md) and
[LICENSE.txt](./LICENSE.txt).

## Prerequisites and setup verification

The agent checks:

- the exact game URL and build/commit under test
- documented controls, main verbs, and expected states
- the project's existing start command and lockfile for local games
- `opencode mcp list` when Playwright availability is uncertain
- whether normal visible Firefox or explicitly requested headless Firefox is in
  scope

No package, browser extension, profiler, or dependency is installed merely to
start a playtest. A temporary local server stays on loopback unless network
exposure was explicitly requested. The visible Playwright browser is isolated
from the user's normal Firefox profile.

## How to request it

- "Smoke-test this browser game in the visible Firefox window."
- "Exercise movement, jump, attack, pause, and restart, then report bugs by
  severity."
- "Check the WebGL scene and HUD at desktop and mobile viewport sizes."
- "Run this playtest headlessly and call out what cannot be trusted without a
  visible session."
- "Let me handle pointer lock, then continue after I hand control back."

Include the URL or project, expected controls, important game states, target
viewports, and any prohibited state-changing actions.

## Worked workflow and expected result

A representative visible-browser smoke test is:

1. Start the existing project command on loopback if needed.
2. Inspect an accessibility snapshot before input.
3. Check boot console messages and failed asset requests.
4. Inspect a mandatory screenshot of the canvas/WebGL initial state.
5. Focus the identified game surface and send one bounded input for each main
   verb.
6. After each action, inspect fresh semantic state and a fresh screenshot.
7. Exercise normal play, pause/overlay, failure or success, and desktop/mobile
   resize states relevant to the game.
8. Recheck console errors, delete all screenshots, and produce a severity-first
   text report with exact reproduction steps and testing gaps.

Expected result: a reproducible assessment of boot, input, rendering, HUD, and
responsive behavior with no retained screenshot files. These are documented
representative steps; they were not executed while creating the skill.

## Verification and known limitations

- Accessibility is inspected first, but canvas/WebGL always requires visual
  screenshot inspection.
- The DOM can expose the canvas element and surrounding HUD; it cannot prove or
  directly drive the internal rendered scene.
- Each input is verified against a post-state or visible frame change.
- Console and network evidence is checked at boot and after exercised states.
- Resizing Firefox to a mobile viewport does not emulate every touch, safe-area,
  GPU, memory, power, or network characteristic of a phone.
- Pointer lock, gamepad, multitouch, timing-sensitive combinations, multiplayer,
  and long-session performance may need user or device testing.
- Headless and visible rendering or timing can differ; the report identifies
  which mode was used.

## Troubleshooting

- Blank canvas: inspect load indicators, console exceptions, failed GLB/texture
  or shader requests, renderer fallback, and canvas dimensions.
- Input has no effect: refresh the snapshot, verify focus and overlays, click
  the identified canvas once, send one documented key, and inspect post-state.
- Canvas has no accessible children: expected; use bounded input and screenshot
  evidence rather than DOM selectors for scene objects.
- Stale element reference: take a fresh snapshot after navigation, resize, or
  user takeover.
- Pointer lock or gesture cannot be automated reliably: use bounded user
  takeover, then inspect fresh state after handoff.
- Playwright unavailable: inspect the registered MCP and report its actual
  startup error; do not switch to blind desktop clicking.
- Nondeterministic animation or physics: use a known deterministic test surface
  if the project already provides one, otherwise report frequency and evidence
  without claiming certainty.

## Safety, confirmation, and elevation

The agent asks before publishing chat, scores, levels, or other content;
purchasing; accepting legal terms; deleting cloud saves; resetting account
progress; or changing account/security/privacy settings. It never handles
passwords, MFA, payment details, or CAPTCHAs. Local files are not uploaded and
servers are not exposed beyond loopback without explicit scope. No elevation is
needed for ordinary playtesting, and browser security controls are not weakened.

Every screenshot taken for playtest analysis is deleted immediately after
inspection. The retained output is a text report.

## Related skills and documents

- [`browser-assistant`](../browser-assistant/README.md) governs the visible,
  user-shared Playwright Firefox session.
- [`browser-headless`](../browser-headless/README.md) governs explicitly
  requested non-interactive browser work.
- [`web-3d-asset-pipeline`](../web-3d-asset-pipeline/README.md) diagnoses and
  validates browser-ready GLB/glTF assets.
- [PROVENANCE.md](./PROVENANCE.md) records the exact OpenAI upstream and
  adaptation boundary.
- [LICENSE.txt](./LICENSE.txt) contains the MIT license for this adaptation.
- The canonical catalog is `skills/README.md`; it is outside the deployed skill
  bundle and is therefore shown as a plain repository path.
