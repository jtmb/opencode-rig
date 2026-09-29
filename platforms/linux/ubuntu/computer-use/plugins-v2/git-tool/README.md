# OpenCode Git diff tool (v2)

Server plugin exposing one read-only `git_diff` tool. It calls `ctx.vcs.diff`
instead of spawning Git and supports `working`, `branch`, and `committed` modes,
an optional safe base ref, 0–20 context lines, an optional repository-relative
file/directory prefix, and a 1 KiB–250 KiB returned UTF-8 byte bound (120 KiB
default). Unsafe refs, absolute/traversal paths, unknown fields, and out-of-range
values fail closed.

The tool returns the native VCS patches as plain unified diff text. OpenCode
v2.0.7's TUI rich diff renderer is hard-coded to normalized built-in `edit` and
`patch` tool IDs: its `metadata.files` contract is only adapted for those IDs.
Custom `git_diff` results therefore cannot invoke that renderer; this package
does not invent unsupported metadata or ANSI escapes and uses the truthful
generic text fallback.

## Check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/git-tool run check
```

Register `git-tool/server` as a server plugin in the parent integration.
