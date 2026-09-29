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
and writes server roles to `opencode.jsonc` and CLI roles to `cli.json`. The
catalog contains thirteen packages; `ponytail-adapter` is the server-only role
for the pinned official Ponytail workspace dependency, and `chatgpt-connector`
is the server role for the local ChatGPT OAuth MCP. Run
`setup-plugin-dependencies.sh --verify-only` (or let setup/bootstrap apply it)
before loading the Ponytail runtime. Package
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
`session.permissions: "prompt"` and `attention.sound: false`. The prompt setting
keeps rig-tools approval gates interactive. Disabling attention sounds avoids
the OpenTUI native ALSA path tracked upstream as OpenCode issue `#41763`, whose
fd-2 diagnostics can overwrite a TUI on hosts without a usable sound device.
System notifications remain independently configurable. The script preserves
other CLI settings and writes only the selected isolated config directory.
Verify-only never writes. When apply adds an entry or normalizes these settings it atomically writes
canonical pretty-printed JSON, intentionally removing comments and normalizing
whitespace; comment markers inside strings remain data. Malformed or duplicate
keys fail closed. The retirement procedure below covers its separate two-config operation.

## Retire `integrated-browser`

For the selected default profile, both configs are under `~/.config/opencode`.
Run verify-only first: it is read-only and exits 1 while registrations remain.
It refuses symlinked config paths/ancestors. Compare the digest-only output to
the approved preimages; stop if either target or hash differs:

```bash
set -euo pipefail
sha256sum -- "$HOME/.config/opencode/opencode.jsonc" "$HOME/.config/opencode/cli.json"
config="$HOME/.config/opencode"
deploy=./platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh
if report="$("$deploy" --config-dir "$config" --cli-config "$config/cli.json" --retire-integrated-browser --verify-only 2>&1)"; then
  printf '%s\n' "$report"
  retirement_ready=0
else
  verify_status=$?
  printf '%s\n' "$report"
  expected="$(printf 'MISSING/STALE: 1 canonical integrated-browser registration(s) remain in %s/opencode.jsonc (rerun with --apply to retire)\nMISSING/STALE: 1 canonical integrated-browser registration(s) remain in %s/cli.json (rerun with --apply to retire)' "$config" "$config")"
  [[ "$verify_status" -eq 1 && "$report" == "$expected" ]] || exit "$verify_status"
  retirement_ready=1
fi
```

Only the exact expected exit-1 report (one entry in each file) sets
`retirement_ready=1`; a clean result prevents apply, and other nonzero reports
are rejected. Diagnostics are printed before the decision.

Review the expected canonical entries, then save owner-only preimages. Run this
preflight, backup, and guarded apply block in the same Bash shell; the backup
block fails closed unless the exact expected drift was verified:

```bash
set -euo pipefail
: "${retirement_ready:?Run the checked preflight in this Bash shell first}"
[[ "$retirement_ready" == "1" ]] || exit 1
config="$HOME/.config/opencode"
uid="$(id -u)"
for dir in "$HOME" "$HOME/.config" "$config"; do
  [[ -d "$dir" && ! -L "$dir" && "$(stat -c '%u' "$dir")" == "$uid" ]] || exit 1
  mode="$(stat -c '%a' "$dir")"
  (( (8#$mode & 0022) == 0 )) || exit 1
done
for file in opencode.jsonc cli.json; do
  [[ -f "$config/$file" && ! -L "$config/$file" && "$(stat -c '%u' "$config/$file")" == "$uid" ]] || exit 1
done
unset backup server_mode cli_mode
server_mode="$(stat -c '%a' "$config/opencode.jsonc")"
cli_mode="$(stat -c '%a' "$config/cli.json")"
umask 077
backup="$(mktemp -d "$config/retirement.XXXXXX")"
[[ -d "$backup" && ! -L "$backup" && "$(stat -c '%u:%a' "$backup")" == "$uid:700" ]] || exit 1
(cd "$config" && sha256sum -- opencode.jsonc cli.json) | tee "$backup/SHA256SUMS"
install -m 600 -- "$config/opencode.jsonc" "$backup/opencode.jsonc"
install -m 600 -- "$config/cli.json" "$backup/cli.json"
for file in opencode.jsonc cli.json SHA256SUMS; do
  [[ -f "$backup/$file" && ! -L "$backup/$file" && "$(stat -c '%u:%a' "$backup/$file")" == "$uid:600" ]] || exit 1
done
(cd "$backup" && sha256sum --check SHA256SUMS)
```

