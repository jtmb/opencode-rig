#!/usr/bin/env bash
# Deploy the local OpenCode plugins, and optionally copy the bootstrap scripts,
# to the global OpenCode config or a project's .opencode directory.
#
# v1 registration points at this checkout with file:// URLs; it does not copy
# the plugin sources. With --v2, the plugins-v2 packages register as object
# entries in a v2 config directory (server plugins in opencode.jsonc, CLI
# plugins in cli.json). Existing plugin entries and their options are preserved.
#
# Read-only verification is the default. Use --apply to write.
#
# Usage:
#   ./deploy-plugins.sh --scope global --verify-only
#   ./deploy-plugins.sh --scope global --apply
#   ./deploy-plugins.sh --scope project --project ~/repos/example --apply
#   ./deploy-plugins.sh --scope project --project . --bootstrap --apply
#   ./deploy-plugins.sh --scope global --plugins source-control --apply
#   ./deploy-plugins.sh --scope global --plugins all --apply
#   ./deploy-plugins.sh --scope global --plugins codex-fallback --chain a/b,c/d --apply
#   ./deploy-plugins.sh --v2 --plugins all --verify-only
#   ./deploy-plugins.sh --v2 --config-dir ~/.opencode-v2-pilot/config --plugins all --apply
set -euo pipefail

APPLY=0
MODE_SET=0
SCOPE=""
OPT_PROJECT=""
PLUGINS="both"
BOOTSTRAP=0
CHAIN=""
PLUGIN_STATUS=0
V2=0
V2_CONFIG_SET=0
V2_CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"

usage() {
  cat <<'EOF'
Usage: deploy-plugins.sh --scope global|project [options]
       deploy-plugins.sh --v2 [--config-dir DIR] [options]

Options:
  --scope global|project   Where to deploy the v1 plugins (required without --v2)
  --project DIR            Target repository for --scope project
  --v2                     Register the plugins-v2 packages in a v2 config directory
  --config-dir DIR         v2 target directory (default: $OPENCODE_V2_CONFIG_DIR,
                           else $OPENCODE_V2_PILOT_DIR/config, else
                           ~/.opencode-v2-pilot/config)
  --plugins LIST           v1: both (default), all, source-control, tui-settings,
                           file-manager, codex-usage, or codex-fallback
                           v2: both (default), all, server, cli, or one of
                           rig-tools, rig-todo, codex-fallback, source-control,
                           codex-usage, file-manager
  --bootstrap              Also copy computer-use/scripts/ into the target (v1 only)
  --chain a/b,c/d          defaultChain written when adding codex-fallback
  --apply                  Write changes
  --verify-only            Check only (default)
  -h, --help               Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --scope)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      SCOPE="$2"; shift 2 ;;
    --scope=*) SCOPE="${1#*=}"; shift ;;
    --project)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      OPT_PROJECT="$2"; shift 2 ;;
    --project=*) OPT_PROJECT="${1#*=}"; shift ;;
    --plugins)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      PLUGINS="$2"; shift 2 ;;
    --plugins=*) PLUGINS="${1#*=}"; shift ;;
    --bootstrap) BOOTSTRAP=1; shift ;;
    --v2) V2=1; shift ;;
    --config-dir)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      V2_CONFIG_DIR="$2"; V2_CONFIG_SET=1; shift 2 ;;
    --config-dir=*) V2_CONFIG_DIR="${1#*=}"; V2_CONFIG_SET=1; shift ;;
    --chain)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      CHAIN="$2"; shift 2 ;;
    --chain=*) CHAIN="${1#*=}"; shift ;;
    --apply)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=1; MODE_SET=1; shift ;;
    --verify-only)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=0; MODE_SET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [ "$V2" -eq 1 ]; then
  case "$SCOPE" in
    ""|global) SCOPE="global" ;;
    project) echo "ERROR: --scope project is not supported with --v2" >&2; exit 2 ;;
  esac
  if [ "$BOOTSTRAP" -eq 1 ]; then
    echo "ERROR: --bootstrap is not supported with --v2" >&2
    exit 2
  fi
  case "$PLUGINS" in
    both|all|server|cli) ;;
    ''|*[!a-z0-9-]*) echo "ERROR: with --v2 --plugins must be both, all, server, cli, or a catalog package name" >&2; exit 2 ;;
  esac
