#!/usr/bin/env bash
# Provision OpenCode's local computer-assistant capabilities on Ubuntu GNOME.
# shellcheck disable=SC2016 # python -c blocks use literal $schema JSON keys.
#
# Security-relevant changes made by --apply:
# - enables AT-SPI so user processes can inspect/control accessible app widgets
# - installs/enables ydotool and adds the user to input (synthetic input access)
# - enables isolated Playwright browser MCPs in the project opencode.json
#   (project-only, never global; no normal-browser cookies)
# - installs a checksum-pinned GitHub MCP and enables its project-local,
#   read-only wrapper (credentials remain outside the repository and config)
#
# Default is read-only verification. Use --apply to install/configure.
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
      MODE_SET=1 ;;
    --verify-only)
      if [ "$MODE_SET" -ne 0 ]; then
        echo "Usage: $0 [--verify-only|--apply]" >&2
        exit 2
      fi
      MODE_SET=1 ;;
    -h|--help)
      echo "Usage: $0 [--verify-only|--apply]"
      exit 0 ;;
    *)
      echo "Usage: $0 [--verify-only|--apply]" >&2
      exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UBUNTU_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$UBUNTU_ROOT/../../.." && pwd)"
PROJECT_CONFIG_JSON="$REPO_ROOT/opencode.json"
NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin"
BROWSER_PROJECT="$UBUNTU_ROOT/browser-tools"
BROWSER_BIN="$BROWSER_PROJECT/node_modules/.bin/playwright"
BROWSER_MCP="$BROWSER_PROJECT/node_modules/.bin/playwright-mcp"
BROWSER_MCP_VERSION="0.0.80"
LIVE_MCP_WRAPPER="$SCRIPT_DIR/playwright-mcp.sh"
HEADLESS_MCP_WRAPPER="$SCRIPT_DIR/playwright-headless-mcp.sh"
GITHUB_PROJECT="$UBUNTU_ROOT/github-tools"
GITHUB_MCP="$GITHUB_PROJECT/bin/github-mcp-server"
GITHUB_MCP_VERSION="1.12.1"
GITHUB_MCP_ARCHIVE="github-mcp-server_Linux_x86_64.tar.gz"
GITHUB_MCP_SHA256="e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b"
GITHUB_MCP_URL="https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}/${GITHUB_MCP_ARCHIVE}"
GITHUB_MCP_WRAPPER="$SCRIPT_DIR/github-mcp.sh"
OPENCODE_CONFIG_JSON="$HOME/.config/opencode/opencode.json"
OPENCODE_CONFIG_JSONC="$HOME/.config/opencode/opencode.jsonc"
MEMORY="$HOME/Documents/computer-assistant/memory.json"
REQUIRED_PACKAGES=(python3-pyatspi ydotool wl-clipboard)

ok() { echo "OK: $*"; }
fail() { echo "MISSING/FAILED: $*" >&2; }

installed_mcp_version() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
    "$BROWSER_PROJECT/node_modules/@playwright/mcp/package.json" 2>/dev/null || true
}

expected_firefox_bin() {
  local install_location=""
  if [ -x "$BROWSER_BIN" ]; then
    install_location="$(PLAYWRIGHT_BROWSERS_PATH="$BROWSER_PROJECT/browsers" \
      PATH="$NODE_BIN:$PATH" "$BROWSER_BIN" install --dry-run firefox 2>/dev/null | \
      awk '/^  Install location:/ {print $3; exit}')"
  fi
  if [ -n "$install_location" ]; then
    printf '%s/firefox/firefox\n' "$install_location"
  fi
}

browser_runtime_complete() {
  local firefox_bin=""
  [ "$(installed_mcp_version)" = "$BROWSER_MCP_VERSION" ] || return 1
  [ -x "$BROWSER_MCP" ] || return 1
  [ -x "$BROWSER_BIN" ] || return 1
  firefox_bin="$(expected_firefox_bin)"
  [ -n "$firefox_bin" ] && [ -x "$firefox_bin" ]
}

github_runtime_complete() {
  local version=""
  [ -x "$GITHUB_MCP" ] || return 1
  version="$("$GITHUB_MCP" --version 2>/dev/null || true)"
  [[ "$version" == *"$GITHUB_MCP_VERSION"* ]]
}

