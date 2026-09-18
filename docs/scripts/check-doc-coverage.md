# `check-doc-coverage.py`

Enforces the repository's documentation gate: a change to a mapped source must
update or create its documentation. It is driven by
[`documentation-map.json`](../../documentation-map.json) and runs locally through
the [pre-push hook](setup-git-hooks.md). It is read-only and never writes to the
repository.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage.py --base origin/main --head HEAD
python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage.py --changed-file path/to/source.py --changed-file docs/page.md
```

## The two checks

- **Completeness (always).** Every tracked file matched by a map rule must have
  its mapped documentation present. A new script, plugin, or skill therefore
  cannot land without its page.
- **Change-aware (when a base/head range or explicit changed files are given).**
  Every matched changed file must have at least one of its mapped documentation
  files changed in the same set. New artifacts (`onAdd`) may additionally
  require an index or overview update.

Check evaluation is **first matching rule wins**, so an exception rule (for
example a self-test that shares its parent's page) must appear before the
general rule.

## Documentation map

`documentation-map.json` at the repository root is the single source of truth:

```json
{
  "version": 1,
  "rules": [
    {
      "name": "scripts",
      "match": ["platforms/linux/ubuntu/computer-use/scripts/*.sh"],
      "docs": ["docs/scripts/{stem}.md"],
      "onAdd": ["docs/scripts/README.md"]
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `name` | Unique rule name, referenced in messages |
| `match` | Globs the rule governs. `*` stops at `/`, `**` crosses it, `?` is one non-slash character |
| `docs` | Documentation paths that must exist and that must change when a matched source changes. At least one must change; all must exist |
| `onAdd` | Optional. When a matched file is **added**, at least one of these must also change (index/overview upkeep) |

`docs` paths may use placeholders: `{stem}` (file name without extension),
`{plugin}` (directory under `.../plugins/`), and `{skill}` (directory under
`.../skills/`). The v2 plugin workspace
(`platforms/linux/ubuntu/computer-use/plugins-v2/**`) is matched by a rule
whose documentation is the workspace
[`plugins-v2/README.md`](../../platforms/linux/ubuntu/computer-use/plugins-v2/README.md)
rather than a per-plugin page.

### `rules` and `additional`

- `rules` are evaluated **first match wins**, so an exception rule (a self-test
  that shares its parent's page) must appear before the general rule. Each
  matched source has exactly one documentation set.
- `additional` rules use **union** semantics: every matching rule applies in
  addition to the primary rule. They are used for cross-cutting requirements.
  `onAdd` is not allowed in `additional`.

The current `rules` cover scripts, plugins, skills, commands, config examples,
the browser manifests, the GitHub tools, the Git hooks, and the map itself. The
single `additional` rule (`handoff`) requires `HANDOFF.md` to be updated
whenever an environment-defining artifact changes: the map and hooks, CI
workflows, global commands, plugin registration, the skills catalog, the
setup/MCP/deploy scripts (including the v2 `setup-opencode-v2.sh` and
`verify-opencode-v2.sh`), the browser manifests, or the GitHub tools README.

## Options

| Option | Meaning |
|--------|---------|
| `--root DIR` | Repository root (default: git top level of the working directory) |
| `--map FILE` | Map path (default: `<root>/documentation-map.json`) |
| `--base REF` | Base ref for the change-aware check; uses `git diff --name-status` against `--head` |
| `--head REF` | Head ref (default: `HEAD`) |
| `--changed-file PATH` | Treat PATH as modified (repeatable; for tests and local checks) |
| `--added-file PATH` | Treat PATH as added (repeatable) |
| `--exempt` | Skip the change-aware check for this run |
| `--json` | Emit a JSON summary |
| `--quiet` | Suppress the `OK:` line |

With no `--base` and no explicit files, only completeness runs.

## Exemption

A genuine no-documentation change can be exempted deliberately:

- a `Doc-Gate: exempt` line in any commit message in the `base..head` range, or
- `--exempt`, or
- `DOC_GATE_EXEMPT=1` in the environment.

The exemption **only** bypasses the change-aware check. Completeness still runs,
so an undocumented new artifact is never allowed through. An exempted run prints
a `NOTICE` line.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Documentation coverage is valid |
| `1` | One or more sources are missing documentation, changed without it, or need an index update |
| `2` | The map is missing/invalid, or the change set could not be computed |

## Output

Violations are printed to standard error, one per line:

```
MISSING/STALE: platforms/.../scripts/example.sh: requires an update to one of: docs/scripts/example.md
MISSING/STALE: new entry under rule 'scripts': requires an update to one of: docs/scripts/README.md
```

`--json` prints `{"ok", "checked", "changed", "exempt", "violations"}`.

## Self-test

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-doc-coverage-self-test.py
```

Builds temporary fixture trees and maps and proves the gate rejects a missing
page, a source change without its documentation, a skill change without its
README, a plugin change without its documentation, and a new script without its
index update, while accepting compliant changes, explicit additions, and the
`--exempt` bypass. It runs the real CLI, not a copy of the logic.

## Relationship to the other checks

- [`check-skill-docs.py`](check-skill-docs.md) validates skill metadata and
  usage-guide structure. The gate adds the same-commit requirement for skill
  changes.
- [`setup-git-hooks.sh`](setup-git-hooks.md) installs the pre-push hook that
  runs this gate before every push.

## Limitations

- The gate proves documentation changed, not that it is accurate; review quality
  remains a human responsibility.
- `git push --no-verify` bypasses the hook entirely, and the hook only compares
  against `origin/main` (falling back to `HEAD~1`).
- Untracked files are not considered; use `--added-file` in tests to simulate
  additions.
