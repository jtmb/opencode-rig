# `setup-ponytail-plugin.sh`

Installs or verifies the official Ponytail package behind Open Rig's local
OpenCode v2 adapter. Verification is the default; `--apply` is the only mode
that changes the package, server config, timer, or OpenCode service.

## Upstream and V2 boundary

The source is [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)
and the package is
[`@dietrichgebert/ponytail`](https://www.npmjs.com/package/@dietrichgebert/ponytail).
The published `4.10.0` package is V1-only for OpenCode's plugin API, so this
script installs package data for
[`ponytail-adapter`](../../platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter/README.md),
not the upstream plugin entrypoint itself.

## Commands

```bash
# Read-only package/config/timer/runtime check (default mode).
./platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin.sh --verify-only

# Download the latest published version, verify it, activate it, enable the
# daily timer, and restart OpenCode if activation changed anything.
./platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin.sh --apply

# Apply without installing or requiring the daily timer, and without a restart.
./platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin.sh \
  --apply --no-timer --no-restart
```

Useful flags:

| Flag | Meaning |
|---|---|
| `--config-dir DIR` | v2 config directory; defaults to `$OPENCODE_V2_CONFIG_DIR`, then the pilot config, then `~/.opencode-v2-pilot/config` |
| `--install-root DIR` | Version store; defaults to `$PONYTAIL_INSTALL_ROOT` or `~/.local/opt/opencode-ponytail` |
| `--apply` | Perform the staged install/update and config/timer changes |
| `--verify-only` | Read-only verification; this is the default |
| `--timer` / `--no-timer` | Require/install the daily timer or skip timer management |
| `--restart` / `--no-restart` | Restart and verify OpenCode after a changed activation, or leave it running |

The script refuses empty or whitespace/control-character paths, a missing
executable v2 binary, a missing bounded runner/runtime verifier, missing npm,
or a missing `flock`. It serializes updates with a per-user `flock -w 30`.

## Exact bounded install/update safety

Every npm and runtime operation goes through
`platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh`:

| Operation | Memory | Swap | Timeout | Lock wait |
|---|---:|---:|---:|---:|
| `npm view @dietrichgebert/ponytail@latest version` | 20% | 5% | 2 min | 30 sec |
| npm staging install | 30% | 10% | 10 min | 30 sec |
| staged package runtime probe | 35% | 10% | 10 min | 30 sec |
| existing-package verify-only probe | 30% | 10% | 10 min | 30 sec |

The latest value must be a semver string. A candidate and every managed
`package.json` must be a regular non-symlink file no larger than 256 KiB with
the exact package name and expected version. The install uses:

```text
npm install --ignore-scripts --no-audit --no-fund --prefix <staging> @dietrichgebert/ponytail@<version>
```

Lifecycle scripts are disabled deliberately. The candidate is runtime-verified
before it is moved into `versions/<version>`. Activation creates a temporary
symlink and uses `mv -Tf` to replace `current`; the config update uses a
temporary file, `fsync`, and atomic replacement. An existing config is backed
up before modification. The adapter registration is rejected if it appears
more than once.

When activation changes the package/config, the script restarts the isolated
v2 service with `OPENCODE_DISABLE_AUTOUPDATE=1` and checks `opencode plugin
list` for an active `ponytail` entry. If that check fails, it restores the prior
`current` target and config backup, then attempts one more restart before
reporting failure.

## Private mock-provider verification

The runtime verifier uses a temporary HOME and XDG data/cache/state
directories, starts OpenCode on a random `127.0.0.1` port, and serves a local
OpenAI-compatible mock that always returns `OK`. Its API key is the test value
`test`; no real credentials or provider endpoint are read. It verifies:

1. the v2 adapter reaches `active`;
2. the current package contributes six Ponytail commands and six skills;
3. `ultra` injects the expected instructions;
4. another session retains its independent default;
5. `off` suppresses injection; and
6. the selected mode remains `off` after an OpenCode server restart.

The setup script invokes the verifier through the bounded runner after staging
and again in verify-only mode. The adapter's package check is also available:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter run check
python3 platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin-self-test.py
```

The self-test uses disposable package/config fixtures and a failing fake v2
service to prove that activation failure restores the exact prior symlink,
config bytes, and file mode without touching the live installation.

## Daily update timer

By default `--apply` writes and enables these user units:

```text
~/.config/systemd/user/opencode-ponytail-update.service
~/.config/systemd/user/opencode-ponytail-update.timer
```

The timer runs `OnCalendar=daily`, adds a randomized delay of up to six hours,
and is persistent. The service has a 20-minute timeout, 1024 MiB memory cap,
128 MiB swap cap, 256-task cap, 200% CPU quota, `Nice=10`,
`NoNewPrivileges=true`, `PrivateTmp=true`, `RestrictSUIDSGID=true`, and only
Unix/IPv4/IPv6 address families.

Inspect it with:

```bash
systemctl --user status opencode-ponytail-update.timer
systemctl --user list-timers opencode-ponytail-update.timer
systemctl --user is-enabled opencode-ponytail-update.timer
```

`--no-timer` skips timer management for that invocation; it does not remove a
timer that was already installed.

## Status, rollback, disable, and uninstall

Set the same paths used by the installer when using the manual commands below:

```bash
PILOT="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}"
CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-$PILOT/config}"
INSTALL_ROOT="${PONYTAIL_INSTALL_ROOT:-$HOME/.local/opt/opencode-ponytail}"
BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
CURRENT="$INSTALL_ROOT/current"
```

**Status** — run the read-only check and inspect the active link/plugin:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin.sh \
  --config-dir "$CONFIG_DIR" --install-root "$INSTALL_ROOT" --verify-only
readlink "$CURRENT"
OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
  XDG_DATA_HOME="$PILOT/data" XDG_STATE_HOME="$PILOT/state" XDG_CACHE_HOME="$PILOT/cache" \
  "$BIN" plugin list
```

