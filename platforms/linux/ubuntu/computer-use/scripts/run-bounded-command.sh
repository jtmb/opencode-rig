#!/usr/bin/env bash
# Run a memory-intensive repository command in an adaptive, isolated budget.
#
# The budget is calculated from current host and cgroup availability instead of
# using a machine-specific byte ceiling. This protects a long-lived OpenCode
# process from a compiler or test process exhausting the whole login session.
set -euo pipefail

MEMORY_FRACTION=40
SWAP_FRACTION=25
NODE_HEAP_FRACTION=65
COMMAND_TIMEOUT="15m"
PRINT_BUDGET=0

usage() {
  cat <<'EOF'
Usage: run-bounded-command.sh [options] -- command [args...]
       run-bounded-command.sh --print-budget

Run one command with an adaptive memory budget and timeout.

Options:
  --memory-fraction PERCENT  Share of effective available memory (default: 40)
  --swap-fraction PERCENT    Share of the memory budget usable as swap (default: 25)
  --node-heap-fraction PERCENT  Share of the memory budget for V8 (default: 65)
  --timeout DURATION         Maximum runtime accepted by timeout (default: 15m)
  --print-budget             Print the current calculated budget and exit
  -h, --help                 Show this help

The command must follow --. The budget is recalculated for every invocation.
Checks are serialized through the user runtime directory. If neither
systemd-run nor prlimit is available, the command fails closed instead of
running without a memory limit.
EOF
}

fail() {
  printf 'bounded-command: %s\n' "$*" >&2
  exit 2
}

validate_percent() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be an integer percentage"
  [ "$value" -gt 0 ] || fail "$name must be greater than zero"
  [ "$value" -le 90 ] || fail "$name must be at most 90"
}

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
  if [ -n "$host_kib" ]; then
    host_bytes=$((host_kib * 1024))
  else
    host_bytes="$(getconf _AVPHYS_PAGES 2>/dev/null || true)"
    if [[ "$host_bytes" =~ ^[0-9]+$ ]]; then
      host_bytes=$((host_bytes * $(getconf PAGE_SIZE)))
    else
      fail "cannot read available memory from /proc or getconf"
    fi
  fi

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

minimum_budget_bytes() {
  local available="$1"
  local budget=$((available * MEMORY_FRACTION / 100))
  # Refuse a command that cannot give Node a useful heap. This is only a
  # viability check; the actual ceiling continues to scale with availability.
  local minimum=$((128 * 1024 * 1024))
  [ "$budget" -ge "$minimum" ] || fail "only $available bytes are available; refusing an unsafe check"
  printf '%s\n' "$budget"
}

print_budget() {
  local available budget swap_free swap_bytes heap_mb
  available="$(effective_available_bytes)"
  budget="$(minimum_budget_bytes "$available")"
  swap_free="$(read_meminfo_kib SwapFree || true)"
  if [ -n "$swap_free" ]; then
    swap_bytes=$((swap_free * 1024 * SWAP_FRACTION / 100))
    local budget_swap=$((budget * SWAP_FRACTION / 100))
    [ "$swap_bytes" -lt "$budget_swap" ] || swap_bytes="$budget_swap"
  else
    swap_bytes=0
  fi
  heap_mb=$((budget * NODE_HEAP_FRACTION / 100 / 1024 / 1024))
  [ "$heap_mb" -ge 64 ] || heap_mb=64
  printf 'available_bytes=%s\n' "$available"
  printf 'memory_budget_bytes=%s\n' "$budget"
  printf 'swap_budget_bytes=%s\n' "$swap_bytes"
  printf 'node_heap_mb=%s\n' "$heap_mb"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --memory-fraction)
      [ "$#" -ge 2 ] || fail "--memory-fraction requires a value"
      MEMORY_FRACTION="$2"
      shift 2
      ;;
    --memory-fraction=*)
      MEMORY_FRACTION="${1#*=}"
      shift
      ;;
    --swap-fraction)
      [ "$#" -ge 2 ] || fail "--swap-fraction requires a value"
      SWAP_FRACTION="$2"
      shift 2
      ;;
    --swap-fraction=*)
      SWAP_FRACTION="${1#*=}"
      shift
      ;;
    --node-heap-fraction)
      [ "$#" -ge 2 ] || fail "--node-heap-fraction requires a value"
      NODE_HEAP_FRACTION="$2"
      shift 2
      ;;
    --node-heap-fraction=*)
      NODE_HEAP_FRACTION="${1#*=}"
      shift
      ;;
    --timeout)
      [ "$#" -ge 2 ] || fail "--timeout requires a value"
      COMMAND_TIMEOUT="$2"
      shift 2
      ;;
    --timeout=*)
      COMMAND_TIMEOUT="${1#*=}"
      shift
      ;;
    --print-budget)
      PRINT_BUDGET=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "options must precede --; got $1"
      ;;
  esac
