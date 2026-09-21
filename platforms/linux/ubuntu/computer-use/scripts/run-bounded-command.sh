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
LOCK_TIMEOUT=30
PRINT_BUDGET=0
REQUIRE_CGROUP=0
MAX_TREE_PROCESSES=256
MAX_TREE_DEPTH=64
MAX_CHILD_ENTRIES=512
declare -A TREE_STARTTIME TREE_DEPTH

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
  --lock-timeout SECONDS     Maximum time to wait for another check (default: 30)
  --print-budget             Print the current calculated budget and exit
  --require-cgroup           Refuse the process-tree fallback
  -h, --help                 Show this help

The command must follow --. The budget is recalculated for every invocation.
Checks are serialized through the user runtime directory and contenders wait
for a bounded time instead of failing immediately. The systemd path uses a
cgroup memory ceiling. The prlimit fallback uses a generous virtual-address
ceiling plus a process-tree RSS monitor; if its monitoring dependencies are
unavailable, the command fails closed instead of running unbounded.
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

validate_seconds() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || fail "$name must be a positive integer number of seconds"
  [ "$value" -gt 0 ] || fail "$name must be greater than zero"
}

read_meminfo_kib() {
  local wanted="$1"
  local key value _unit
  [ -r "$PROC_ROOT/meminfo" ] || return 1
  while read -r key value _unit; do
    if [ "$key" = "$wanted:" ] && [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  done < "$PROC_ROOT/meminfo"
  return 1
}

cgroup_path() {
  local _hierarchy controllers path
  [ -r "$PROC_ROOT/self/cgroup" ] || return 1
  while IFS=: read -r _hierarchy controllers path; do
    if [ -z "$controllers" ]; then
      [[ "$path" = /* && "$path" != *..* ]] || return 1
      printf '%s%s\n' "${CGROUP_ROOT%/}" "${path%/}"
      return 0
    fi
  done < "$PROC_ROOT/self/cgroup"
  return 1
}

cgroup_ancestor_paths() {
  local directory="$1" depth=0
  directory="${directory%/}"
  while :; do
    case "$directory" in
      "$CGROUP_ROOT"|"$CGROUP_ROOT"/*) printf '%s\n' "$directory" ;;
      *) return 1 ;;
    esac
    [ "$directory" = "${CGROUP_ROOT%/}" ] && return 0
    depth=$((depth + 1))
    [ "$depth" -le 32 ] || return 1
    directory="${directory%/*}"
    [ -n "$directory" ] || directory="${CGROUP_ROOT%/}"
  done
}

read_cgroup_setting() {
  local path="$1" label="$2" value
  [ -r "$path" ] || return 1
  read -r value < "$path" || return 2
  if [ "$value" = max ] || [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  printf 'bounded-command: malformed %s\n' "$label" >&2
  return 2
}

read_cgroup_current() {
  local path="$1" label="$2" value
  [ -r "$path" ] || return 1
  read -r value < "$path" || return 2
  [[ "$value" =~ ^[0-9]+$ ]] || { printf 'bounded-command: malformed %s\n' "$label" >&2; return 2; }
  printf '%s\n' "$value"
}

effective_available_bytes() {
  local host_kib host_bytes group_dir group_max group_current group_bytes
  local ancestors directory index setting_status
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
    ancestors="$(cgroup_ancestor_paths "$group_dir" || true)"
    [ -n "$ancestors" ] || fail "cannot safely traverse cgroup ancestors"
    index=0
    while IFS= read -r directory; do
      if group_max="$(read_cgroup_setting "$directory/memory.max" "$directory/memory.max")"; then
        :
      else
        setting_status=$?
        [ "$setting_status" -eq 1 ] && { index=$((index + 1)); continue; }
        return 2
      fi
      if [ "$group_max" != max ]; then
        if group_current="$(read_cgroup_current "$directory/memory.current" "$directory/memory.current")"; then
          :
        else
          fail "missing or malformed cgroup memory.current: $directory"
        fi
        if [ "$group_current" -gt "$group_max" ]; then
          fail "inconsistent cgroup memory.current: $directory"
        elif [ "$group_current" -eq "$group_max" ]; then
          host_bytes=0
        else
          group_bytes=$((group_max - group_current))
          [ "$group_bytes" -lt "$host_bytes" ] && host_bytes="$group_bytes"
        fi
      fi
      index=$((index + 1))
    done <<< "$ancestors"
  fi
  printf '%s\n' "$host_bytes"
}

available_swap_bytes() {
  local swap_free group_dir group_max group_current group_bytes ancestors directory index setting_status
  swap_free="$(read_meminfo_kib SwapFree || true)"
  [ -n "$swap_free" ] || { printf '0\n'; return 0; }
  swap_free=$((swap_free * 1024))
  group_dir="$(cgroup_path || true)"
  if [ -n "$group_dir" ]; then
    ancestors="$(cgroup_ancestor_paths "$group_dir" || true)"
    [ -n "$ancestors" ] || fail "cannot safely traverse cgroup ancestors"
    index=0
    while IFS= read -r directory; do
      if group_max="$(read_cgroup_setting "$directory/memory.swap.max" "$directory/memory.swap.max")"; then
        :
      else
        setting_status=$?
        [ "$setting_status" -eq 1 ] && { index=$((index + 1)); continue; }
        return 2
      fi
      if [ "$group_max" != max ]; then
        if group_current="$(read_cgroup_current "$directory/memory.swap.current" "$directory/memory.swap.current")"; then
          :
        else
          fail "missing or malformed cgroup memory.swap.current: $directory"
        fi
        if [ "$group_current" -gt "$group_max" ]; then
          fail "inconsistent cgroup memory.swap.current: $directory"
        elif [ "$group_current" -eq "$group_max" ]; then
          swap_free=0
        else
          group_bytes=$((group_max - group_current))
          [ "$group_bytes" -lt "$swap_free" ] && swap_free="$group_bytes"
        fi
      fi
      index=$((index + 1))
    done <<< "$ancestors"
  fi
  printf '%s\n' "$swap_free"
}

validate_private_dir() {
  local path="$1" private="$2" owner mode perm
  [ -d "$path" ] && [ ! -L "$path" ] || fail "runtime directory must be a real directory: $path"
  owner="$(stat -c %u "$path" 2>/dev/null || true)"
  mode="$(stat -c %a "$path" 2>/dev/null || true)"
  [ "$owner" = "$(id -u)" ] || fail "runtime directory is not owned by the current user: $path"
  [[ "$mode" =~ ^[0-7]+$ ]] || fail "cannot inspect runtime directory mode: $path"
  perm=$((8#$mode))
  (( (perm & 18) == 0 )) || fail "runtime directory is group/world writable: $path"
  if [ "$private" -eq 1 ] && (( (perm & 63) != 0 )); then
    fail "runtime directory is not private: $path"
  fi
}

prepare_runtime_dir() {
  local path parent
  if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    RUNTIME_DIR="$XDG_RUNTIME_DIR"
    while [[ "$RUNTIME_DIR" != / && "$RUNTIME_DIR" == */ ]]; do
      RUNTIME_DIR="${RUNTIME_DIR%/}"
    done
    validate_private_dir "$RUNTIME_DIR" 1
    return 0
  fi
  [ -n "${HOME:-}" ] || fail "HOME is required when XDG_RUNTIME_DIR is unset"
  for path in "$HOME/.cache" "$HOME/.cache/opencode-rig" "$HOME/.cache/opencode-rig/runtime"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      if [ "$path" = "$HOME/.cache/opencode-rig/runtime" ]; then
        validate_private_dir "$path" 1
      else
        validate_private_dir "$path" 0
      fi
    else
      parent="${path%/*}"
      validate_private_dir "$parent" 0
      (umask 077 && mkdir "$path") || fail "cannot create private runtime directory: $path"
      validate_private_dir "$path" 1
    fi
  done
  RUNTIME_DIR="$HOME/.cache/opencode-rig/runtime"
}

prepare_lock_file() {
  local owner mode perm fd_path
  LOCK_PATH="$RUNTIME_DIR/opencode-rig-bounded-command.lock"
  if [ -L "$LOCK_PATH" ]; then
    fail "lock path must not be a symlink: $LOCK_PATH"
  fi
  if [ -e "$LOCK_PATH" ] && [ ! -f "$LOCK_PATH" ]; then
    fail "lock path must be a regular file: $LOCK_PATH"
  fi
  if [ ! -e "$LOCK_PATH" ]; then
    (umask 077 && : > "$LOCK_PATH") || fail "cannot create lock file: $LOCK_PATH"
  fi
  [ ! -L "$LOCK_PATH" ] && [ -f "$LOCK_PATH" ] || fail "lock path changed to an unsafe file"
  owner="$(stat -c %u "$LOCK_PATH" 2>/dev/null || true)"
  mode="$(stat -c %a "$LOCK_PATH" 2>/dev/null || true)"
  [ "$owner" = "$(id -u)" ] || fail "lock file is not owned by the current user"
  [[ "$mode" =~ ^[0-7]+$ ]] || fail "cannot inspect lock file mode"
  perm=$((8#$mode))
  (( (perm & 63) == 0 )) || fail "lock file is group/world accessible"
  exec 9>>"$LOCK_PATH"
  fd_path="$(readlink "/proc/$$/fd/9" 2>/dev/null || true)"
  [ "$fd_path" = "$LOCK_PATH" ] || fail "lock descriptor does not reference the safe lock file"
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

duration_seconds() {
  local value="$1"
  local amount unit multiplier
  if [[ "$value" =~ ^([0-9]+)(ms|s|m|h|d)?$ ]]; then
    amount="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]:-s}"
    case "$unit" in
      ms) multiplier=1; amount=$((amount / 1000)) ;;
      s) multiplier=1 ;;
      m) multiplier=60 ;;
      h) multiplier=3600 ;;
      d) multiplier=86400 ;;
    esac
    printf '%s\n' "$((amount * multiplier))"
    return 0
  fi
  return 1
}

