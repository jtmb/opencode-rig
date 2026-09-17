# `check-skill-docs.py` and `check-skill-docs-self-test.py`

Read-only validation of the canonical skill metadata and user-facing usage
guides, plus a negative self-test that proves the validator rejects invalid
input. Together they guard the repository's documentation contract, which is
described further in the `skill-maintenance` skill.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-skill-docs-self-test.py
```

## `check-skill-docs.py`

The validator is a repository consistency check. It does not deploy skills,
modify files, or inspect live application state. It discovers every skill by
listing directories under `computer-use/skills/` and checks the catalog at
`skills/README.md`.

### Frontmatter

`read_frontmatter()` requires the file to begin with a `---` envelope whose
leading content is empty, and parses two levels:

- Top-level `key: value` fields.
- A `metadata:` block whose entries are indented two spaces, with **quoted**
  string values.

Allowed top-level fields are exactly `name`, `description`, `license`,
`compatibility`, and `metadata`. Duplicate keys, unexpected indentation, and
unquoted metadata values are rejected.

Checks per skill:

| Check | Rule |
|-------|------|
| `name` | Must equal the directory name and match `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters |
| `description` | 1–1024 characters |
| `metadata.schema-version` | Must be `"1"` |
| `metadata.category` | Must be in the category set |
| `metadata.tags` | 3–8 tags, unique, each matching `^[a-z0-9]+(-[a-z0-9]+)*$` |

The allowed categories are: `applications`, `automation`, `browser`, `desktop`,
`editor`, `files`, `maintenance`, `memory`, `skills`, `troubleshooting`.

### Usage guide (`README.md`)

Each skill must have a `README.md` whose first line is `# <Human Name> Usage`
and which contains all eight required sections:

```
## Purpose and when to use it
## Prerequisites and setup verification
## How to request it
## Worked workflow and expected result
## Verification and known limitations
## Troubleshooting
## Safety, confirmation, and elevation
## Related skills and documents
```

It must also declare `Category: \`<category>\`` and `Tags: <tags>` matching the
frontmatter exactly. The guide must link `./SKILL.md`, and `SKILL.md` must link
`./README.md`.

### Catalog

`skills/README.md` is parsed for category-index rows beginning with `| [\``.
Each row supplies a name, category, and tag list. The validator requires:

- The set of rows equals the set of skill directories (no missing or extra
  rows).
- No duplicate row names.
- Each row's category and tags equal the skill's frontmatter.
- The catalog contains a `### <name>` heading for each skill.

### Bundle hygiene

Every file in a skill bundle is checked:

- No symbolic links anywhere.
- No generated artifacts: `__pycache__`, `.mypy_cache`, `.pytest_cache`,
  `.ruff_cache`, `node_modules`, `.DS_Store`, `Thumbs.db`, `.pyc`, `.pyo`.
- No world-writable files (`o+w`).

### Link checking

All Markdown links in every skill document and in the catalog are resolved.

- In-page anchors, absolute paths, `~` paths, and URLs are skipped.
- Relative links must resolve to an existing file.
- A link must not escape the skills directory. The validator resolves the target
  and requires it to stay under `SKILLS_DIR`, so a skill cannot link out to
  arbitrary repository or system files.

On success it prints
`OK: skill metadata and documentation valid for N skills` and exits `0`. Any
failure raises `SystemExit` with a `check-skill-docs:` message and a non-zero
exit.

## `check-skill-docs-self-test.py`

Because a validator that passes everything is worthless, the self-test proves
negative coverage. It loads the validator as a module, redirects
`SKILLS_DIR` and `CATALOG` at temporary fixtures, and asserts that:

1. A well-formed fixture **passes** (`main()` returns `0`).
2. Each of the following invalid fixtures **fails**:

| Case | What is broken |
|------|----------------|
| duplicate metadata | Two `category` keys in the metadata block |
| unquoted metadata | `schema-version: 1` without quotes |
| overlong name | A 65-character skill name |
| empty tag | A tag list containing an empty element |
| catalog mismatch | Catalog tag differs from the skill's frontmatter |
| missing section | A required usage-guide section removed |
| unresolved link | A link to a nonexistent file |
| extra catalog row | A catalog row with no matching skill directory |
| generated artifact | A `__pycache__/helper.pyc` inside the bundle |
| escaping link | A link that resolves outside the skills directory |
| symbolic link | A symlinked file inside the bundle |
| world writable | A bundle file with the `o+w` bit |

It prints `OK: validator negative coverage passed for N cases` and exits `0`.
If any invalid fixture is accepted, it raises `AssertionError` and exits
non-zero.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Validation passed (validator) or all negative cases rejected (self-test) |
| `1` | Validation failure, or a self-test case that should have failed but did not |
| `2` | Unused; argument parsing is minimal (no arguments) |

## When to run

Run both after any change to a `SKILL.md`, a usage-guide `README.md`, the
skills catalog, or the validator itself. The `/promote-skills` command runs the
validator before deploying, and the repository's required verification (see
[`AGENTS.md`](../../AGENTS.md)) includes both scripts.
