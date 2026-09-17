# Provenance

## Upstream

- Repository: https://github.com/openai/plugins
- Commit: `1dc195897af4161d039b80d8471ec0a10c9bbc89`
- Source skill:
  https://github.com/openai/plugins/blob/1dc195897af4161d039b80d8471ec0a10c9bbc89/plugins/game-studio/skills/game-playtest/SKILL.md
- Game Studio manifest declaring `MIT`:
  https://github.com/openai/plugins/blob/1dc195897af4161d039b80d8471ec0a10c9bbc89/plugins/game-studio/.codex-plugin/plugin.json
- Upstream author: OpenAI

The upstream concepts were independently adapted under the MIT declaration in
the pinned Game Studio manifest. The standard license text is preserved in
[LICENSE.txt](./LICENSE.txt).

## Adaptation notes

- Replaced generic browser-automation references with this repository's visible
  `playwright_browser_*` tools and explicit-only
  `playwright_headless_browser_*` tools.
- Added accessibility-snapshot-first inspection while requiring screenshots
  for canvas/WebGL and explicitly rejecting DOM claims about internal scene
  state.
- Added bounded input followed by fresh semantic and visual post-state checks.
- Expanded representative state, main verb, desktop/mobile viewport, console,
  network, HUD/render-layer, pointer-lock, and user-takeover coverage.
- Added evidence-layer separation, severity-first reporting, observed-versus-
  hypothesized ownership, and explicit residual-risk reporting.
- Added repository confirmation gates, secret handling, loopback server, upload,
  browser-security, and immediate screenshot-cleanup rules.

No proprietary OpenAI/Codex Computer Use content or unavailable internal skill
material was copied or inferred.