else
  if [ "$V2_CONFIG_SET" -eq 1 ]; then
    echo "ERROR: --config-dir requires --v2" >&2
    exit 2
  fi
  case "$SCOPE" in
    global|project) ;;
    *) usage >&2; exit 2 ;;
  esac
  case "$PLUGINS" in
    both|all|source-control|tui-settings|file-manager|codex-usage|codex-fallback) ;;
    *) echo "ERROR: --plugins must be both, all, source-control, tui-settings, file-manager, codex-usage, or codex-fallback" >&2; exit 2 ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPUTER_USE_ROOT/../../../.." && pwd)"
TUI_MODULE="$COMPUTER_USE_ROOT/plugins/codex-usage/src/tui.tsx"
SERVER_MODULE="$COMPUTER_USE_ROOT/plugins/codex-fallback/src/index.ts"
SOURCE_CONTROL_MODULE="$COMPUTER_USE_ROOT/plugins/source-control/src/tui.tsx"
TUI_SETTINGS_MODULE="$COMPUTER_USE_ROOT/plugins/tui-settings/src/tui.tsx"
FILE_MANAGER_MODULE="$COMPUTER_USE_ROOT/plugins/file-manager/src/tui.tsx"
V2_ROLE_CATALOG="${OPENCODE_V2_ROLE_CATALOG:-$COMPUTER_USE_ROOT/config/v2-plugin-roles.json}"
V2_CATALOG_TOOL="$SCRIPT_DIR/v2-plugin-catalog.py"

declare -a V2_CATALOG_NAMES=()
declare -a V2_SELECTED_NAMES=()
declare -A V2_PACKAGE_FOR=()
declare -A V2_ENTRYPOINT_FOR=()
declare -A V2_CONFIG_FOR=()
declare -A V2_ROLE_FOR=()
declare -A V2_SELECTED_FOR=()

if [ "$V2" -eq 0 ]; then
  [ -f "$TUI_MODULE" ] || { echo "ERROR: missing plugin entrypoint: $TUI_MODULE" >&2; exit 1; }
  [ -f "$SERVER_MODULE" ] || { echo "ERROR: missing plugin entrypoint: $SERVER_MODULE" >&2; exit 1; }
fi

if [ "$V2" -eq 1 ]; then
  [ -f "$V2_ROLE_CATALOG" ] || { echo "ERROR: missing v2 role catalog: $V2_ROLE_CATALOG" >&2; exit 1; }
  [ -f "$V2_CATALOG_TOOL" ] || { echo "ERROR: missing v2 catalog validator: $V2_CATALOG_TOOL" >&2; exit 1; }
  V2_CATALOG_ROWS="$(python3 "$V2_CATALOG_TOOL" --catalog "$V2_ROLE_CATALOG" --root "$COMPUTER_USE_ROOT" --rows)"
  while IFS=$'\t' read -r name role package entrypoint config; do
    [ -n "$name" ] || continue
    if [ -z "${V2_PACKAGE_FOR[$name]+present}" ]; then
      V2_CATALOG_NAMES+=("$name")
      V2_PACKAGE_FOR["$name"]="$package"
    fi
    V2_ENTRYPOINT_FOR["$name:$role"]="$entrypoint"
    V2_CONFIG_FOR["$name:$role"]="$config"
    V2_ROLE_FOR["$name:$role"]=1
  done <<< "$V2_CATALOG_ROWS"
fi

if [ "$V2" -eq 1 ]; then
  TARGET_ROOT="$V2_CONFIG_DIR"
  SERVER_CONFIG="$TARGET_ROOT/opencode.jsonc"
  CLI_CONFIG="$TARGET_ROOT/cli.json"
