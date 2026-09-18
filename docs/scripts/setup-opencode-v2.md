# `setup-opencode-v2.sh`

Deploys the OpenCode v2 (2.0.x) harness surface into an isolated v2 config
directory: the 16 skill bundles as symlinks, the four global commands, and the
starting `opencode.jsonc`/`cli.json`. Read-only verification is the default;
`--apply` writes. v1 is never modified — the target defaults to the pilot config
directory.

```bash
platforms/linux/ubuntu/computer-use/scripts/setup-opencode-v2.sh --verify-only
platforms/linux/ubuntu/computer-use/scripts/setup-opencode-v2.sh --apply
platforms/linux/ubuntu/computer-use/scripts/setup-opencode-v2.sh \
  --config-dir ~/.opencode-v2-pilot/config --apply
```

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--config-dir DIR` | `$OPENCODE_V2_CONFIG_DIR`, else `$OPENCODE_V2_PILOT_DIR/config`, else `~/.opencode-v2-pilot/config` | Target v2 config directory |
| `--allow-v1-config-dir` | off | Permit `--config-dir` to be `~/.config/opencode` |
| `--apply` | — | Link skills, deploy commands, seed missing configs |
| `--verify-only` | yes | Check only (default) |
| `-h`, `--help` | — | Show help |

`--apply` and `--verify-only` are mutually exclusive. Without
`--allow-v1-config-dir`, a `--config-dir` that resolves to `~/.config/opencode`
is refused with exit `2`: v1 stays untouched until the approved cutover.

## What it deploys

- **Skills (`skills/<name>`)** — one directory symlink per skill pointing at
  `computer-use/skills/<name>` in this checkout, so the repository stays the
  single source of truth and v2's file watcher sees repository edits. A target
  that is already a symlink to the canonical source is left untouched; a
  symlink to anywhere else, or a real file/directory at that name, is reported
  and never replaced.
- **Commands (`commands/<name>.md`)** — the four global commands are
  content-aware copies, byte-identical checks skip, symbolic-link targets are
  refused.
- **Config (`opencode.jsonc`, `cli.json`)** — seeded from
  `config/v2-opencode.example.jsonc` and `config/v2-cli.example.json` only when
  the target file does not exist. The reference-checkout path in the examples
  is rewritten to this repository's root, full-line `//` comments are stripped,
  and the result is written atomically as strict JSON. An existing config is
  never overwritten or merged.

## Verification

The parity pass reports one line per item (`OK: skill link ...`,
`OK: command /... deployed`, `OK: config valid: ...`), then runs
[`verify-opencode-v2.sh`](verify-opencode-v2.md) with
`OPENCODE_V2_CONFIG_DIR="$CONFIG_DIR"` for the pilot health check (binary,
skills/commands counts, MCP declarations, plugin registrations, aura theme).
The script exits non-zero if any parity or health check fails.

A freshly seeded config declares both `github` and the single live `playwright`
MCP, so the delegated check reports `exactly one playwright MCP declared`. The
running pilot intentionally declares no Playwright MCP until cutover and prints
the health check's `NOTICE` instead.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Verification passed, or apply plus verification passed |
| `1` | A required source is missing, or parity/health verification failed |
| `2` | Invalid usage, an empty `--config-dir`, or the v1 config directory without `--allow-v1-config-dir` |

## Side effects to expect

- Symlinks and command copies are idempotent; re-running `--apply` reports no
  changes when everything is current.
- Configs are seeded once. Changing the repository examples does not update an
  existing deployed config; translate changes by hand or delete the config to
  reseed it (the file is user-owned).
- Restart OpenCode after deploying so changed skills and commands load.

## Related

- [`verify-opencode-v2.md`](verify-opencode-v2.md) — the pilot health check this
  script delegates to.
- [`deploy-plugins.md`](deploy-plugins.md) — registers the plugins-v2 packages
  with `--v2`.
- [`setup-opencode.md`](setup-opencode.md) — the v1 counterpart.
