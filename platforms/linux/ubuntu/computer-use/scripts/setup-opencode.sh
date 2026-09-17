#!/usr/bin/env bash
# Persist OPENCODE_ENABLE_EXA so plain `opencode` always gets it,
# and deploy global opencode skills and commands from this component.
# Idempotent - safe to re-run.
#
# Usage:
#   ./setup-opencode.sh --verify-only
#   ./setup-opencode.sh --apply
#   OPENCODE_ENABLE_EXA=0 ./setup-opencode.sh --apply
#   ./setup-opencode.sh --apply --value 1
set -euo pipefail

VALUE="${OPENCODE_ENABLE_EXA:-1}"
APPLY=0
MODE_SET=0

usage() {
  echo "Usage: $0 [--verify-only|--apply] [--value 0|1]"
  echo "Env: OPENCODE_ENABLE_EXA=0|1"
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
    --value)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      VALUE="$2"
      shift 2 ;;
    --value=*)
      VALUE="${1#--value=}"
      shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      usage >&2
      exit 2 ;;
  esac
done

case "$VALUE" in
  0|1) ;;
  *)
    echo "ERROR: OPENCODE_ENABLE_EXA value must be 0 or 1, got: $VALUE" >&2
    exit 2 ;;
esac

BASHRC="$HOME/.bashrc"
ZSHRC="$HOME/.zshrc"
EXPORT_LINE="export OPENCODE_ENABLE_EXA=$VALUE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SRC="$COMPUTER_USE_ROOT/skills"
SKILLS_DEST="$HOME/.config/opencode/skills"
COMMANDS_SRC="$COMPUTER_USE_ROOT/commands"
COMMANDS_DEST="$HOME/.config/opencode/commands"
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
  promote-skills
)

check_required_skill_sources() {
  local name
  for name in "${REQUIRED_SKILLS[@]}"; do
    if [ ! -f "$SKILLS_SRC/$name/SKILL.md" ]; then
      echo "ERROR: required skill source missing: $SKILLS_SRC/$name/SKILL.md" >&2
      return 1
    fi
  done
}

check_required_command_sources() {
  local name
  for name in "${REQUIRED_COMMANDS[@]}"; do
    if [ ! -f "$COMMANDS_SRC/$name.md" ]; then
      echo "ERROR: required command source missing: $COMMANDS_SRC/$name.md" >&2
      return 1
    fi
  done
}

ensure_export() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -q '^export OPENCODE_ENABLE_EXA=' "$rc"; then
    if grep -Fqx "$EXPORT_LINE" "$rc"; then
      echo "OK: $rc already -> $EXPORT_LINE"
      return 0
    fi
    # Update in place if value differs
    sed -i "s/^export OPENCODE_ENABLE_EXA=.*/$EXPORT_LINE/" "$rc"
  else
    printf '\n# opencode (managed by setup-opencode.sh)\n%s\n' "$EXPORT_LINE" >> "$rc"
  fi
  echo "OK: $rc -> $EXPORT_LINE"
}

check_destination() {
  local name="$1"
  local dest_dir="$2"
  if [ -L "$dest_dir" ]; then
    echo "ERROR: deployed skill path is a symbolic link: $dest_dir" >&2
    return 1
  fi
  if [ -d "$dest_dir" ] && [ -n "$(find "$dest_dir" -type l -print -quit)" ]; then
    echo "ERROR: deployed skill $name contains a symbolic link; refusing to deploy" >&2
    return 1
  fi
}

ensure_skill() {
  local name="$1"
  local src_dir="$SKILLS_SRC/$name"
  local dest_dir="$SKILLS_DEST/$name"
  local source_file relative dest_file

  if [ -L "$src_dir" ]; then
    echo "ERROR: skill source path is a symbolic link: $src_dir" >&2
    return 1
  fi
  if [ -n "$(find "$src_dir" -type l -print -quit)" ]; then
    echo "ERROR: skill bundles may not contain symbolic links: $src_dir" >&2
    return 1
  fi
  check_destination "$name" "$dest_dir"
  mkdir -p "$dest_dir"
  while IFS= read -r -d '' source_file; do
    relative="${source_file#"$src_dir/"}"
    dest_file="$dest_dir/$relative"
    mkdir -p "$(dirname "$dest_file")"
    if [ -f "$dest_file" ] && cmp -s "$source_file" "$dest_file"; then
      continue
    fi
    cp -p "$source_file" "$dest_file"
    echo "OK: deployed $name/$relative"
  done < <(find "$src_dir" -type f -print0)
  echo "OK: complete skill bundle $name deployed"
}