elif [ "$SCOPE" = project ]; then
  [ -n "$OPT_PROJECT" ] || { echo "ERROR: --project DIR is required with --scope project" >&2; exit 2; }
  [ -d "$OPT_PROJECT" ] || { echo "ERROR: project directory not found: $OPT_PROJECT" >&2; exit 2; }
  PROJECT_DIR="$(cd "$OPT_PROJECT" && pwd)"
  TARGET_ROOT="$PROJECT_DIR/.opencode"
  if [ -f "$TARGET_ROOT/tui.jsonc" ]; then TUI_CONFIG="$TARGET_ROOT/tui.jsonc"; else TUI_CONFIG="$TARGET_ROOT/tui.json"; fi
  SERVER_CONFIG="$TARGET_ROOT/opencode.json"
else
  TARGET_ROOT="$HOME/.config/opencode"
  if [ -f "$TARGET_ROOT/tui.jsonc" ]; then TUI_CONFIG="$TARGET_ROOT/tui.jsonc"; else TUI_CONFIG="$TARGET_ROOT/tui.json"; fi
  if [ -f "$TARGET_ROOT/opencode.jsonc" ]; then
    SERVER_CONFIG="$TARGET_ROOT/opencode.jsonc"
  else
    SERVER_CONFIG="$TARGET_ROOT/opencode.json"
  fi
fi
SCRIPTS_DEST="$TARGET_ROOT/scripts"

ok() { echo "OK: $*"; }
fail() { echo "MISSING/STALE: $*" >&2; }

check_config() {
  local path="$1"
  local spec="$2"
  local label="$3"
  local result
  if [ ! -f "$path" ]; then
    fail "$label config not found: $path"
    PLUGIN_STATUS=1
    return 0
  fi
  result="$(python3 - "$path" "$spec" <<'PY'
import json
import os
import sys

path, spec = sys.argv[1], sys.argv[2]
target = os.path.realpath(spec[7:] if spec.startswith("file://") else spec)
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    print("invalid")
    raise SystemExit(0)
if not isinstance(data, dict):
    print("invalid")
    raise SystemExit(0)
entries = data.get("plugin")
if not isinstance(entries, list):
    print("missing")
    raise SystemExit(0)
for entry in entries:
    candidate = None
    if isinstance(entry, str):
        candidate = entry
    elif isinstance(entry, list) and entry and isinstance(entry[0], str):
        candidate = entry[0]
    if candidate is None:
        continue
    candidate_path = candidate[7:] if candidate.startswith("file://") else candidate
    if not os.path.isabs(candidate_path):
        candidate_path = os.path.join(os.path.dirname(path), candidate_path)
    if os.path.realpath(candidate_path) == target:
        print("present")
        raise SystemExit(0)
print("missing")
PY
)"
  case "$result" in
    present) ok "$label plugin registered in $path" ;;
    missing) fail "$label plugin not registered in $path"; PLUGIN_STATUS=1 ;;
    *) fail "$label config is not editable JSON (comments?): $path"; PLUGIN_STATUS=1 ;;
  esac
}

apply_config() {
  local path="$1"
  local schema="$2"
  local spec="$3"
  local options_json="$4"
  local label="$5"
  local result
  mkdir -p "$(dirname "$path")"
  result="$(python3 - "$path" "$schema" "$spec" "$options_json" <<'PY'
import json
import os
import sys
import tempfile

path, schema, spec, options_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
options = json.loads(options_json) if options_json.strip() else None
target = os.path.realpath(spec[7:] if spec.startswith("file://") else spec)

if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"invalid: {exc}")
        raise SystemExit(0)
    if not isinstance(data, dict):
        print("invalid: config is not a JSON object")
        raise SystemExit(0)
else:
    data = {"$schema": schema}

entries = data.get("plugin")
if not isinstance(entries, list):
    entries = []
    data["plugin"] = entries

present = False
for entry in entries:
    candidate = None
    if isinstance(entry, str):
        candidate = entry
    elif isinstance(entry, list) and entry and isinstance(entry[0], str):
        candidate = entry[0]
    if candidate is None:
        continue
    candidate_path = candidate[7:] if candidate.startswith("file://") else candidate
    if not os.path.isabs(candidate_path):
        candidate_path = os.path.join(os.path.dirname(path), candidate_path)
    if os.path.realpath(candidate_path) == target:
        present = True
        break
if present:
    print("present")
    raise SystemExit(0)

entries.append([spec, options] if options else spec)

