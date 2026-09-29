# Open Rig v2 Ownership Boundaries

Open Rig uses a small, explicit v2 runtime boundary:

## Layer 1: OpenCode v2 configuration

- Declares local MCP servers and plugin packages in the v2 config examples.
- Uses canonical absolute plugin paths and prompt-gated session permissions.
- Is changed only by the selected setup/deployment operation.

## Layer 2: Canonical repository source

- Skills: `platforms/linux/ubuntu/computer-use/skills/`
- Plugins: `platforms/linux/ubuntu/computer-use/plugins-v2/`
- Commands, examples, scripts, and checks: siblings below
  `platforms/linux/ubuntu/computer-use/`.
- Source files are regular, non-symlink files and are never replaced by live
  user configuration.

## Layer 3: Selected runtime target

- A target is supplied explicitly, such as a test directory or v2 config
  directory; it is never inferred for a write.
- Verification reads the target and reports drift without modifying it.
- Apply writes atomically, refuses symlink ancestors, and preserves unrelated
  files and configuration fields.

## NEVER

- Treat a generated user copy as canonical source.
- Write during a default verification pass.
- Follow a symlink or path escape from source or target.
- Treat generated runtime files as canonical source.
- Delete unrelated target files while reconciling a bundle.
