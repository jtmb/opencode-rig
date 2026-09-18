#!/usr/bin/env bash
# Deploy the OpenCode v2 (2.0.x) harness surface: skill symlinks, the four
# global commands, and the starting opencode.jsonc/cli.json. Read-only
# verification is the default; --apply writes. v1 is never modified: the target
# defaults to the isolated pilot config directory and is overridden with
# --config-dir or OPENCODE_V2_CONFIG_DIR.
#
# Skill bundles deploy as directory symlinks into this checkout so the
# repository stays the single source of truth (and v2's file watcher sees repo
# edits). Commands deploy as content-aware copies. Config files seed only when
# missing; an existing config is never overwritten.
#
# Usage:
#   ./setup-opencode-v2.sh --verify-only
#   ./setup-opencode-v2.sh --apply
#   ./setup-opencode-v2.sh --config-dir ~/.opencode-v2-pilot/config --apply
set -euo pipefail

APPLY=0
MODE_SET=0
ALLOW_V1=0
CONFIG_DIR="${OPENCODE_V2_CONFIG_DIR:-${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}/config}"

usage() {
  cat <<'EOF'
Usage: setup-opencode-v2.sh [--verify-only|--apply] [--config-dir DIR]

Options:
  --config-dir DIR         Target v2 config directory (default:
                           $OPENCODE_V2_CONFIG_DIR, else
                           $OPENCODE_V2_PILOT_DIR/config, else
                           ~/.opencode-v2-pilot/config)
  --allow-v1-config-dir    Permit --config-dir to be ~/.config/opencode
  --apply                  Write changes
  --verify-only            Check only (default)
  -h, --help               Show this help

The script links the 16 skill bundles from this checkout, deploys the four
global commands, seeds opencode.jsonc and cli.json only when missing, and runs
verify-opencode-v2.sh for the pilot health check.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      [ "$MODE_SET" -eq 0 ] || { usage >&2; exit 2; }
      APPLY=1
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
    --allow-v1-config-dir)
      ALLOW_V1=1
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
V1_CONFIG_DIR="$HOME/.config/opencode"
VERIFY_SCRIPT="$SCRIPT_DIR/verify-opencode-v2.sh"
REFERENCE_REPO_ROOT="/home/james/repos/opencode-rig"

REQUIRED_SKILLS=(
  app-setup
  blender
  browser-assistant
  browser-headless
  desktop-control
  desktop-vision
  files-and-documents
  game-playtest
  github-operations
  opencode-db-maintenance
  routine-automation
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

if [ "$ALLOW_V1" -eq 0 ] && [ "$(realpath -m -- "$CONFIG_DIR")" = "$(realpath -m -- "$V1_CONFIG_DIR")" ]; then
  echo "ERROR: $CONFIG_DIR is the v1 config directory; v1 stays untouched until the approved cutover." >&2
  echo "       Pass --allow-v1-config-dir only for the accepted one-time translation." >&2
  exit 2
fi

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

skill_link_ok() {
  local name="$1" src dest current
  src="$SKILLS_SRC/$name"
  dest="$SKILLS_DEST/$name"
  if [ -L "$dest" ]; then
    current="$(readlink -- "$dest")"
    if [ -n "$current" ]; then
      case "$current" in
        /*) current="$(realpath -m -- "$current")" ;;
        *) current="$(realpath -m -- "$(dirname -- "$dest")/$current")" ;;
      esac
    fi
    if [ "$current" = "$(realpath -m -- "$src")" ]; then
      ok "skill link $name -> $src"
      return 0
    fi
    fail "skill link $name points to ${current:-<empty>}"
    return 1
  fi
  if [ -e "$dest" ]; then
    fail "skill path exists and is not a symlink: $dest (remove it or use the v1 copy deployment)"
    return 1
  fi
  fail "skill link missing: $dest (run with --apply to deploy)"
  return 1
}

ensure_skill_link() {
  local name="$1" src dest
  src="$SKILLS_SRC/$name"
  dest="$SKILLS_DEST/$name"
  if [ -L "$dest" ] || [ -e "$dest" ]; then
    skill_link_ok "$name" || true
    return 0
  fi
  mkdir -p -- "$SKILLS_DEST"
  ln -s -- "$src" "$dest"
  ok "linked skill $name"
}

ensure_commands() {
  local name src dest
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
  if python3 - "$path" <<'PY'
import json
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
text = re.sub(r"(?m)^\s*//.*$", "", text)
data = json.loads(text)
if not isinstance(data, dict):
    raise SystemExit(1)
PY
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
  python3 - "$source" "$dest" "$REFERENCE_REPO_ROOT" "$REPO_ROOT" <<'PY'
import json
import os
import re
import sys
import tempfile

source, dest, reference, actual = sys.argv[1:5]
text = open(source, encoding="utf-8").read()
text = text.replace(reference, actual)
text = re.sub(r"(?m)^\s*//.*$", "", text)
data = json.loads(text)
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
  mkdir -p -- "$CONFIG_DIR"
  seed_config opencode.jsonc "$CONFIG_EXAMPLES/v2-opencode.example.jsonc"
  seed_config cli.json "$CONFIG_EXAMPLES/v2-cli.example.json"
  for name in "${REQUIRED_SKILLS[@]}"; do
    ensure_skill_link "$name"
  done
  ensure_commands
fi

echo "--- verify: $CONFIG_DIR ---"
for name in "${REQUIRED_SKILLS[@]}"; do
  skill_link_ok "$name" || true
done
verify_commands
verify_config "$CONFIG_DIR/opencode.jsonc"
verify_config "$CONFIG_DIR/cli.json"

echo "--- v2 pilot health check ---"
if OPENCODE_V2_CONFIG_DIR="$CONFIG_DIR" OPENCODE_V2_REPO="$REPO_ROOT" "$VERIFY_SCRIPT"; then
  ok "v2 pilot health check passed"
else
  fail "v2 pilot health check failed"
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
