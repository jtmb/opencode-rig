#!/usr/bin/env bash
# Provision OpenCode's local computer-assistant capabilities on Ubuntu GNOME.
#
# Security-relevant changes made by --apply:
# - enables AT-SPI so user processes can inspect/control accessible app widgets
# - installs/enables ydotool and adds the user to input (synthetic input access)
# - enables an isolated Playwright browser MCP (no normal-browser cookies)
#
# Default is read-only verification. Use --apply to install/configure.
set -euo pipefail

APPLY=0
case "${1:---verify-only}" in
  --apply) APPLY=1 ;;
  --verify-only) ;;
  -h|--help)
    echo "Usage: $0 [--verify-only|--apply]"
    exit 0 ;;
  *)
    echo "Usage: $0 [--verify-only|--apply]" >&2
    exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin"
BROWSER_PROJECT="$REPO_ROOT/browser"
BROWSER_BIN="$BROWSER_PROJECT/node_modules/.bin/playwright"
BROWSER_MCP="$BROWSER_PROJECT/node_modules/.bin/playwright-mcp"
BROWSER_MCP_VERSION="0.0.80"
MEMORY="$HOME/Documents/computer-assistant/memory.json"
REQUIRED_PACKAGES=(python3-pyatspi ydotool wl-clipboard)

ok() { echo "OK: $*"; }
fail() { echo "MISSING/FAILED: $*" >&2; }

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
  echo "=== system dependencies ==="
  run_root apt-get install -y --no-remove "${REQUIRED_PACKAGES[@]}"

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

install_browser_runtime() {
  echo "=== browser runtime ==="
  if [ ! -x "$NODE_BIN/node" ] || [ ! -x "$NODE_BIN/npm" ]; then
    fail "fnm default Node/npm under $NODE_BIN"
    return 1
  fi
  if [ ! -f "$BROWSER_PROJECT/package.json" ] || [ ! -f "$BROWSER_PROJECT/package-lock.json" ]; then
    fail "$BROWSER_PROJECT/package.json and package-lock.json"
    return 1
  fi
  if [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
      "$BROWSER_PROJECT/node_modules/@playwright/mcp/package.json" 2>/dev/null || true)" != \
      "$BROWSER_MCP_VERSION" ]; then
    PATH="$NODE_BIN:$PATH" npm ci --ignore-scripts --no-audit --no-fund \
      --prefix "$BROWSER_PROJECT"
  else
    ok "Playwright MCP $BROWSER_MCP_VERSION already installed"
  fi
  PLAYWRIGHT_BROWSERS_PATH="$BROWSER_PROJECT/browsers" \
    PATH="$NODE_BIN:$PATH" "$BROWSER_BIN" install firefox

  if ! grep -Fq "$SCRIPT_DIR/playwright-mcp.sh" \
      "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null; then
    opencode mcp add playwright -- "$SCRIPT_DIR/playwright-mcp.sh"
  fi
  python3 - "$HOME/.config/opencode/opencode.jsonc" "$SCRIPT_DIR/playwright-mcp.sh" <<'PY'
import json, sys
path, wrapper = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
except (OSError, ValueError):
    config = {"$schema": "https://opencode.ai/config.json"}
entry = config.setdefault("mcp", {}).setdefault("playwright", {})
entry["type"] = "local"
entry["command"] = [wrapper]
entry["enabled"] = True
entry["timeout"] = 30000
with open(path, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY
}

initialize_local_state() {
  echo "=== skills and memory ==="
  "$SCRIPT_DIR/setup-opencode.sh"
  python3 "$SCRIPT_DIR/assistant-memory.py" init
}

verify() {
  local status=0
  local package
  echo "=== computer assistant verify ==="

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

  if systemctl --user is-active --quiet ydotool.service && \
     [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket" ]; then
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

  if python3 "$SCRIPT_DIR/assistant-memory.py" validate >/dev/null 2>&1; then
    ok "private memory store $MEMORY"
  else
    fail "private memory store $MEMORY"
    status=1
  fi

  if [ -x "$BROWSER_MCP" ] && [ -x "$BROWSER_BIN" ] && \
     [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
        "$BROWSER_PROJECT/node_modules/@playwright/mcp/package.json" 2>/dev/null || true)" = \
       "$BROWSER_MCP_VERSION" ]; then
    ok "pinned Playwright MCP $BROWSER_MCP_VERSION runtime"
  else
    fail "Playwright MCP $BROWSER_MCP_VERSION runtime"
    status=1
  fi

  if compgen -G "$BROWSER_PROJECT/browsers/firefox-*/firefox/firefox" >/dev/null; then
    ok "Playwright Firefox runtime"
  else
    fail "Playwright Firefox runtime"
    status=1
  fi

  if opencode mcp list 2>&1 | grep -q 'playwright.*connected'; then
    ok "OpenCode Playwright MCP connected"
  else
    fail "OpenCode Playwright MCP connection"
    status=1
  fi

  if grep -Fq "$SCRIPT_DIR/playwright-mcp.sh" \
      "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null; then
    ok "OpenCode Playwright MCP uses local pinned wrapper"
  else
    fail "OpenCode Playwright MCP command is not $SCRIPT_DIR/playwright-mcp.sh"
    status=1
  fi

  if "$SCRIPT_DIR/setup-opencode.sh" --verify-only >/dev/null; then
    ok "all OpenCode skills deployed"
  else
    fail "OpenCode skills missing/stale"
    status=1
  fi

  return "$status"
}

if [ "$APPLY" -eq 1 ]; then
  install_system_dependencies
  initialize_local_state
  install_browser_runtime
fi

verify
