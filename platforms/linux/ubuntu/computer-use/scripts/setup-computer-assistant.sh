#!/usr/bin/env bash
# Provision OpenCode's local computer-assistant capabilities on Ubuntu GNOME.
# shellcheck disable=SC2016 # python -c blocks use literal $schema JSON keys.
#
# Security-relevant changes made by --apply:
# - enables AT-SPI so user processes can inspect/control accessible app widgets
# - installs/enables ydotool and adds the user to input (synthetic input access)
# - enables the single isolated Playwright browser MCP in the project opencode.json
#   (project-only, never global; no normal-browser cookies)
# - installs a checksum-pinned GitHub MCP and enables its global, write-capable
#   wrapper in lockdown mode (credentials remain outside the repository and
#   config; mutations keep the confirmation gate)
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
GITHUB_PROJECT="$UBUNTU_ROOT/github-tools"
GITHUB_MCP="$GITHUB_PROJECT/bin/github-mcp-server"
GITHUB_MCP_VERSION="1.12.1"
GITHUB_MCP_ARCHIVE="github-mcp-server_Linux_x86_64.tar.gz"
GITHUB_MCP_SHA256="e45c73a26a3c4cd643b40360db06f442de1e73a60d4eaf9e8639204ec3b95d3b"
GITHUB_MCP_URL="https://github.com/github/github-mcp-server/releases/download/v${GITHUB_MCP_VERSION}/${GITHUB_MCP_ARCHIVE}"
GITHUB_MCP_WRAPPER="$SCRIPT_DIR/github-mcp.sh"
V2_CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"
OPENCODE_BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
OPENCODE_CONFIG_JSON="$V2_CONFIG_DIR/opencode.json"
OPENCODE_CONFIG_JSONC="$V2_CONFIG_DIR/opencode.jsonc"
CLI_CONFIG="$V2_CONFIG_DIR/cli.json"
BASIC_MEMORY_VERSION="0.23.2"
BASIC_MEMORY_WRAPPER="$SCRIPT_DIR/basic-memory-mcp.sh"
REQUIRED_PACKAGES=(python3-pyatspi ydotool wl-clipboard)

ok() { echo "OK: $*"; }
fail() { echo "MISSING/FAILED: $*" >&2; }

preflight_v2_config() {
  python3 - "$V2_CONFIG_DIR" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC" "$CLI_CONFIG" <<'PY'
import os
import sys

root, json_path, jsonc_path, cli_path = sys.argv[1:]
if os.path.exists(json_path) and os.path.exists(jsonc_path):
    raise SystemExit(f"both {json_path} and {jsonc_path} exist; consolidate them before setup")
def check(path, label):
    absolute = os.path.abspath(path)
    if os.path.islink(absolute):
        raise SystemExit(f"refusing symlinked {label}: {path}")
    parent = os.path.dirname(absolute)
    while parent != os.path.dirname(parent):
        if os.path.islink(parent):
            raise SystemExit(f"refusing symlink ancestor for {label}: {path}")
        parent = os.path.dirname(parent)
    if path == root and os.path.exists(path) and not os.path.isdir(path):
        raise SystemExit(f"config root is not a directory: {path}")
for path in (root, json_path, jsonc_path, cli_path):
    check(path, "config root" if path == root else "config file")
PY
}

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

github_auth_available() {
  command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1
}

global_mcp_config_path() {
  if [ -f "$OPENCODE_CONFIG_JSONC" ]; then
    printf '%s\n' "$OPENCODE_CONFIG_JSONC"
  else
    printf '%s\n' "$OPENCODE_CONFIG_JSON"
  fi
}