ensure_mcp() {
  local name="$1"
  local wrapper="$2"
  ensure_project_mcp_entry "$name" "$wrapper" || return 1
  remove_global_mcp_entry "$name" || return 1
  if ! project_mcp_matches "$name" "$wrapper"; then
    fail "Project MCP $name was not bound to $wrapper in $PROJECT_CONFIG_JSON"
    return 1
  fi
  if global_mcp_has_entry "$name"; then
    fail "Global MCP $name still present; expected project-only in $PROJECT_CONFIG_JSON"
    return 1
  fi
  if ! mcp_config_matches "$name" "$wrapper"; then
    fail "OpenCode MCP $name was not bound to $wrapper"
    return 1
  fi
}

project_mcp_matches() {
  local name="$1"
  local wrapper="$2"
  [ -f "$PROJECT_CONFIG_JSON" ] || return 1
  python3 -c '
import json
import sys

path, name, wrapper = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as handle:
        entry = json.load(handle).get("mcp", {}).get(name, {})
except (OSError, ValueError):
    raise SystemExit(1)
matches = (
    entry.get("type") == "local"
    and entry.get("command") == [wrapper]
    and entry.get("enabled", True) is not False
)
raise SystemExit(0 if matches else 1)
' "$PROJECT_CONFIG_JSON" "$name" "$wrapper" 2>/dev/null
}

global_mcp_has_entry() {
  local name="$1"
  python3 -c '
import json
import os
import sys

name = sys.argv[1]
paths = sys.argv[2:]
for path in paths:
    if not os.path.exists(path):
        continue
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        # Unparseable global config needs manual review; treat as present.
        raise SystemExit(0)
    if name in data.get("mcp", {}):
        raise SystemExit(0)
raise SystemExit(1)
' "$name" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC" 2>/dev/null
}

ensure_project_mcp_entry() {
  local name="$1"
  local wrapper="$2"
  python3 -c '
import json
import os
import sys
import tempfile

path, name, wrapper = sys.argv[1:]
entry = {
    "type": "local",
    "command": [wrapper],
    "enabled": True,
    "timeout": 30000,
}
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except FileNotFoundError:
    data = {"$schema": "https://opencode.ai/config.json"}
except (OSError, ValueError) as exc:
    print(f"MISSING/FAILED: cannot parse {path}: {exc}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(data, dict):
    print(f"MISSING/FAILED: {path} is not a JSON object", file=sys.stderr)
    raise SystemExit(1)
mcp = data.get("mcp")
if not isinstance(mcp, dict):
    mcp = {}
    data["mcp"] = mcp
if mcp.get(name) == entry:
    raise SystemExit(0)
mcp[name] = entry
directory = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".opencode.", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.replace(tmp, path)
except OSError as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    print(f"MISSING/FAILED: cannot write {path}: {exc}", file=sys.stderr)
    raise SystemExit(1)
print(f"OK: project MCP {name} -> {wrapper}")
' "$PROJECT_CONFIG_JSON" "$name" "$wrapper"
}

remove_global_mcp_entry() {
  local name="$1"
  python3 -c '
import json
import os
import sys
import tempfile

name = sys.argv[1]
paths = sys.argv[2:]
status = 0
for path in paths:
    if not os.path.exists(path):
        continue
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"MISSING/FAILED: cannot parse {path}: {exc}", file=sys.stderr)
        raise SystemExit(1)
    if not isinstance(data, dict):
        print(f"MISSING/FAILED: {path} is not a JSON object", file=sys.stderr)
        raise SystemExit(1)
    mcp = data.get("mcp")
    if not isinstance(mcp, dict) or name not in mcp:
        continue
    del mcp[name]
    if not mcp:
        data.pop("mcp", None)
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".opencode.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    except OSError as exc:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        print(f"MISSING/FAILED: cannot write {path}: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print(f"OK: removed global MCP {name} from {path}")
' "$name" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC"
}