The manifest contains digests and filenames only. Review them against the
approved preimages. The apply block fails closed unless the owner-only backup
and live files pass the path, ownership, mode, and preimage checks:

```bash
set -euo pipefail
: "${retirement_ready:?Run the checked preflight in this Bash shell first}"
[[ "$retirement_ready" == "1" ]] || exit 1
: "${deploy:?Run the checked preflight in this Bash shell first}"
: "${config:?Run the backup block in this Bash shell first}"
: "${backup:?Run the backup block successfully in this Bash shell first}"
: "${server_mode:?Run the backup block successfully in this Bash shell first}"
: "${cli_mode:?Run the backup block successfully in this Bash shell first}"
uid="$(id -u)"
for dir in "$HOME" "$HOME/.config" "$config"; do
  [[ -d "$dir" && ! -L "$dir" && "$(stat -c '%u' "$dir")" == "$uid" ]] || exit 1
  mode="$(stat -c '%a' "$dir")"
  (( (8#$mode & 0022) == 0 )) || exit 1
done
[[ "$backup" == "$config"/retirement.* && -d "$backup" && ! -L "$backup" && "$(stat -c '%u:%a' "$backup")" == "$uid:700" ]] || exit 1
for file in opencode.jsonc cli.json; do
  [[ -f "$config/$file" && ! -L "$config/$file" && "$(stat -c '%u' "$config/$file")" == "$uid" ]] || exit 1
done
[[ "$(stat -c '%a' "$config/opencode.jsonc")" == "$server_mode" && "$(stat -c '%a' "$config/cli.json")" == "$cli_mode" ]] || exit 1
for file in opencode.jsonc cli.json SHA256SUMS; do
  [[ -f "$backup/$file" && ! -L "$backup/$file" && "$(stat -c '%u:%a' "$backup/$file")" == "$uid:600" ]] || exit 1
done
(cd "$backup" && sha256sum --check SHA256SUMS) || exit 1
(cd "$config" && sha256sum --check "$backup/SHA256SUMS") || exit 1
"$deploy" \
  --config-dir "$config" \
  --cli-config "$config/cli.json" \
  --retire-integrated-browser --apply
```

Run the verify-only command again; it should report both files clean. Each file
is replaced atomically, but the pair is not a transaction: interruption can
leave only one updated. Apply serializes JSON and drops JSONC comments. Rollback
restores contents and modes, not timestamps or ACLs, and is sequential and
non-atomic too. Restore only after checking there are no later edits to preserve;
if interrupted, finish both restores and reverify:

```bash
set -euo pipefail
: "${backup:?Use the verified preimage backup}"
: "${config:?Use the same Bash shell as the backup block}"
: "${server_mode:?Use the recorded preimage mode}"
: "${cli_mode:?Use the recorded preimage mode}"
uid="$(id -u)"
for dir in "$HOME" "$HOME/.config" "$config"; do
  [[ -d "$dir" && ! -L "$dir" && "$(stat -c '%u' "$dir")" == "$uid" ]] || exit 1
  mode="$(stat -c '%a' "$dir")"
  (( (8#$mode & 0022) == 0 )) || exit 1
done
[[ "$backup" == "$config"/retirement.* && -d "$backup" && ! -L "$backup" && "$(stat -c '%u:%a' "$backup")" == "$uid:700" ]] || exit 1
for file in opencode.jsonc cli.json SHA256SUMS; do
  [[ -f "$backup/$file" && ! -L "$backup/$file" && "$(stat -c '%u:%a' "$backup/$file")" == "$uid:600" ]] || exit 1
done
for file in opencode.jsonc cli.json; do
  [[ -f "$config/$file" && ! -L "$config/$file" && "$(stat -c '%u' "$config/$file")" == "$uid" ]] || exit 1
done
(cd "$backup" && sha256sum --check SHA256SUMS) || exit 1
install -m "$server_mode" -- "$backup/opencode.jsonc" "$config/opencode.jsonc"
install -m "$cli_mode" -- "$backup/cli.json" "$config/cli.json"
(cd "$config" && sha256sum --check "$backup/SHA256SUMS")
stat -c '%a %n' "$config/opencode.jsonc" "$config/cli.json"
```

Script success verifies config files only, not the loaded service. Do not restart
while child work remains active. Once connector and policy source are integrated,
combine retirement with any required `wsl_browser_*` registration before one
restart of the service identified by the selected profile's registry—not the
separate pilot launcher. Verify service identity and loaded plugin status after;
deploy-script success never proves loaded plugin state.
