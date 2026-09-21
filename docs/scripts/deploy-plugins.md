# `deploy-plugins.sh`

Registers the repository's OpenCode v2 packages in an isolated config directory.
Verification is the default; `--apply` writes atomically and preserves existing
entries and options.

```bash
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --plugins all --verify-only
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --config-dir ~/.opencode-v2-pilot/config --plugins all --apply
./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh --config-dir ~/.opencode-wsl2-pilot/config --cli-config ~/.opencode-wsl2-pilot/xdg/opencode/cli.json --plugins all --apply
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `--config-dir DIR` | `$OPENCODE_V2_CONFIG_DIR`, then `$OPENCODE_V2_PILOT_DIR/config`, then `~/.opencode-v2-pilot/config` | v2 config directory |
| `--cli-config FILE` | `DIR/cli.json` | Explicit CLI config path for an isolated profile with a separate XDG root |
| `--plugins LIST` | `both` | `both`, `all`, `server`, `cli`, or one catalog package |
| `--chain a/b,c/d` | — | `defaultChain` for `codex-fallback` |
| `--apply` | — | Write changes, then verify |
| `--verify-only` | yes | Read-only verification |

The script reads `config/v2-plugin-roles.json`, validates every selected package,
and writes server roles to `opencode.jsonc` and CLI roles to `cli.json`. Package
paths are canonical absolute paths. Existing entries are deduplicated and left
unchanged; malformed, duplicate, or non-canonical config is reported without
rewriting it. JSONC comments and trailing commas are accepted safely. A missing
config is created with its schema.

`both` selects the Codex usage/fallback pair. `all` selects every catalog package;
`server` and `cli` select roles. A fallback without `defaultChain` is reported as
inactive. Run the disposable regression suite with:

```bash
platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh -- \
  python3 platforms/linux/ubuntu/computer-use/scripts/deploy-plugins-self-test.py
```

When `rig-tools` is selected, the CLI config must have
`session.permissions: "prompt"`; apply sets only that field because rig-tools
gates require interactive approval, preserving other CLI settings. The script
writes only the selected isolated config directory. Verify-only never writes.
When apply adds an entry or normalizes permissions it atomically writes
canonical pretty-printed JSON, intentionally removing comments and normalizing
whitespace; comment markers inside strings remain data. Malformed or duplicate
keys fail closed. Restart OpenCode after registration changes.