mcp_config_matches() {
  local name="$1"
  local wrapper="$2"
  has_conflicting_opencode_configs && return 1
  (cd "$REPO_ROOT" && opencode debug config 2>/dev/null) | python3 -c '
import json
import sys

name, wrapper = sys.argv[1:]
entry = json.load(sys.stdin).get("mcp", {}).get(name, {})
matches = (
    entry.get("type") == "local"
    and entry.get("command") == [wrapper]
    and entry.get("enabled", True) is not False
)
raise SystemExit(0 if matches else 1)
' "$name" "$wrapper" 2>/dev/null
}

has_opencode_config() {
  [ -f "$OPENCODE_CONFIG_JSON" ] || [ -f "$OPENCODE_CONFIG_JSONC" ]
}

has_conflicting_opencode_configs() {
  [ -f "$OPENCODE_CONFIG_JSON" ] && [ -f "$OPENCODE_CONFIG_JSONC" ]
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
  if ! browser_runtime_complete; then
    PATH="$NODE_BIN:$PATH" npm ci --ignore-scripts --no-audit --no-fund \
      --prefix "$BROWSER_PROJECT"
    PLAYWRIGHT_BROWSERS_PATH="$BROWSER_PROJECT/browsers" \
      PATH="$NODE_BIN:$PATH" "$BROWSER_BIN" install firefox
  fi
  if ! browser_runtime_complete; then
    fail "Playwright MCP $BROWSER_MCP_VERSION runtime"
    return 1
  fi
  ok "Playwright MCP $BROWSER_MCP_VERSION already installed"

  if has_conflicting_opencode_configs; then
    fail "both $OPENCODE_CONFIG_JSON and $OPENCODE_CONFIG_JSONC exist; consolidate them before MCP setup"
    return 1
  fi
  ensure_mcp playwright "$LIVE_MCP_WRAPPER"
  ensure_mcp playwright_headless "$HEADLESS_MCP_WRAPPER"
}

install_github_runtime() {
  echo "=== GitHub MCP runtime ==="
  if ! github_runtime_complete; then
    local command
    for command in curl install sha256sum tar; do
      if ! command -v "$command" >/dev/null 2>&1; then
        fail "required GitHub MCP installer command: $command"
        return 1
      fi
    done
    mkdir -p "$GITHUB_PROJECT/bin" /tmp/opencode
    (
      local archive tmp_dir
      tmp_dir="$(mktemp -d /tmp/opencode/github-mcp.XXXXXX)"
      trap 'rm -rf "$tmp_dir"' EXIT
      archive="$tmp_dir/$GITHUB_MCP_ARCHIVE"
      curl --fail --location --silent --show-error \
        --output "$archive" "$GITHUB_MCP_URL"
      printf '%s  %s\n' "$GITHUB_MCP_SHA256" "$archive" | sha256sum --check --status
      tar -xzf "$archive" -C "$tmp_dir"
      if [ ! -f "$tmp_dir/github-mcp-server" ]; then
        fail "GitHub MCP archive did not contain github-mcp-server"
        exit 1
      fi
      install -m 0755 "$tmp_dir/github-mcp-server" "$GITHUB_MCP"
    )
  fi
  if ! github_runtime_complete; then
    fail "GitHub MCP $GITHUB_MCP_VERSION runtime"
    return 1
  fi
  ok "GitHub MCP $GITHUB_MCP_VERSION runtime installed"

  if has_conflicting_opencode_configs; then
    fail "both $OPENCODE_CONFIG_JSON and $OPENCODE_CONFIG_JSONC exist; consolidate them before MCP setup"
    return 1
  fi
  ensure_mcp github "$GITHUB_MCP_WRAPPER"
}

initialize_local_state() {
  echo "=== skills and memory ==="
  "$SCRIPT_DIR/setup-opencode.sh" --apply
  python3 "$SCRIPT_DIR/assistant-memory.py" init
}