ensure_skills() {
  local skill_dir
  [ -d "$SKILLS_SRC" ] || { echo "SKIP: no skills dir: $SKILLS_SRC"; return 0; }
  check_required_skill_sources
  for skill_dir in "$SKILLS_SRC"/*/; do
    [ -d "$skill_dir" ] || continue
    ensure_skill "$(basename "$skill_dir")"
  done
}

ensure_commands() {
  local name source_file dest_file
  [ -d "$COMMANDS_SRC" ] || { echo "ERROR: no commands dir: $COMMANDS_SRC" >&2; return 1; }
  [ ! -L "$COMMANDS_SRC" ] || { echo "ERROR: command source path is a symbolic link: $COMMANDS_SRC" >&2; return 1; }
  [ ! -L "$COMMANDS_DEST" ] || { echo "ERROR: deployed command path is a symbolic link: $COMMANDS_DEST" >&2; return 1; }
  check_required_command_sources
  if [ -n "$(find "$COMMANDS_SRC" -type l -print -quit)" ]; then
    echo "ERROR: command sources may not contain symbolic links: $COMMANDS_SRC" >&2
    return 1
  fi
  mkdir -p "$COMMANDS_DEST"
  for name in "${REQUIRED_COMMANDS[@]}"; do
    source_file="$COMMANDS_SRC/$name.md"
    dest_file="$COMMANDS_DEST/$name.md"
    if [ -L "$dest_file" ]; then
      echo "ERROR: deployed command is a symbolic link: $dest_file" >&2
      return 1
    fi
    if [ -f "$dest_file" ] && cmp -s "$source_file" "$dest_file"; then
      echo "OK: global command /$name deployed"
      continue
    fi
    cp -p "$source_file" "$dest_file"
    echo "OK: deployed global command /$name"
  done
}

verify() {
  local status=0
  local skill_dir local_name source_file deployed_file relative dest_file skill_status
  echo "=== verify ==="
  if [ -f "$BASHRC" ] && grep -Fqx "$EXPORT_LINE" "$BASHRC"; then
    echo "OK: $BASHRC -> $EXPORT_LINE"
  else
    echo "MISSING/STALE: $EXPORT_LINE in $BASHRC"
    status=1
  fi
  if [ -f "$ZSHRC" ]; then
    if grep -Fqx "$EXPORT_LINE" "$ZSHRC"; then
      echo "OK: $ZSHRC -> $EXPORT_LINE"
    else
      echo "MISSING/STALE: $EXPORT_LINE in $ZSHRC"
      status=1
    fi
  fi
  if command -v opencode >/dev/null 2>&1; then
    echo "opencode: $(opencode --version 2>&1)"
  else
    echo "opencode: not on PATH"
  fi
  echo "--- skills ---"
  if [ -d "$SKILLS_SRC" ]; then
    check_required_skill_sources || status=1
    for skill_dir in "$SKILLS_SRC"/*/; do
      [ -d "$skill_dir" ] || continue
      local_name="$(basename "$skill_dir")"
      skill_status=0
      if [ -n "$(find "$skill_dir" -type l -print -quit)" ]; then
        echo "INVALID: skill $local_name contains a symbolic link"
        status=1
        continue
      fi
      while IFS= read -r -d '' source_file; do
        relative="${source_file#"$skill_dir"}"
        dest_file="$SKILLS_DEST/$local_name/$relative"
        if [ ! -f "$dest_file" ] || ! cmp -s "$source_file" "$dest_file"; then
          echo "MISSING/STALE: $local_name/$relative (run with --apply to deploy)"
          skill_status=1
          status=1
        fi
      done < <(find "$skill_dir" -type f -print0)
      if [ -d "$SKILLS_DEST/$local_name" ]; then
        if [ -n "$(find "$SKILLS_DEST/$local_name" -type l -print -quit)" ]; then
          echo "EXTRA: deployed skill $local_name contains a preserved symbolic link"
          skill_status=1
          status=1
        fi
        while IFS= read -r -d '' deployed_file; do
          relative="${deployed_file#"$SKILLS_DEST/$local_name/"}"
          if [ ! -f "$skill_dir$relative" ]; then
            echo "EXTRA: $local_name/$relative (preserved; review before deleting)"
            skill_status=1
            status=1
          fi
        done < <(find "$SKILLS_DEST/$local_name" -type f -print0)
      fi
      if [ "$skill_status" -eq 0 ]; then
        echo "OK: complete skill bundle $local_name deployed"
      fi
    done
  else
    echo "SKIP: no skills dir: $SKILLS_SRC"
    status=1
  fi
  echo "--- commands ---"
  if [ -L "$COMMANDS_SRC" ] || [ -n "$(find "$COMMANDS_SRC" -type l -print -quit 2>/dev/null)" ]; then
    echo "INVALID: command sources contain a symbolic link"
    status=1
  elif [ -L "$COMMANDS_DEST" ]; then
    echo "INVALID: global command directory is a symbolic link"
    status=1
  elif check_required_command_sources; then
    for local_name in "${REQUIRED_COMMANDS[@]}"; do
      source_file="$COMMANDS_SRC/$local_name.md"
      dest_file="$COMMANDS_DEST/$local_name.md"
      if [ -L "$dest_file" ]; then
        echo "INVALID: global command /$local_name is a symbolic link"
        status=1
      elif [ ! -f "$dest_file" ] || ! cmp -s "$source_file" "$dest_file"; then
        echo "MISSING/STALE: global command /$local_name (run with --apply to deploy)"
        status=1
      else
        echo "OK: global command /$local_name deployed"
      fi
    done
  else
    status=1
  fi
  return "$status"
}

if [ "$APPLY" -eq 0 ]; then
  verify
  exit
fi

ensure_export "$BASHRC"
[ -f "$ZSHRC" ] && ensure_export "$ZSHRC"
ensure_skills
ensure_commands

export OPENCODE_ENABLE_EXA="$VALUE"

verify
echo ""
echo "Done. Restart OpenCode so updated skills are loaded."
