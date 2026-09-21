# Blender Usage

This guide explains how to request the `blender` skill. Agent operating rules
remain in [SKILL.md](./SKILL.md). OpenCode loads `SKILL.md` on demand; this
README and the linked references are not loaded automatically.

Category: `applications`

Tags: `blender`, `3d`, `bpy`, `rendering`, `export`

## Purpose and when to use it

Use this skill to inspect or modify `.blend` scenes, run bounded Blender Python
jobs, create renders, and import or export 3D data on Ubuntu. It supports both
safe background workflows and interactive GUI work through the repository's
desktop skills. It does not assume a Blender MCP server.

This skill is original to this repository and based on public Blender 5.0
manual and Python API practices. It is not an OpenAI/Codex Blender or Computer
Use skill.

## Prerequisites and setup verification

The agent first checks the installed executable and version without launching
the GUI:

```bash
command -v blender
timeout 15s blender \
  --background \
  --factory-startup \
  --disable-autoexec \
  --python-exit-code 1 \
  --version
```

Blender 5.0 is the documented target. Background Python runs inside Blender;
`python3 -c 'import bpy'` is not a valid setup test. For GUI work, the
`desktop-control` and `desktop-vision` skills must be available. Installation
or repair belongs to `app-setup` and is not performed implicitly.

Ubuntu's Blender 5.0 glTF add-on also needs the distribution's `python3-numpy`
package. Verify `import numpy` inside Blender before export or import; install it
through `app-setup` only when the glTF workflow demonstrates that it is missing.

## How to request it

Ask for the outcome and name the source, destination, and important checks.

- "Inspect `/path/to/scene.blend` without changing it and report missing
  textures."
- "Create a versioned copy with the camera moved, render frame 24, and verify
  the image."
- "Export this collection to GLB, reimport it cleanly, and compare the object
  hierarchy."
- "Open Blender and help me adjust this material interactively."

## Worked workflow and expected result

For a representative read-only scene inspection, the agent:

1. Confirms Blender 5.0 and the exact source path.
2. Reads
   [the background workflow](./references/background-workflows.md).
3. Runs the deployed [scene probe](./scripts/scene_probe.py) through Blender
   with safe global options and a bounded timeout.
4. Reads the new JSON report and checks objects, transforms, materials, images,
   libraries, cameras, animation, and missing external files.
5. Leaves the `.blend` unchanged and reports the JSON path or removes the
   task-created report if it was only temporary.

Expected result: a concrete structural inventory and warnings with no source
mutation. For an edit, the expected result is instead a new versioned `.blend`,
a clean-process reopen comparison, and any requested render or export. The
commands in this guide are documented representative invocations; they were
not executed while creating the skill.

## Verification and known limitations

Read [verification and export](./references/verification-and-export.md) before
accepting a save, render, or export.

- Exit status alone does not verify a Blender result.
- Reopen a saved file in a separate Blender process and rerun the scene probe.
- Read the actual rendered image to verify visual output.
- Reimport an export into a clean scene and compare its hierarchy, transforms,
  materials, textures, animation, and bounds.
- `--disable-autoexec` blocks automatic Python execution but does not prove an
  unknown `.blend` is safe.
- Blender's custom 3D viewport may not expose useful AT-SPI nodes.
- Background mode cannot verify interactive tool behavior or viewport-only
  appearance.

## Troubleshooting

- `blender` missing or wrong version: inspect package/source state, then use
  `app-setup`; do not install a second package format silently.
- `ModuleNotFoundError: bpy`: run the script with Blender's `--python`, not
  system Python.
- `ModuleNotFoundError: numpy` from `io_scene_gltf2`: simulate and install
  Ubuntu's `python3-numpy`; do not use `pip` inside Blender.
- Draco library warning: Ubuntu's package may omit optional Draco support.
  Export uncompressed unless the project already has an approved compatible
  compressor and runtime decoder.
- Exit code `124`: the shell timeout expired; inspect logs and narrow the job
  before increasing the bound.
- Python error but Blender exits zero: ensure `--python-exit-code 1` appears
  before the input file.
- Embedded driver or script warning: keep `--disable-autoexec`; do not enable
  auto-run merely to complete the task.
- Missing texture: inspect packed state and Blender-resolved absolute paths
  before remapping anything.
- GUI action cannot be targeted: stop blind interaction, inspect with
  `desktop-vision`, and use a deterministic background script when practical.

## Safety, confirmation, and elevation

Source `.blend` files are preserved. Writes use unused versioned paths. The
agent asks before overwrite, deletion, add-on installation, package or
permission changes, and any upload. Blender is never run as root. If an
approved package operation needs elevation, the user completes the trusted
PolicyKit dialog; the agent does not observe or type into it.

Desktop screenshots are deleted immediately after inspection. Requested
renders and exports are retained as user artifacts; only task-created temporary
verification output is cleaned up.

## Related skills and documents

- [Background workflows](./references/background-workflows.md) defines safe
  Blender CLI ordering and script execution.
- [Verification and export](./references/verification-and-export.md) defines
  save/reopen, render, and reimport checks.
- [`web-3d-asset-pipeline`](../web-3d-asset-pipeline/README.md) covers
  browser-ready GLB assets.
- [`desktop-control`](../desktop-control/README.md) and
  [`desktop-vision`](../desktop-vision/README.md) support interactive Blender.
- [`browser-assistant`](../browser-assistant/README.md) and
  [`browser-headless`](../browser-headless/README.md) govern visible and
  explicitly requested headless checks of browser-based output.
- [`files-and-documents`](../files-and-documents/README.md) governs final local
  artifact organization.
- The public Blender 5.0 manual documents
  [command-line arguments](https://docs.blender.org/manual/en/5.0/advanced/command_line/arguments.html)
  and
  [command-line rendering](https://docs.blender.org/manual/en/5.0/advanced/command_line/render.html).
- The canonical catalog is `skills/README.md`; it is outside the deployed skill
  bundle and is therefore shown as a plain repository path.
