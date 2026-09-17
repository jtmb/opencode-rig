---
name: skill-maintenance
description: Create, update, audit, catalog, deploy, rename, or retire OpenCode skills in this repository. Use when skill coverage is missing or stale, a SKILL.md or reference bundle changes, skills/README.md drifts, deployment needs verification, or the user requests skill maintenance.
metadata:
  schema-version: "1"
  category: "skills"
  tags: "skills,documentation,deployment,catalog"
---

# Skill Maintenance

Maintain the complete lifecycle of this repository's OpenCode skills while
keeping changes bounded, reviewable, and consistent with repository policy.

## Authority and paths

- Read the repository-root `AGENTS.md` first. It is the routing and operating
  authority for skills in this repository.
- Canonical sources live at
  `platforms/linux/ubuntu/computer-use/skills/<name>/`.
- `~/.config/opencode/skills/<name>/` is a generated deployed copy. Never edit
  it directly.
- Use `platforms/linux/ubuntu/computer-use/skills/README.md` as the skill
  catalog. Do not introduce or maintain `SKILL-INDEX.md`.
- Do not assume project-specific MCP servers, databases, agents, companion
  skills, or a `learnings.md` workflow exist.

## Workflow

1. Read `AGENTS.md`, the skill catalog, and the complete target skill bundle.
2. Inspect current source, deployment behavior, references, and relevant docs
   before proposing a change.
3. Define the smallest scope that solves the requested maintenance problem.
4. Read the relevant reference file below explicitly. OpenCode loads
   `SKILL.md` on demand; linked reference files are not automatically included.
5. Edit canonical source only. Preserve unrelated dirty work.
6. Validate structure, content, links, catalog consistency, and deployment.
7. Report unrelated opportunities without implementing them.
8. Commit only when the user explicitly requests a commit.

## Core rules

### Keep the repository layout flat

Each skill directory is a direct child of the canonical `skills/` directory.
This is repository policy. OpenCode's official project and global discovery
locations also use `<skills>/<name>/SKILL.md`.

### Use valid skill frontmatter

`SKILL.md` must be uppercase and begin with YAML frontmatter containing:

- `name`, required, matching the directory name exactly
- `description`, required, 1-1024 characters, describing what the skill does
  and when to use it
- `metadata`, required by this repository, containing exactly the documented
  `schema-version`, `category`, and `tags`
- optionally `license` and `compatibility` as documented by OpenCode

Do not add other frontmatter fields. Names are 1-64 characters, lowercase
alphanumeric with single hyphen separators, and match
`^[a-z0-9]+(-[a-z0-9]+)*$`. Category and tags must follow
[documentation-and-metadata.md](references/documentation-and-metadata.md).

### Use split bundles deliberately

Keep `SKILL.md` under 500 lines as this repository's editorial guideline, not
as an OpenCode loader limit. Put detailed procedures in `references/*.md` and
link them from `SKILL.md`. Every workflow that depends on a reference must say
to read that file explicitly. Every skill also has a user-facing `README.md`
that documents requests, prerequisites, commands, verification, and safety
without replacing `SKILL.md`.

### Deploy the complete bundle

Deployment must copy the entire skill directory recursively from canonical
source to `~/.config/opencode/skills/<name>/`, including references and other
runtime files. It must be idempotent and remove nothing unexpectedly. Verify
source and deployed files match. If repository deployment tooling copies only
`SKILL.md`, report the mismatch and obtain authority to fix that tooling; do
not patch around it by editing the generated copy.

After deployment, restart OpenCode and use a fresh session. Running sessions
do not reload skill definitions or their supporting files.

### Never retire automatically

For a rename or retirement, first show the proposed old-to-new or deletion
manifest and all known references. Ask for confirmation immediately before
deleting any source or deployed data. Do not infer deletion approval from a
general maintenance request.

## References

Read only the files needed for the current operation, but read each selected
file in full before acting.

| File | Use |
| --- | --- |
| [`references/documentation-and-metadata.md`](references/documentation-and-metadata.md) | Add required usage guides, metadata, tags, and catalog summaries. |
| [`references/detection.md`](references/detection.md) | Find evidence of missing, overlapping, or stale skill coverage. |
| [`references/creation.md`](references/creation.md) | Design and create a valid monolithic or split skill. |
| [`references/lifecycle.md`](references/lifecycle.md) | Update, rename, deploy, or propose retirement safely. |
| [`references/index-regeneration.md`](references/index-regeneration.md) | Reconcile the existing `skills/README.md` catalog. |
| [`references/audit.md`](references/audit.md) | Audit source, links, catalog entries, and deployment. |
| [`references/validation-checklist.md`](references/validation-checklist.md) | Validate a new or changed bundle before completion. |

Historical imported material is retained at
[`references/sources/local-persistence/source-index.md`](references/sources/local-persistence/source-index.md)
for provenance only. It is inactive and must not be executed or reinstated.
See [`PROVENANCE.md`](PROVENANCE.md) for import details.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
