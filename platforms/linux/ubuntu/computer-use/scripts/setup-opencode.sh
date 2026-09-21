#!/usr/bin/env bash
# Deploy the OpenCode v2 (2.0.x) harness surface: complete skill copies, the four
# global commands, starting opencode.jsonc/cli.json, and pinned Explorer parser
# assets. Read-only verification is the default; --apply writes. The target
# defaults to the isolated Open Rig config directory and is overridden with
# --config-dir or OPENCODE_V2_CONFIG_DIR.
#
# Skill bundles and commands deploy as content-aware copies from this checkout;
# config files seed only when missing, and existing config is never overwritten.
#
# Usage:
#   ./setup-opencode.sh --verify-only
#   ./setup-opencode.sh --apply
#   ./setup-opencode.sh --prepare
#   ./setup-opencode.sh --config-dir ~/.opencode-v2-pilot/config --apply
set -euo pipefail

APPLY=0
PREPARE=0
MODE_SET=0
CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"

usage() {
  cat <<'EOF'
Usage: setup-opencode.sh [--verify-only|--apply|--prepare] [--config-dir DIR]

Options:
  --config-dir DIR         Target v2 config directory (default:
                           $OPENCODE_V2_CONFIG_DIR, else
                           $OPENCODE_V2_PILOT_DIR/config, else
                           ~/.opencode-v2-pilot/config)
  --apply                  Write changes
  --prepare                Seed/deploy files without running health verification;
                           intended for setup sequencing before plugin registration
  --verify-only            Check only (default)
  -h, --help               Show this help

The script recursively deploys the 19 skill bundles from this checkout and the four
global commands, seeds opencode.jsonc and cli.json only when missing, installs
the exact locked plugin dependencies and managed Explorer parser assets when
needed. Apply runs verify-opencode-v2.sh; prepare defers that health check for
callers that must register plugins between seeding and verification.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=1
      MODE_SET=1
       shift ;;
    --prepare)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=1
      PREPARE=1
      MODE_SET=1
      shift ;;
    --verify-only)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=0
      MODE_SET=1
      shift ;;
    --config-dir)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      CONFIG_DIR="$2"
      shift 2 ;;
    --config-dir=*)
      CONFIG_DIR="${1#*=}"
      shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      usage >&2
      exit 2 ;;
  esac
done

