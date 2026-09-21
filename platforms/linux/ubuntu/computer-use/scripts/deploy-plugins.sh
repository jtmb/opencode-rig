#!/usr/bin/env bash
# Register the repository's OpenCode v2 plugins in a v2 config directory.
# Verification is the default; --apply writes atomically and preserves existing entries/options.
set -euo pipefail

APPLY=0
MODE_SET=0
PLUGINS="both"
CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"
CLI_CONFIG=""

usage() {
  cat <<'EOF'
Usage: deploy-plugins.sh [--config-dir DIR] [--cli-config FILE] [--plugins LIST] [--apply|--verify-only]

Options:
  --config-dir DIR  v2 target directory (default: $OPENCODE_V2_CONFIG_DIR,
                     else $OPENCODE_V2_PILOT_DIR/config, else ~/.opencode-v2-pilot/config)
  --cli-config FILE Override the CLI config path (default: DIR/cli.json). This
                     supports isolated profiles whose CLI uses a separate XDG root.
  --plugins LIST    both (default), all, server, cli, or a catalog package name
  --chain a/b,c/d   defaultChain written when adding codex-fallback
  --apply           Write changes
  --verify-only     Check only (default)
  -h, --help        Show this help
EOF
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config-dir) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; CONFIG_DIR="$2"; shift 2 ;;
    --config-dir=*) CONFIG_DIR="${1#*=}"; shift ;;
    --cli-config) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; CLI_CONFIG="$2"; shift 2 ;;
    --cli-config=*) CLI_CONFIG="${1#*=}"; shift ;;
    --plugins) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; PLUGINS="$2"; shift 2 ;;
    --plugins=*) PLUGINS="${1#*=}"; shift ;;
    --chain) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; CHAIN="$2"; shift 2 ;;
    --chain=*) CHAIN="${1#*=}"; shift ;;
    --apply) [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }; APPLY=1; MODE_SET=1; shift ;;
    --verify-only) [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }; APPLY=0; MODE_SET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$CONFIG_DIR" ] || { echo "ERROR: --config-dir must not be empty" >&2; exit 2; }
CLI_CONFIG="${CLI_CONFIG:-$CONFIG_DIR/cli.json}"
[ -n "$CLI_CONFIG" ] || { echo "ERROR: --cli-config must not be empty" >&2; exit 2; }
case "$PLUGINS" in
  both|all|server|cli) ;;
  ''|*[!a-z0-9-]*) echo "ERROR: --plugins must be both, all, server, cli, or a catalog package name" >&2; exit 2 ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
V2_ROLE_CATALOG="${OPENCODE_V2_ROLE_CATALOG:-$COMPUTER_USE_ROOT/config/v2-plugin-roles.json}"
V2_CATALOG_TOOL="$SCRIPT_DIR/v2-plugin-catalog.py"
TARGET_ROOT="$CONFIG_DIR"
SERVER_CONFIG="$TARGET_ROOT/opencode.jsonc"

preflight_config_paths() {
  python3 - "$TARGET_ROOT" "$SERVER_CONFIG" "$CLI_CONFIG" <<'PY'
import os
import sys

root, *files = sys.argv[1:]
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
for path in [root, *files]:
    check(path, "config root" if path == root else "config file")
PY
}

preflight_config_paths || exit 1
declare -a V2_CATALOG_NAMES=() V2_SELECTED_NAMES=()
declare -A V2_PACKAGE_FOR=() V2_ENTRYPOINT_FOR=() V2_CONFIG_FOR=() V2_ROLE_FOR=() V2_SELECTED_FOR=()
PLUGIN_STATUS=0
ok() { echo "OK: $*"; }
fail() { echo "MISSING/STALE: $*" >&2; }
[ -f "$V2_ROLE_CATALOG" ] || { echo "ERROR: missing v2 role catalog: $V2_ROLE_CATALOG" >&2; exit 1; }
[ -f "$V2_CATALOG_TOOL" ] || { echo "ERROR: missing v2 catalog validator: $V2_CATALOG_TOOL" >&2; exit 1; }
V2_CATALOG_ROWS="$(python3 "$V2_CATALOG_TOOL" --catalog "$V2_ROLE_CATALOG" --root "$COMPUTER_USE_ROOT" --rows)"
while IFS=$'\t' read -r name role package entrypoint config; do
  [ -n "$name" ] || continue
  if [ -z "${V2_PACKAGE_FOR[$name]+present}" ]; then V2_CATALOG_NAMES+=("$name"); V2_PACKAGE_FOR["$name"]="$package"; fi
  V2_ENTRYPOINT_FOR["$name:$role"]="$entrypoint"; V2_CONFIG_FOR["$name:$role"]="$config"; V2_ROLE_FOR["$name:$role"]=1
