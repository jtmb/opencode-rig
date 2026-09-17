# Creating Skills

Read this file explicitly before creating a skill.

## Define scope

Start from concrete user intents and reusable behavior. Give one skill one
coherent responsibility. Prefer extending an existing skill when its trigger
and workflow already own the problem.

Before writing, inspect:

- root `AGENTS.md` for routing and repository rules
- `skills/README.md` for names, boundaries, and required integrations
- adjacent skill bundles for established style
- implementation and authoritative external documentation for factual claims

## Choose a name

Use a specific lowercase hyphen-separated name, 1-64 characters, matching
`^[a-z0-9]+(-[a-z0-9]+)*$`. The directory and frontmatter `name` must match.
Check every canonical skill directory for collisions.

## Choose a structure

Use a single `SKILL.md` when the instructions remain focused. Use a split
bundle when detailed workflows would obscure routing and core rules:

```text
skills/<name>/
  SKILL.md
  README.md
  references/
    workflow-one.md
    workflow-two.md
```

Keep `SKILL.md` under 500 lines as an editorial guideline. Supporting files
have no repository line limit, but should remain focused. Link every reference
from `SKILL.md` and explicitly instruct the agent when to read it.

Do not add a duplicate `metadata.json` unless a concrete non-OpenCode consumer
requires it. OpenCode uses `SKILL.md` frontmatter.

## Write frontmatter

```yaml
---
name: example-skill
description: Perform a specific reusable workflow. Use when the user names the workflow, relevant files, or its common failure mode.
metadata:
  schema-version: "1"
  category: "desktop"
  tags: "example,skill,workflow"
---
```

Only `name`, `description`, `license`, `compatibility`, and `metadata` are
recognized. `name` and `description` are required; description length is
1-1024 characters. This repository also requires metadata with
`schema-version`, `category`, and `tags`. Do not claim a license that has not
been granted. Read
[documentation-and-metadata.md](documentation-and-metadata.md) before creating
the skill-specific `README.md`.

## Write useful instructions

Put routing, authority, paths, safety boundaries, and the normal workflow near
the start. Include commands only when they are current and safer than plain
prose. Define verification in terms of the user's outcome, not merely a zero
exit code.

Do not assume MCP servers, databases, agents, companion skills, or learning
logs. Mention integrations only when they exist in this repository and are
necessary to the workflow.

## Register and validate

Add or update the existing `skills/README.md` catalog rather than creating a
new index format. Add the skill-specific `README.md`, links, category, and
tags to the catalog. Ensure root `AGENTS.md` routing remains authoritative.
Run the checks in [validation-checklist.md](validation-checklist.md), and
verify recursive deployment before calling the skill usable.
