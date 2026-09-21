# Provenance

## Upstream

- Repository: https://github.com/openai/plugins
- Commit: `1dc195897af4161d039b80d8471ec0a10c9bbc89`
- Source skill:
  https://github.com/openai/plugins/blob/1dc195897af4161d039b80d8471ec0a10c9bbc89/plugins/game-studio/skills/web-3d-asset-pipeline/SKILL.md
- Game Studio manifest declaring `MIT`:
  https://github.com/openai/plugins/blob/1dc195897af4161d039b80d8471ec0a10c9bbc89/plugins/game-studio/.codex-plugin/plugin.json
- Upstream author: OpenAI

The upstream concepts were independently adapted under the MIT declaration in
the pinned Game Studio manifest. The standard license text is preserved in
[LICENSE.txt](./LICENSE.txt).

## Adaptation notes

- Replaced plugin-specific and unavailable references with a self-contained
  Ubuntu/OpenCode workflow.
- Mapped browser validation to this repository's connected live Playwright
  tools and the explicit-only bounded runtime documented by the
  `browser-headless` skill.
- Added source preservation, versioned output, confirmation, upload, temporary
  file, and Firefox screenshot rules from this repository's safety policy.
- Added explicit pivot, units, transform, naming, hierarchy, material, texture,
  clean reimport, and runtime contract checks.
- Made GLB the default while retaining glTF for intentional external-resource
  packaging.
- Made compression conditional on an existing approved pinned tool and runtime
  decoder; the adaptation never force-installs Node tooling.
- Integrated the original local [`blender` skill](../blender/SKILL.md) without
  claiming a Blender MCP server exists.

No proprietary OpenAI/Codex Computer Use content or unavailable internal skill
material was copied or inferred.