done

validate_percent "--memory-fraction" "$MEMORY_FRACTION"
validate_percent "--swap-fraction" "$SWAP_FRACTION"
validate_percent "--node-heap-fraction" "$NODE_HEAP_FRACTION"

if [ "$PRINT_BUDGET" -eq 1 ]; then
  [ "$#" -eq 0 ] || fail "--print-budget cannot be combined with a command"
  print_budget
  exit 0
fi

[ "$#" -gt 0 ] || fail "a command is required after --"
command -v timeout >/dev/null 2>&1 || fail "timeout is required"
command -v flock >/dev/null 2>&1 || fail "flock is required"
TIMEOUT_BIN="$(command -v timeout)"

AVAILABLE_BYTES="$(effective_available_bytes)"
MEMORY_BYTES="$(minimum_budget_bytes "$AVAILABLE_BYTES")"
SWAP_FREE_KIB="$(read_meminfo_kib SwapFree || true)"
if [ -n "$SWAP_FREE_KIB" ]; then
  SWAP_BYTES=$((SWAP_FREE_KIB * 1024 * SWAP_FRACTION / 100))
  BUDGET_SWAP_BYTES=$((MEMORY_BYTES * SWAP_FRACTION / 100))
  [ "$SWAP_BYTES" -lt "$BUDGET_SWAP_BYTES" ] || SWAP_BYTES="$BUDGET_SWAP_BYTES"
else
  SWAP_BYTES=0
fi
NODE_HEAP_MB=$((MEMORY_BYTES * NODE_HEAP_FRACTION / 100 / 1024 / 1024))
[ "$NODE_HEAP_MB" -ge 64 ] || NODE_HEAP_MB=64

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
LOCK_PATH="$RUNTIME_DIR/opencode-rig-bounded-command.lock"
exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  fail "another bounded command is already running"
fi

printf 'bounded-command: available=%sMiB budget=%sMiB swap=%sMiB node_heap=%sMiB\n' \
  "$((AVAILABLE_BYTES / 1024 / 1024))" \
  "$((MEMORY_BYTES / 1024 / 1024))" \
  "$((SWAP_BYTES / 1024 / 1024))" \
  "$NODE_HEAP_MB" >&2

# The check command owns NODE_OPTIONS while it runs so an inherited heap setting
# cannot silently exceed the calculated ceiling.
export NODE_OPTIONS="--max-old-space-size=$NODE_HEAP_MB"

if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 \
  && systemctl --user show-environment >/dev/null 2>&1; then
  systemd-run --user --pipe --wait --collect --service-type=exec \
    --working-directory="$PWD" \
    --setenv="PATH=$PATH" \
    --setenv="HOME=$HOME" \
    --setenv="NODE_OPTIONS=$NODE_OPTIONS" \
    --property="MemoryMax=$MEMORY_BYTES" \
    --property="MemorySwapMax=$SWAP_BYTES" \
    -- "$TIMEOUT_BIN" --foreground --kill-after=10s "$COMMAND_TIMEOUT" "$@"
  exit $?
fi

if command -v prlimit >/dev/null 2>&1; then
  prlimit --as="$MEMORY_BYTES" -- "$TIMEOUT_BIN" --foreground --kill-after=10s "$COMMAND_TIMEOUT" "$@"
  exit $?
fi

fail "no supported memory limiter is available; refusing to run unbounded"
