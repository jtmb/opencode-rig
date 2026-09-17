# Skill Lifecycle

Read this file explicitly before updating, renaming, deploying, or proposing
retirement of a skill.

## Update

1. Read the entire source bundle and all links it exposes.
2. Compare instructions with current repository behavior and authoritative
   external documentation.
3. Search for references to names, paths, triggers, and changed claims.
4. Make the smallest source-only change that resolves the verified drift.
5. Update `skills/README.md` only when catalog content changed.
6. Validate the bundle and report unrelated opportunities without changing
   them.

Never edit `~/.config/opencode/skills/` directly. It is generated state.

## Rename

A rename affects the canonical directory, frontmatter name, catalog, links,
routing references, and deployed directory. Build an old-to-new manifest and
search the repository before changing anything. Because removing the old name
deletes data, preview the final deletion and ask immediately before it.

## Deploy

Use repository deployment tooling only after confirming that it recursively
copies every file under each source skill directory to the corresponding
generated directory. Deployment must be content-aware and idempotent.

Verify at minimum:

- every source file exists at the same relative deployed path
- file contents match
- no required reference or runtime file was skipped
- unrelated deployed skills or files were not removed

After source or deployment changes, restart OpenCode and begin a fresh session
to test discovery and reference use. Existing sessions retain loaded context.

If deployment tooling handles only `SKILL.md`, report the concrete mismatch.
Do not manually edit or partially populate the deployed directory as a
workaround.

## Retirement

Retirement is never automatic.

1. Verify the covered behavior is gone, replaced, or intentionally unsupported.
2. Search source, docs, catalog, routing policy, and deployed state for every
   reference.
3. Present the reason, replacement route, affected paths, and exact deletion
   manifest.
4. Ask for confirmation immediately before deletion.
5. Only after confirmation, delete the approved paths and update references.
6. Audit and verify that no stale links or routing entries remain.

## Version control

Do not make snapshot, maintenance, or follow-up commits automatically. Commit
only when the user explicitly asks, and stage only intended files after
reviewing status and diff.
