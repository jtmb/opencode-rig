# Skill System Audit

Read this file explicitly when auditing one skill or the complete catalog.
Keep the audit read-only until findings and authorized scope are clear.

## Checks

### Source structure

- Canonical skill directories are direct children of `skills/`.
- Each has an uppercase `SKILL.md`.
- Frontmatter name matches the directory and satisfies the official pattern.
- Description is present, specific, and no longer than 1024 characters.
- Only recognized OpenCode skill frontmatter fields are used.
- Repository-required metadata, category, tags, and the skill-specific usage
  guide are present and consistent with the catalog.

### Content and references

- Instructions agree with root `AGENTS.md` and current implementation.
- Commands, paths, versions, permissions, and safety gates remain accurate.
- Every linked reference is explicitly described and exists.
- Internal relative links resolve from the file containing each link.
- Historical files are clearly inactive and cannot be mistaken for policy.

### Routing and catalog

- Root `AGENTS.md` routes relevant user intents to the skill without ambiguous
  overlap.
- `skills/README.md` entries and counts agree with canonical source.
- No `SKILL-INDEX.md`, agent grant, database registration, or learning log is
  assumed.

### Deployment

- The deployed location is `~/.config/opencode/skills/<name>/`.
- Canonical source is authoritative and deployed files are generated copies.
- The complete directory is deployed recursively, not only `SKILL.md`.
- Source and deployed relative paths and contents match.
- Deployment is idempotent and does not remove unrelated files.

### Runtime

- OpenCode discovers the skill after restart in a fresh session.
- The displayed name and description are correct.
- Loading the skill succeeds.
- A representative workflow explicitly reads its required reference and
  follows repository policy.

## Handling findings

Fix only findings inside the user's requested and permitted scope. Report all
others with evidence and affected paths. Never auto-commit. Never auto-delete;
preview a deletion manifest and ask immediately before the destructive action.
