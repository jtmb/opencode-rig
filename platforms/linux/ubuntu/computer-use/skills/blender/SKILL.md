---
name: blender
description: Operate Blender 5.0 on Ubuntu for safe scene inspection, scripted edits, versioned saves, rendering, and import or export verification. Use when the user asks to inspect or modify a .blend file, run Blender Python, render a scene, automate Blender from the shell, or verify a 3D export.
compatibility: Blender 5.0 on Ubuntu; no Blender MCP server is required or assumed.
metadata:
  schema-version: "1"
  category: "applications"
  tags: "blender,3d,bpy,rendering,export"
---

# Blender

Use Blender's own executable for `bpy`; never assume the system Python can
import it. This is an original Ubuntu/OpenCode skill grounded in Blender 5.0
documentation. It is not copied from, or presented as, an OpenAI or Codex
Computer Use skill.

## Execution surfaces

- Prefer bounded shell commands and Blender background mode for deterministic
  inspection, scripted edits, rendering, and export.
- Use `desktop-control` plus `desktop-vision` for an interactive Blender UI
  task. The 3D viewport may expose little AT-SPI information, so observe,
  perform one bounded action, and verify visually rather than clicking blind.
- There is no Blender MCP server in this repository. Do not invent or require
  one.
- Use visible `playwright_browser_*` tools only for browser-based output or
  documentation that needs interaction. Use `playwright_headless_browser_*`
  only when the user explicitly requests headless/background browser work.

## Core workflow

1. Establish the requested result, source file, output directory, Blender
   version, render frame or range, export format, and acceptance checks.
2. Inspect paths, available disk space, `command -v blender`, and
   `blender --version` before changing anything. Do not reinstall or reconfigure
   Blender merely because a command or file is not where expected.
   For glTF work, also verify `import numpy` inside Blender; Ubuntu's glTF add-on
   requires the distribution's `python3-numpy`, not an ad hoc `pip` install.
3. Preserve every source `.blend`. Use a new, versioned output such as
   `scene-v002.blend`, `scene-v002.glb`, or `scene-v002-frame-0001.png`; fail if
   that exact output already exists rather than silently overwriting it.
4. For any background-mode task, first read
   [references/background-workflows.md](./references/background-workflows.md)
   in full and follow its command ordering, timeout, auto-execution, and script
   rules.
5. Probe an existing scene before editing with
   [scripts/scene_probe.py](./scripts/scene_probe.py). It is a read-only Blender
   Python script that writes a new JSON inventory and must be run by Blender,
   not by `python3`.
6. Review every task-specific Python script before execution. Bound its inputs
   and outputs, avoid network access and unrelated paths, and make failures
   propagate through `--python-exit-code 1`.
7. Make the smallest requested change in memory, then save only to the
   versioned output path. Do not mutate Blender preferences or install add-ons
   unless the user requested setup and approved any consequential change.
8. Before saving, rendering, or exporting, read
   [references/verification-and-export.md](./references/verification-and-export.md)
   in full. Verify a saved `.blend` by reopening it in a separate Blender
   process and comparing a fresh structural probe. Verify a render by reading
   the actual image, not merely checking that Blender exited successfully.
9. Report the Blender version, source and output paths, command timeout,
   structural differences, visual result, warnings, and anything not tested.

## Non-negotiable command rules

- Put global options before an input file. Every automated Blender invocation
  uses `--background --factory-startup --disable-autoexec` and
  `--python-exit-code 1`, with an explicit `timeout` appropriate to the job.
- Blender processes command-line arguments in order. Put the input `.blend`
  before a task `--python` script that operates on it, and put render settings
  before the final `--render-frame` or `--render-anim` action.
- Use absolute, quoted paths. Put script arguments after `--` so Blender does
  not parse them as its own options.
- `--disable-autoexec` reduces risk from embedded scripts and drivers; it does
  not make an untrusted file harmless. Keep unknown files isolated from private
  data and do not enable auto-run to silence warnings.
- Never run Blender or another graphical application as root. Never weaken
  Wayland, AppArmor, filesystem permissions, or sandboxing to make automation
  work.

## Verification standard

- Process success is necessary but insufficient. Check that each expected file
  is new, non-empty, readable, and at the intended path.
- A saved scene passes only after a clean-process reopen and structural probe
  confirm expected scenes, objects, hierarchy, materials, images, cameras,
  animation, and external dependencies.
- A render passes only after actual image inspection for framing, lighting,
  materials, transparency, missing textures, and obvious corruption.
- An export passes only after clean reimport structural checks and, when meant
  for a browser, a Firefox runtime load check.
- A desktop screenshot is disposable verification evidence and must be deleted
  immediately after inspection. A render requested by the user is an output
  artifact and must be retained at the approved destination. Delete only
  task-created temporary verification renders.

## Safety boundaries

- Treat `.blend` files and Python scripts from unknown sources as untrusted.
- Do not overwrite source files, pack or unpack resources, remap paths, apply
  transforms, purge data, delete objects, or alter linked libraries without the
  task requiring it and the effect being understood.
- Ask immediately before deleting local data, changing permissions or package
  sources, installing add-ons, or replacing an existing output.
- Use `pkexec` only for an already-reviewed bounded system operation. Never
  request, capture, or type a password, and never observe a PolicyKit dialog.
- Do not upload a `.blend`, texture, render, or export unless the user named
  both the exact file and destination.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements. README and reference files are not loaded
automatically with this `SKILL.md`.
