# Web 3D Asset Pipeline Usage

This guide explains how to request `web-3d-asset-pipeline`. Agent operating
rules remain in [SKILL.md](./SKILL.md). OpenCode loads `SKILL.md` on demand;
this README, provenance, and license are not loaded automatically.

Category: `files`

Tags: `3d`, `gltf`, `glb`, `assets`, `web`

## Purpose and when to use it

Use this skill to turn an editable 3D source into a predictable browser asset,
or to diagnose a GLB/glTF that loads with the wrong scale, pivot, hierarchy,
materials, textures, animation, collision, or performance characteristics. It
owns the asset pipeline, not engine selection or runtime scene architecture.

The workflow is adapted from OpenAI's public Game Studio guidance for this
repository's Ubuntu, Blender, file-safety, and Playwright Firefox tools. See
[PROVENANCE.md](./PROVENANCE.md) and [LICENSE.txt](./LICENSE.txt).

## Prerequisites and setup verification

The agent checks, without installing anything:

- the exact source and current runtime asset paths
- the target engine/loader and its existing package lockfile
- the project's asset conventions and budgets
- the installed DCC/exporter version when a DCC is needed
- the available visible `playwright` MCP for interactive Firefox validation
- any existing, approved, pinned optimization command

There is no assumed Blender MCP server. If Blender is used, the agent loads the
[`blender` skill](../blender/SKILL.md) and verifies Blender's executable and
version. Missing Node tools are not force-installed, and `npx` is not used to
download undeclared packages.

## How to request it

- "Prepare this Blender prop for Three.js as a GLB and preserve the source."
- "Find why this model imports at the wrong scale and rotates around the wrong
  point."
- "Reduce this GLB if our existing toolchain supports it, then verify it in
  Firefox."
- "Check the hierarchy, materials, textures, animation names, and runtime load
  of this glTF."

Name the source, target project or loader, output location, quality constraints,
and required animation, collision, or LOD behavior.

## Worked workflow and expected result

A representative GLB delivery proceeds as follows:

1. Record units, orientation, pivot, stable names, hierarchy, materials,
   textures, animations, collisions, LODs, and size budget.
2. Inventory and preserve the source files and existing shipping asset.
3. Clean only the necessary scene data and export a new versioned GLB.
4. Reimport it into a clean scene and compare structure and transforms.
5. Run the project's existing local server on loopback and load the exact GLB
   in visible Playwright Firefox.
6. Take an accessibility snapshot, inspect console and network activity, then
   inspect a screenshot of the canvas/WebGL result.
7. Report measured size and load behavior plus structural and visual findings.

Expected result: a new runtime asset that meets the explicit contract, reimports
without unexpected loss, and loads visibly in Firefox without asset-related
console/network failures. These are documented representative steps; they were
not executed while creating the skill.

## Verification and known limitations

- Export must be followed by clean reimport and structural comparison.
- Browser verification must load the exact shipping file through the actual
  project loader, not a DCC preview.
- A browser accessibility snapshot does not describe canvas geometry;
  screenshot inspection is mandatory for WebGL output.
- A desktop/mobile viewport pass does not replace testing on real mobile GPU,
  memory, touch input, and network conditions.
- Compression is tested only when a compatible approved tool and decoder
  already exist.
- Reimport may normalize representation while retaining appearance, so compare
  against the runtime contract rather than requiring byte-identical data.

## Troubleshooting

- Wrong scale/orientation: compare source units, exporter conversion, root and
  child transforms, and runtime loader transforms before editing geometry.
- Wrong pivot: inspect the authored origin and parent hierarchy; do not hide a
  reusable asset error with per-instance runtime offsets unless intentional.
- Missing or flat materials: inspect supported PBR nodes, texture existence,
  color spaces, UV sets, alpha mode, and browser requests.
- Renamed nodes or clips: stabilize source names and exporter settings, then
  reimport and compare before changing runtime selectors.
- GLB works locally but not through the app: inspect exact URL, status, MIME,
  CORS, base path, decoder availability, and console error.
- Optimized asset fails: restore the preserved baseline, identify the one
  incompatible optimization, and do not stack speculative recompression.

## Safety, confirmation, and elevation

The agent preserves sources and prior shipping assets, writes unused versioned
outputs, previews batch path changes, and asks before deletion or replacement.
It never uploads an asset without an exact file and destination from the user.
It does not install add-ons, Node packages, decoders, repositories, or system
packages implicitly. Blender and browser applications are never run as root,
and security controls are not weakened.

## Related skills and documents

- [`blender`](../blender/README.md) provides safe Blender CLI, `bpy`, rendering,
  and save/reopen procedures.
- [`game-playtest`](../game-playtest/README.md) verifies interactive game states
  after the asset loads.
- [`browser-assistant`](../browser-assistant/README.md) governs the visible
  Playwright Firefox session.
- [`files-and-documents`](../files-and-documents/README.md) governs local
  artifact preservation and organization.
- [PROVENANCE.md](./PROVENANCE.md) records the exact OpenAI upstream and
  adaptation boundary.
- [LICENSE.txt](./LICENSE.txt) contains the MIT license for this adaptation.
- The canonical catalog is `skills/README.md`; it is outside the deployed skill
  bundle and is therefore shown as a plain repository path.
