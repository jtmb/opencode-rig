# Skill Documentation and Metadata

Read this file explicitly before adding or changing skill documentation,
frontmatter metadata, tags, usage guides, or catalog summaries.

This repository requires metadata even though OpenCode treats it as optional.
Metadata is authoritative in `SKILL.md`; catalogs and README files derive
summaries from it.

## Required frontmatter

Every canonical `SKILL.md` must contain:

```yaml
---
name: example-skill
description: Perform a specific reusable workflow. Use when the user names the workflow, relevant files, or its common failure mode.
metadata:
  schema-version: "1"
  category: "desktop"
  tags: "gnome,screenshot,visual-verification"
---
```

Requirements:

- Use only `name`, `description`, `license`, `compatibility`, and `metadata`.
- `metadata` must be a string-to-string map.
- Repository-required keys are `schema-version`, `category`, and `tags`.
- `schema-version` must be exactly `"1"`.
- `category` must be one lowercase hyphen-separated category currently listed
  in `skills/README.md`.
- `tags` must contain three to eight unique lowercase hyphen-separated tags,
  separated by commas without spaces.
- Do not use a top-level `tags` field. OpenCode recognizes `metadata`, not
  top-level tags.
- Do not create a parallel `metadata.json` unless a concrete non-OpenCode
  consumer requires it.
- Keep the skill directory, frontmatter `name`, official naming regex, and
  description rules unchanged.

## Required usage guide

Every skill directory must contain a user-facing `README.md` that supplements,
but does not replace, `SKILL.md`. Agent behavior and safety boundaries stay in
`SKILL.md`.

Use this order:

1. Purpose and when to use it.
2. Prerequisites and setup verification.
3. How to request it.
4. Worked workflow and expected result.
5. Tools or commands, including preview and write behavior.
6. Verification and known limitations.
7. Troubleshooting.
8. Safety, confirmation, and elevation requirements.
9. Related skills and documents.

Usage-guide rules:

- Show natural-language requests first. They are the normal interface.
- Distinguish loading the skill, agent MCP/tool calls, supporting terminal
  commands, and fixed MCP server wrappers.
- Verify examples against current scripts, MCP entries, file paths, flags, and
  safety behavior. Do not invent shell flags, CLI subcommands, slash commands,
  MCP tool names, or session-state behavior.
- State whether each example was actually executed or is a documented,
  representative invocation.
- Inside a skill bundle, link only files deployed with the complete skill
  set. Because deployment copies every canonical skill bundle, sibling skill
  bundles are valid relative-link targets. Use repository paths as plain
  text, not relative links, for scripts, catalogs, root policy, and other files
  outside the deployed skill set.
- State explicitly that README files and other references are not loaded
  automatically when the skill is loaded.

## Catalog synchronization

When documentation or metadata changes:

1. Add or update the skill-specific `README.md`.
2. Extract the exact category and tags into the category/tag index in
   `skills/README.md`.
3. Preserve the catalog's trigger boundaries, examples, and prose style.
4. Link each usage guide and skill source.
5. Run the metadata/documentation validator, recursive deployment, and exact
   source/deploy parity checks.
