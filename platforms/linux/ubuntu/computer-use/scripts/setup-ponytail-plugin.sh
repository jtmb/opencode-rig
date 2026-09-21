#!/usr/bin/env bash
# Install and keep the official Ponytail package current behind Open Rig's v2 adapter.
set -euo pipefail

APPLY=0
MODE_SET=0
ENABLE_TIMER=1
RESTART=1
PILOT="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}"
CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-$PILOT/config}"
INSTALL_ROOT="${PONYTAIL_INSTALL_ROOT:-$HOME/.local/opt/opencode-ponytail}"
BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"

usage() {
  cat <<'EOF'
Usage: setup-ponytail-plugin.sh [options] [--apply|--verify-only]

Install the latest official @dietrichgebert/ponytail package with lifecycle
scripts disabled, verify it against an isolated OpenCode v2 server and local
mock model, then atomically activate it through Open Rig's v2 adapter.

Options:
  --config-dir DIR    OpenCode v2 config directory
  --install-root DIR  Versioned Ponytail package directory
  --apply             Install/update and configure Ponytail
  --verify-only       Check package, adapter, config, and timer (default)
  --timer             Install/verify the daily user update timer (default)
  --no-timer          Do not install or require the timer
  --restart           Restart and verify OpenCode after a change (default)
  --no-restart        Apply files without restarting OpenCode
  -h, --help          Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config-dir) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; CONFIG_DIR="$2"; shift 2 ;;
    --config-dir=*) CONFIG_DIR="${1#*=}"; shift ;;
    --install-root) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; INSTALL_ROOT="$2"; shift 2 ;;
    --install-root=*) INSTALL_ROOT="${1#*=}"; shift ;;
    --apply) [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }; APPLY=1; MODE_SET=1; shift ;;
    --verify-only) [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }; APPLY=0; MODE_SET=1; shift ;;
    --timer) ENABLE_TIMER=1; shift ;;
    --no-timer) ENABLE_TIMER=0; shift ;;
    --restart) RESTART=1; shift ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTER_DIR="$COMPUTER_USE_ROOT/plugins-v2/ponytail-adapter"
RUNTIME_VERIFIER="$ADAPTER_DIR/scripts/verify-runtime.mjs"
RUNNER="$SCRIPT_DIR/run-bounded-command.sh"
JSONC_READER="$SCRIPT_DIR/setup-opencode-jsonc.py"
SERVER_CONFIG="$CONFIG_DIR/opencode.jsonc"
VERSIONS="$INSTALL_ROOT/versions"
CURRENT="$INSTALL_ROOT/current"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_UNIT="$UNIT_DIR/opencode-ponytail-update.service"
TIMER_UNIT="$UNIT_DIR/opencode-ponytail-update.timer"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
LOCK="$RUNTIME_DIR/opencode-ponytail-update-${UID}.lock"
NPM_BIN="${PONYTAIL_NPM_BIN:-$(command -v npm || true)}"
SYSTEMCTL_BIN="${PONYTAIL_SYSTEMCTL_BIN:-$(command -v systemctl || true)}"

ok() { printf 'OK: %s\n' "$*"; }
fail() { printf 'MISSING/STALE: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

case "$CONFIG_DIR:$INSTALL_ROOT" in *$'\n'*|*$'\r'*) die "paths contain an unsafe control character" ;; *[[:space:]]*) die "paths containing whitespace are not supported by the managed systemd unit" ;; esac
[ -n "$CONFIG_DIR" ] && [ -n "$INSTALL_ROOT" ] || die "paths must not be empty"
[ -x "$BIN" ] || die "OpenCode v2 binary is not executable: $BIN"
[ -x "$RUNNER" ] || die "bounded command runner is not executable: $RUNNER"
[ -f "$RUNTIME_VERIFIER" ] || die "Ponytail runtime verifier is missing: $RUNTIME_VERIFIER"
[ -f "$JSONC_READER" ] || die "strict JSONC reader is missing: $JSONC_READER"
[ -n "$NPM_BIN" ] && [ -x "$NPM_BIN" ] || die "npm is required"
command -v flock >/dev/null 2>&1 || die "flock is required"

exec 9>>"$LOCK"
flock -w 30 9 || die "timed out waiting for another Ponytail update"

