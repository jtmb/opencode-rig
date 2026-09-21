#!/usr/bin/env bash
# Launch the canonical Basic Memory MCP with bounded memory and profile state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$SCRIPT_DIR/mcp_runtime.py"
PROFILE="${OPENCODE_MCP_PROFILE:-native}"
PROFILE_ROOT="${OPENCODE_MCP_PROFILE_ROOT:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}}"
NATIVE_ROOT="${OPENCODE_MCP_NATIVE_ROOT:-$HOME/.local/share/opencode/mcp}"
NATIVE_NOTES="${BASIC_MEMORY_HOME:-$HOME/Documents/computer-assistant/basic-memory}"
NATIVE_CONFIG="$NATIVE_ROOT/basic-memory/config"
PROJECT="${BASIC_MEMORY_PROJECT:-computer-assistant}"
VERSION="$(python3 "$RUNTIME" policy --kind uvx)"
MEMORY_FRACTION=20
SWAP_FRACTION=25
MINIMUM_BUDGET_BYTES=$((64 * 1024 * 1024))

fail() {
  printf 'basic-memory-mcp: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: basic-memory-mcp.sh [--verify-only|--provision]

Options:
  --verify-only   Print the resolved binary, project, limiter, and budget
  --provision     Populate the selected profile's pinned Basic Memory runtime
  -h, --help      Show this help

Environment:
  OPENCODE_MCP_PROFILE       native (default) or wsl2
  OPENCODE_MCP_PROFILE_ROOT  private WSL/profile state root
  BASIC_MEMORY_PROJECT       Basic Memory project (default: computer-assistant)
  BASIC_MEMORY_HOME          native notes/index root (default: ~/Documents/computer-assistant/basic-memory)
  OPENCODE_MCP_NATIVE_ROOT  native private runtime state root
  OPENCODE_MCP_UVX_BIN       trusted uvx override
EOF
}

VERIFY_ONLY=0
PROVISION=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    --provision) PROVISION=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ "$VERIFY_ONLY" -eq 0 ] || [ "$PROVISION" -eq 0 ] || fail "--verify-only and --provision are mutually exclusive"
case "$PROFILE" in
  native|wsl2) ;;
  *) fail "unsupported MCP profile: $PROFILE" ;;
esac