done <<< "$V2_CATALOG_ROWS"
check_config_v2() {
  local path="$1"
  local package_dir="$2"
  local label="$3"
  local result
  if [ ! -f "$path" ]; then
    fail "$label config not found: $path (run setup-opencode.sh --apply first)"
    PLUGIN_STATUS=1
    return 0
  fi
result="$(python3 - "$path" "$package_dir" <<'PY'
import json
import os
import sys

path, package = sys.argv[1], sys.argv[2]
target = os.path.realpath(package)

def load_jsonc(filename):
    text = open(filename, encoding="utf-8").read()
    out = []
    i = 0
    in_string = False
    escaped = False
    while i < len(text):
        char = text[i]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            i += 1
        elif text.startswith("//", i):
            newline = text.find("\n", i + 2)
            i = len(text) if newline < 0 else newline
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0:
                raise ValueError("unterminated block comment")
            i = end + 2
        else:
            out.append(char)
            i += 1
    if in_string:
        raise ValueError("unterminated string")
    cleaned = "".join(out)
    out = []
    i = 0
    in_string = False
    escaped = False
    while i < len(cleaned):
        char = cleaned[i]
        if in_string:
            out.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
        elif char == '"':
            in_string = True
            out.append(char)
            i += 1
        elif char == ',':
            j = i + 1
            while j < len(cleaned) and cleaned[j].isspace():
                j += 1
            if j < len(cleaned) and cleaned[j] in ']}':
                i += 1
            else:
                out.append(char)
                i += 1
        else:
            out.append(char)
            i += 1
    class Unique(dict):
        pass
    def pairs(items):
        result = Unique()
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result
    return json.loads("".join(out), object_pairs_hook=pairs)
try:
    data = load_jsonc(path)
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

def load_jsonc(filename):
    text = open(filename, encoding="utf-8").read()
    out, i, string, escaped = [], 0, False, False
    while i < len(text):
        c = text[i]
        if string:
            out.append(c)
            if escaped: escaped = False
            elif c == "\\": escaped = True
            elif c == '"': string = False
            i += 1; continue
        if c == '"': string = True; out.append(c); i += 1
        elif text.startswith("//", i):
            n = text.find("\n", i + 2); i = len(text) if n < 0 else n
        elif text.startswith("/*", i):
            n = text.find("*/", i + 2)
            if n < 0: raise ValueError("unterminated block comment")
            i = n + 2
        else: out.append(c); i += 1
    if string: raise ValueError("unterminated string")
    cleaned = "".join(out); out, i, string, escaped = [], 0, False, False
    while i < len(cleaned):
        c = cleaned[i]
        if string:
            out.append(c)
            if escaped: escaped = False
            elif c == "\\": escaped = True
            elif c == '"': string = False
            i += 1; continue
        if c == '"': string = True; out.append(c); i += 1
        elif c == ',':
            n = i + 1
            while n < len(cleaned) and cleaned[n].isspace(): n += 1
            if n < len(cleaned) and cleaned[n] in ']}': i += 1
            else: out.append(c); i += 1
        else: out.append(c); i += 1
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result
    return json.loads("".join(out), object_pairs_hook=pairs)

if os.path.exists(path):
    try:
        data = load_jsonc(path)
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

def load_jsonc(filename):
    text = open(filename, encoding="utf-8").read()
    out, i, string, escaped = [], 0, False, False
    while i < len(text):
        c = text[i]
        if string:
            out.append(c)
            if escaped: escaped = False
            elif c == "\\": escaped = True
            elif c == '"': string = False
            i += 1; continue
        if c == '"': string = True; out.append(c); i += 1
        elif text.startswith("//", i):
            n = text.find("\n", i + 2); i = len(text) if n < 0 else n
        elif text.startswith("/*", i):
            n = text.find("*/", i + 2)
            if n < 0: raise ValueError("unterminated block comment")
            i = n + 2
        else: out.append(c); i += 1
    if string: raise ValueError("unterminated string")
    cleaned = "".join(out); out, i, string, escaped = [], 0, False, False
    while i < len(cleaned):
        c = cleaned[i]
        if string:
            out.append(c)
            if escaped: escaped = False
            elif c == "\\": escaped = True
            elif c == '"': string = False
            i += 1; continue
        if c == '"': string = True; out.append(c); i += 1
        elif c == ',':
            n = i + 1
            while n < len(cleaned) and cleaned[n].isspace(): n += 1
            if n < len(cleaned) and cleaned[n] in ']}': i += 1
            else: out.append(c); i += 1
        else: out.append(c); i += 1
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result
    return json.loads("".join(out), object_pairs_hook=pairs)
try:
    data = load_jsonc(path)
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
chain_options() {
  if [ -n "${CHAIN:-}" ]; then
    python3 -c 'import json,sys; print(json.dumps({"defaultChain": [p.strip() for p in sys.argv[1].split(",") if p.strip()]}))' "$CHAIN"
  fi
}

ensure_rig_tools_permission() {
  [ -n "${V2_SELECTED_FOR[rig-tools]+present}" ] || return 0
  local result
  result="$(python3 - "$CLI_CONFIG" "$APPLY" <<'PY'
import json, os, sys, tempfile
path, applying = sys.argv[1], sys.argv[2] == "1"

def load_jsonc(filename):
    text = open(filename, encoding="utf-8").read(); out=[]; i=0; string=False; escaped=False
    while i < len(text):
        c=text[i]
        if string:
            out.append(c)
            if escaped: escaped=False
            elif c == "\\": escaped=True
            elif c == '"': string=False
            i+=1; continue
        if c == '"': string=True; out.append(c); i+=1
        elif text.startswith("//", i):
            n=text.find("\n", i+2); i=len(text) if n < 0 else n
        elif text.startswith("/*", i):
            n=text.find("*/", i+2)
            if n < 0: raise ValueError("unterminated block comment")
            i=n+2
        else: out.append(c); i+=1
    if string: raise ValueError("unterminated string")
    cleaned="".join(out); out=[]; i=0; string=False; escaped=False
    while i < len(cleaned):
        c=cleaned[i]
        if string:
            out.append(c)
            if escaped: escaped=False
            elif c == "\\": escaped=True
            elif c == '"': string=False
            i+=1; continue
        if c == '"': string=True; out.append(c); i+=1
        elif c == ',':
            n=i+1
            while n < len(cleaned) and cleaned[n].isspace(): n+=1
            if n < len(cleaned) and cleaned[n] in ']}': i+=1
            else: out.append(c); i+=1
        else: out.append(c); i+=1
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ValueError(f"duplicate key: {key}")
            result[key]=value
        return result
    return json.loads("".join(out), object_pairs_hook=pairs)

try:
    data = load_jsonc(path) if os.path.exists(path) else {"$schema": "https://opencode.ai/v2/cli.json"}
    if not isinstance(data, dict): raise ValueError("config is not a JSON object")
    session=data.get("session")
    if session is None: session={}; data["session"]=session
    if not isinstance(session, dict): raise ValueError("session is not an object")
    current=session.get("permissions")
    if current == "prompt": print("present"); raise SystemExit(0)
    if not applying:
        print("missing")
        raise SystemExit(0)
    session["permissions"]="prompt"
    directory=os.path.dirname(path) or "."; os.makedirs(directory, exist_ok=True)
    fd,tmp=tempfile.mkstemp(dir=directory, prefix=".deploy.", suffix=".tmp")
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as handle:
            json.dump(data,handle,indent=2); handle.write("\n")
        os.chmod(tmp, os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o644)
        os.replace(tmp,path)
    except OSError:
        try: os.unlink(tmp)
        except OSError: pass
        raise
    print("updated")
except (OSError, ValueError) as exc:
    print(f"invalid: {exc}")
PY
  )"
  case "$result" in
    present) ok "CLI session.permissions is prompt for rig-tools gates" ;;
    updated) ok "CLI session.permissions set to prompt for rig-tools gates" ;;
    missing) fail "CLI session.permissions must be prompt when rig-tools is registered (rerun --plugins rig-tools --apply)"; PLUGIN_STATUS=1 ;;
    *) fail "CLI config is malformed or cannot set session.permissions to prompt: $result"; PLUGIN_STATUS=1 ;;
  esac
}
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
    orchestration-policy) printf '%s\n' '{"backgroundOnly":true,"maxConcurrent":3,"allowedAgents":["explore","general"],"allowedModels":["openai/gpt-5.6-luna#max","openai/gpt-5.6-sol#xhigh","openai/gpt-6-astra#max"],"memoryReserveMiB":512,"memoryPerAgentMiB":256}' ;;
    source-control) printf '%s\n' '{"github":true,"whenEmpty":"show"}' ;;
    *) printf '%s\n' '{}' ;;
  esac
}