migrate_mcp_configs() {
  local global_config
  if has_conflicting_opencode_configs; then
    fail "both $OPENCODE_CONFIG_JSON and $OPENCODE_CONFIG_JSONC exist; consolidate them before MCP migration"
    return 1
  fi
  global_config="$(global_mcp_config_path)"
  python3 - "$global_config" "$PROJECT_CONFIG_JSON" "$GITHUB_MCP_WRAPPER" \
    "$BASIC_MEMORY_WRAPPER" "$LIVE_MCP_WRAPPER" "$SCRIPT_DIR/setup-opencode-jsonc.py" <<'PY'
import importlib.util
import json
import os
import sys
import tempfile

global_path, project_path, github, basic_memory, playwright, helper_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("setup_jsonc", helper_path)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load strict JSONC helper")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

def safe_target(path):
    absolute = os.path.abspath(path)
    if os.path.islink(absolute):
        raise ValueError(f"refusing symlinked config target: {path}")
    parent = os.path.dirname(absolute)
    while parent != os.path.dirname(parent):
        if os.path.islink(parent):
            raise ValueError(f"refusing config path with symlink ancestor: {path}")
        parent = os.path.dirname(parent)

def load(path, schema):
    safe_target(path)
    if not os.path.exists(path):
        return {"$schema": schema}
    value = helper.load_jsonc(path)
    if not isinstance(value, dict):
        raise ValueError(f"config is not an object: {path}")
    return value

def get_mcp(data):
    value = data.get("mcp")
    if value is None:
        value = {}; data["mcp"] = value
    if not isinstance(value, dict):
        raise ValueError("mcp is not an object")
    return value

def ensure_server(data, name, command):
    mcp = get_mcp(data)
    servers = mcp.get("servers")
    if servers is None:
        servers = {}; mcp["servers"] = servers
    if not isinstance(servers, dict):
        raise ValueError("mcp.servers is not an object")
    current = servers.get(name)
    if current is None:
        legacy = mcp.get(name)
        current = legacy if isinstance(legacy, dict) else {}
    if not isinstance(current, dict):
        raise ValueError(f"mcp.servers.{name} is not an object")
    entry = dict(current)
    entry["type"] = "local"
    entry["command"] = [command]
    entry["disabled"] = False
    timeout = entry.get("timeout")
    if timeout is None:
        timeout = {}
    if not isinstance(timeout, dict):
        raise ValueError(f"mcp.servers.{name}.timeout is not an object")
    timeout = dict(timeout)
    timeout.setdefault("startup", 30000)
    entry["timeout"] = timeout
    servers[name] = entry

def remove_legacy(data, remove_global_servers):
    mcp = get_mcp(data)
    for name in ("github", "playwright", "basic-memory"):
        mcp.pop(name, None)
    servers = mcp.get("servers")
    if isinstance(servers, dict) and not remove_global_servers:
        servers.pop("playwright", None)
    if remove_global_servers and isinstance(servers, dict):
        for name in ("github", "basic-memory"):
            servers.pop(name, None)

global_data = load(global_path, "https://opencode.ai/config.json")
project_data = load(project_path, "https://opencode.ai/config.json")
ensure_server(global_data, "github", github)
ensure_server(global_data, "basic-memory", basic_memory)
ensure_server(project_data, "playwright", playwright)
remove_legacy(global_data, False)
remove_legacy(project_data, True)

def write(path, data):
    safe_target(path)
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o644
    fd, temporary = tempfile.mkstemp(dir=directory, prefix=".mcp.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise

# Both files are parsed and validated before either is written.
write(global_path, global_data)
write(project_path, project_data)
print("OK: migrated OpenCode MCP registrations to v2 scopes")
PY
}

ensure_mcp() {
  local name="$1"
  local wrapper="$2"
  local scope="${3:-project}"
  if [ "$scope" = global ]; then
    ensure_global_mcp_entry "$name" "$wrapper" || return 1
    remove_project_mcp_entry "$name" || return 1
    if ! global_mcp_matches "$name" "$wrapper"; then
      fail "Global MCP $name was not bound to $wrapper in $(global_mcp_config_path)"
      return 1
    fi
    if project_mcp_has_entry "$name"; then
      fail "Project MCP $name still present; expected global-only"
      return 1
    fi
  else
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
  fi
  if ! mcp_config_matches "$name" "$wrapper"; then
    fail "OpenCode MCP $name was not bound to $wrapper"
    return 1
  fi
}

mcp_file_matches() {
  local path="$1"
  local name="$2"
  local wrapper="$3"
  [ -f "$path" ] || return 1
  python3 -c '
import importlib.util
import sys

path, name, wrapper, helper_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("setup_jsonc", helper_path)
if spec is None or spec.loader is None: raise SystemExit(1)
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
try:
    data = helper.load_jsonc(path)
except (OSError, ValueError):
    raise SystemExit(1)
mcp = data.get("mcp", {}) if isinstance(data, dict) else {}
servers = mcp.get("servers", {}) if isinstance(mcp, dict) else {}
entry = servers.get(name, {}) if isinstance(servers, dict) else {}
matches = (
    entry.get("type") == "local"
    and entry.get("command") == [wrapper]
    and entry.get("disabled", False) is not True
    and isinstance(entry.get("timeout"), dict)
    and entry["timeout"].get("startup") == 30000
)
raise SystemExit(0 if matches else 1)
  ' "$path" "$name" "$wrapper" "$SCRIPT_DIR/setup-opencode-jsonc.py" 2>/dev/null
}

mcp_file_has_entry() {
  local name="$1"
  shift
  python3 -c '
import importlib.util
import os
import sys

helper_path, name = sys.argv[1:3]
paths = sys.argv[3:]
spec = importlib.util.spec_from_file_location("setup_jsonc", helper_path)
if spec is None or spec.loader is None: raise SystemExit(1)
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
for path in paths:
    if not os.path.exists(path):
        continue
    try:
        data = helper.load_jsonc(path)
    except (OSError, ValueError):
        # Unparseable config needs manual review; treat as present.
        raise SystemExit(0)
    mcp = data.get("mcp", {}) if isinstance(data, dict) else None
    if not isinstance(mcp, dict):
        raise SystemExit(0)
    servers = mcp.get("servers", {})
    if not isinstance(servers, dict):
        raise SystemExit(0)
    if name in servers:
        raise SystemExit(0)
raise SystemExit(1)
  ' "$SCRIPT_DIR/setup-opencode-jsonc.py" "$name" "$@" 2>/dev/null
}

project_mcp_matches() {
  mcp_file_matches "$PROJECT_CONFIG_JSON" "$1" "$2"
}

global_mcp_matches() {
  mcp_file_matches "$(global_mcp_config_path)" "$1" "$2"
}

global_mcp_has_entry() {
  mcp_file_has_entry "$1" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC"
}

project_mcp_has_entry() {
  mcp_file_has_entry "$1" "$PROJECT_CONFIG_JSON"
}

mcp_file_has_legacy_entry() {
  local name="$1"
  shift
  python3 -c '
import importlib.util
import os
import sys

helper_path, name = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("setup_jsonc", helper_path)
if spec is None or spec.loader is None: raise SystemExit(1)
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
for path in sys.argv[3:]:
    if not os.path.exists(path):
        continue
    try:
        data = helper.load_jsonc(path)
    except (OSError, ValueError):
        raise SystemExit(0)
    mcp = data.get("mcp", {}) if isinstance(data, dict) else None
    if isinstance(mcp, dict) and name in mcp:
        raise SystemExit(0)
raise SystemExit(1)
  ' "$SCRIPT_DIR/setup-opencode-jsonc.py" "$name" "$@" 2>/dev/null
}

global_mcp_has_legacy_entry() {
  mcp_file_has_legacy_entry "$1" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC"
}

project_mcp_has_legacy_entry() {
  mcp_file_has_legacy_entry "$1" "$PROJECT_CONFIG_JSON"
}

write_mcp_entry() {
  local path="$1"
  local name="$2"
  local wrapper="$3"
  local label="$4"
  python3 -c '
import json
import os
import sys
import tempfile

path, name, wrapper, label = sys.argv[1:]
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
if mcp is None:
    mcp = {}
    data["mcp"] = mcp
elif not isinstance(mcp, dict):
    print(f"MISSING/FAILED: {path} mcp is not an object", file=sys.stderr)
    raise SystemExit(1)
servers = mcp.get("servers")
if servers is None:
    servers = {}
    mcp["servers"] = servers
elif not isinstance(servers, dict):
    print(f"MISSING/FAILED: {path} mcp.servers is not an object", file=sys.stderr)
    raise SystemExit(1)
current = servers.get(name)
entry = dict(current) if isinstance(current, dict) else {}
entry["type"] = "local"
entry["command"] = [wrapper]
entry["disabled"] = False
timeout = entry.get("timeout")
if not isinstance(timeout, dict):
    timeout = {}
timeout.setdefault("startup", 30000)
entry["timeout"] = timeout
if servers.get(name) == entry:
    raise SystemExit(0)
servers[name] = entry
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
print(f"OK: {label} MCP {name} -> {wrapper}")
' "$path" "$name" "$wrapper" "$label"
}

ensure_project_mcp_entry() {
  write_mcp_entry "$PROJECT_CONFIG_JSON" "$1" "$2" project
}

ensure_global_mcp_entry() {
  write_mcp_entry "$(global_mcp_config_path)" "$1" "$2" global
}

remove_mcp_entry_from() {
  local label="$1"
  local name="$2"
  shift 2
  python3 -c '
import json
import os
import sys
import tempfile

label, name = sys.argv[1], sys.argv[2]
paths = sys.argv[3:]
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
    if mcp is None:
        continue
    if not isinstance(mcp, dict):
        print(f"MISSING/FAILED: {path} mcp is not an object", file=sys.stderr)
        raise SystemExit(1)
    servers = mcp.get("servers")
    if servers is None:
        continue
    if not isinstance(servers, dict):
        print(f"MISSING/FAILED: {path} mcp.servers is not an object", file=sys.stderr)
        raise SystemExit(1)
    if name not in servers:
        continue
    del servers[name]
    if not servers:
        mcp.pop("servers", None)
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
    print(f"OK: removed {label} MCP {name} from {path}")
' "$label" "$name" "$@"
}

remove_global_mcp_entry() {
  remove_mcp_entry_from global "$1" "$OPENCODE_CONFIG_JSON" "$OPENCODE_CONFIG_JSONC"
}

remove_project_mcp_entry() {
  remove_mcp_entry_from project "$1" "$PROJECT_CONFIG_JSON"
}

mcp_config_matches() {
  local name="$1"
  local wrapper="$2"
  has_conflicting_opencode_configs && return 1
  project_mcp_matches "$name" "$wrapper" || global_mcp_matches "$name" "$wrapper"
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
  ensure_mcp github "$GITHUB_MCP_WRAPPER" global
}

initialize_local_state() {
  echo "=== skills ==="
  # Seed the complete examples before plugin deployment. Deploying first would
  # create minimal configs and prevent setup-opencode's seed guards from
  # installing MCP declarations, theme, and other canonical defaults.
  "$SCRIPT_DIR/setup-opencode.sh" --config-dir "$V2_CONFIG_DIR" --prepare
  echo "=== v2 plugins ==="
  "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$V2_CONFIG_DIR" --plugins all --apply
  echo "=== MCP migration ==="
  migrate_mcp_configs
}

verify() {
  local status=0
  local package
  local mcp_list
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

  if ! command -v basic-memory >/dev/null 2>&1; then
    fail "Basic Memory $BASIC_MEMORY_VERSION (basic-memory not on PATH)"
    status=1
  elif ! basic-memory --version 2>&1 | grep -qF "$BASIC_MEMORY_VERSION"; then
    fail "Basic Memory $BASIC_MEMORY_VERSION (found: $(basic-memory --version 2>&1 | head -1))"
    status=1
  else
    ok "Basic Memory $BASIC_MEMORY_VERSION"
  fi

  if [ -x "$BASIC_MEMORY_WRAPPER" ] && "$BASIC_MEMORY_WRAPPER" --verify-only >/dev/null 2>&1; then
    ok "bounded Basic Memory MCP wrapper"
  else
    fail "bounded Basic Memory MCP wrapper ($BASIC_MEMORY_WRAPPER --verify-only)"
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
    # Preserve an explicit caller project-config opt-out. The shared service
    # can still prove global MCP health; only the project-only Playwright
    # connection is deferred below when that opt-out is active.
    mcp_list="$( (cd "$REPO_ROOT" 2>/dev/null; OPENCODE_CONFIG_DIR="$V2_CONFIG_DIR" "$OPENCODE_BIN" mcp list 2>&1) || true )"
  fi
  if [ "${OPENCODE_DISABLE_PROJECT_CONFIG:-}" = 1 ]; then
    ok "OpenCode live Playwright MCP check deferred (project config explicitly disabled by caller)"
  elif printf '%s\n' "$mcp_list" | grep -q 'playwright .*connected'; then
    ok "OpenCode live Playwright MCP connected"
  else
    fail "OpenCode live Playwright MCP connection"
    status=1
  fi

  if [ -n "${GITHUB_PERSONAL_ACCESS_TOKEN:-}${GH_TOKEN:-}" ] || github_auth_available; then
    if printf '%s\n' "$mcp_list" | grep -q 'github .*connected'; then
      ok "OpenCode GitHub MCP connected"
    else
      fail "OpenCode GitHub MCP connection"
      status=1
    fi
  else
    ok "GitHub MCP authentication pending (run 'gh auth login' or set GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN before starting OpenCode)"
  fi

  if project_mcp_matches playwright "$LIVE_MCP_WRAPPER"; then
    ok "Project live Playwright MCP uses local pinned wrapper"
  else
    fail "Project live Playwright MCP command is not $LIVE_MCP_WRAPPER in $PROJECT_CONFIG_JSON"
    status=1
  fi

  if global_mcp_matches github "$GITHUB_MCP_WRAPPER"; then
    ok "Global GitHub MCP uses local pinned wrapper"
  else
    fail "Global GitHub MCP command is not $GITHUB_MCP_WRAPPER in $(global_mcp_config_path)"
    status=1
  fi

  if global_mcp_matches basic-memory "$BASIC_MEMORY_WRAPPER"; then
    ok "Global Basic Memory MCP uses bounded local wrapper"
  else
    fail "Global Basic Memory MCP command is not $BASIC_MEMORY_WRAPPER in $(global_mcp_config_path)"
    status=1
  fi

  if global_mcp_has_entry playwright; then
    fail "Global Playwright MCP present; expected project-only in $PROJECT_CONFIG_JSON"
    status=1
  else
    ok "Global Playwright MCP absent (project-only)"
  fi

  for name in github playwright basic-memory; do
    if global_mcp_has_legacy_entry "$name"; then
      fail "legacy flat global MCP key remains: mcp.$name"
      status=1
    else
      ok "legacy flat global MCP key absent: mcp.$name"
    fi
  done

  if project_mcp_has_entry github; then
    fail "Project GitHub MCP present; expected global in $(global_mcp_config_path)"
    status=1
  else
    ok "Project GitHub MCP absent (global)"
  fi

  for name in github basic-memory; do
    if project_mcp_has_entry "$name" || project_mcp_has_legacy_entry "$name"; then
      fail "Global-only MCP $name remains in project config"
      status=1
    else
      ok "Global-only MCP $name absent from project config"
    fi
  done
  if project_mcp_has_legacy_entry playwright; then
    fail "legacy flat project MCP key remains: mcp.playwright"
    status=1
  else
    ok "legacy flat project MCP key absent: mcp.playwright"
  fi

  if mcp_config_matches playwright "$LIVE_MCP_WRAPPER"; then
    ok "OpenCode live Playwright MCP uses local pinned wrapper"
  else
    fail "OpenCode live Playwright MCP command is not $LIVE_MCP_WRAPPER"
    status=1
  fi

  if mcp_config_matches github "$GITHUB_MCP_WRAPPER"; then
    ok "OpenCode GitHub MCP uses local pinned wrapper"
  else
    fail "OpenCode GitHub MCP command is not $GITHUB_MCP_WRAPPER"
    status=1
  fi

  if "$SCRIPT_DIR/setup-opencode.sh" --config-dir "$V2_CONFIG_DIR" --verify-only >/dev/null; then
    ok "all OpenCode skills, commands, and tools deployed"
  else
    fail "OpenCode skills, commands, or tools missing/stale"
    status=1
  fi

  if "$SCRIPT_DIR/deploy-plugins.sh" --config-dir "$V2_CONFIG_DIR" --plugins all --verify-only >/dev/null; then
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
  install_browser_runtime
  install_github_runtime
fi

verify
