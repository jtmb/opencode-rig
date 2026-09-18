# `deploy-plugins.sh`

Deploys the local OpenCode plugins to an OpenCode installation, and optionally
copies the bootstrap scripts into the target. It is the engine behind the
[`/deploy` command](../plugins/README.md) and is also directly runnable.

Registration **references this checkout** with `file://` URLs; it does not copy
the plugin sources. Existing plugin entries and their options are preserved.

```bash
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope global --verify-only
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope global --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope project --project ~/repos/example --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope project --project . --bootstrap --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope global --plugins source-control --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope global --plugins all --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --scope global --plugins codex-fallback --chain a/b,c/d --apply
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--scope global\|project` | required | Deploy to the user's global config or one repository |
| `--project DIR` | required for `project` | Target repository; `.opencode/` is created inside it |
| `--plugins both\|all\|source-control\|tui-settings\|file-manager\|codex-usage\|codex-fallback` | `both` | Which plugins to register; `both` preserves the Codex pair and `all` includes source-control, tui-settings, and file-manager |
| `--bootstrap` | off | Also copy `computer-use/scripts/` into the target |
| `--chain a/b,c/d` | — | `defaultChain` written when adding `codex-fallback` |
| `--apply` | — | Write changes |
| `--verify-only` | yes | Check only (default) |
| `-h`, `--help` | — | Show help |

`--apply` and `--verify-only` are mutually exclusive. Missing `--scope`, a
missing or non-directory `--project`, or an unknown `--plugins` value exits `2`.

## Targets

| Scope | Plugin | Config file | Key |
|-------|--------|-------------|-----|
| global | `codex-usage` (TUI) | `~/.config/opencode/tui.json` (or `.jsonc` if present) | `plugin` |
| global | `codex-fallback` (server) | `~/.config/opencode/opencode.jsonc`, else `opencode.json` | `plugin` |
| project | `codex-usage` (TUI) | `<repo>/.opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |
| project | `codex-fallback` (server) | `<repo>/.opencode/opencode.json` | `plugin` |
| global | `source-control` (TUI) | `~/.config/opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |
| project | `source-control` (TUI) | `<repo>/.opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |
| global | `tui-settings` (TUI) | `~/.config/opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |
| project | `tui-settings` (TUI) | `<repo>/.opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |
| global | `file-manager` (TUI) | `~/.config/opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |
| project | `file-manager` (TUI) | `<repo>/.opencode/tui.json` (or `tui.jsonc` if present) | `plugin` |

Entries written:

```json
"file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/codex-usage/src/tui.tsx"
```

```json
[
  "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/codex-fallback/src/index.ts",
  { "defaultChain": ["provider/model"] }
]
```

```json
[
  "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/source-control/src/tui.tsx",
  { "github": true }
]
```

```json
[
  "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/tui-settings/src/tui.tsx",
  { "order": 10 }
]
```

```json
[
  "file:///home/james/repos/opencode-rig/platforms/linux/ubuntu/computer-use/plugins/file-manager/src/tui.tsx",
  { "order": 60 }
]
```

The `codex-fallback` entry is written as a plain string unless `--chain` is
given (or an entry already exists). A bare entry means an empty chain, so the
router is **inactive** until `defaultChain` is configured. The script prints a
notice when that is the case.

## How registration works

- **Deduplication.** Before adding, the script scans the existing `plugin`
  array. Each entry (string, or `[spec, options]` tuple) is resolved to a real
  path — `file://` prefix stripped, relative specs resolved against the config
  file's directory — and compared with the canonical plugin module. A match is
  left untouched, so the script is idempotent and never clobbers user options.
- **Non-destructive merge.** Only the entry is added; the rest of the file is
  left as-is. The file is written through a temp file in the same directory and
  `os.replace`, preserving the existing file mode. A file is only rewritten when
  something actually changes.
- **Creation.** A missing config is created with the correct `$schema`
  (`https://opencode.ai/tui.json` or `https://opencode.ai/config.json`).
- **Comment safety.** The script parses targets as plain JSON. A config that
  contains JSONC comments cannot be parsed, so the script refuses to touch it
  and reports `MISSING/STALE` with a "(comments?)" hint rather than rewriting a
  user's file and losing comments. Consolidate or remove comments to let the
  script manage that file, or add the entry by hand.

The source-control TUI entry is written as a tuple with `{ "github": true }`
so the optional read-only GitHub row is explicitly enabled. Its MCP child
calculates an adaptive memory budget at runtime; deployment does not write a
machine-specific byte limit.

The tui-settings TUI entry is written with `{ "order": 10 }` so the settings
row defaults to the top of the sidebar. The overlay can later move it, and
source-control, through the `local.tui-settings.order` and
`local.source-control.order` kv keys, which apply at the next restart.

The file-manager TUI entry is written with `{ "order": 60 }` so the `Explorer`
row sits below Source Control and above the built-in context panel.

## Bootstrap script copy (`--bootstrap`)

Copies every regular file under `computer-use/scripts/` into:

- project: `<repo>/.opencode/scripts/`
- global: `~/.config/opencode/scripts/`

The copy is verbatim and content-aware: a file whose bytes already match is
skipped, copies preserve mode with `cp -p`, symbolic-link sources are refused,
and `__pycache__` is excluded. The copy includes `deploy-plugins.sh` itself.

> **Limitation.** The scripts resolve paths relative to their own location
> (`setup-computer-assistant.sh` walks up to the `platforms/linux/ubuntu`
> component tree; `setup-opencode.sh` expects sibling `skills/` and `commands/`).
> A copied `scripts/` directory is therefore a working reference copy, but
> end-to-end provisioning still runs from the canonical checkout. The script
> prints this caveat whenever `--bootstrap` is used.

## Verification

`--verify-only` (and the post-`--apply` verification pass) reports one line per
item:

- `OK: <plugin> plugin registered in <path>` — the module is present.
- `MISSING/STALE: <plugin> plugin not registered in <path>` — absent.
- `MISSING/STALE: <plugin> config is not editable JSON (comments?)` — present
  but not safely editable.
- `OK: bootstrap scripts current in <dest>` — every source file is present and
  byte-identical.

`--apply` writes, then runs the same verification. The script exits non-zero if
any requested item is still missing, so it is usable as a gate.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Verification passed, or apply plus verification passed |
| `1` | A plugin is missing, a config is not editable, or the bootstrap copy is incomplete; also used for a missing plugin entrypoint |
| `2` | Invalid usage (missing `--scope`, bad `--project`, unknown `--plugins`, conflicting mode flags) |

## Side effects to expect

- Registration changes take effect only after OpenCode restarts.
- When a project `.opencode/` directory contains `plugin` entries, OpenCode
  itself installs `@opencode-ai/plugin` into that directory on startup, creating
  `package.json`, a lockfile, `node_modules/`, and a `.gitignore`. The deploy
  script does not create these; OpenCode does. Add them to the target repo's
  `.gitignore` if they should not be committed.
- Deployment is not reversible by this script. Remove the `file://` entry (and
  copied scripts, if any) by hand to undeploy.

## Related

- [`docs/plugins/README.md`](../plugins/README.md#deploying-the-plugins) — the
  `/deploy` command and the plugin registration model.
- [`setup-opencode.md`](setup-opencode.md) — deploys skills and global commands.