latest_version() {
  local value
  value="$($RUNNER --memory-fraction 20 --swap-fraction 5 --timeout 2m --lock-timeout 30 -- "$NPM_BIN" view @dietrichgebert/ponytail@latest version)"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || die "npm returned an invalid Ponytail version: $value"
  printf '%s\n' "$value"
}

package_version() {
  local package="$1"
  python3 - "$package/package.json" <<'PY'
import json, os, stat, sys
path = sys.argv[1]
try:
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 262144:
        raise ValueError("unsafe package.json")
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("name") != "@dietrichgebert/ponytail" or not isinstance(data.get("version"), str):
        raise ValueError("wrong package identity")
    print(data["version"])
except (OSError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
PY
}

config_entry() {
  local mode="$1"
  python3 - "$SERVER_CONFIG" "$ADAPTER_DIR" "$CURRENT/node_modules/@dietrichgebert/ponytail" "$mode" "$JSONC_READER" <<'PY'
import hashlib, importlib.util, json, os, stat, sys, tempfile

path, adapter, package_root, mode, reader_path = sys.argv[1:]
adapter = os.path.realpath(adapter)
spec = importlib.util.spec_from_file_location("strict_jsonc", reader_path)
if spec is None or spec.loader is None:
    raise SystemExit("invalid JSONC reader")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

if os.path.lexists(path) and os.path.islink(path):
    raise SystemExit("refusing symlinked OpenCode config")
if os.path.exists(path):
    data = reader.load_jsonc(path)
else:
    data = {"$schema": "https://opencode.ai/config.json"}
if not isinstance(data, dict):
    raise SystemExit("OpenCode config must be an object")
entries = data.get("plugins")
if entries is None:
    entries = []
    data["plugins"] = entries
if not isinstance(entries, list):
    raise SystemExit("OpenCode plugins must be a list")

matches = []
for index, entry in enumerate(entries):
    if not isinstance(entry, dict) or not isinstance(entry.get("package"), str):
        continue
    candidate = entry["package"]
    if os.path.isabs(candidate) and os.path.realpath(candidate) == adapter:
        matches.append(index)
if len(matches) > 1:
    raise SystemExit("Ponytail adapter is configured more than once")
if matches:
    entry = entries[matches[0]]
    options = entry.get("options")
    if isinstance(options, dict) and options.get("packageRoot") == package_root:
        print("present")
        raise SystemExit(0)
    if mode != "apply":
        print("stale")
        raise SystemExit(0)
    entry["options"] = {**options, "packageRoot": package_root} if isinstance(options, dict) else {"packageRoot": package_root}
    result = "updated"
else:
    if mode != "apply":
        print("missing")
        raise SystemExit(0)
    entries.append({"package": adapter, "options": {"packageRoot": package_root}})
    result = "added"
directory = os.path.dirname(path)
os.makedirs(directory, mode=0o700, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".ponytail-config.", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600)
    os.replace(temporary, path)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
print(result)
PY
}

write_units() {
  mkdir -p "$UNIT_DIR"
  local temporary_service temporary_timer previous_service previous_timer service_existed=0 timer_existed=0
  temporary_service="$(mktemp "$UNIT_DIR/.opencode-ponytail-update.service.XXXXXX")"
  temporary_timer="$(mktemp "$UNIT_DIR/.opencode-ponytail-update.timer.XXXXXX")"
  previous_service="$(mktemp "$UNIT_DIR/.opencode-ponytail-update.service.previous.XXXXXX")"
  previous_timer="$(mktemp "$UNIT_DIR/.opencode-ponytail-update.timer.previous.XXXXXX")"
  trap 'rm -f -- "${temporary_service:-}" "${temporary_timer:-}" "${previous_service:-}" "${previous_timer:-}"' RETURN
  if [ -f "$SERVICE_UNIT" ]; then cp --preserve=mode,timestamps -- "$SERVICE_UNIT" "$previous_service"; service_existed=1; fi
  if [ -f "$TIMER_UNIT" ]; then cp --preserve=mode,timestamps -- "$TIMER_UNIT" "$previous_timer"; timer_existed=1; fi
  cat >"$temporary_service" <<EOF
[Unit]
Description=Update and verify the OpenCode Ponytail plugin
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$SCRIPT_DIR/setup-ponytail-plugin.sh --apply --config-dir=$CONFIG_DIR --install-root=$INSTALL_ROOT --no-timer
TimeoutStartSec=20min
MemoryMax=1024M
MemorySwapMax=128M
TasksMax=256
CPUQuota=200%
Nice=10
NoNewPrivileges=true
PrivateTmp=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
EOF
  cat >"$temporary_timer" <<'EOF'
[Unit]
Description=Keep the OpenCode Ponytail plugin up to date

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true
Unit=opencode-ponytail-update.service

[Install]
WantedBy=timers.target
EOF
  chmod 0644 "$temporary_service" "$temporary_timer"
  mv -f -- "$temporary_service" "$SERVICE_UNIT"
  mv -f -- "$temporary_timer" "$TIMER_UNIT"
  "$SYSTEMCTL_BIN" --user daemon-reload
  "$SYSTEMCTL_BIN" --user enable opencode-ponytail-update.timer >/dev/null
  "$SYSTEMCTL_BIN" --user start opencode-ponytail-update.timer
  if ! verify_unit_limits; then
    if [ "$service_existed" -eq 1 ]; then mv -f -- "$previous_service" "$SERVICE_UNIT"; else rm -f -- "$SERVICE_UNIT"; fi
    if [ "$timer_existed" -eq 1 ]; then mv -f -- "$previous_timer" "$TIMER_UNIT"; else rm -f -- "$TIMER_UNIT"; fi
    "$SYSTEMCTL_BIN" --user daemon-reload || true
    rm -f -- "$previous_service" "$previous_timer"
    trap - RETURN
    return 1
  fi
  rm -f -- "$previous_service" "$previous_timer"
  trap - RETURN
}

verify_unit_limits() {
  local quota
  quota="$($SYSTEMCTL_BIN --user show opencode-ponytail-update.service --property=CPUQuotaPerSecUSec --value)"
  [ "$quota" = 2s ] || { fail "Ponytail updater CPU quota is ineffective: ${quota:-unset}"; return 1; }
}

restart_and_verify() {
  OPENCODE_CONFIG_DIR="$CONFIG_DIR" \
  XDG_DATA_HOME="$PILOT/data" \
  XDG_STATE_HOME="$PILOT/state" \
  XDG_CACHE_HOME="$PILOT/cache" \
  OPENCODE_DISABLE_AUTOUPDATE=1 \
    "$BIN" service restart >/dev/null
  local plugins
  plugins="$(cd "$HOME" && OPENCODE_CONFIG_DIR="$CONFIG_DIR" XDG_DATA_HOME="$PILOT/data" XDG_STATE_HOME="$PILOT/state" XDG_CACHE_HOME="$PILOT/cache" "$BIN" plugin list)"
  grep -Eq '^ponytail[[:space:]]' <<<"$plugins" || { fail "Ponytail did not become active after restart"; return 1; }
}

LATEST="$(latest_version)"
VERSION_DIR="$VERSIONS/$LATEST"
PACKAGE_DIR="$VERSION_DIR/node_modules/@dietrichgebert/ponytail"
INSTALLED=""
if [ -e "$CURRENT" ]; then
  [ -L "$CURRENT" ] || die "managed current path is not a symbolic link: $CURRENT"
  INSTALLED="$(package_version "$CURRENT/node_modules/@dietrichgebert/ponytail" 2>/dev/null || true)"
fi
CONFIG_STATUS="$(config_entry verify)"

if [ "$APPLY" -eq 0 ]; then
  status=0
  if [ "$INSTALLED" = "$LATEST" ]; then ok "official Ponytail $LATEST is installed"; else fail "official Ponytail latest=$LATEST installed=${INSTALLED:-none}"; status=1; fi
  if [ "$CONFIG_STATUS" = present ]; then ok "Ponytail v2 adapter is registered in $SERVER_CONFIG"; else fail "Ponytail v2 adapter is not registered in $SERVER_CONFIG"; status=1; fi
  if [ "$ENABLE_TIMER" -eq 1 ]; then
    if [ -f "$SERVICE_UNIT" ] && [ -f "$TIMER_UNIT" ] && "$SYSTEMCTL_BIN" --user is-enabled --quiet opencode-ponytail-update.timer; then
      if verify_unit_limits; then ok "daily Ponytail update timer is installed, enabled, and resource-bounded"; else status=1; fi
    else
      fail "daily Ponytail update timer is missing or disabled"
      status=1
    fi
  fi
  if [ "$status" -eq 0 ]; then
    "$RUNNER" --memory-fraction 30 --swap-fraction 10 --timeout 10m --lock-timeout 30 -- \
      env OPENCODE_V2_BIN="$BIN" node "$RUNTIME_VERIFIER" "$ADAPTER_DIR" "$CURRENT/node_modules/@dietrichgebert/ponytail"
  fi
  exit "$status"
fi

mkdir -p "$VERSIONS"
changed=0
if [ ! -d "$PACKAGE_DIR" ]; then
  staging="$(mktemp -d "$INSTALL_ROOT/.staging.${LATEST}.XXXXXX")"
  cleanup_staging() { [ -n "${staging:-}" ] && [ -d "$staging" ] && rm -rf -- "$staging"; }
  trap cleanup_staging EXIT INT TERM
  "$RUNNER" --memory-fraction 30 --swap-fraction 10 --timeout 10m --lock-timeout 30 -- \
    "$NPM_BIN" install --ignore-scripts --no-audit --no-fund --prefix "$staging" "@dietrichgebert/ponytail@$LATEST"
  candidate="$staging/node_modules/@dietrichgebert/ponytail"
  [ "$(package_version "$candidate")" = "$LATEST" ] || die "installed Ponytail package version does not match $LATEST"
  "$RUNNER" --memory-fraction 35 --swap-fraction 10 --timeout 10m --lock-timeout 30 -- \
    env OPENCODE_V2_BIN="$BIN" node "$RUNTIME_VERIFIER" "$ADAPTER_DIR" "$candidate"
  mv -- "$staging" "$VERSION_DIR"
  staging=""
  trap - EXIT INT TERM
  changed=1
  ok "installed and verified official Ponytail $LATEST"
else
  [ "$(package_version "$PACKAGE_DIR")" = "$LATEST" ] || die "managed Ponytail version directory has the wrong package identity"
  ok "official Ponytail $LATEST package is already staged"
fi

if [ "$ENABLE_TIMER" -eq 1 ]; then
  [ -n "$SYSTEMCTL_BIN" ] && [ -x "$SYSTEMCTL_BIN" ] || die "systemctl is required to install the update timer"
  write_units || die "Ponytail updater unit activation failed; prior units were restored"
  ok "daily Ponytail update timer is enabled"
fi

previous_target=""
if [ -L "$CURRENT" ]; then previous_target="$(readlink "$CURRENT")"; fi
if [ "$INSTALLED" != "$LATEST" ]; then
  link="$INSTALL_ROOT/.current.$$.${RANDOM}"
  ln -s "versions/$LATEST" "$link"
  mv -Tf -- "$link" "$CURRENT"
  changed=1
  ok "activated official Ponytail $LATEST"
fi

config_existed=0
backup=""
if [ -f "$SERVER_CONFIG" ]; then
  config_existed=1
  mkdir -p "$INSTALL_ROOT/backups"
  backup="$INSTALL_ROOT/backups/opencode.jsonc.$(date -u +%Y%m%dT%H%M%SZ).$$"
  cp --preserve=mode,timestamps -- "$SERVER_CONFIG" "$backup"
fi
CONFIG_RESULT="$(config_entry apply)"
if [ "$CONFIG_RESULT" = added ]; then
  changed=1
  ok "registered Ponytail v2 adapter in $SERVER_CONFIG"
elif [ "$CONFIG_RESULT" = updated ]; then
  changed=1
  ok "updated Ponytail v2 adapter package root in $SERVER_CONFIG"
else
  ok "Ponytail v2 adapter is already registered"
fi

if [ "$changed" -eq 1 ] && [ "$RESTART" -eq 1 ]; then
  if ! restart_and_verify; then
    if [ -n "$previous_target" ]; then
      rollback_link="$INSTALL_ROOT/.rollback.$$.${RANDOM}"
      ln -s "$previous_target" "$rollback_link"
      mv -Tf -- "$rollback_link" "$CURRENT"
    fi
    if [ "$config_existed" -eq 1 ] && [ -n "$backup" ]; then cp --preserve=mode,timestamps -- "$backup" "$SERVER_CONFIG"; else rm -f -- "$SERVER_CONFIG"; fi
    restart_and_verify || true
    die "Ponytail activation failed and the prior package/config were restored"
  fi
  ok "OpenCode restarted with Ponytail active"
fi

ok "Ponytail setup complete (version $LATEST)"
