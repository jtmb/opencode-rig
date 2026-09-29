# development-conventions Usage

Category: `maintenance`

Tags: `development`, `conventions`, `source-editing`, `testing`, `documentation`, `operations`

## Purpose and when to use it

Use this bundle for source editing and review, documentation, API contracts,
tests, and OpenCode v2 harness operations. It is a reference bundle, not a
replacement for the repository-root `AGENTS.md`.

## Prerequisites and setup verification

Read `AGENTS.md`, inspect the current working tree, and identify the canonical
source under `platforms/linux/ubuntu/computer-use/`. Read only the relevant
reference files before acting. Verification is read-only by default.

## How to request it

Ask for a convention review, a focused source change, documentation guidance,
or bounded setup/deployment verification. Name the relevant domain when one is
known, such as Python, API, UI, or v2 bundle deployment.

## Worked workflow and expected result

1. Inspect the current source and preserve unrelated dirty work.
2. Read the mandatory comments/testing references and the matching domain guide.
3. Make the smallest canonical-source change.
4. Run focused checks; use `--apply` only for an explicitly selected target.

Expected result: a reviewable change with no stale links, no unsafe path
assumptions, and evidence that the affected behavior was checked.

## Verification and known limitations

Run `../scripts/check-skill-docs.py` from the computer-use directory to verify
metadata, structure, links, and catalog coverage. Use
`../scripts/setup-opencode.sh --verify-only` to inspect deployment drift and
`--apply` only when deployment is explicitly requested.

## Troubleshooting

- Missing references: inspect the bundle rather than inventing a filename.
- Stale deployment: run `../scripts/setup-opencode.sh --verify-only`, then use
  `--apply` only after reviewing the selected target.

## Safety, confirmation, and elevation

Never edit generated user configuration directly. Do not replace unrelated
files, follow symlink escapes, or infer commit/push approval. Deploy only through
the repository setup script, which preserves unrelated target files.

## Related skills and documents

- [`SKILL.md`](./SKILL.md) — agent-facing routing and conventions.
- [`references/useful-comments/guidelines.md`](./references/useful-comments/guidelines.md)
  — comment guidance.
- [`references/testing/patterns.md`](./references/testing/patterns.md) — test
  selection and failure-focused checks.
- Repository-root `AGENTS.md` — Open Rig v2 operating authority.