proc_stat_info() {
  local pid="$1"
  local line tail
  local -a fields
  PROC_STARTTIME=''
  PROC_STAT_PPID=''
  PROC_PGRP=''
  [ -r "$PROC_ROOT/$pid/stat" ] || return 1
  line="$(<"$PROC_ROOT/$pid/stat")" || return 1
  # Everything through the final ") " is the comm field. This avoids the
  # usual whitespace parser bug when a process name contains spaces or ')'.
  tail="${line##*') '}"
  read -r -a fields <<< "$tail"
  [ "${#fields[@]}" -ge 20 ] || return 1
  PROC_STAT_PPID="${fields[1]}"
  PROC_PGRP="${fields[2]}"
  PROC_STARTTIME="${fields[19]}"
  [[ "$PROC_STAT_PPID" =~ ^[0-9]+$ && "$PROC_PGRP" =~ ^[0-9]+$ && "$PROC_STARTTIME" =~ ^[0-9]+$ ]]
}

proc_info() {
  local pid="$1"
  local key value
  PROC_PARENT=''
  PROC_RSS_KIB=''
  PROC_RSS_ANON=''
  PROC_RSS_FILE=''
  PROC_RSS_SHMEM=''
  PROC_STATE=''
  PROC_STARTTIME=''
  PROC_PGRP=''
  if [ "${BOUNDED_COMMAND_TESTING:-0}" = 1 ] \
    && [ -r "${BOUNDED_COMMAND_TEST_MALFORM_PID_FILE:-}" ] \
    && [ "$(<"$BOUNDED_COMMAND_TEST_MALFORM_PID_FILE")" = "$pid" ]; then
    return 1
  fi
  [ -r "$PROC_ROOT/$pid/status" ] || return 1
  while IFS=: read -r key value; do
    key="${key//[[:space:]]/}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%%[[:space:]]*}"
    case "$key" in
      PPid) PROC_PARENT="$value" ;;
      VmRSS) PROC_RSS_KIB="$value" ;;
      RssAnon) PROC_RSS_ANON="$value" ;;
      RssFile) PROC_RSS_FILE="$value" ;;
      RssShmem) PROC_RSS_SHMEM="$value" ;;
      State) PROC_STATE="$value" ;;
    esac
  done < "$PROC_ROOT/$pid/status"
  [ ! -e "$PROC_ROOT/$pid/status" ] && return 2
  if [[ ! "$PROC_RSS_KIB" =~ ^[0-9]+$ ]] \
    && [[ "$PROC_RSS_ANON" =~ ^[0-9]+$ && "$PROC_RSS_FILE" =~ ^[0-9]+$ \
      && "$PROC_RSS_SHMEM" =~ ^[0-9]+$ ]]; then
    PROC_RSS_KIB=$((PROC_RSS_ANON + PROC_RSS_FILE + PROC_RSS_SHMEM))
  fi
  if [[ ! "$PROC_RSS_KIB" =~ ^[0-9]+$ ]] && [ -r "$PROC_ROOT/$pid/statm" ]; then
    local _statm_size _statm_resident
    read -r _statm_size _statm_resident < "$PROC_ROOT/$pid/statm" || true
    if [[ "${_statm_resident:-}" =~ ^[0-9]+$ ]]; then
      # Linux pages are 4096 bytes on supported Ubuntu targets. The fallback
      # must not depend on another PATH utility while PATH is being tested.
      PROC_RSS_KIB=$((_statm_resident * 4096 / 1024))
    fi
  fi
  proc_stat_info "$pid" || return 1
  [ "$PROC_PARENT" = "$PROC_STAT_PPID" ] || PROC_PARENT="$PROC_STAT_PPID"
  if [[ "$PROC_PARENT" =~ ^[0-9]+$ && "$PROC_RSS_KIB" =~ ^[0-9]+$ \
    && "$PROC_STARTTIME" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  [ "$PROC_STATE" = Z ] && return 2
  return 1
}

pid_in_tree() {
  local candidate="$1"
  local pid
  for pid in "${TREE_PIDS[@]}"; do
    [ "$pid" = "$candidate" ] && return 0
  done
  return 1
}

tree_rss_bytes() {
  local pid child child_file child_count depth proc_status retry
  TREE_PIDS=("$ROOT_PID")
  TREE_RSS_BYTES=0
  TREE_DEPTH=()
  TREE_DEPTH["$ROOT_PID"]=0
  for ((TREE_INDEX=0; TREE_INDEX < ${#TREE_PIDS[@]}; TREE_INDEX++)); do
    pid="${TREE_PIDS[$TREE_INDEX]}"
    if proc_info "$pid"; then
      :
    else
      proc_status=$?
      if [ "$pid" = "$ROOT_PID" ] && [ -e "$PROC_ROOT/$pid/status" ] && [ -e "$PROC_ROOT/$pid/stat" ]; then
        for ((retry=0; retry<5; retry++)); do
          sleep 0.01
          proc_info "$pid" && break
        done
        [[ "$PROC_STARTTIME" =~ ^[0-9]+$ && "$PROC_RSS_KIB" =~ ^[0-9]+$ ]] && proc_status=0
      fi
      if [ "$proc_status" -ne 0 ]; then
        # A process can disappear between kill -0 and /proc inspection. A
        # missing root ends the normal wait; a malformed live root is unsafe.
        [ "$pid" != "$ROOT_PID" ] && continue
        [ "$proc_status" -eq 2 ] && return 2
        { [ ! -e "$PROC_ROOT/$pid/status" ] || [ ! -e "$PROC_ROOT/$pid/stat" ]; } && return 2
        return 1
      fi
    fi
    if [ "$pid" = "$ROOT_PID" ]; then
      if [ -z "${ROOT_STARTTIME:-}" ]; then
        TREE_STARTTIME["$pid"]="$PROC_STARTTIME"
        ROOT_STARTTIME="$PROC_STARTTIME"
      elif [ "$PROC_STARTTIME" != "$ROOT_STARTTIME" ]; then
        return 1
      fi
    elif [ -n "${TREE_STARTTIME[$pid]:-}" ] \
      && [ "$PROC_STARTTIME" != "${TREE_STARTTIME[$pid]}" ]; then
      return 1
    fi
    TREE_RSS_BYTES=$((TREE_RSS_BYTES + PROC_RSS_KIB * 1024))
    depth="${TREE_DEPTH[$pid]}"
    child_file="$PROC_ROOT/$pid/task/$pid/children"
    if [ ! -r "$child_file" ]; then
      [ "$pid" != "$ROOT_PID" ] && continue
      { [ ! -e "$PROC_ROOT/$pid/status" ] || [ ! -e "$PROC_ROOT/$pid/stat" ]; } && return 2
      return 1
    fi
    CHILDREN=()
    if ! read -r -a CHILDREN < "$child_file"; then
      [ ! -s "$child_file" ] || return 1
    fi
    child_count="${#CHILDREN[@]}"
    [ "$child_count" -le "$MAX_CHILD_ENTRIES" ] || return 1
    [ "$depth" -lt "$MAX_TREE_DEPTH" ] || { [ "$child_count" -eq 0 ] && continue; return 1; }
    for child in "${CHILDREN[@]}"; do
      [ -n "$child" ] || continue
      [[ "$child" =~ ^[0-9]+$ ]] || return 1
      pid_in_tree "$child" && continue
      # A PID listed in children can vanish between the read and inspection;
      # that is the one permitted race. A live entry must validate fully.
      if [ ! -e "$PROC_ROOT/$child/status" ]; then
        continue
      fi
      if ! proc_info "$child"; then
        [ ! -e "$PROC_ROOT/$child/status" ] && continue
        for ((retry=0; retry<5; retry++)); do
          sleep 0.01
          proc_info "$child" && break
        done
        if [[ "$PROC_PARENT" =~ ^[0-9]+$ && "$PROC_RSS_KIB" =~ ^[0-9]+$ \
          && "$PROC_STARTTIME" =~ ^[0-9]+$ ]]; then
          :
        else
          [ ! -e "$PROC_ROOT/$child/status" ] && continue
          return 1
        fi
      fi
      [ "$PROC_PARENT" = "$pid" ] || return 1
      [ -z "${TREE_STARTTIME[$child]:-}" ] || [ "$PROC_STARTTIME" = "${TREE_STARTTIME[$child]}" ] || return 1
      [ "${#TREE_PIDS[@]}" -lt "$MAX_TREE_PROCESSES" ] || return 1
      TREE_PIDS+=("$child")
      TREE_STARTTIME["$child"]="$PROC_STARTTIME"
      TREE_DEPTH["$child"]=$((depth + 1))
    done
  done
  return 0
}

terminate_fallback_group() {
  local signal="$1"
  local pid root_live=1 retry
  # Verify identity before using the negative PID. Individual descendants are
  # revalidated immediately before signaling to avoid PID-reuse kills.
  if ! proc_info "$ROOT_PID" || [ "$PROC_STARTTIME" != "$ROOT_STARTTIME" ]; then
    if kill -0 "$ROOT_PID" 2>/dev/null; then
      printf 'bounded-command: root identity changed; refusing to signal its process group\n' >&2
      root_live=0
    else
      root_live=0
    fi
  elif [ "$PROC_PGRP" != "$ROOT_PID" ]; then
    for ((retry=0; retry<5; retry++)); do
      sleep 0.01
      proc_info "$ROOT_PID" || break
      [ "$PROC_STARTTIME" = "$ROOT_STARTTIME" ] && [ "$PROC_PGRP" = "$ROOT_PID" ] && break
    done
    if [ "$PROC_STARTTIME" = "$ROOT_STARTTIME" ] && [ "$PROC_PGRP" = "$ROOT_PID" ]; then
      :
    else
      printf 'bounded-command: root process group identity is unproven; refusing negative-PID signal\n' >&2
      root_live=0
    fi
  fi
  [ "$root_live" -eq 0 ] || kill -"$signal" -- "-$ROOT_PID" 2>/dev/null || true
  for ((TREE_INDEX=${#TREE_PIDS[@]} - 1; TREE_INDEX >= 0; TREE_INDEX--)); do
    pid="${TREE_PIDS[$TREE_INDEX]}"
    [ "$pid" = "$ROOT_PID" ] && continue
    if proc_info "$pid" && [ "$PROC_STARTTIME" = "${TREE_STARTTIME[$pid]}" ] \
      && kill -0 "$pid" 2>/dev/null; then
      kill -"$signal" "$pid" 2>/dev/null || true
    fi
  done
  return 0
}

run_prlimit_fallback() {
  local timeout_seconds
  local status
  PROC_ROOT="${BOUNDED_COMMAND_PROC_ROOT:-/proc}"
  if [ "$PROC_ROOT" != "/proc" ] && [ "${BOUNDED_COMMAND_TESTING:-0}" != 1 ]; then
    fail "alternate /proc roots are test-only"
  fi
  command -v prlimit >/dev/null 2>&1 || fail "prlimit is required for the safe fallback"
  command -v setsid >/dev/null 2>&1 || fail "setsid is required for the safe fallback"
  command -v sleep >/dev/null 2>&1 || fail "sleep is required for the safe fallback"
  timeout_seconds="$(duration_seconds "$COMMAND_TIMEOUT" || true)"
  [ -n "$timeout_seconds" ] || fail "fallback requires timeout in seconds, minutes, hours, or days"
  [ "$timeout_seconds" -gt 0 ] || fail "fallback timeout must be greater than zero"

  # This is intentionally much larger than the RSS budget. It prevents a
  # runaway virtual mapping without imposing the adaptive RSS budget on V8's
  # code-range reservation. RSS remains the actual enforced memory limit.
  ADDRESS_BYTES=$((MEMORY_BYTES * 8))
  local minimum_address=$((8 * 1024 * 1024 * 1024))
  [ "$ADDRESS_BYTES" -ge "$minimum_address" ] || ADDRESS_BYTES="$minimum_address"
  printf 'bounded-command: fallback=rss-tree rss_limit=%sMiB address_limit=%sMiB\n' \
    "$((MEMORY_BYTES / 1024 / 1024))" "$((ADDRESS_BYTES / 1024 / 1024))" >&2

  # --wait keeps this monitored PID alive while setsid creates the actual
  # command session; without it setsid may fork and leave a zombie leader that
  # makes a short-lived command look like malformed /proc data.
  prlimit --as="$ADDRESS_BYTES" -- "$(command -v setsid)" --wait -- "$@" &
  ROOT_PID=$!
  TREE_PIDS=("$ROOT_PID")
  TREE_STARTTIME=()
  TREE_DEPTH=()
  ROOT_STARTTIME=''
  ROOT_STATUS_MISSES=0
  SECONDS=0
  while kill -0 "$ROOT_PID" 2>/dev/null; do
    if tree_rss_bytes; then
      :
    else
      tree_status=$?
      if [ "$tree_status" -eq 2 ]; then
        # The prlimit/setsid exec can briefly precede creation of its /proc
        # status view. Retry that startup race, but fail closed if it persists.
        ROOT_STATUS_MISSES=$((ROOT_STATUS_MISSES + 1))
        if [ "$ROOT_STATUS_MISSES" -le 100 ] && kill -0 "$ROOT_PID" 2>/dev/null; then
          sleep 0.01
          continue
        fi
        ! kill -0 "$ROOT_PID" 2>/dev/null && break
      fi
      printf 'bounded-command: malformed or unreadable /proc tree; terminating safely\n' >&2
      terminate_fallback_group TERM || true
      sleep 1
      terminate_fallback_group KILL || true
      wait "$ROOT_PID" 2>/dev/null || true
      return 125
    fi
    if [ "${BOUNDED_COMMAND_TESTING:-0}" = 1 ] \
      && [[ "${BOUNDED_COMMAND_TEST_RSS_BYTES:-}" =~ ^[0-9]+$ ]]; then
      TREE_RSS_BYTES="$BOUNDED_COMMAND_TEST_RSS_BYTES"
    fi
    if [ "$TREE_RSS_BYTES" -gt "$MEMORY_BYTES" ]; then
      printf 'bounded-command: process-tree RSS exceeded %s bytes; terminating\n' "$MEMORY_BYTES" >&2
      terminate_fallback_group TERM || true
      sleep 1
      terminate_fallback_group KILL || true
      wait "$ROOT_PID" 2>/dev/null || true
      return 137
    fi
    if [ "$SECONDS" -ge "$timeout_seconds" ]; then
      printf 'bounded-command: command exceeded timeout %ss; terminating\n' "$timeout_seconds" >&2
      terminate_fallback_group TERM || true
      sleep 1
      terminate_fallback_group KILL || true
      wait "$ROOT_PID" 2>/dev/null || true
      return 124
    fi
    sleep 0.1
  done

  if wait "$ROOT_PID"; then
    status=0
  else
    status=$?
  fi
  printf 'bounded-command: fallback command exit=%s\n' "$status" >&2
  return "$status"
}

print_budget() {
  local available budget swap_free swap_bytes heap_mb
  available="$(effective_available_bytes)"
  budget="$(minimum_budget_bytes "$available")"
  swap_free="$(available_swap_bytes)"
  swap_bytes=$((swap_free * SWAP_FRACTION / 100))
  local budget_swap=$((budget * SWAP_FRACTION / 100))
  [ "$swap_bytes" -lt "$budget_swap" ] || swap_bytes="$budget_swap"
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
    --lock-timeout)
      [ "$#" -ge 2 ] || fail "--lock-timeout requires a value"
      LOCK_TIMEOUT="$2"
      shift 2
      ;;
    --lock-timeout=*)
      LOCK_TIMEOUT="${1#*=}"
      shift
      ;;
    --print-budget)
      PRINT_BUDGET=1
      shift
      ;;
    --require-cgroup)
      REQUIRE_CGROUP=1
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

PROC_ROOT="${BOUNDED_COMMAND_PROC_ROOT:-/proc}"
CGROUP_ROOT="${BOUNDED_COMMAND_CGROUP_ROOT:-/sys/fs/cgroup}"
if { [ "$PROC_ROOT" != "/proc" ] || [ "$CGROUP_ROOT" != "/sys/fs/cgroup" ]; } \
  && [ "${BOUNDED_COMMAND_TESTING:-0}" != 1 ]; then
  fail "alternate proc/cgroup roots are test-only"
fi
validate_percent "--memory-fraction" "$MEMORY_FRACTION"
validate_percent "--swap-fraction" "$SWAP_FRACTION"
validate_percent "--node-heap-fraction" "$NODE_HEAP_FRACTION"
validate_seconds "--lock-timeout" "$LOCK_TIMEOUT"

if [ "$PRINT_BUDGET" -eq 1 ]; then
  [ "$#" -eq 0 ] || fail "--print-budget cannot be combined with a command"
  print_budget
  exit 0
fi

[ "$#" -gt 0 ] || fail "a command is required after --"
command -v timeout >/dev/null 2>&1 || fail "timeout is required"
command -v flock >/dev/null 2>&1 || fail "flock is required"
TIMEOUT_BIN="$(command -v timeout)"

command -v stat >/dev/null 2>&1 || fail "stat is required for safe runtime coordination"
command -v id >/dev/null 2>&1 || fail "id is required for safe runtime coordination"
command -v readlink >/dev/null 2>&1 || fail "readlink is required for safe runtime coordination"
prepare_runtime_dir
prepare_lock_file
if ! flock -n 9; then
  printf 'bounded-command: another check is running; waiting up to %ss\n' "$LOCK_TIMEOUT" >&2
  if ! flock -w "$LOCK_TIMEOUT" 9; then
    fail "timed out after ${LOCK_TIMEOUT}s waiting for another bounded command"
  fi
fi

# Calculate only after acquiring the slot. Since checks remain serialized, no
# concurrent invocation can consume a second adaptive budget behind this one.
AVAILABLE_BYTES="$(effective_available_bytes)"
MEMORY_BYTES="$(minimum_budget_bytes "$AVAILABLE_BYTES")"
SWAP_AVAILABLE_BYTES="$(available_swap_bytes)"
SWAP_BYTES=$((SWAP_AVAILABLE_BYTES * SWAP_FRACTION / 100))
BUDGET_SWAP_BYTES=$((MEMORY_BYTES * SWAP_FRACTION / 100))
[ "$SWAP_BYTES" -lt "$BUDGET_SWAP_BYTES" ] || SWAP_BYTES="$BUDGET_SWAP_BYTES"
NODE_HEAP_MB=$((MEMORY_BYTES * NODE_HEAP_FRACTION / 100 / 1024 / 1024))
[ "$NODE_HEAP_MB" -ge 64 ] || NODE_HEAP_MB=64

printf 'bounded-command: available=%sMiB budget=%sMiB swap=%sMiB node_heap=%sMiB\n' \
  "$((AVAILABLE_BYTES / 1024 / 1024))" \
  "$((MEMORY_BYTES / 1024 / 1024))" \
  "$((SWAP_BYTES / 1024 / 1024))" \
  "$NODE_HEAP_MB" >&2

# The check command owns NODE_OPTIONS while it runs so an inherited heap setting
# cannot silently exceed the calculated ceiling. A user scope inherits the
# environment of this process; do not turn the caller's environment into
# systemd-run arguments, where values could be exposed in process listings or
# diagnostics.
export NODE_OPTIONS="--max-old-space-size=$NODE_HEAP_MB"

if command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1 \
  && systemctl --user show-environment >/dev/null 2>&1; then
  # --scope runs synchronously with systemd-run as the parent, so the complete
  # caller environment and standard descriptors are inherited without a shell
  # or an environment file. --wait and --pipe are intentionally omitted:
  # systemd-run rejects both with --scope.
  systemd-run --user --scope \
    --property="MemoryMax=$MEMORY_BYTES" \
    --property="MemorySwapMax=$SWAP_BYTES" \
    --property="TasksMax=$MAX_TREE_PROCESSES" \
    --property="CPUQuota=200%" \
    -- "$TIMEOUT_BIN" --kill-after=10s "$COMMAND_TIMEOUT" "$@"
  exit $?
fi

if [ "$REQUIRE_CGROUP" -eq 1 ]; then
  fail "a usable systemd user cgroup is required"
fi

if command -v prlimit >/dev/null 2>&1; then
  run_prlimit_fallback "$@"
  exit $?
fi

fail "no supported memory limiter or safe RSS fallback is available; refusing to run unbounded"
