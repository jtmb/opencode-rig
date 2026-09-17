# Validation Checklist

Read this file explicitly before completing any new or changed skill bundle.

## Structure and frontmatter

- [ ] Canonical source is under
      `platforms/linux/ubuntu/computer-use/skills/<name>/`.
- [ ] The skill directory is a direct child of `skills/`.
- [ ] The entry file is exactly `SKILL.md`.
- [ ] `name` matches the directory and official naming regex.
- [ ] `description` is 1-1024 characters and states what and when.
- [ ] Frontmatter uses only `name`, `description`, `license`, `compatibility`,
      or string-to-string `metadata`.
- [ ] Repository-required metadata contains `schema-version: "1"`, one accepted
      category, and three to eight valid comma-separated tags.
- [ ] A complete skill-specific `README.md` is present and linked from the
      bundle where appropriate.
- [ ] No unverified license claim was introduced.

## Content

- [ ] Root `AGENTS.md` was read and remains the routing authority.
- [ ] Claims match current implementation and authoritative documentation.
- [ ] Safety and confirmation gates match repository policy.
- [ ] Scope is bounded and unrelated opportunities are only reported.
- [ ] No automatic commit or learning-log requirement exists.
- [ ] Rename or retirement does not delete anything without an immediate
      pre-deletion confirmation.
- [ ] `SKILL.md` is under 500 lines as an editorial guideline.

## Split bundles and links

- [ ] Every linked reference exists at the resolved relative path.
- [ ] Workflows explicitly instruct the agent to read needed references.
- [ ] No reference is described as automatically loaded.
- [ ] Historical material is clearly marked inactive.
- [ ] All text is ASCII unless the repository has a concrete need otherwise.

## Catalog and deployment

- [ ] The existing `skills/README.md` catalog is consistent, including the
      category/tag index and links to each usage guide; no `SKILL-INDEX.md`
      was introduced.
- [ ] Only canonical source was edited.
- [ ] Deployment tooling copies the complete bundle recursively.
- [ ] Every deployed file matches its canonical source counterpart.
- [ ] A restart and fresh-session discovery test follows deployment.

## Completion

- [ ] Relevant repository checks pass.
- [ ] Git diff contains only intended authorized changes.
- [ ] Exact files changed and any unresolved caveat are reported.
- [ ] No commit was created unless explicitly requested.