**Rollback** — choose a previously verified directory under `versions/`, save
the current target, switch the managed symlink atomically, and restart:

```bash
GOOD_VERSION="<previous-verified-version>"
test -L "$CURRENT"
test -d "$INSTALL_ROOT/versions/$GOOD_VERSION/node_modules/@dietrichgebert/ponytail"
OLD_TARGET="$(readlink "$CURRENT")"
ROLLBACK_LINK="$INSTALL_ROOT/.ponytail-rollback.$$"
ln -s "versions/$GOOD_VERSION" "$ROLLBACK_LINK"
mv -Tf "$ROLLBACK_LINK" "$CURRENT"
OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
  XDG_DATA_HOME="$PILOT/data" XDG_STATE_HOME="$PILOT/state" XDG_CACHE_HOME="$PILOT/cache" \
  OPENCODE_DISABLE_AUTOUPDATE=1 "$BIN" service restart
```

If the restarted plugin is not healthy, restore the saved target with the same
atomic pattern:

```bash
RESTORE_LINK="$INSTALL_ROOT/.ponytail-restore.$$"
ln -s "$OLD_TARGET" "$RESTORE_LINK"
mv -Tf "$RESTORE_LINK" "$CURRENT"
```

**Disable** — `/ponytail off` disables injection only for the current session.
To stop automatic updates while retaining installed versions:

```bash
systemctl --user disable --now opencode-ponytail-update.timer
```

To disable the plugin for the v2 installation, first back up
`"$CONFIG_DIR/opencode.jsonc"`, remove the object whose `package` is the
adapter's absolute path, and restart OpenCode. Use a JSONC-aware editor rather
than `sed`; `--no-timer` alone does not remove an existing unit.

```bash
"${EDITOR:-nano}" "$CONFIG_DIR/opencode.jsonc"
OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
  XDG_DATA_HOME="$PILOT/data" XDG_STATE_HOME="$PILOT/state" XDG_CACHE_HOME="$PILOT/cache" \
  OPENCODE_DISABLE_AUTOUPDATE=1 "$BIN" service restart
```

**Uninstall** — stop and remove the user units, remove the adapter object from
the config, restart OpenCode, then remove only the managed version store after
checking the path:

```bash
systemctl --user disable --now opencode-ponytail-update.timer opencode-ponytail-update.service || true
rm -f -- "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/opencode-ponytail-update.service" \
        "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/opencode-ponytail-update.timer"
systemctl --user daemon-reload
"${EDITOR:-nano}" "$CONFIG_DIR/opencode.jsonc"
OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
  XDG_DATA_HOME="$PILOT/data" XDG_STATE_HOME="$PILOT/state" XDG_CACHE_HOME="$PILOT/cache" \
  OPENCODE_DISABLE_AUTOUPDATE=1 "$BIN" service restart
```

After removing the adapter entry and restarting, delete the default install
root only when it is exactly the expected directory:

```bash
case "$INSTALL_ROOT" in
  "$HOME/.local/opt/opencode-ponytail") rm -rf -- "$INSTALL_ROOT" ;;
  *) printf 'Refusing unexpected install root: %s\n' "$INSTALL_ROOT" >&2; exit 2 ;;
esac
```

No repository source, test, package manifest, ledger, commit, or remote push is
part of this lifecycle.
