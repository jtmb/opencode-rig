#!/usr/bin/env bash
# Provision OpenCode's local computer-assistant capabilities on Ubuntu GNOME.
set -euo pipefail

APPLY=0
MODE_SET=0
for arg in "$@"; do
  case "$arg" in
    --apply)
      if [ "$MODE_SET" -ne 0 ]; then
        echo "Usage: $0 [--verify-only|--apply]" >&2
        exit 2
      fi
      APPLY=1
      MODE_SET=1
      ;;
    --verify-only)
      if [ "$MODE_SET" -ne 0 ]; then
        echo "Usage: $0 [--verify-only|--apply]" >&2
        exit 2
      fi
      MODE_SET=1
      ;;
    -h|--help)
      echo "Usage: $0 [--verify-only|--apply]"
      exit 0
      ;;
    *)
      echo "Usage: $0 [--verify-only|--apply]" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UBUNTU_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$UBUNTU_ROOT/../../.." && pwd)"
PROJECT_CONFIG_JSON="$REPO_ROOT/opencode.json"
V2_CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"
OPENCODE_BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
OPENCODE_CONFIG_JSON="$V2_CONFIG_DIR/opencode.json"
OPENCODE_CONFIG_JSONC="$V2_CONFIG_DIR/opencode.jsonc"
CLI_CONFIG="$V2_CONFIG_DIR/cli.json"
MCP_RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
REQUIRED_PACKAGES=(python3-pyatspi ydotool wl-clipboard)

ok() { echo "OK: $*"; }
fail() { echo "MISSING/FAILED: $*" >&2; }

global_mcp_config_path() {
  if [ -f "$OPENCODE_CONFIG_JSONC" ]; then
    printf '%s\n' "$OPENCODE_CONFIG_JSONC"
  else
    printf '%s\n' "$OPENCODE_CONFIG_JSON"
  fi
}

preflight_v2_config() {
  python3 - "$V2_CONFIG_DIR" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC" "$CLI_CONFIG" "$PROJECT_CONFIG_JSON" <<'PY'
import os
import stat
import sys

root, json_path, jsonc_path, cli_path, project_path = sys.argv[1:]
if os.path.exists(json_path) and os.path.exists(jsonc_path):
    raise SystemExit(f"both {json_path} and {jsonc_path} exist; consolidate them before setup")
for path in (root, json_path, jsonc_path, cli_path, project_path):
    absolute = os.path.abspath(path)
    current = os.path.dirname(absolute) if path != root else absolute
    while current != os.path.dirname(current):
        if os.path.islink(current):
            raise SystemExit(f"refusing config path with symlink ancestor: {path}")
        current = os.path.dirname(current)
    if os.path.lexists(absolute):
        metadata = os.lstat(absolute)
        if stat.S_ISLNK(metadata.st_mode):
            raise SystemExit(f"refusing symlinked config path: {path}")
        if path == root and not stat.S_ISDIR(metadata.st_mode):
            raise SystemExit(f"config root is not a directory: {path}")
        if path != root and not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f"config path is not a regular file: {path}")
PY
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif sudo -n true 2>/dev/null; then
    sudo "$@"
  elif [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v pkexec >/dev/null 2>&1; then
    pkexec "$@"
  else
    sudo "$@"
  fi
}

install_system_dependencies() {
  local package
  local missing=()
  echo "=== system dependencies ==="
  for package in "${REQUIRED_PACKAGES[@]}"; do
    if ! dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -q '^installed$'; then
      missing+=("$package")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    run_root apt-get install -y --no-remove "${missing[@]}"
  else
    ok "required system packages already installed"
  fi
  if ! id -nG "$(id -un)" | tr ' ' '\n' | grep -qx input; then
    run_root usermod -aG input "$(id -un)"
    echo "NOTICE: input group added; a full logout/login may be required."
  fi
  gsettings set org.gnome.desktop.interface toolkit-accessibility true
  systemctl --user daemon-reload
  if [ -w /dev/uinput ]; then
    systemctl --user enable --now ydotool.service
  else
    echo "NOTICE: /dev/uinput is not writable in this login; log out/in, then rerun."
  fi
}

initialize_local_state() {
  echo "=== skills and commands ==="
  "$SCRIPT_DIR/setup-opencode.sh" --config-dir "$V2_CONFIG_DIR" --prepare
  echo "=== v2 plugins ==="
  "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$V2_CONFIG_DIR" --plugins all --apply
  echo "=== canonical MCP configuration ==="
  python3 "$MCP_RUNTIME" config --scope global --config "$(global_mcp_config_path)" --apply
  python3 "$MCP_RUNTIME" config --scope project --config "$PROJECT_CONFIG_JSON"
  echo "=== canonical MCP runtimes ==="
  "$SCRIPT_DIR/setup-mcps.sh" --profile native --apply
}

