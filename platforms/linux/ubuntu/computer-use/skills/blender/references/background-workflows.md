# Safe Blender Background Workflows

Read this file in full before running Blender in background mode. These are
documented representative patterns and were not executed while this skill was
created.

## Preflight

Inspect before acting:

```bash
command -v blender
timeout 15s blender \
  --background \
  --factory-startup \
  --disable-autoexec \
  --python-exit-code 1 \
  --version
```

Confirm the absolute input path, intended versioned output path, free space,
and whether any referenced assets are outside the project. Do not use the
system Python to test `bpy`; Blender provides that module only in its own Python
environment.

Review every Python file before passing it to `--python`. A task script must
have bounded file inputs and outputs, no unexplained network access, no package
installation, and no preference or add-on mutation unless explicitly requested.

## Required ordering

Blender processes arguments in order. Put the safety and process-wide options
before the input file. Put the input file before a Python script that needs the
loaded scene. Put task-script arguments after `--`.

Every automated invocation uses all of these controls:

- `timeout <duration>` bounds the process. Exit code `124` means it timed out.
- `--background` avoids opening the GUI.
- `--factory-startup` avoids user startup files and preferences.
- `--disable-autoexec` blocks automatic execution of embedded scripts and
  drivers.
- `--python-exit-code 1` makes a Python exception fail the Blender process.

These controls reduce risk; they do not make an unknown `.blend` or script
trusted.

## Read-only scene probe

Choose a new JSON path. The output parent must already exist, and the probe
refuses to replace an existing file.

```bash
timeout 120s blender \
  --background \
  --factory-startup \
  --disable-autoexec \
  --python-exit-code 1 \
  "/absolute/path/source.blend" \
  --python "$HOME/.config/opencode/skills/blender/scripts/scene_probe.py" \
  -- --output "/tmp/opencode/source-probe-v001.json"
```

The command loads the source and writes only the report. Read the JSON and
inspect its `warnings`, object inventory, scenes, images, libraries, and
transforms before planning a mutation.

## Task-specific edit

Use a reviewed script stored in the project when it is part of the deliverable,
or in `/tmp/opencode/` when it is session-only. The script receives an unused
absolute output path, checks that it differs from the source and does not
exist, makes the bounded in-memory change, then calls
`bpy.ops.wm.save_as_mainfile(filepath=output_path)`.

```bash
timeout 300s blender \
  --background \
  --factory-startup \
  --disable-autoexec \
  --python-exit-code 1 \
  "/absolute/path/source.blend" \
  --python "/tmp/opencode/bounded-edit.py" \
  -- --output "/absolute/path/scene-v002.blend"
```

Do not have a script save back to `bpy.data.filepath`. Do not use an overwrite
flag as a substitute for choosing a versioned path. Prefer direct Blender data
API changes when operator context would be ambiguous.

## New scene without an input file

For a new scene, keep all global options before the task script:

```bash
timeout 300s blender \
  --background \
  --factory-startup \
  --disable-autoexec \
  --python-exit-code 1 \
  --python "/tmp/opencode/create-scene.py" \
  -- --output "/absolute/path/scene-v001.blend"
```

The script must use an unused output path and save explicitly. A successful
process that did not create the expected file is a failed task.

## Failure handling

- On a Python traceback, fix the first concrete error and rerun with a new
  output path if a partial file was created.
- On timeout, inspect the captured log and determine whether Blender was
  compiling shaders, rendering, waiting on a dependency, or stuck. Increase
  the limit only with evidence.
- If an operator reports an invalid context in background mode, prefer the data
  API or construct the documented context deliberately. Do not open the GUI and
  click blindly.
- If an embedded script or driver is blocked, report it. Do not remove
  `--disable-autoexec` without a separate security decision from the user.

## Official sources

- [Blender 5.0 command-line arguments](https://docs.blender.org/manual/en/5.0/advanced/command_line/arguments.html)
- [Blender 5.0 Python API](https://docs.blender.org/api/5.0/)
- [Blender Python operator gotchas](https://docs.blender.org/api/5.0/info_gotchas_operators.html)