[ -n "$CONFIG_DIR" ] || { echo "ERROR: --config-dir must not be empty" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$COMPUTER_USE_ROOT/../../../.." && pwd)"
SKILLS_SRC="$COMPUTER_USE_ROOT/skills"
COMMANDS_SRC="$COMPUTER_USE_ROOT/commands"
CONFIG_EXAMPLES="$COMPUTER_USE_ROOT/config"
SKILLS_DEST="$CONFIG_DIR/skills"
COMMANDS_DEST="$CONFIG_DIR/commands"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-opencode-v2.sh"
JSONC_HELPER="$SCRIPT_DIR/setup-opencode-jsonc.py"
BOUNDED_RUNNER="$SCRIPT_DIR/run-bounded-command.sh"
PLUGINS_ROOT="$COMPUTER_USE_ROOT/plugins-v2"
FILE_MANAGER_ROOT="$PLUGINS_ROOT/file-manager"
PARSER_PACKAGE_JSON="$PLUGINS_ROOT/node_modules/tree-sitter-wasm/package.json"
PARSER_CACHE_DIR="${RIG_PARSERS_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/cache/opencode-rig/parsers}"
REFERENCE_REPO_ROOT="/home/james/repos/opencode-rig"

REQUIRED_SKILLS=(
  agent-orchestration
  app-setup
  blender
  browser-assistant
  browser-headless
  desktop-control
  desktop-vision
  development-conventions
  files-and-documents
  game-playtest
  github-operations
  opencode-db-maintenance
  routine-automation
  session-context
  skill-maintenance
  system-troubleshooting
  task-memory
  vscode-management
  web-3d-asset-pipeline
)
REQUIRED_COMMANDS=(
  deploy
  handoff
  promote-skills
  resume
)

status=0
ok() { echo "OK: $*"; }
fail() { echo "MISSING/STALE: $*" >&2; status=1; }

preflight_config_paths() {
  python3 - "$CONFIG_DIR" "$CONFIG_DIR/opencode.jsonc" "$CONFIG_DIR/cli.json" <<'PY'
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

workspace_parser_dependency_ok() {
  [ -f "$PARSER_PACKAGE_JSON" ] || return 1
  node - "$PARSER_PACKAGE_JSON" <<'NODE'
const fs = require("node:fs")
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
process.exit(data.name === "tree-sitter-wasm" && data.version === "2.0.1" ? 0 : 1)
NODE
}

ensure_workspace_dependencies() {
  if workspace_parser_dependency_ok; then
    ok "workspace dependency tree-sitter-wasm@2.0.1"
    return 0
  fi
  command -v npm >/dev/null 2>&1 || { fail "npm is required to install the pinned plugin workspace dependencies"; return 1; }
  [ -x "$BOUNDED_RUNNER" ] || { fail "bounded command runner is not executable: $BOUNDED_RUNNER"; return 1; }
  if (
    cd "$PLUGINS_ROOT"
    "$BOUNDED_RUNNER" -- npm ci --ignore-scripts --no-audit --no-fund
  ) && workspace_parser_dependency_ok; then
    ok "installed pinned plugin workspace dependencies"
  else
    fail "pinned plugin workspace dependency installation failed"
    return 1
  fi
}

verify_workspace_dependencies() {
  if workspace_parser_dependency_ok; then
    ok "workspace dependency tree-sitter-wasm@2.0.1"
  else
    fail "workspace dependency tree-sitter-wasm@2.0.1 missing or stale (run with --apply)"
  fi
}

install_managed_parsers() {
  if ! workspace_parser_dependency_ok; then
    fail "managed Explorer parsers require tree-sitter-wasm@2.0.1"
    return 1
  fi
  if npm --prefix "$FILE_MANAGER_ROOT" run parsers:verify -- --target "$PARSER_CACHE_DIR" >/dev/null 2>&1; then
    ok "managed Explorer parser assets already installed"
    return 0
  fi
  if npm --prefix "$FILE_MANAGER_ROOT" run parsers:install -- --target "$PARSER_CACHE_DIR"; then
    ok "managed Explorer parser assets installed"
  else
    fail "managed Explorer parser asset installation failed"
    return 1
  fi
}

verify_managed_parsers() {
  if ! workspace_parser_dependency_ok; then
    fail "managed Explorer parsers cannot be verified without tree-sitter-wasm@2.0.1"
    return 0
  fi
  if npm --prefix "$FILE_MANAGER_ROOT" run parsers:verify -- --target "$PARSER_CACHE_DIR"; then
    ok "managed Explorer parser assets verified"
  else
    fail "managed Explorer parser assets missing or stale (run with --apply)"
  fi
}


source_missing=0
for name in "${REQUIRED_SKILLS[@]}"; do
  if [ ! -f "$SKILLS_SRC/$name/SKILL.md" ]; then
    echo "ERROR: required skill source missing: $SKILLS_SRC/$name/SKILL.md" >&2
    source_missing=1
  fi
done
for name in "${REQUIRED_COMMANDS[@]}"; do
  if [ ! -f "$COMMANDS_SRC/$name.md" ]; then
    echo "ERROR: required command source missing: $COMMANDS_SRC/$name.md" >&2
    source_missing=1
  fi
done
[ "$source_missing" -eq 0 ] || exit 1

skill_bundle_ok() {
  local name="$1" src dest source_file deployed_file relative
  src="$SKILLS_SRC/$name"
  dest="$SKILLS_DEST/$name"
  if [ -L "$src" ] || [ -n "$(find "$src" -type l -print -quit 2>/dev/null)" ]; then
    fail "skill source bundle contains a symlink: $src"
    return 1
  fi
  if [ -L "$dest" ]; then
    fail "skill bundle $name is still a symlink (run with --apply to deploy a complete copy)"
    return 1
  fi
  if [ ! -d "$dest" ]; then
    fail "skill bundle missing: $dest (run with --apply to deploy)"
    return 1
  fi
  local bundle_status=0
  while IFS= read -r -d '' source_file; do
    relative="${source_file#"$src/"}"
    deployed_file="$dest/$relative"
    if [ ! -f "$deployed_file" ] || ! cmp -s -- "$source_file" "$deployed_file"; then
      fail "skill bundle file missing or stale: $name/$relative (run with --apply)"
      bundle_status=1
    fi
  done < <(find "$src" -type f -print0)
  while IFS= read -r -d '' deployed_file; do
    relative="${deployed_file#"$dest/"}"
    if [ ! -f "$src/$relative" ]; then
      fail "skill bundle has an extra preserved file: $name/$relative"
      bundle_status=1
    fi
  done < <(find "$dest" -type f -print0)
  while IFS= read -r -d '' deployed_file; do
    relative="${deployed_file#"$dest/"}"
    if [ ! -d "$src/$relative" ]; then
      fail "skill bundle has an extra preserved entry: $name/$relative"
      bundle_status=1
    fi
  done < <(find "$dest" -type d -mindepth 1 -print0)
  while IFS= read -r -d '' deployed_file; do
    fail "skill bundle contains unsupported file type: $name/${deployed_file#"$dest/"}"
    bundle_status=1
  done < <(find "$dest" -mindepth 1 \( -type l -o -type b -o -type c -o -type p -o -type s \) -print0)
  if [ "$bundle_status" -eq 0 ]; then
    ok "complete skill bundle $name deployed"
  fi
  return "$bundle_status"
}

path_has_symlink_ancestor() {
  local path="$1" ancestor
  ancestor="$(dirname -- "$path")"
  while [ "$ancestor" != "/" ] && [ "$ancestor" != "." ]; do
    if [ -L "$ancestor" ]; then
      return 0
    fi
    ancestor="$(dirname -- "$ancestor")"
  done
  return 1
}

validate_skill_destination() {
  local name="$1" src="$2" dest="$3" entry
  if path_has_symlink_ancestor "$dest"; then
    fail "skill destination has a symlink ancestor: $dest"
    return 1
  fi
  if [ -e "$dest" ] && [ ! -d "$dest" ]; then
    fail "skill destination is not a directory: $dest"
    return 1
  fi
  if [ -L "$dest" ]; then
    fail "skill destination is a symlink: $dest"
    return 1
  fi
  if [ -d "$dest" ]; then
    while IFS= read -r -d '' entry; do
      if [ -L "$entry" ]; then
        fail "deployed skill bundle contains a symlink: $entry"
        return 1
      fi
      if [ ! -d "$entry" ] && [ ! -f "$entry" ]; then
        fail "skill bundle contains unsupported file type: $name/${entry#"$dest/"}"
        return 1
      fi
    done < <(find "$dest" -mindepth 1 -print0)
  fi
  return 0
}

ensure_skill_bundle() {
  local name="$1" src dest current source_file relative deployed_file
  src="$SKILLS_SRC/$name"
  dest="$SKILLS_DEST/$name"
  if [ -L "$src" ] || [ -n "$(find "$src" -type l -print -quit)" ]; then
    fail "skill source bundle contains a symlink: $src"
    return 0
  fi
  if [ -L "$dest" ]; then
    current="$(readlink -- "$dest")"
    case "$current" in
      /*) current="$(realpath -m -- "$current")" ;;
      *) current="$(realpath -m -- "$(dirname -- "$dest")/$current")" ;;
    esac
    if [ "$current" != "$(realpath -m -- "$src")" ]; then
      fail "skill symlink $name points outside its canonical source: ${current:-<empty>}"
      return 0
    fi
    rm -- "$dest"
    ok "replaced canonical skill symlink $name with a deployed copy"
  fi
  if [ -L "$SKILLS_DEST" ]; then
    fail "skills destination is a symlink: $SKILLS_DEST"
    return 0
  fi
  if ! validate_skill_destination "$name" "$src" "$dest"; then
    return 0
  fi
  mkdir -p -- "$SKILLS_DEST"
  mkdir -p -- "$dest"
  while IFS= read -r -d '' source_file; do
    relative="${source_file#"$src/"}"
    deployed_file="$dest/$relative"
    if [ -L "$deployed_file" ]; then
      fail "deployed skill file is a symlink: $deployed_file"
      continue
    fi
    mkdir -p -- "$(dirname -- "$deployed_file")"
    if [ -f "$deployed_file" ] && cmp -s -- "$source_file" "$deployed_file"; then
      continue
    fi
    cp -p -- "$source_file" "$deployed_file"
    ok "deployed skill file $name/$relative"
  done < <(find "$src" -type f -print0)
}

ensure_commands() {
  local name src dest
  if [ -L "$COMMANDS_SRC" ] || [ -n "$(find "$COMMANDS_SRC" -type l -print -quit)" ]; then
    fail "command source contains a symlink: $COMMANDS_SRC"
    return 0
  fi
  if [ -L "$COMMANDS_DEST" ]; then
    fail "command destination is a symlink: $COMMANDS_DEST"
    return 0
  fi
  mkdir -p -- "$COMMANDS_DEST"
  for name in "${REQUIRED_COMMANDS[@]}"; do
    src="$COMMANDS_SRC/$name.md"
    dest="$COMMANDS_DEST/$name.md"
    if [ -L "$dest" ]; then
      fail "command destination is a symlink: $dest"
      continue
    fi
    if [ -f "$dest" ] && cmp -s -- "$src" "$dest"; then
      ok "command /$name deployed"
      continue
    fi
    cp -p -- "$src" "$dest"
    ok "deployed command /$name"
  done
}

verify_commands() {
  local name src dest
  if [ -L "$COMMANDS_SRC" ] || [ -n "$(find "$COMMANDS_SRC" -type l -print -quit 2>/dev/null)" ]; then
    fail "command source contains a symlink: $COMMANDS_SRC"
    return 0
  fi
  if [ -L "$COMMANDS_DEST" ]; then
    fail "command destination is a symlink: $COMMANDS_DEST"
    return 0
  fi
  for name in "${REQUIRED_COMMANDS[@]}"; do
    src="$COMMANDS_SRC/$name.md"
    dest="$COMMANDS_DEST/$name.md"
    if [ -L "$dest" ]; then
      fail "command destination is a symlink: $dest"
      continue
    fi
    if [ ! -f "$dest" ] || ! cmp -s -- "$src" "$dest"; then
      fail "command /$name not deployed (run with --apply)"
      continue
    fi
    ok "command /$name deployed"
  done
}

verify_config() {
  local path="$1"
  if [ ! -f "$path" ]; then
    fail "config missing: $path (run with --apply to seed it)"
    return 1
  fi
  if python3 "$JSONC_HELPER" "$path"
  then
    ok "config valid: $path"
  else
    fail "config is not valid JSON(C): $path"
  fi
}

seed_config() {
  local name="$1" source="$2" dest
  dest="$CONFIG_DIR/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    return 0
  fi
  mkdir -p -- "$CONFIG_DIR"
  python3 - "$source" "$dest" "$REFERENCE_REPO_ROOT" "$REPO_ROOT" "$JSONC_HELPER" <<'PY'
import importlib.util
import json
import os
import sys
import tempfile

source, dest, reference, actual, helper_path = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("setup_opencode_jsonc", helper_path)
helper = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(helper)
text = open(source, encoding="utf-8").read().replace(reference, actual)
data = helper.parse_jsonc(text)
if os.path.basename(dest) == "opencode.jsonc":
    mcp = data.get("mcp") if isinstance(data, dict) else None
    if isinstance(mcp, dict):
        mcp.pop("playwright", None)
        servers = mcp.get("servers")
        if isinstance(servers, dict):
            servers.pop("playwright", None)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest) or ".", prefix=".seed.", suffix=".tmp")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, dest)
except OSError:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
  ok "seeded config $name from $(basename -- "$source")"
}

if [ "$APPLY" -eq 1 ]; then
  ensure_workspace_dependencies
  install_managed_parsers
  mkdir -p -- "$CONFIG_DIR"
  seed_config opencode.jsonc "$CONFIG_EXAMPLES/v2-opencode.example.jsonc"
  seed_config cli.json "$CONFIG_EXAMPLES/v2-cli.example.json"
  for name in "${REQUIRED_SKILLS[@]}"; do
    ensure_skill_bundle "$name"
  done
  ensure_commands
  # Copy helpers intentionally accumulate bundle failures so prepare can
  # report every problem, but the final status gate below must still fail.
  for name in "${REQUIRED_SKILLS[@]}"; do
    skill_bundle_ok "$name" || true
  done
fi

if [ "$PREPARE" -eq 1 ]; then
  if [ "$status" -eq 0 ]; then
    echo "OK: v2 deployment prepared ($CONFIG_DIR); health verification deferred"
    exit 0
  fi
  echo "FAIL: v2 deployment preparation incomplete; health verification was deferred" >&2
  exit "$status"
fi

echo "--- verify: $CONFIG_DIR ---"
verify_workspace_dependencies
verify_managed_parsers
for name in "${REQUIRED_SKILLS[@]}"; do
  skill_bundle_ok "$name" || true
done
verify_commands
verify_config "$CONFIG_DIR/opencode.jsonc"
verify_config "$CONFIG_DIR/cli.json"

echo "--- v2 deployment health check ---"
if OPENCODE_V2_CONFIG_DIR="$CONFIG_DIR" OPENCODE_V2_REPO="$REPO_ROOT" "$VERIFY_SCRIPT"; then
  ok "v2 deployment health check passed"
else
  fail "v2 deployment health check failed"
fi

echo ""
if [ "$status" -eq 0 ]; then
  echo "OK: v2 deployment verified ($CONFIG_DIR)"
  if [ "$APPLY" -eq 1 ]; then
    echo "Restart OpenCode so updated skills and commands are loaded."
  fi
else
  echo "FAIL: v2 deployment incomplete; see MISSING/STALE lines above." >&2
fi
exit "$status"