directory = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".deploy.", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.chmod(tmp, (os.stat(path).st_mode & 0o777) if os.path.exists(path) else 0o644)
    os.replace(tmp, path)
except OSError as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    print(f"error: {exc}")
    raise SystemExit(0)
print("added")
PY
)"
  case "$result" in
    present) ok "$label plugin already present in $path" ;;
    added) ok "$label plugin entry written to $path" ;;
    *) fail "$label config could not be updated ($result)"; PLUGIN_STATUS=1 ;;
  esac
}

check_config_v2() {
  local path="$1"
  local package_dir="$2"
  local label="$3"
  local result
  if [ ! -f "$path" ]; then
    fail "$label config not found: $path (run setup-opencode-v2.sh --apply first)"
    PLUGIN_STATUS=1
    return 0
  fi
  result="$(python3 - "$path" "$package_dir" <<'PY'
import json
import os
import sys

path, package = sys.argv[1], sys.argv[2]
target = os.path.realpath(package)
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    print("invalid")
    raise SystemExit(0)
entries = data.get("plugins") if isinstance(data, dict) else None
if not isinstance(entries, list):
    print("missing")
    raise SystemExit(0)
matches = 0
for entry in entries:
    if not isinstance(entry, dict) or not isinstance(entry.get("package"), str):
        print("malformed")
        raise SystemExit(0)
    candidate = entry["package"]
    if not os.path.isabs(candidate) or candidate != os.path.realpath(candidate):
        print("malformed")
        raise SystemExit(0)
    if os.path.realpath(candidate) == target:
        matches += 1
if matches > 1:
    print("duplicate")
elif matches == 1:
    print("present")
else:
    print("missing")
PY
)"
  case "$result" in
    present) ok "$label plugin registered in $path" ;;
    missing) fail "$label plugin not registered in $path"; PLUGIN_STATUS=1 ;;
    duplicate) fail "$label plugin is registered more than once in $path"; PLUGIN_STATUS=1 ;;
    malformed) fail "$label config contains a malformed or non-canonical plugin entry: $path"; PLUGIN_STATUS=1 ;;
    *) fail "$label config is not editable JSON (comments?): $path"; PLUGIN_STATUS=1 ;;
  esac
}

apply_config_v2() {
  local path="$1"
  local schema="$2"
  local package_dir="$3"
  local options_json="$4"
  local label="$5"
  local result
  mkdir -p "$(dirname "$path")"
  result="$(python3 - "$path" "$schema" "$package_dir" "$options_json" <<'PY'
import json
import os
import sys
import tempfile

path, schema, package, options_json = sys.argv[1:5]
options = json.loads(options_json) if options_json.strip() else {}
target = os.path.realpath(package)

if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"invalid: {exc}")
        raise SystemExit(0)
    if not isinstance(data, dict):
        print("invalid: config is not a JSON object")
        raise SystemExit(0)
else:
    data = {"$schema": schema}

entries = data.get("plugins")
if not isinstance(entries, list):
    if "plugins" in data:
        print("invalid: plugins must be a list")
        raise SystemExit(0)
    entries = []
    data["plugins"] = entries

matches = 0
for entry in entries:
    if not isinstance(entry, dict) or not isinstance(entry.get("package"), str):
        print("invalid: plugins contains a malformed entry")
        raise SystemExit(0)
    candidate = entry["package"]
    if not os.path.isabs(candidate) or candidate != os.path.realpath(candidate):
        print("invalid: plugins contains a non-canonical package path")
        raise SystemExit(0)
    if os.path.realpath(candidate) == target:
        matches += 1
if matches > 1:
    print("invalid: package is duplicated")
    raise SystemExit(0)
if matches == 1:
    print("present")
    raise SystemExit(0)

entries.append({"package": package, "options": options})

directory = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".deploy.", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.chmod(tmp, (os.stat(path).st_mode & 0o777) if os.path.exists(path) else 0o644)
    os.replace(tmp, path)
except OSError as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    print(f"error: {exc}")
    raise SystemExit(0)
