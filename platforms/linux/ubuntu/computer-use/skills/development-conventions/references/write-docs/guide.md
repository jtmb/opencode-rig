---
title: "Writing Documentation — READMEs, API Docs, ADRs, Project Docs"
impact: HIGH
impactDescription: "Ensures docs stay current, complete, and follow project conventions"
tags: [documentation, readme, adr, api-docs, getting-started]
---

## Writing Documentation

## 🔴 HARD RULEs

### Setup guidance
Every maintained project or platform surface should have one discoverable setup
guide covering prerequisites, installation, build steps, configuration,
verification, and troubleshooting. In Open Rig, route this through the existing
`docs/` and `platforms/linux/ubuntu/computer-use/` documentation; do not invent
parallel documentation trees.

### Configuration guidance
Document environment variables and config files where they are actually used.
Each entry lists the name, default or required state, owning file, and purpose.
Do not put credentials or private user configuration in examples.

### Per-feature guides
Add a focused guide only when a feature is user-facing or operationally
significant. Link it from the repository's existing documentation index rather
than creating a duplicate catalog.

### README.md

A good README answers these questions in order:
```markdown
# Project Name
One-line description.

## Quick Start
Fastest path to working setup. Goal: under 5 minutes.

## Usage
Common workflows with copy-pasteable examples.

## Configuration
Environment variables, config files, feature flags.

## Development
How to set up dev environment, run tests, contribute.

## Architecture
High-level overview — link to the closest existing architecture or platform
guide.
```

- Write for someone who just found your repo — they have 30 seconds
- Copy-pasteable examples: every code block should be runnable as-is
- Keep it current: outdated Quick Start is worse than no Quick Start

### API Documentation

For every endpoint:
```markdown
### GET /api/v1/users/:id
**Path Parameters** | **Query Parameters** | **Response (200)** | **Errors**
```

- Every endpoint, every status code, every field documented
- Request and response examples for each status code
- Authentication requirements clearly stated

### Architecture Decision Records (ADRs)

For significant architectural decisions, create `docs/adr/NNNN-title.md`:
```markdown
# ADR-0001: Title
**Status:** proposed | accepted | deprecated | superseded
**Date:** YYYY-MM-DD
**Context:** What problem?
**Decision:** What we decided.
**Consequences:** Tradeoffs.
```

### Incremental Updates

When a specific change was made, update only the affected docs:

| Change | Docs to update |
|--------|---------------|
| Added/removed/modified a skill | the relevant canonical skill guide and existing documentation index |
| Added/removed/modified an agent | the relevant agent or harness guide, when one exists |
| Changed config | the owning v2 config example and its focused setup/verification guide |
| Added new dependencies | the owning package manifest and setup documentation |
| Modified a learning or memory surface | the relevant canonical skill and its existing documentation route |

Repository-root `AGENTS.md` is an instruction authority. Update it only on an
explicit request; do not use documentation work as a reason to rewrite it.
