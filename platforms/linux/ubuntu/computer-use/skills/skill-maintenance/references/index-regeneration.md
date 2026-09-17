# Catalog Reconciliation

Read this file explicitly after creating, renaming, materially changing, or
retiring a skill, or when catalog drift is reported.

This repository uses
`platforms/linux/ubuntu/computer-use/skills/README.md` as its skill catalog.
Do not create `SKILL-INDEX.md`.

## Procedure

1. Enumerate direct child directories under the canonical `skills/` source.
2. For each directory, read `SKILL.md` and extract its exact `name`,
   `description`, category, and tags.
3. Compare the source set with the catalog and root `AGENTS.md` routing table.
4. Update only stale counts, entries, paths, boundaries, examples,
   requirements, guides, categories, or tags affected by the requested change.
5. Preserve the catalog's established organization and prose style.

The catalog may summarize descriptions for readability, but it must not change
the trigger boundary or contradict `SKILL.md`.

## Verification

- Every cataloged skill has a canonical `SKILL.md`.
- Every active canonical skill is cataloged unless repository policy records a
  specific exception.
- Names, counts, trigger boundaries, and relevant requirements agree.
- Root `AGENTS.md` remains the routing authority.
- All relative links resolve.

If catalog or routing edits are needed outside the authorized task scope,
report exact proposed paths and changes rather than making them.