print("added")
PY
)"
  case "$result" in
    present) ok "$label plugin already present in $path" ;;
    added) ok "$label plugin entry written to $path" ;;
    *) fail "$label config could not be updated ($result)"; PLUGIN_STATUS=1 ;;
  esac
}

fallback_chained_v2() {
  local path="$1"
  local package_dir="$2"
  python3 - "$path" "$package_dir" <<'PY'
import json
import os
import sys

path, package = sys.argv[1], sys.argv[2]
target = os.path.realpath(package)
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    raise SystemExit(1)
entries = data.get("plugins") if isinstance(data, dict) else None
if not isinstance(entries, list):
    raise SystemExit(1)
for entry in entries:
    if not isinstance(entry, dict):
        continue
    candidate = entry.get("package")
    if not isinstance(candidate, str) or os.path.realpath(candidate) != target:
        continue
    options = entry.get("options") if isinstance(entry.get("options"), dict) else {}
    chain = options.get("defaultChain")
    raise SystemExit(0 if isinstance(chain, list) and chain else 1)
raise SystemExit(1)
PY
}

copy_scripts_check() {
  local dest="$1"
  local status=0
  local src rel dst
  while IFS= read -r -d '' src; do
    rel="${src#"$SCRIPT_DIR/"}"
    case "$rel" in __pycache__/*|*/__pycache__/*) continue ;; esac
    if [ -L "$src" ]; then
      fail "bootstrap source is a symbolic link: $src"
      status=1
      continue
    fi
    dst="$dest/$rel"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      continue
    fi
    fail "bootstrap script missing/stale: $dst"
    status=1
  done < <(find "$SCRIPT_DIR" -type f -print0 | sort -z)
  if [ "$status" -eq 0 ]; then
    ok "bootstrap scripts current in $dest"
  fi
  return "$status"
}

copy_scripts_apply() {
  local dest="$1"
  local src rel dst
  mkdir -p "$dest"
  while IFS= read -r -d '' src; do
    rel="${src#"$SCRIPT_DIR/"}"
    case "$rel" in __pycache__/*|*/__pycache__/*) continue ;; esac
    if [ -L "$src" ]; then
      fail "bootstrap source is a symbolic link: $src"
      return 1
    fi
    dst="$dest/$rel"
    mkdir -p "$(dirname "$dst")"
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
      continue
    fi
    cp -p "$src" "$dst"
    ok "copied bootstrap script $rel"
  done < <(find "$SCRIPT_DIR" -type f -print0 | sort -z)
}

chain_options() {
  if [ -n "$CHAIN" ]; then
    python3 -c 'import json,sys; print(json.dumps({"defaultChain": [p.strip() for p in sys.argv[1].split(",") if p.strip()]}))' "$CHAIN"
  fi
}

fallback_chained() {
  local path="$1"
  python3 - "$path" "file://$SERVER_MODULE" <<'PY'
import json
import os
import sys

path, spec = sys.argv[1], sys.argv[2]
target = os.path.realpath(spec[7:] if spec.startswith("file://") else spec)
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
except (OSError, ValueError):
    raise SystemExit(1)
entries = data.get("plugin") if isinstance(data, dict) else None
if not isinstance(entries, list):
    raise SystemExit(1)
for entry in entries:
    if not (isinstance(entry, list) and entry and isinstance(entry[0], str)):
        continue
    candidate = entry[0][7:] if entry[0].startswith("file://") else entry[0]
    if not os.path.isabs(candidate):
        candidate = os.path.join(os.path.dirname(path), candidate)
    if os.path.realpath(candidate) != target:
        continue
    options = entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {}
    chain = options.get("defaultChain")
    raise SystemExit(0 if isinstance(chain, list) and chain else 1)
raise SystemExit(1)
PY
}

want_usage=0
want_fallback=0
want_source_control=0
want_tui_settings=0
want_file_manager=0

v2_select_name() {
  local name="$1"
  if [ -z "${V2_PACKAGE_FOR[$name]+present}" ]; then
    echo "ERROR: package is not present in the v2 role catalog: $name" >&2
    exit 2
  fi
  if [ -z "${V2_SELECTED_FOR[$name]+present}" ]; then
    V2_SELECTED_NAMES+=("$name")
    V2_SELECTED_FOR["$name"]=1
  fi
}

v2_select_role() {
  local role="$1"
  local name
  for name in "${V2_CATALOG_NAMES[@]}"; do
    if [ -n "${V2_ROLE_FOR[$name:$role]+present}" ]; then
      v2_select_name "$name"
    fi
  done
}

v2_role_selected() {
  case "$PLUGINS:$1" in
    server:cli|cli:server) return 1 ;;
    *) return 0 ;;
  esac
}

v2_config_for_role() {
  case "$1" in
    server) printf '%s\n' "$SERVER_CONFIG" ;;
    cli) printf '%s\n' "$CLI_CONFIG" ;;
    *) return 1 ;;
  esac
}

v2_schema_for_role() {
  case "$1" in
    server) printf '%s\n' "https://opencode.ai/config.json" ;;
    cli) printf '%s\n' "https://opencode.ai/v2/cli.json" ;;
    *) return 1 ;;
  esac
}

v2_options_for() {
  case "$1" in
    codex-fallback) chain_options ;;
    source-control) printf '%s\n' '{"github":true,"whenEmpty":"show"}' ;;
    *) printf '%s\n' '{}' ;;
  esac
}

if [ "$V2" -eq 1 ]; then
  case "$PLUGINS" in
    both) v2_select_name codex-usage; v2_select_name codex-fallback ;;
    all) for name in "${V2_CATALOG_NAMES[@]}"; do v2_select_name "$name"; done ;;
    server) v2_select_role server ;;
    cli) v2_select_role cli ;;
    *) v2_select_name "$PLUGINS" ;;
  esac
else
  case "$PLUGINS" in
    both) want_usage=1; want_fallback=1 ;;
    all) want_usage=1; want_fallback=1; want_source_control=1; want_tui_settings=1; want_file_manager=1 ;;
    codex-usage) want_usage=1 ;;
    codex-fallback) want_fallback=1 ;;
    source-control) want_source_control=1 ;;
    tui-settings) want_tui_settings=1 ;;
    file-manager) want_file_manager=1 ;;
  esac
fi

if [ "$V2" -eq 1 ]; then
  for name in "${V2_SELECTED_NAMES[@]}"; do
    for role in server cli; do
      key="$name:$role"
      if [ -n "${V2_ENTRYPOINT_FOR[$key]+present}" ] && v2_role_selected "$role"; then
        entrypoint="${V2_ENTRYPOINT_FOR[$key]}"
        expected_config="${V2_CONFIG_FOR[$key]}"
        config_path="$(v2_config_for_role "$role")"
        if [ ! -f "$entrypoint" ]; then
          echo "ERROR: missing plugin role entrypoint: $entrypoint" >&2
          exit 1
        fi
        if [ "$(basename -- "$config_path")" != "$expected_config" ]; then
          echo "ERROR: catalog expects $expected_config for $name ($role), but deployment targets $config_path" >&2
          exit 1
        fi
      fi
    done
  done
else
  if [ "$want_source_control" -eq 1 ] && [ ! -f "$SOURCE_CONTROL_MODULE" ]; then
    echo "ERROR: missing plugin entrypoint: $SOURCE_CONTROL_MODULE" >&2
    exit 1
  fi
  if [ "$want_tui_settings" -eq 1 ] && [ ! -f "$TUI_SETTINGS_MODULE" ]; then
    echo "ERROR: missing plugin entrypoint: $TUI_SETTINGS_MODULE" >&2
    exit 1
  fi
  if [ "$want_file_manager" -eq 1 ] && [ ! -f "$FILE_MANAGER_MODULE" ]; then
    echo "ERROR: missing plugin entrypoint: $FILE_MANAGER_MODULE" >&2
    exit 1
  fi
fi

if [ "$APPLY" -eq 1 ]; then
  if [ "$V2" -eq 1 ]; then
    for name in "${V2_SELECTED_NAMES[@]}"; do
      for role in server cli; do
        key="$name:$role"
        if [ -n "${V2_ENTRYPOINT_FOR[$key]+present}" ] && v2_role_selected "$role"; then
          config_path="$(v2_config_for_role "$role")"
          schema="$(v2_schema_for_role "$role")"
          apply_config_v2 "$config_path" "$schema" "${V2_PACKAGE_FOR[$name]}" "$(v2_options_for "$name")" "$name ($role)"
        fi
      done
    done
  else
    if [ "$want_usage" -eq 1 ]; then
      apply_config "$TUI_CONFIG" "https://opencode.ai/tui.json" "file://$TUI_MODULE" "" "codex-usage"
    fi
    if [ "$want_fallback" -eq 1 ]; then
      apply_config "$SERVER_CONFIG" "https://opencode.ai/config.json" "file://$SERVER_MODULE" "$(chain_options)" "codex-fallback"
    fi
    if [ "$want_source_control" -eq 1 ]; then
      apply_config "$TUI_CONFIG" "https://opencode.ai/tui.json" "file://$SOURCE_CONTROL_MODULE" '{"github":true}' "source-control"
    fi
    if [ "$want_tui_settings" -eq 1 ]; then
      apply_config "$TUI_CONFIG" "https://opencode.ai/tui.json" "file://$TUI_SETTINGS_MODULE" '{"order":10}' "tui-settings"
    fi
    if [ "$want_file_manager" -eq 1 ]; then
      apply_config "$TUI_CONFIG" "https://opencode.ai/tui.json" "file://$FILE_MANAGER_MODULE" '{"order":60}' "file-manager"
    fi
    if [ "$BOOTSTRAP" -eq 1 ]; then
      copy_scripts_apply "$SCRIPTS_DEST" || PLUGIN_STATUS=1
    fi
  fi
  echo "--- verify ---"
fi

if [ "$V2" -eq 1 ]; then
  for name in "${V2_SELECTED_NAMES[@]}"; do
    for role in server cli; do
      key="$name:$role"
      if [ -n "${V2_ENTRYPOINT_FOR[$key]+present}" ] && v2_role_selected "$role"; then
        check_config_v2 "$(v2_config_for_role "$role")" "${V2_PACKAGE_FOR[$name]}" "$name ($role)"
      fi
    done
  done
  if [ -n "${V2_SELECTED_FOR[codex-fallback]+present}" ] && ! fallback_chained_v2 "$SERVER_CONFIG" "${V2_PACKAGE_FOR[codex-fallback]}"; then
    echo "NOTICE: codex-fallback has no defaultChain configured and stays inactive (see plugins-v2/codex-fallback/README.md)."
  fi
else
  if [ "$want_usage" -eq 1 ]; then
    check_config "$TUI_CONFIG" "file://$TUI_MODULE" "codex-usage"
  fi
  if [ "$want_fallback" -eq 1 ]; then
    check_config "$SERVER_CONFIG" "file://$SERVER_MODULE" "codex-fallback"
  fi
  if [ "$want_source_control" -eq 1 ]; then
    check_config "$TUI_CONFIG" "file://$SOURCE_CONTROL_MODULE" "source-control"
  fi
  if [ "$want_tui_settings" -eq 1 ]; then
    check_config "$TUI_CONFIG" "file://$TUI_SETTINGS_MODULE" "tui-settings"
  fi
  if [ "$want_file_manager" -eq 1 ]; then
    check_config "$TUI_CONFIG" "file://$FILE_MANAGER_MODULE" "file-manager"
  fi
  if [ "$BOOTSTRAP" -eq 1 ]; then
    copy_scripts_check "$SCRIPTS_DEST" || PLUGIN_STATUS=1
    echo "NOTICE: bootstrap scripts are a verbatim copy; end-to-end provisioning still runs from $REPO_ROOT."
  fi
  if [ "$want_fallback" -eq 1 ] && ! fallback_chained "$SERVER_CONFIG"; then
    echo "NOTICE: codex-fallback has no defaultChain configured and stays inactive (see plugins/codex-fallback/README.md)."
  fi
fi

echo ""
if [ "$PLUGIN_STATUS" -eq 0 ]; then
  echo "Done. Restart OpenCode to load plugin registration changes."
else
  echo "Deployment incomplete; see MISSING/STALE lines above." >&2
fi
exit "$PLUGIN_STATUS"