read_meminfo_kib() {
  local wanted="$1"
  local key value _unit
  [ -r /proc/meminfo ] || return 1
  while read -r key value _unit; do
    if [ "$key" = "$wanted:" ] && [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < /proc/meminfo
  return 1
}

read_numeric_file() {
  local path="$1"
  local value
  [ -r "$path" ] || return 1
  read -r value < "$path" || return 1
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$value"
}

cgroup_path() {
  local _hierarchy controllers path
  [ -r /proc/self/cgroup ] || return 1
  while IFS=: read -r _hierarchy controllers path; do
    if [ -z "$controllers" ]; then
      printf '/sys/fs/cgroup%s\n' "$path"
      return 0
    fi
  done < /proc/self/cgroup
  return 1
}

effective_available_bytes() {
  local host_kib host_bytes group_dir group_max group_current group_bytes
  host_kib="$(read_meminfo_kib MemAvailable || true)"
  [ -n "$host_kib" ] || fail "cannot read MemAvailable from /proc/meminfo"
  host_bytes=$((host_kib * 1024))
  group_dir="$(cgroup_path || true)"
  if [ -n "$group_dir" ]; then
    group_max="$(read_numeric_file "$group_dir/memory.max" || true)"
    group_current="$(read_numeric_file "$group_dir/memory.current" || true)"
    if [ -n "$group_max" ] && [ -n "$group_current" ] && [ "$group_max" -gt "$group_current" ]; then
      group_bytes=$((group_max - group_current))
      if [ "$group_bytes" -lt "$host_bytes" ]; then host_bytes="$group_bytes"; fi
    fi
  fi
  printf '%s\n' "$host_bytes"
}

effective_swap_free_bytes() {
  local swap_kib swap_bytes group_dir group_max group_current group_bytes
  swap_kib="$(read_meminfo_kib SwapFree || true)"
  swap_bytes=0
  if [ -n "$swap_kib" ]; then swap_bytes=$((swap_kib * 1024)); fi
  group_dir="$(cgroup_path || true)"
  if [ -n "$group_dir" ]; then
    group_max="$(read_numeric_file "$group_dir/memory.swap.max" || true)"
    group_current="$(read_numeric_file "$group_dir/memory.swap.current" || true)"
    if [ -n "$group_max" ] && [ -n "$group_current" ] && [ "$group_max" -gt "$group_current" ]; then
      group_bytes=$((group_max - group_current))
      if [ "$group_bytes" -lt "$swap_bytes" ]; then swap_bytes="$group_bytes"; fi
    fi
  fi
  printf '%s\n' "$swap_bytes"
}

AVAILABLE_BYTES="$(effective_available_bytes)"
BUDGET_BYTES=$((AVAILABLE_BYTES * MEMORY_FRACTION / 100))
[ "$BUDGET_BYTES" -ge "$MINIMUM_BUDGET_BYTES" ] || fail "only ${AVAILABLE_BYTES} bytes are available; refusing to start without a usable budget"
SWAP_FREE_BYTES="$(effective_swap_free_bytes)"
SWAP_BUDGET_BYTES=$((SWAP_FREE_BYTES * SWAP_FRACTION / 100))
BUDGET_SWAP=$((BUDGET_BYTES * SWAP_FRACTION / 100))
if [ "$SWAP_BUDGET_BYTES" -gt "$BUDGET_SWAP" ]; then SWAP_BUDGET_BYTES="$BUDGET_SWAP"; fi

if [ "$PROFILE" = "wsl2" ]; then
  [[ "$PROFILE_ROOT" = /* ]] || fail "wsl2 MCP profile root must be absolute"
  if [ "$PROVISION" -eq 1 ]; then
    python3 "$RUNTIME" prepare --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --apply --quiet
  fi
  UVX="$(python3 "$RUNTIME" runner --kind uvx --override "${OPENCODE_MCP_UVX_BIN:-}" 2>/dev/null || true)"
  [ -n "$UVX" ] || fail "no trusted uvx runner is available"
  MCP_ROOT="$PROFILE_ROOT/mcp/basic-memory"
  environment=(
    "HOME=$MCP_ROOT/home"
    "BASIC_MEMORY_HOME=$MCP_ROOT/notes"
    "BASIC_MEMORY_CONFIG_DIR=$MCP_ROOT/home"
    "BASIC_MEMORY_DEFAULT_PROJECT=$PROJECT"
    "BASIC_MEMORY_NO_PROMOS=1"
    "UV_CACHE_DIR=$PROFILE_ROOT/cache/uv"
    "PATH=$(dirname "$UVX"):/usr/local/bin:/usr/bin:/bin"
    "LANG=${LANG:-C.UTF-8}"
  )
  for name in HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy SSL_CERT_FILE SSL_CERT_DIR; do
    if [[ -n "${!name:-}" ]]; then environment+=("$name=${!name}"); fi
  done
  SYSTEMD_RUN="$(command -v systemd-run || true)"
  SYSTEMCTL="$(command -v systemctl || true)"
  PRLIMIT="$(command -v prlimit || true)"
  user_systemd_available() { [ -n "$SYSTEMD_RUN" ] && [ -n "$SYSTEMCTL" ] && "$SYSTEMCTL" --user show-environment >/dev/null 2>&1; }
  if user_systemd_available; then
    LIMITER="systemd-run"
  elif [ -n "$PRLIMIT" ]; then
    LIMITER="prlimit"
  else
    fail "no memory limiter available (needs systemd-run --user with systemctl --user, or prlimit)"
  fi
  run_limited() {
    if [ "$LIMITER" = "systemd-run" ]; then
      "$SYSTEMD_RUN" --user --pipe --wait --collect --service-type=exec \
        "--working-directory=$PWD" "--property=MemoryMax=$BUDGET_BYTES" \
        "--property=MemorySwapMax=$SWAP_BUDGET_BYTES" -- \
        /usr/bin/env -i "${environment[@]}" "$@"
    fi
    /usr/bin/env -i "${environment[@]}" "$PRLIMIT" "--as=$BUDGET_BYTES" -- "$@"
  }
  if [ "$PROVISION" -eq 1 ]; then
    run_limited "$UVX" --prerelease=allow --from "basic-memory==$VERSION" basic-memory --version
    if ! python3 "$RUNTIME" basic-project --config "$MCP_ROOT/home/config.json" --notes "$MCP_ROOT/notes" --project "$PROJECT" --quiet; then
      run_limited "$UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" \
        basic-memory project add "$PROJECT" "$MCP_ROOT/notes" --local --default
    fi
  fi
  if [ "$VERIFY_ONLY" -eq 1 ]; then
    python3 "$RUNTIME" mcp-runtime --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --quiet
  elif [ "$PROVISION" -eq 0 ]; then
    python3 "$RUNTIME" mcp-runtime --profile "$PROFILE" --profile-root "$PROFILE_ROOT" --quiet
  fi
  python3 "$RUNTIME" basic-project --config "$MCP_ROOT/home/config.json" --notes "$MCP_ROOT/notes" --project "$PROJECT" --quiet
  if [ "$VERIFY_ONLY" -eq 1 ]; then
    printf 'binary=%s\n' "$UVX"
    printf 'project=%s\n' "$PROJECT"
    printf 'limiter=%s\n' "$LIMITER"
    printf 'available_bytes=%s\n' "$AVAILABLE_BYTES"
    printf 'memory_budget_bytes=%s\n' "$BUDGET_BYTES"
    printf 'swap_budget_bytes=%s\n' "$SWAP_BUDGET_BYTES"
    exit 0
  fi
  run_limited "$UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory mcp --project "$PROJECT"
  exit $?
fi

NATIVE_UVX="$(python3 "$RUNTIME" runner --kind uvx --override "${OPENCODE_MCP_UVX_BIN:-}" 2>/dev/null || true)"
[ -n "$NATIVE_UVX" ] || fail "no trusted uvx runner is available"
environment=(
  "HOME=$HOME"
  "BASIC_MEMORY_HOME=$NATIVE_NOTES"
  "BASIC_MEMORY_CONFIG_DIR=$NATIVE_CONFIG"
  "BASIC_MEMORY_DEFAULT_PROJECT=$PROJECT"
  "BASIC_MEMORY_NO_PROMOS=1"
  "PATH=$(dirname "$NATIVE_UVX"):/usr/local/bin:/usr/bin:/bin"
  "LANG=${LANG:-C.UTF-8}"
)
for name in HTTPS_PROXY https_proxy ALL_PROXY all_proxy NO_PROXY no_proxy SSL_CERT_FILE SSL_CERT_DIR; do
  if [[ -n "${!name:-}" ]]; then environment+=("$name=${!name}"); fi
done
if [ "$PROVISION" -eq 1 ]; then
  python3 "$RUNTIME" prepare --profile native --apply --quiet
  /usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --prerelease=allow --from "basic-memory==$VERSION" basic-memory --version
  if ! python3 "$RUNTIME" basic-project --config "$NATIVE_CONFIG/config.json" --notes "$NATIVE_NOTES" --project "$PROJECT" --quiet; then
    /usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --offline --prerelease=allow \
      --from "basic-memory==$VERSION" basic-memory project add "$PROJECT" "$NATIVE_NOTES" --local --default
  fi
  python3 "$RUNTIME" basic-project --config "$NATIVE_CONFIG/config.json" --notes "$NATIVE_NOTES" --project "$PROJECT" --quiet
  exit $?
fi
if [ "$VERIFY_ONLY" -eq 1 ]; then
  version_output="$(/usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory --version 2>&1 || true)"
  [[ "$version_output" == *"$VERSION"* ]] || fail "Basic Memory runtime is not pinned to $VERSION: ${version_output%%$'\n'*}"
else
  python3 "$RUNTIME" mcp-runtime --profile native --quiet
fi
python3 "$RUNTIME" basic-project --config "$NATIVE_CONFIG/config.json" --notes "$NATIVE_NOTES" --project "$PROJECT" --quiet
SYSTEMD_RUN="$(command -v systemd-run || true)"
SYSTEMCTL="$(command -v systemctl || true)"
PRLIMIT="$(command -v prlimit || true)"
user_systemd_available() { [ -n "$SYSTEMD_RUN" ] && [ -n "$SYSTEMCTL" ] && "$SYSTEMCTL" --user show-environment >/dev/null 2>&1; }
if user_systemd_available; then
  LIMITER="systemd-run"
  LIMITER_COMMAND=("$SYSTEMD_RUN" --user --pipe --wait --collect --service-type=exec "--working-directory=$PWD" "--property=MemoryMax=$BUDGET_BYTES" "--property=MemorySwapMax=$SWAP_BUDGET_BYTES" -- /usr/bin/env -i "${environment[@]}" "$NATIVE_UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory mcp --project "$PROJECT")
elif [ -n "$PRLIMIT" ]; then
  LIMITER="prlimit"
  LIMITER_COMMAND=(/usr/bin/env -i "${environment[@]}" "$PRLIMIT" "--as=$BUDGET_BYTES" -- "$NATIVE_UVX" --offline --prerelease=allow --from "basic-memory==$VERSION" basic-memory mcp --project "$PROJECT")
else
  fail "no memory limiter available (needs systemd-run --user with systemctl --user, or prlimit)"
fi
if [ "$VERIFY_ONLY" -eq 1 ]; then
  printf 'binary=%s\n' "$NATIVE_UVX"
  printf 'project=%s\n' "$PROJECT"
  printf 'version=%s\n' "$VERSION"
  printf 'notes=%s\n' "$NATIVE_NOTES"
  printf 'limiter=%s\n' "$LIMITER"
  printf 'available_bytes=%s\n' "$AVAILABLE_BYTES"
  printf 'memory_budget_bytes=%s\n' "$BUDGET_BYTES"
  printf 'swap_budget_bytes=%s\n' "$SWAP_BUDGET_BYTES"
  exit 0
fi
exec "${LIMITER_COMMAND[@]}"
