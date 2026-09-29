# Skill Maintenance Usage

This guide explains how to use the `skill-maintenance` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `skills`

Tags: `skills`, `documentation`, `deployment`, `catalog`

## Purpose and when to use it

Use `skill-maintenance` when skill coverage, documentation, metadata,
catalogs, deployment, names, or retirement needs controlled maintenance.

Appropriate requests include:

- "Audit all skills for stale paths and unsafe instructions."
- "Create a skill for this repeated workflow."
- "Update this skill and verify its references."
- "Deploy this updated split skill and verify every reference file."
- "Propose retirement for a skill whose behavior is gone."

Do not use it as a shortcut for unrelated edits or automatic repository-wide
rewrites.

## Prerequisites and setup verification

Before maintaining a skill, the agent should inspect:

- Repository-root `AGENTS.md`.
- `skills/README.md`.
- The complete canonical skill bundle.
- Deployment behavior in `scripts/setup-opencode.sh`.
- Relevant existing references and outside files affected by the change.

Canonical sources are:

```text
platforms/linux/ubuntu/computer-use/skills/<name>/
```

Deployed copies are generated state:

```text
~/.opencode-v2-pilot/config/skills/<name>/
```

The user should define whether the task is detection, creation, update,
deployment, rename, retirement, catalog reconciliation, validation, or a
combination.

## How to request it

Ask in ordinary language and name the affected skill when possible.

Example requests:

- "Detect missing or overlapping skill coverage for browser work."
- "Create a focused new skill without duplicating app-setup."
- "Update this skill's outdated installation command."
- "Reconcile the skill catalog after changing count or routing."

The agent should treat detection as evidence gathering, not authorization for
unrelated edits.

## Worked workflow and expected result

A representative agent workflow is:

1. Read `AGENTS.md`, the skill catalog, and the entire target bundle.
2. Define the smallest scope that solves the maintenance problem.
3. Explicitly read only the relevant maintenance reference:
   - Read [detection](./references/detection.md) for missing, overlapping, or
     stale coverage.
   - Read [creation](./references/creation.md) before creating a skill.
   - Read [lifecycle](./references/lifecycle.md) before updating, renaming,
     deploying, or proposing retirement.
   - Read [catalog reconciliation](./references/index-regeneration.md) after
     creating, renaming, materially changing, or retiring a skill.
   - Read [audit](./references/audit.md) when auditing one skill or the
     complete catalog.
   - Read [validation](./references/validation-checklist.md) before completing
     a new or changed bundle.
   - Read [documentation and metadata](./references/documentation-and-metadata.md)
     before adding guides, categories, or tags.
4. Edit canonical source only.
5. Preview deployment without changing the system:

   ```bash
   ./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
   ```

6. Deploy only the approved complete bundle, then verify parity:

   ```bash
   ./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply
   ```

7. Validate frontmatter, links, documentation, catalog, deployment, and exact
   parity.
8. Report unrelated findings without implementing them.

Expected result: a bounded, reviewable skill change with consistent routing,
metadata, usage documentation, catalog entries, and deployed files.

## Verification and known limitations

The agent should verify:

- Directory, entry-file, name, description, category, tags, and metadata
  requirements.
- Every linked reference exists and resolves from the containing file.
- Catalog counts, names, boundaries, and requirements agree.
- Deployment recursively copied the complete bundle.
- Source and deployed files match exactly.
- OpenCode discovers the skill after a restart.

Known limitations:

- Linked references are not loaded automatically.
- Existing sessions retain previously loaded skill context.
- Provenance and historical files must remain clearly inactive.
- A deployment utility can have side effects beyond copying skills; read its
  implementation before presenting it as documentation-only.

## Troubleshooting

- Missing reference: inspect the bundle rather than inventing a path or
  filename.
- Ambiguous trigger overlap: clarify routing boundaries instead of merging
  skills automatically.
- Catalog drift: regenerate counts and metadata from canonical sources rather
  than editing generated deployment copies.
- Incomplete deployment: fix repository tooling rather than manually editing
  the selected v2 config directory's `skills/` tree.
- Rename or retirement uncertainty: prepare an old-to-new or deletion
  manifest and request immediate pre-deletion confirmation.

## Safety, confirmation, and elevation

The agent must:

- Never edit generated deployment copies directly.
- Never commit automatically.
- Never delete or retire a skill automatically.
- Show deletion manifests and ask immediately before destructive action.
- Preserve unrelated dirty work.
- Follow normal confirmation gates for repository, security, deletion, legal,
  purchase, publishing, and other consequential actions.

Normal skill maintenance does not require administrator elevation.

## Related skills and documents

- `AGENTS.md` remains the routing and operating authority.
- `skills/README.md` is the skill catalog containing this skill's canonical
  entry.
- [PROVENANCE.md](./PROVENANCE.md) records the upstream source for this
  imported bundle.
