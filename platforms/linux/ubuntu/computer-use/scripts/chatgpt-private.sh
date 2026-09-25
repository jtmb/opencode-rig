#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: chatgpt-private.sh [--help]

Launch the private ChatGPT primary agent from a dedicated neutral workspace.
The workspace defaults to /tmp/opencode/chatgpt-private-<uid> and is private.
OpenCode selects chatgpt-private as the workspace's default primary agent.
Use /agents (Ctrl+X, then A) in the TUI to confirm or select it.
EOF
}

if [[ "$#" -gt 0 ]]; then
  if [[ "$#" -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 2
fi

[[ "${HOME:-}" == /* ]] || fail 'HOME must be an absolute path'

SCRIPT_PATH="$(realpath -e -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)"
COMPUTER_USE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
REPO_ROOT="$(cd -- "$COMPUTER_USE_ROOT/../../../.." && pwd -P)"
AGENT_SOURCE="$COMPUTER_USE_ROOT/agents/chatgpt-private.md"
OPENCODE_LAUNCHER="$SCRIPT_DIR/opencode-launcher.sh"

[[ -f "$AGENT_SOURCE" && ! -L "$AGENT_SOURCE" ]] || fail 'canonical agent source must be a regular non-symlink file'
[[ -f "$OPENCODE_LAUNCHER" && ! -L "$OPENCODE_LAUNCHER" && -x "$OPENCODE_LAUNCHER" ]] || fail 'canonical OpenCode launcher is missing or not executable'

ACTIVE_BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
[[ "$ACTIVE_BIN" == /* ]] || fail 'OPENCODE_V2_BIN must be an absolute path'
[[ -f "$ACTIVE_BIN" && ! -L "$ACTIVE_BIN" && -x "$ACTIVE_BIN" ]] || fail "active OpenCode v2 binary is missing or not executable: $ACTIVE_BIN"
[[ "$(realpath -e -- "$ACTIVE_BIN")" == "$ACTIVE_BIN" ]] || fail 'OPENCODE_V2_BIN must not contain symlinked path components'
export OPENCODE_V2_BIN="$ACTIVE_BIN"

PILOT_DIR="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}"
[[ "$PILOT_DIR" == /* ]] || fail 'OPENCODE_V2_PILOT_DIR must be an absolute path'
PILOT_REAL="$(realpath -m -- "$PILOT_DIR")"
case "$PILOT_REAL/" in
  "$REPO_ROOT/"*) fail 'OpenCode profile config must be outside the repository' ;;
esac

DEFAULT_NEUTRAL_DIR="/tmp/opencode/chatgpt-private-$EUID"
NEUTRAL_DIR="${CHATGPT_PRIVATE_DIR:-$DEFAULT_NEUTRAL_DIR}"
NEUTRAL_DIR="${NEUTRAL_DIR%/}"
[[ "$NEUTRAL_DIR" == /* && "$NEUTRAL_DIR" != "/" ]] || fail 'CHATGPT_PRIVATE_DIR must be a non-root absolute path'
[[ "$NEUTRAL_DIR" != *'//'* ]] || fail 'CHATGPT_PRIVATE_DIR must not contain repeated separators'
case "$NEUTRAL_DIR" in
  *'/../'*|*/..|*'/./'*|*/.) fail 'CHATGPT_PRIVATE_DIR must not contain dot path components' ;;
esac
NEUTRAL_REAL="$(realpath -m -- "$NEUTRAL_DIR")"
case "$NEUTRAL_REAL/" in
  "$REPO_ROOT/"*) fail 'private workspace must be outside the repository' ;;
esac

assert_no_symlink_components() {
  local path="$1"
  local current=""
  local component
  local -a components

  IFS='/' read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    [[ ! -L "$current" ]] || fail "refusing symlink in private workspace path: $current"
  done
}

has_project_context() {
  local directory="$1"
  local candidate
  local -a candidates=(
    "$directory/AGENTS.md"
    "$directory/opencode.json"
    "$directory/opencode.jsonc"
    "$directory/.git"
    "$directory/.opencode/AGENTS.md"
    "$directory/.opencode/opencode.json"
    "$directory/.opencode/opencode.jsonc"
    "$directory/.opencode/agents"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","default_agent":"chatgpt-private"}'
PROJECT_CONFIG="$NEUTRAL_DIR/opencode.json"

validate_existing_workspace() {
  local entry
  local candidate
  local -a root_conflicts=(
    "$NEUTRAL_DIR/AGENTS.md"
    "$NEUTRAL_DIR/.git"
    "$NEUTRAL_DIR/opencode.jsonc"
    "$NEUTRAL_DIR/.opencode/AGENTS.md"
    "$NEUTRAL_DIR/.opencode/opencode.json"
    "$NEUTRAL_DIR/.opencode/opencode.jsonc"
  )

  for candidate in "${root_conflicts[@]}"; do
    if [[ -e "$candidate" || -L "$candidate" ]]; then
      fail "private workspace contains unrelated project context: $candidate"
    fi
  done

  if [[ -e "$PROJECT_CONFIG" || -L "$PROJECT_CONFIG" ]]; then
    [[ -f "$PROJECT_CONFIG" && ! -L "$PROJECT_CONFIG" ]] || fail 'private workspace config must be a regular non-symlink file'
    [[ "$(stat -c '%u' -- "$PROJECT_CONFIG")" == "$EUID" ]] || fail 'private workspace config is not owned by the current user'
    [[ "$(cat -- "$PROJECT_CONFIG")" == "$CONFIG_CONTENT" ]] || fail 'private workspace config has unexpected contents'
  fi

  if [[ -e "$NEUTRAL_DIR/.opencode" || -L "$NEUTRAL_DIR/.opencode" ]]; then
    [[ -d "$NEUTRAL_DIR/.opencode" && ! -L "$NEUTRAL_DIR/.opencode" ]] || fail 'private .opencode directory must be a real directory'
    shopt -s nullglob dotglob
    for entry in "$NEUTRAL_DIR/.opencode/"*; do
      [[ "${entry##*/}" == 'agents' ]] || fail "private workspace contains unrelated OpenCode config: $entry"
    done
    shopt -u nullglob dotglob

    if [[ -e "$NEUTRAL_DIR/.opencode/agents" || -L "$NEUTRAL_DIR/.opencode/agents" ]]; then
      [[ -d "$NEUTRAL_DIR/.opencode/agents" && ! -L "$NEUTRAL_DIR/.opencode/agents" ]] || fail 'private agent directory must be a real directory'
      shopt -s nullglob dotglob
      for entry in "$NEUTRAL_DIR/.opencode/agents/"*; do
        [[ "${entry##*/}" == 'chatgpt-private.md' ]] || fail "private workspace contains an unrelated agent: $entry"
      done
      shopt -u nullglob dotglob
    fi
  fi
}

ensure_directory_chain() {
  local path="$1"
  local current=""
  local component
  local -a components

  IFS='/' read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current}/${component}"
    [[ ! -L "$current" ]] || fail "refusing symlink in private workspace path: $current"
    if [[ ! -e "$current" ]]; then
      mkdir -- "$current"
    fi
    [[ -d "$current" && ! -L "$current" ]] || fail "private workspace path component is not a real directory: $current"
  done
}

secure_directory() {
  local directory="$1"
  [[ -d "$directory" && ! -L "$directory" ]] || fail "private workspace directory is not real: $directory"
  [[ "$(stat -c '%u' -- "$directory")" == "$EUID" ]] || fail "private workspace directory is not owned by the current user: $directory"
  chmod 700 -- "$directory"
}

assert_no_symlink_components "$NEUTRAL_DIR"

if [[ -e "$NEUTRAL_DIR" || -L "$NEUTRAL_DIR" ]]; then
  [[ -d "$NEUTRAL_DIR" && ! -L "$NEUTRAL_DIR" ]] || fail 'private workspace must be a real non-symlink directory'
  validate_existing_workspace
fi

ancestor="$(dirname -- "$NEUTRAL_DIR")"
while [[ ! -d "$ancestor" ]]; do
  [[ "$ancestor" != '/' ]] || fail 'no existing parent directory for the private workspace'
  ancestor="$(dirname -- "$ancestor")"
done
while true; do
  if has_project_context "$ancestor"; then
    fail "refusing project context above the private workspace: $ancestor"
  fi
  [[ "$ancestor" == '/' ]] && break
  ancestor="$(dirname -- "$ancestor")"
done

ensure_directory_chain "$NEUTRAL_DIR"
secure_directory "$NEUTRAL_DIR"
ensure_directory_chain "$NEUTRAL_DIR/.opencode/agents"
secure_directory "$NEUTRAL_DIR/.opencode"
secure_directory "$NEUTRAL_DIR/.opencode/agents"

TEMP_FILE=''
cleanup() {
  if [[ -n "$TEMP_FILE" && -e "$TEMP_FILE" && ! -L "$TEMP_FILE" ]]; then
    rm -- "$TEMP_FILE"
  fi
}
trap cleanup EXIT

write_private_file() {
  local source="$1"
  local destination="$2"
  local contents="$3"
  TEMP_FILE="$(mktemp "$NEUTRAL_DIR/.chatgpt-private.XXXXXX")"
  if [[ -n "$source" ]]; then
    cp -- "$source" "$TEMP_FILE"
  else
    printf '%s\n' "$contents" > "$TEMP_FILE"
  fi
  chmod 600 -- "$TEMP_FILE"
  mv -fT -- "$TEMP_FILE" "$destination"
  TEMP_FILE=''
}

if [[ ! -e "$PROJECT_CONFIG" ]]; then
  write_private_file '' "$PROJECT_CONFIG" "$CONFIG_CONTENT"
else
  chmod 600 -- "$PROJECT_CONFIG"
fi

AGENT_DEST="$NEUTRAL_DIR/.opencode/agents/chatgpt-private.md"
if [[ -e "$AGENT_DEST" || -L "$AGENT_DEST" ]]; then
  [[ -f "$AGENT_DEST" && ! -L "$AGENT_DEST" ]] || fail 'private agent must be a regular non-symlink file'
  [[ "$(stat -c '%u' -- "$AGENT_DEST")" == "$EUID" ]] || fail 'private agent file is not owned by the current user'
fi
if ! cmp -s -- "$AGENT_SOURCE" "$AGENT_DEST"; then
  write_private_file "$AGENT_SOURCE" "$AGENT_DEST" ''
else
  chmod 600 -- "$AGENT_DEST"
fi

unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_DISABLE_PROJECT_CONFIG
cd -- "$NEUTRAL_DIR"
exec "$OPENCODE_LAUNCHER"
