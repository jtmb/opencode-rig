# `setup-opencode.sh`

Persists `OPENCODE_ENABLE_EXA` so a plain `opencode` invocation always gets it,
and deploys the repository's skills, global commands, and custom tools into the
user's OpenCode configuration. It is the canonical deployment path; the
`/promote-skills` command and `setup-computer-assistant.sh` both call it.

```bash
# Verify by default (no changes)
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only

# Apply
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply
OPENCODE_ENABLE_EXA=0 ./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply --value 1
```

## Options

| Option | Effect |
|--------|--------|
| `--verify-only` | Read-only verification (default) |
| `--apply` | Write changes and then verify |
| `--value 0\|1` | Value for the export; overrides the environment |
| `OPENCODE_ENABLE_EXA=0\|1` | Environment fallback for the value |

`--verify-only` and `--apply` are mutually exclusive. The value must be exactly
`0` or `1`, or the script exits `2`. Any unknown argument is a usage error.

## Paths

| Role | Path |
|------|------|
| Skill sources | `platforms/linux/ubuntu/computer-use/skills/<name>/` |
| Skill destination | `~/.config/opencode/skills/<name>/` |
| Command sources | `platforms/linux/ubuntu/computer-use/commands/` |
| Command destination | `~/.config/opencode/commands/` |
| Tool sources | `platforms/linux/ubuntu/computer-use/tools/<name>.ts` |
| Tool destination | `~/.config/opencode/tools/<name>.ts` |
| Shell files | `~/.bashrc` and `~/.zshrc` (if present) |

## Export management

`ensure_export()` edits a shell rc file:

- If `export OPENCODE_ENABLE_EXA=` is already present with the exact desired
  line, it reports `OK` and changes nothing.
- If it is present with a different value, it updates it in place with `sed`.
- If it is absent, it appends a managed block:

  ```sh
  # opencode (managed by setup-opencode.sh)
  export OPENCODE_ENABLE_EXA=1
  ```

`verify()` checks the exact line in each existing rc file and fails if it is
missing or stale.

## Skill, command, and tool deployment

### Required sources

`setup-opencode.sh` refuses to proceed if a required skill, command, or tool
source is missing. The required skills are:

```
app-setup  blender  browser-assistant  browser-headless  desktop-control
desktop-vision  files-and-documents  game-playtest  github-operations
opencode-db-maintenance  routine-automation  skill-maintenance
system-troubleshooting  task-memory  vscode-management  web-3d-asset-pipeline
```

The required commands are `deploy`, `handoff`, `promote-skills`, and `resume`.
The required custom tools are `desktop` (`tools/desktop.ts`).

### `ensure_skill()`

For each skill directory:

1. Refuses if the source path is a symbolic link.
2. Refuses if the source bundle contains any symbolic link.
3. Calls `check_destination()`: refuses if the destination path is a symlink or
   if the deployed bundle contains a preserved symlink.
4. Creates the destination and walks every source file:
   - Computes the path relative to the skill root.
   - Skips the copy when the destination exists and `cmp -s` reports identical
     content (so timestamps are preserved and no needless write occurs).
   - Otherwise copies with `cp -p` and reports it.
5. Reports `OK: complete skill bundle <name> deployed`.

This is a content-aware, file-by-file deployment: extra files already present
in the destination are **not** deleted, and a rename in the source shows up as a
new file plus an `EXTRA` warning during verification rather than a silent
removal.

### `ensure_commands()`

The same guards apply to the command source and destination directories, then
each required command Markdown file is copied content-aware into
`~/.config/opencode/commands/<name>.md`.

### `ensure_tools()`

The same symbolic-link guards apply to the tool source and destination paths,
then each `REQUIRED_TOOLS` entry is copied content-aware into
`~/.config/opencode/tools/<name>.ts`. Only the explicit top-level `.ts` files
are deployed; the package's `node_modules/` and tests stay in the repository.
OpenCode discovers the deployed files by filename at startup, which is why a
restart is required after a tool change.

## Verification semantics

`verify()` returns a status flag and prints one line per finding:

- `OK:` — deployed and matching.
- `MISSING/STALE:` — the source file is absent from the destination or differs,
  or the export line is missing. These fail verification. The check covers
  skills, commands, and custom tools.
- `EXTRA:` — a deployed file has no source counterpart. This is reported and
  fails verification so it is reviewed, but `--apply` will not delete it.
- `INVALID:` — a symbolic link was found where one is not allowed.

It also prints the detected `opencode --version`. Note that it does **not**
verify OpenCode's runtime discovery of the skills; run `opencode debug skill`
for that. Custom tools have no equivalent debug listing and are confirmed by a
fresh OpenCode process.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Verification passed (or apply + verify passed) |
| `1` | Verification found missing, stale, extra, or invalid entries |
| `2` | Invalid arguments or value |

## Notes and limitations

- **Never edit deployed copies directly.** Change the source under
  `computer-use/skills/`, `computer-use/commands/`, or `computer-use/tools/`,
  then re-run `--apply`.
- Changing skills, commands, tools, or the export requires restarting OpenCode.
- The command and tool lists are explicit (`REQUIRED_COMMANDS`,
  `REQUIRED_TOOLS`); adding a new command or tool source file requires adding it
  to the list here, and updating this document and the component README.
- The script is idempotent: a second `--apply` with no source changes reports
  every bundle `OK` and performs no copies.
- Related: [`check-skill-docs.md`](check-skill-docs.md) validates the skill
  documentation that this script deploys.
