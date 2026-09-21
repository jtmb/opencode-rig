#!/usr/bin/env bash
# Launch the Basic Memory MCP server inside an adaptive user-cgroup memory
# budget, with a prlimit fallback; fail closed when no limiter is available.
#
# The 20% memory / 25% swap fractions mirror the source-control plugin's
# bounded GitHub MCP child, so a long-running note indexer or embedder cannot
# exhaust the login session.
#
# Usage:
#   basic-memory-mcp.sh --verify-only   # print binary, project, limiter, budget
#   basic-memory-mcp.sh                 # exec the bounded stdio MCP server
set -euo pipefail

MEMORY_FRACTION=20
SWAP_FRACTION=25
MINIMUM_BUDGET_BYTES=$((64 * 1024 * 1024))
PROJECT="${BASIC_MEMORY_PROJECT:-computer-assistant}"

fail() {
  printf 'basic-memory-mcp: %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: basic-memory-mcp.sh [--verify-only]

Options:
  --verify-only   Print the resolved binary, project, limiter, and budget
                  without starting the server
  -h, --help      Show this help

Environment:
  BASIC_MEMORY_PROJECT   Basic Memory project (default: computer-assistant)
  BASIC_MEMORY_BIN       basic-memory executable (default: found on PATH)
EOF
}

VERIFY_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

BINARY="${BASIC_MEMORY_BIN:-}"
if [ -z "$BINARY" ]; then
  BINARY="$(command -v basic-memory || true)"
fi
[ -n "$BINARY" ] || fail "basic-memory is not on PATH; see docs/scripts/basic-memory-mcp.md"
[ -x "$BINARY" ] || fail "basic-memory is not executable: $BINARY"

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
      if [ "$group_bytes" -lt "$host_bytes" ]; then
        host_bytes="$group_bytes"
      fi
    fi
  fi
  printf '%s\n' "$host_bytes"
}

effective_swap_free_bytes() {
  local swap_kib swap_bytes group_dir group_max group_current group_bytes
  swap_kib="$(read_meminfo_kib SwapFree || true)"
  swap_bytes=0
  if [ -n "$swap_kib" ]; then
    swap_bytes=$((swap_kib * 1024))
  fi

  group_dir="$(cgroup_path || true)"
  if [ -n "$group_dir" ]; then
    group_max="$(read_numeric_file "$group_dir/memory.swap.max" || true)"
    group_current="$(read_numeric_file "$group_dir/memory.swap.current" || true)"
    if [ -n "$group_max" ] && [ -n "$group_current" ] && [ "$group_max" -gt "$group_current" ]; then
      group_bytes=$((group_max - group_current))
      if [ "$group_bytes" -lt "$swap_bytes" ]; then
        swap_bytes="$group_bytes"
      fi
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
if [ "$SWAP_BUDGET_BYTES" -gt "$BUDGET_SWAP" ]; then
  SWAP_BUDGET_BYTES="$BUDGET_SWAP"
fi

SYSTEMD_RUN="$(command -v systemd-run || true)"
SYSTEMCTL="$(command -v systemctl || true)"
PRLIMIT="$(command -v prlimit || true)"

user_systemd_available() {
  [ -n "$SYSTEMD_RUN" ] || return 1
  [ -n "$SYSTEMCTL" ] || return 1
  "$SYSTEMCTL" --user show-environment >/dev/null 2>&1
}

if user_systemd_available; then
  LIMITER="systemd-run"
  LIMITER_COMMAND=(
    "$SYSTEMD_RUN" --user --pipe --wait --collect --service-type=exec
    "--working-directory=$PWD"
    "--setenv=PATH=$PATH"
    "--setenv=HOME=$HOME"
    "--property=MemoryMax=$BUDGET_BYTES"
    "--property=MemorySwapMax=$SWAP_BUDGET_BYTES"
    --
    "$BINARY" mcp --project "$PROJECT"
  )
elif [ -n "$PRLIMIT" ]; then
  LIMITER="prlimit"
  LIMITER_COMMAND=("$PRLIMIT" "--as=$BUDGET_BYTES" -- "$BINARY" mcp --project "$PROJECT")
else
  fail "no memory limiter available (needs systemd-run --user with systemctl --user, or prlimit)"
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  printf 'binary=%s\n' "$BINARY"
  printf 'project=%s\n' "$PROJECT"
  printf 'limiter=%s\n' "$LIMITER"
  printf 'available_bytes=%s\n' "$AVAILABLE_BYTES"
  printf 'memory_budget_bytes=%s\n' "$BUDGET_BYTES"
  printf 'swap_budget_bytes=%s\n' "$SWAP_BUDGET_BYTES"
  exit 0
fi

exec "${LIMITER_COMMAND[@]}"