verify() {
  local status=0
  local package
  local mcp_list
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

  if browser_runtime_complete; then
    ok "pinned Playwright MCP $BROWSER_MCP_VERSION runtime"
    ok "Playwright Firefox runtime"
  else
    fail "Playwright MCP $BROWSER_MCP_VERSION runtime"
    fail "Playwright Firefox runtime"
    status=1
  fi

  if github_runtime_complete; then
    ok "pinned GitHub MCP $GITHUB_MCP_VERSION runtime"
  else
    fail "GitHub MCP $GITHUB_MCP_VERSION runtime"
    status=1
  fi

  if has_conflicting_opencode_configs; then
    fail "both $OPENCODE_CONFIG_JSON and $OPENCODE_CONFIG_JSONC exist"
    status=1
    mcp_list=""
  else
    mcp_list="$(cd "$REPO_ROOT" && opencode mcp list 2>&1 || true)"
  fi
  if printf '%s\n' "$mcp_list" | grep -q 'playwright .*connected'; then
    ok "OpenCode live Playwright MCP connected"
  else
    fail "OpenCode live Playwright MCP connection"
    status=1
  fi

  if printf '%s\n' "$mcp_list" | grep -q 'playwright_headless.*connected'; then
    ok "OpenCode headless Playwright MCP connected"
  else
    fail "OpenCode headless Playwright MCP connection"
    status=1
  fi

  if [ -n "${GITHUB_PERSONAL_ACCESS_TOKEN:-}${GH_TOKEN:-}" ]; then
    if printf '%s\n' "$mcp_list" | grep -q 'github .*connected'; then
      ok "OpenCode GitHub MCP connected"
    else
      fail "OpenCode GitHub MCP connection"
      status=1
    fi
  else
    ok "GitHub MCP authentication pending (set GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN before starting OpenCode)"
  fi

  if project_mcp_matches playwright "$LIVE_MCP_WRAPPER"; then
    ok "Project live Playwright MCP uses local pinned wrapper"
  else
    fail "Project live Playwright MCP command is not $LIVE_MCP_WRAPPER in $PROJECT_CONFIG_JSON"
    status=1
  fi

  if project_mcp_matches playwright_headless "$HEADLESS_MCP_WRAPPER"; then
    ok "Project headless Playwright MCP uses local pinned wrapper"
  else
    fail "Project headless Playwright MCP command is not $HEADLESS_MCP_WRAPPER in $PROJECT_CONFIG_JSON"
    status=1
  fi

  if project_mcp_matches github "$GITHUB_MCP_WRAPPER"; then
    ok "Project GitHub MCP uses local pinned wrapper"
  else
    fail "Project GitHub MCP command is not $GITHUB_MCP_WRAPPER in $PROJECT_CONFIG_JSON"
    status=1
  fi

  if global_mcp_has_entry playwright; then
    fail "Global Playwright MCP present; expected project-only in $PROJECT_CONFIG_JSON"
    status=1
  else
    ok "Global Playwright MCP absent (project-only)"
  fi

  if global_mcp_has_entry playwright_headless; then
    fail "Global headless Playwright MCP present; expected project-only in $PROJECT_CONFIG_JSON"
    status=1
  else
    ok "Global headless Playwright MCP absent (project-only)"
  fi

  if global_mcp_has_entry github; then
    fail "Global GitHub MCP present; expected project-only in $PROJECT_CONFIG_JSON"
    status=1
  else
    ok "Global GitHub MCP absent (project-only)"
  fi

  if mcp_config_matches playwright "$LIVE_MCP_WRAPPER"; then
    ok "OpenCode live Playwright MCP uses local pinned wrapper"
  else
    fail "OpenCode live Playwright MCP command is not $LIVE_MCP_WRAPPER"
    status=1
  fi

  if mcp_config_matches playwright_headless "$HEADLESS_MCP_WRAPPER"; then
    ok "OpenCode headless Playwright MCP uses local pinned wrapper"
  else
    fail "OpenCode headless Playwright MCP command is not $HEADLESS_MCP_WRAPPER"
    status=1
  fi

  if mcp_config_matches github "$GITHUB_MCP_WRAPPER"; then
    ok "OpenCode GitHub MCP uses local pinned wrapper"
  else
    fail "OpenCode GitHub MCP command is not $GITHUB_MCP_WRAPPER"
    status=1
  fi

  if "$SCRIPT_DIR/setup-opencode.sh" --verify-only >/dev/null; then
    ok "all OpenCode skills and commands deployed"
  else
    fail "OpenCode skills or commands missing/stale"
    status=1
  fi

  return "$status"
}

if [ "$APPLY" -eq 1 ]; then
  install_system_dependencies
  initialize_local_state
  install_browser_runtime
  install_github_runtime
fi

verify