verify() {
  local status=0
  local package
  local mcp_list=""
  echo "=== computer assistant verify ==="

  if [ -x "$OPENCODE_BIN" ] && [[ "$("$OPENCODE_BIN" --version 2>/dev/null || true)" == "opencode v2."* ]]; then
    ok "OpenCode v2 binary $OPENCODE_BIN"
  else
    fail "OpenCode v2 binary $OPENCODE_BIN"
    status=1
  fi

  for package in "${REQUIRED_PACKAGES[@]}"; do
    if dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -q '^installed$'; then
      ok "package $package"
    else
      fail "package $package"
      status=1
    fi
  done

  if [ "$(gsettings get org.gnome.desktop.interface toolkit-accessibility)" = "true" ]; then
    ok "GNOME toolkit accessibility enabled"
  else
    fail "GNOME toolkit accessibility disabled"
    status=1
  fi
  if python3 -c 'import pyatspi' 2>/dev/null; then
    ok "AT-SPI Python binding"
  else
    fail "AT-SPI Python binding"
    status=1
  fi
  if id -nG "$(id -un)" | tr ' ' '\n' | grep -qx input; then
    ok "account belongs to input group"
  else
    fail "account does not belong to input group"
    status=1
  fi
  if [ -w /dev/uinput ]; then
    ok "/dev/uinput writable in this login"
  else
    fail "/dev/uinput not writable (logout/login may be pending)"
    status=1
  fi
  if systemctl --user is-active --quiet ydotool.service && [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket" ]; then
    ok "ydotool user service and private socket"
  else
    fail "ydotool user service/socket"
    status=1
  fi
  if python3 "$SCRIPT_DIR/desktop-control.py" apps >/dev/null 2>&1; then
    ok "desktop-control AT-SPI inspection"
  else
    fail "desktop-control AT-SPI inspection"
    status=1
  fi

  if python3 "$MCP_RUNTIME" config --scope project --config "$PROJECT_CONFIG_JSON"; then
    ok "portable project MCP configuration remains canonical"
  else
    fail "portable project MCP configuration"
    status=1
  fi
  if python3 "$MCP_RUNTIME" config --scope global --config "$(global_mcp_config_path)"; then
    ok "native global MCP configuration"
  else
    fail "native global MCP configuration"
    status=1
  fi
  if "$SCRIPT_DIR/setup-mcps.sh" --profile native --verify-only; then
    ok "pinned Basic Memory, Node.js, Playwright MCP, and Chrome runtimes"
  else
    fail "canonical native MCP runtimes"
    status=1
  fi

  if [ -x "$OPENCODE_BIN" ]; then
    mcp_list="$( (cd "$REPO_ROOT"; OPENCODE_CONFIG_DIR="$V2_CONFIG_DIR" "$OPENCODE_BIN" mcp list 2>&1) || true )"
  fi
  for name in basic-memory playwright; do
    if printf '%s\n' "$mcp_list" | grep -q "$name .*connected"; then
      ok "OpenCode $name MCP connected"
    else
      fail "OpenCode $name MCP connection"
      status=1
    fi
  done
  if printf '%s\n' "$mcp_list" | grep -qE 'github .*(connected|needs_auth)'; then
    ok "OpenCode GitHub hosted MCP connected or awaiting operator OAuth"
  else
    fail "OpenCode GitHub hosted MCP declaration/connection"
    status=1
  fi

  if "$SCRIPT_DIR/setup-opencode.sh" --config-dir "$V2_CONFIG_DIR" --verify-only; then
    ok "all OpenCode skills, commands, and tools deployed"
  else
    fail "OpenCode skills, commands, or tools missing/stale"
    status=1
  fi
  if "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$V2_CONFIG_DIR" --plugins all --verify-only; then
    ok "all OpenCode v2 plugins registered and gated"
  else
    fail "OpenCode v2 plugins missing, stale, or session permissions are not prompt"
    status=1
  fi
  return "$status"
}

if ! preflight_v2_config; then
  fail "v2 config preflight failed"
  exit 1
fi

if [ "$APPLY" -eq 1 ]; then
  install_system_dependencies
  initialize_local_state
fi

verify