case "$PLUGINS" in
  both) v2_select_name codex-usage; v2_select_name codex-fallback ;;
  all) for name in "${V2_CATALOG_NAMES[@]}"; do v2_select_name "$name"; done ;;
  server) v2_select_role server ;;
  cli) v2_select_role cli ;;
  *) v2_select_name "$PLUGINS" ;;
esac
for name in "${V2_SELECTED_NAMES[@]}"; do
  for role in server cli; do
    key="$name:$role"
    if [ -n "${V2_ENTRYPOINT_FOR[$key]+present}" ] && v2_role_selected "$role"; then
      entrypoint="${V2_ENTRYPOINT_FOR[$key]}"; expected_config="${V2_CONFIG_FOR[$key]}"; config_path="$(v2_config_for_role "$role")"
      [ -f "$entrypoint" ] || { echo "ERROR: missing plugin role entrypoint: $entrypoint" >&2; exit 1; }
      [ "$(basename -- "$config_path")" = "$expected_config" ] || { echo "ERROR: catalog expects $expected_config for $name ($role), but deployment targets $config_path" >&2; exit 1; }
    fi
  done
done
if [ "$APPLY" -eq 1 ]; then
  for name in "${V2_SELECTED_NAMES[@]}"; do
    for role in server cli; do
      key="$name:$role"
      if [ -n "${V2_ENTRYPOINT_FOR[$key]+present}" ] && v2_role_selected "$role"; then
        apply_config_v2 "$(v2_config_for_role "$role")" "$(v2_schema_for_role "$role")" "${V2_PACKAGE_FOR[$name]}" "$(v2_options_for "$name")" "$name ($role)"
      fi
    done
  done
fi
ensure_rig_tools_permission
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
exit "$PLUGIN_STATUS"
