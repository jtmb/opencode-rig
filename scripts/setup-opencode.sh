#!/usr/bin/env bash
# Persist OPENCODE_ENABLE_EXA so plain `opencode` always gets it,
# and deploy global opencode skills from ./skills/.
# Idempotent — safe to re-run.
#
# Usage:
#   ./setup-opencode.sh
#   ./setup-opencode.sh --verify-only
#   OPENCODE_ENABLE_EXA=0 ./setup-opencode.sh  # custom value
#   ./setup-opencode.sh --value 1
set -euo pipefail

VALUE="${OPENCODE_ENABLE_EXA:-1}"
VERIFY_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    --value)
      echo "Usage: $0 [--verify-only] [--value 0|1] (or OPENCODE_ENABLE_EXA=1 $0)" >&2
      exit 1 ;;
    --value=*) VALUE="${arg#--value=}" ;;
    -h|--help)
      echo "Usage: $0 [--verify-only] [--value 0|1]"
      echo "Env: OPENCODE_ENABLE_EXA=1 $0"
      exit 0 ;;
  esac
done
# Support `--value 1` (space-separated)
for ((i = 1; i <= $#; i++)); do
  if [ "${!i:-}" = "--value" ]; then
    j=$((i + 1))
    VALUE="${!j:-1}"
  fi
done

BASHRC="$HOME/.bashrc"
ZSHRC="$HOME/.zshrc"
EXPORT_LINE="export OPENCODE_ENABLE_EXA=$VALUE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
SKILLS_DEST="$HOME/.config/opencode/skills"
REQUIRED_SKILLS=(
  app-setup
  browser-assistant
  desktop-control
  desktop-vision
  files-and-documents
  opencode-db-maintenance
  routine-automation
  system-troubleshooting
  task-memory
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

ensure_export() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -q '^export OPENCODE_ENABLE_EXA=' "$rc"; then
    # Update in place if value differs
    sed -i "s/^export OPENCODE_ENABLE_EXA=.*/$EXPORT_LINE/" "$rc"
  else
    printf '\n# opencode (managed by setup-opencode.sh)\n%s\n' "$EXPORT_LINE" >> "$rc"
  fi
  echo "OK: $rc -> $EXPORT_LINE"
}

ensure_skill() {
  local name="$1"
  local src="$SKILLS_SRC/$name/SKILL.md"
  local dest_dir="$SKILLS_DEST/$name"
  local dest="$dest_dir/SKILL.md"
  if [ ! -f "$src" ]; then
    echo "SKIP: skill source missing: $src"
    return 0
  fi
  mkdir -p "$dest_dir"
  if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    echo "OK: skill $name already deployed"
  else
    cp "$src" "$dest"
    echo "OK: skill $name deployed -> $dest"
  fi
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

verify() {
  local status=0
  echo "=== verify ==="
  grep -H '^export OPENCODE_ENABLE_EXA=' "$BASHRC" 2>/dev/null || echo "MISSING in $BASHRC"
  [ -f "$ZSHRC" ] && grep -H '^export OPENCODE_ENABLE_EXA=' "$ZSHRC" 2>/dev/null || true
  bash -i -c 'echo "bashrc effective value: ${OPENCODE_ENABLE_EXA:-<unset>}"' 2>/dev/null || \
    bash -c "source \"$BASHRC\" && echo \"bashrc effective value: \${OPENCODE_ENABLE_EXA:-<unset>}\""
  command -v opencode >/dev/null 2>&1 && opencode --version 2>&1 | head -n1 || echo "opencode: not on PATH"
  echo "--- skills ---"
  if [ -d "$SKILLS_SRC" ]; then
    check_required_skill_sources || status=1
    for skill_dir in "$SKILLS_SRC"/*/; do
      [ -d "$skill_dir" ] || continue
      local_name="$(basename "$skill_dir")"
      if [ -f "$SKILLS_DEST/$local_name/SKILL.md" ] && cmp -s "$skill_dir/SKILL.md" "$SKILLS_DEST/$local_name/SKILL.md"; then
        echo "OK: skill $local_name deployed"
      else
        echo "MISSING/STALE: skill $local_name (run without --verify-only to deploy)"
        status=1
      fi
    done
  else
    echo "SKIP: no skills dir: $SKILLS_SRC"
    status=1
  fi
  return "$status"
}

if [ "$VERIFY_ONLY" = "1" ]; then verify; exit 0; fi

ensure_export "$BASHRC"
[ -f "$ZSHRC" ] && ensure_export "$ZSHRC"
ensure_skills

# Apply to current shell parent on demand (script can't export to caller)
export OPENCODE_ENABLE_EXA="$VALUE"

verify
echo ""
echo "Done. New terminals: just run \`opencode\`."
echo "Current shell: run \`export OPENCODE_ENABLE_EXA=$VALUE\` or \`source ~/.bashrc\`."
