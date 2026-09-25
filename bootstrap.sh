#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
PROJECT_CONFIG="$REPO_ROOT/opencode.json"
NATIVE_SCRIPT_DIR="$REPO_ROOT/platforms/linux/ubuntu/computer-use/scripts"
WSL_SCRIPT_DIR="$REPO_ROOT/platforms/windows/wsl2/ubuntu/computer-use/scripts"
WSL_ROOT="$REPO_ROOT/platforms/windows/wsl2/ubuntu/computer-use"
WSL_INTEROP_ROOT="$WSL_ROOT/plugins-v2/wsl-interop"
RIG_TOOLS_ROOT="$REPO_ROOT/platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools"

MODE="verify"
MODE_SET=0
PLATFORM_REQUESTED="auto"
PLATFORM_SET=0
PLATFORM=""
DETECTED_PLATFORM=""
USER_ONLY=0
DRY_RUN=0
FORCE_PLATFORM="${OPEN_RIG_BOOTSTRAP_FORCE_PLATFORM:-0}"
WSL_PILOT_DIR=""
WSL_CONFIG_DIR=""
JOURNAL_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/open-rig/bootstrap"
JOURNAL_PATH=""
BEFORE_HASH=""
VERIFY_STATUS=0

NATIVE_SETUP="$NATIVE_SCRIPT_DIR/setup-computer-assistant.sh"
NATIVE_DEPLOY="$NATIVE_SCRIPT_DIR/deploy-plugins.sh"
NATIVE_VERIFY="$NATIVE_SCRIPT_DIR/verify-opencode-v2.sh"
NATIVE_HOOKS="$NATIVE_SCRIPT_DIR/setup-git-hooks.sh"
QA_RUNTIME_SETUP="$NATIVE_SCRIPT_DIR/setup-qa-runtime.py"

WSL_SETUP="$WSL_SCRIPT_DIR/setup-opencode.sh"
WSL_DEPLOY="$WSL_SCRIPT_DIR/deploy-plugins.sh"
WSL_MCP="$WSL_SCRIPT_DIR/setup-mcps.sh"
WSL_VERIFY="$WSL_SCRIPT_DIR/verify-wsl2.sh"

usage() {
  cat <<'EOF'
Usage: ./bootstrap.sh [OPTIONS]

  ./bootstrap.sh --verify-only        read-only health check (default mode; no writes at all, not even logs)
  ./bootstrap.sh --apply              provision the detected platform
  ./bootstrap.sh --platform auto|native|wsl2   default auto
  ./bootstrap.sh --user-only          skip sudo/privileged steps
  ./bootstrap.sh --dry-run            print the ordered stage plan without mutating (any mode)
  ./bootstrap.sh --help

Modes are mutually exclusive. An explicitly selected platform must match the
detected platform for verification or apply unless
OPEN_RIG_BOOTSTRAP_FORCE_PLATFORM=1 is set. Dry-run plans may select either
platform so that their plans can be reviewed on any host.
EOF
}

usage_error() {
  printf 'ERROR: %s\n' "$*" >&2
  usage >&2
  exit 2
}

ok() {
  printf 'OK: %s\n' "$*"
}

missing() {
  printf 'MISSING/FAILED: %s\n' "$*" >&2
}

notice() {
  printf 'NOTICE: %s\n' "$*"
}

detect_platform() {
  local release release_lower
  [[ -r /proc/sys/kernel/osrelease ]] || return 3
  if ! release="$(cat /proc/sys/kernel/osrelease)"; then
    return 3
  fi
  release_lower="${release,,}"
  if [[ "$release_lower" == *microsoft* && "$release_lower" == *wsl* ]]; then
    printf 'wsl2\n'
  else
    printf 'native\n'
  fi
}

parse_args() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --verify-only)
        [[ "$MODE_SET" -eq 0 ]] || usage_error "--verify-only and --apply are mutually exclusive"
        MODE="verify"
        MODE_SET=1
        shift
        ;;
      --apply)
        [[ "$MODE_SET" -eq 0 ]] || usage_error "--verify-only and --apply are mutually exclusive"
        MODE="apply"
        MODE_SET=1
        shift
        ;;
      --platform)
        [[ "$#" -ge 2 ]] || usage_error "--platform requires auto, native, or wsl2"
        [[ "$PLATFORM_SET" -eq 0 ]] || usage_error "--platform may be specified only once"
        PLATFORM_REQUESTED="$2"
        PLATFORM_SET=1
        shift 2
        ;;
      --platform=*)
        [[ "$PLATFORM_SET" -eq 0 ]] || usage_error "--platform may be specified only once"
        PLATFORM_REQUESTED="${1#*=}"
        PLATFORM_SET=1
        shift
        ;;
      --user-only)
        [[ "$USER_ONLY" -eq 0 ]] || usage_error "--user-only may be specified only once"
        USER_ONLY=1
        shift
        ;;
      --dry-run)
        [[ "$DRY_RUN" -eq 0 ]] || usage_error "--dry-run may be specified only once"
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        usage_error "unknown option: $1"
        ;;
    esac
  done

  case "$PLATFORM_REQUESTED" in
    auto|native|wsl2) ;;
    *) usage_error "unsupported platform: $PLATFORM_REQUESTED" ;;
  esac
}

select_platform() {
  if DETECTED_PLATFORM="$(detect_platform)"; then
    :
  else
    DETECTED_PLATFORM="unknown"
  fi

  if [[ "$PLATFORM_REQUESTED" == "auto" ]]; then
    [[ "$DETECTED_PLATFORM" != "unknown" ]] || {
      printf 'ERROR: cannot read /proc/sys/kernel/osrelease to detect the platform\n' >&2
      exit 3
    }
    PLATFORM="$DETECTED_PLATFORM"
    return 0
  fi

  PLATFORM="$PLATFORM_REQUESTED"
  if [[ "$DETECTED_PLATFORM" == "unknown" ]]; then
    if [[ "$DRY_RUN" -eq 0 && "$FORCE_PLATFORM" != "1" ]]; then
      printf 'ERROR: cannot validate --platform %s because the host platform is undetectable\n' "$PLATFORM" >&2
      exit 3
    fi
    notice "using explicitly selected platform $PLATFORM; host detection was unavailable"
    return 0
  fi

  if [[ "$PLATFORM" != "$DETECTED_PLATFORM" ]]; then
    if [[ "$DRY_RUN" -eq 1 || "$FORCE_PLATFORM" == "1" ]]; then
      notice "selected platform $PLATFORM differs from detected platform $DETECTED_PLATFORM"
    else
      usage_error "--platform $PLATFORM does not match detected platform $DETECTED_PLATFORM; use auto or explicitly force the selection"
    fi
  fi
}

run_bounded() (
  local variable_name
  # Force every delegate to use the saved gh login rather than token-bearing environment variables.
  while IFS= read -r variable_name; do
    case "$variable_name" in
      GH_TOKEN|GITHUB_*) unset "$variable_name" || true ;;
    esac
  done < <(compgen -v)
  set +e
  "$@" 2>&1 | awk 'NR <= 240 { print }'
  local_status="${PIPESTATUS[0]}"
  exit "$local_status"
)

ubuntu_release_ok() {
  [[ -r /etc/os-release ]] || return 1
  grep -Eiq '^ID="?ubuntu"?$' /etc/os-release || grep -Eiq '^ID_LIKE=.*ubuntu' /etc/os-release
}

check_prerequisites() {
  local status=0 binary resolved gh_path
  local -a required=(python3 node npm git awk sha256sum)

  if ubuntu_release_ok; then
    ok "Ubuntu release detected"
  else
    missing "Ubuntu is required (including Ubuntu under WSL2)"
    status=1
  fi

  for binary in "${required[@]}"; do
    if resolved="$(command -v "$binary")"; then
      ok "$binary: $resolved"
    else
      missing "required command: $binary"
      status=1
    fi
  done

  if gh_path="$(command -v gh)"; then
    if gh auth status >/dev/null 2>&1; then
      ok "gh auth status passed via $gh_path (credential output suppressed)"
    else
      notice "gh is not authenticated; GitHub MCP may not connect"
    fi
  else
    notice "gh is absent; GitHub MCP may not connect"
  fi

  if [[ "$status" -ne 0 ]]; then
    return 3
  fi
}

check_wsl_paths() {
  if ! python3 - "$WSL_PILOT_DIR" "$WSL_CONFIG_DIR" <<'PY'
import os
import sys

pilot, config = (os.path.abspath(value) for value in sys.argv[1:])
raise SystemExit(0 if config == os.path.join(pilot, "config") else 1)
PY
  then
    missing "OPENCODE_WSL2_CONFIG_DIR must be the config directory below OPENCODE_WSL2_PILOT_DIR"
    return 1
  fi
  if [[ ! -f "$WSL_SCRIPT_DIR/configure.py" ]]; then
    missing "WSL2 isolated path checker is missing: $WSL_SCRIPT_DIR/configure.py"
    return 1
  fi
  if python3 "$WSL_SCRIPT_DIR/configure.py" check-path --config-dir "$WSL_CONFIG_DIR"; then
    ok "WSL2 isolated pilot path: $WSL_PILOT_DIR"
  else
    missing "WSL2 pilot/config path is not safe: $WSL_CONFIG_DIR"
    return 1
  fi
}

check_wsl_host_integration() {
  local status=0 ps_path server_config cli_config vision host_script rig_tools_index
  server_config="$WSL_CONFIG_DIR/opencode.jsonc"
  if [[ ! -f "$server_config" && -f "$WSL_CONFIG_DIR/opencode.json" ]]; then
    server_config="$WSL_CONFIG_DIR/opencode.json"
  fi
  cli_config="$WSL_PILOT_DIR/xdg/opencode/cli.json"
  vision="$RIG_TOOLS_ROOT/src/vision.ts"
  host_script="$WSL_INTEROP_ROOT/powershell/OpenRig.WindowsHost.ps1"
  rig_tools_index="$RIG_TOOLS_ROOT/src/index.ts"

  if ps_path="$(command -v pwsh.exe)"; then
    ok "PowerShell interop executable: $ps_path"
  elif ps_path="$(command -v powershell.exe)"; then
    ok "Windows PowerShell interop executable: $ps_path"
  else
    missing "PowerShell interop (pwsh.exe or powershell.exe) is not resolvable"
    status=1
  fi

  if [[ -f "$WSL_INTEROP_ROOT/package.json" &&
        -f "$WSL_INTEROP_ROOT/server.ts" &&
        -f "$WSL_INTEROP_ROOT/tui.tsx" &&
        -f "$host_script" &&
        -f "$server_config" &&
        -f "$cli_config" ]]; then
    ok "WSL2 UI Automation source package and isolated config are present"
    if python3 "$WSL_SCRIPT_DIR/configure.py" verify \
      --config-dir "$WSL_CONFIG_DIR" --plugins wsl-interop; then
      ok "WSL2 UI Automation plugin is registered in server and CLI config"
    else
      missing "WSL2 UI Automation plugin/config registration"
      status=1
    fi
  else
    missing "WSL2 UI Automation plugin/config presence"
    status=1
  fi

  if [[ -f "$vision" &&
        -f "$host_script" &&
        -f "$rig_tools_index" &&
        -f "$WSL_INTEROP_ROOT/test/powershell-host.test.ts" ]] &&
     grep -Fq 'name: "vision_capture"' "$rig_tools_index" &&
     grep -Fq 'captureWindowsScreenshot' "$vision" &&
     grep -Fq 'if (isWslKernel(release)) return captureWindowsScreenshot(mode)' "$vision" &&
     grep -Fq 'windows.screenshot' "$vision" &&
     grep -Fq 'return decodeWindowsScreenshot' "$vision" &&
     grep -Fq 'windows.screenshot' "$host_script" &&
     grep -Fq 'windows.screenshot' "$WSL_INTEROP_ROOT/test/powershell-host.test.ts" &&
     ! grep -Fq 'writeFile' "$vision"; then
    ok "WSL2 vision_capture fallback is registered and remains in memory"
  else
    missing "WSL2 in-memory screenshot fallback wiring"
    status=1
  fi

  return "$status"
}

hash_value() {
  local raw hash
  [[ -f "$PROJECT_CONFIG" && ! -L "$PROJECT_CONFIG" ]] || return 1
  if ! raw="$(sha256sum -- "$PROJECT_CONFIG")"; then
    return 1
  fi
  hash="${raw%% *}"
  [[ "$hash" =~ ^[[:xdigit:]]{64}$ ]] || return 1
  printf '%s\n' "$hash"
}

journal_event() {
  [[ -n "$JOURNAL_PATH" ]] || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$JOURNAL_PATH"
}

init_journal() {
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  JOURNAL_PATH="$JOURNAL_DIR/bootstrap-${stamp}-$$.log"
  if ! mkdir -p -- "$JOURNAL_DIR"; then
    return 1
  fi
  if ! (umask 077; : > "$JOURNAL_PATH"); then
    return 1
  fi
  if ! chmod 0600 -- "$JOURNAL_PATH"; then
    return 1
  fi
  journal_event "START platform=$PLATFORM mode=$MODE user_only=$USER_ONLY repo=$REPO_ROOT" || true
}

suggested_rerun() {
  local command="./bootstrap.sh --platform $PLATFORM --apply"
  if [[ "$USER_ONLY" -eq 1 ]]; then
    command+=" --user-only"
  fi
  printf '%s\n' "$command"
}

apply_failure() {
  local stage="$1" status="$2" exit_code="${3:-4}"
  journal_event "FAIL stage=$stage status=$status" || true
  if [[ "$exit_code" -eq 3 ]]; then
    printf 'ERROR: required prerequisite missing at stage %s (status %s).\n' "$stage" "$status" >&2
  else
    printf 'ERROR: apply stage failed: %s (status %s).\n' "$stage" "$status" >&2
  fi
  printf 'Journal: %s\n' "$JOURNAL_PATH" >&2
  printf 'Suggested rerun: %s\n' "$(suggested_rerun)" >&2
  exit "$exit_code"
}

run_apply_stage() {
  local stage="$1" status
  shift
  printf '\n=== stage: %s ===\n' "$stage"
  journal_event "START stage=$stage" || true
  if run_bounded "$@"; then
    journal_event "PASS stage=$stage" || true
    ok "stage $stage"
  else
    status="$?"
    journal_event "FAIL stage=$stage status=$status" || true
    if [[ "$stage" == "prerequisites" && "$status" -eq 3 ]]; then
      apply_failure "$stage" "$status" 3
    fi
    apply_failure "$stage" "$status" 4
  fi
}

run_hash_apply_stage() {
  local stage="$1" status
  shift
  printf '\n=== stage: %s ===\n' "$stage"
  journal_event "START stage=$stage" || true
  if "$@"; then
    journal_event "PASS stage=$stage" || true
    ok "stage $stage"
  else
    status="$?"
    journal_event "FAIL stage=$stage status=$status" || true
    apply_failure "$stage" "$status" 4
  fi
}

run_verify_stage() {
  local stage="$1" status
  shift
  printf '\n=== verify stage: %s ===\n' "$stage"
  if run_bounded "$@"; then
    ok "stage $stage"
  else
    status="$?"
    missing "stage $stage (status $status)"
    VERIFY_STATUS=1
  fi
}

verify_prerequisites() {
  local status
  printf '\n=== verify stage: prerequisites ===\n'
  if run_bounded check_prerequisites; then
    ok "stage prerequisites"
  else
    status="$?"
    missing "stage prerequisites (status $status)"
    if [[ "$status" -eq 3 ]]; then
      return 3
    fi
    VERIFY_STATUS=1
  fi
}

record_hash_before() {
  local hash
  if ! hash="$(hash_value)"; then
    missing "cannot calculate SHA-256 for $PROJECT_CONFIG"
    return 1
  fi
  BEFORE_HASH="$hash"
  printf 'SHA-256 before apply: %s\n' "$BEFORE_HASH"
  journal_event "HASH_BEFORE sha256=$BEFORE_HASH" || true
}

record_hash_after() {
  local after_hash
  if ! after_hash="$(hash_value)"; then
    missing "cannot calculate post-apply SHA-256 for $PROJECT_CONFIG"
    return 1
  fi
  printf 'SHA-256 after apply: %s\n' "$after_hash"
  journal_event "HASH_AFTER sha256=$after_hash" || true
  if [[ -z "$BEFORE_HASH" || "$after_hash" != "$BEFORE_HASH" ]]; then
    missing "portable project config changed during apply: $PROJECT_CONFIG"
    return 1
  fi
  ok "portable project config remained byte-for-byte unchanged"
}

wsl_command() {
  env \
    OPENCODE_WSL2_PILOT_DIR="$WSL_PILOT_DIR" \
    OPENCODE_WSL2_CONFIG_DIR="$WSL_CONFIG_DIR" \
    "$@"
}

print_plan() {
  local index=1 item user_suffix=""
  local -a stages=()
  if [[ "$USER_ONLY" -eq 1 ]]; then
    user_suffix=" --user-only"
  fi

  if [[ "$PLATFORM" == "native" && "$MODE" == "verify" ]]; then
    stages=(
      "preflight — Ubuntu, python3, node/npm, git, and optional gh status"
      "checkout-local-qa-runtime — python3 $QA_RUNTIME_SETUP --verify-only (read-only pinned Node/npm check)"
      "native-computer-assistant — $NATIVE_SETUP --verify-only$user_suffix (pinned Ponytail dependency and surface)"
      "native-plugin-registration — $NATIVE_DEPLOY --plugins all --verify-only (including ponytail-adapter)"
      "native-v2-health — $NATIVE_VERIFY (Ponytail commands, skills, hooks, and portable registration)"
      "native-git-hooks — $NATIVE_HOOKS --verify-only"
    )
  elif [[ "$PLATFORM" == "native" ]]; then
    stages=(
      "preflight — Ubuntu, python3, node/npm, git, and optional gh status"
      "portable-config-hash-before — record opencode.json SHA-256"
      "checkout-local-qa-runtime — python3 $QA_RUNTIME_SETUP --apply (official Node 26.4 archive, checksum-verified)"
      "native-computer-assistant — $NATIVE_SETUP --apply$user_suffix (install pinned Ponytail dependency with ignore-scripts)"
      "native-plugin-registration — $NATIVE_DEPLOY --plugins all --apply (including ponytail-adapter)"
      "native-v2-health — $NATIVE_VERIFY (Ponytail commands, skills, hooks, and portable registration)"
      "native-git-hooks — $NATIVE_HOOKS --apply"
      "portable-config-hash-after — compare opencode.json SHA-256"
    )
  elif [[ "$MODE" == "verify" ]]; then
    stages=(
      "preflight — Ubuntu, python3, node/npm, git, and optional gh status"
      "checkout-local-qa-runtime — python3 $QA_RUNTIME_SETUP --verify-only (read-only pinned Node/npm check)"
      "wsl2-isolated-paths — validate $WSL_CONFIG_DIR without creating it"
      "wsl2-opencode — $WSL_SETUP --config-dir $WSL_CONFIG_DIR --verify-only (canonical pinned Ponytail dependency and WSL plugin workspace dependencies)"
      "wsl2-plugin-registration — $WSL_DEPLOY --config-dir $WSL_CONFIG_DIR --plugins all --verify-only (including ponytail-adapter)"
      "wsl2-mcp-runtimes — $WSL_MCP --pilot-dir $WSL_PILOT_DIR --verify-only"
      "wsl2-source — $WSL_VERIFY --source"
      "wsl2-host-integration — PowerShell, UI Automation, and in-memory screenshot wiring"
    )
  else
    stages=(
      "preflight — Ubuntu, python3, node/npm, git, and optional gh status"
      "portable-config-hash-before — record opencode.json SHA-256"
      "checkout-local-qa-runtime — python3 $QA_RUNTIME_SETUP --apply (official Node 26.4 archive, outside WSL profile state)"
      "wsl2-isolated-paths — validate $WSL_CONFIG_DIR without creating it"
      "wsl2-opencode — $WSL_SETUP --config-dir $WSL_CONFIG_DIR --apply (install canonical pinned Ponytail dependency and WSL plugin workspace dependencies with ignore-scripts)"
      "wsl2-plugin-registration — $WSL_DEPLOY --config-dir $WSL_CONFIG_DIR --plugins all --apply (including ponytail-adapter)"
      "wsl2-mcp-runtimes — $WSL_MCP --pilot-dir $WSL_PILOT_DIR --apply"
      "wsl2-source — $WSL_VERIFY --source"
      "wsl2-host-integration — PowerShell, UI Automation, and in-memory screenshot wiring"
      "portable-config-hash-after — compare opencode.json SHA-256"
    )
  fi

  for item in "${stages[@]}"; do
    printf '%d. %s\n' "$index" "$item"
    index=$((index + 1))
  done
}

verify_native() {
  local -a setup_args=("$NATIVE_SETUP" --verify-only)
  if [[ "$USER_ONLY" -eq 1 ]]; then
    setup_args+=(--user-only)
  fi
  if verify_prerequisites; then
    :
  else
    return "$?"
  fi
  run_verify_stage "checkout-local-qa-runtime" python3 "$QA_RUNTIME_SETUP" --verify-only
  run_verify_stage "native-computer-assistant" "${setup_args[@]}"
  run_verify_stage "native-plugin-registration" "$NATIVE_DEPLOY" --plugins all --verify-only
  run_verify_stage "native-v2-health" env OPENCODE_V2_REPO="$REPO_ROOT" "$NATIVE_VERIFY"
  run_verify_stage "native-git-hooks" "$NATIVE_HOOKS" --verify-only
  return "$VERIFY_STATUS"
}

apply_native() {
  local -a setup_args=("$NATIVE_SETUP" --apply)
  if [[ "$USER_ONLY" -eq 1 ]]; then
    setup_args+=(--user-only)
  fi
  run_apply_stage "prerequisites" check_prerequisites
  run_hash_apply_stage "portable-config-hash-before" record_hash_before
  run_apply_stage "checkout-local-qa-runtime" python3 "$QA_RUNTIME_SETUP" --apply
  run_apply_stage "native-computer-assistant" "${setup_args[@]}"
  run_apply_stage "native-plugin-registration" "$NATIVE_DEPLOY" --plugins all --apply
  run_apply_stage "native-v2-health" env OPENCODE_V2_REPO="$REPO_ROOT" "$NATIVE_VERIFY"
  run_apply_stage "native-git-hooks" "$NATIVE_HOOKS" --apply
  run_hash_apply_stage "portable-config-hash-after" record_hash_after
}

verify_wsl() {
  if verify_prerequisites; then
    :
  else
    return "$?"
  fi
  run_verify_stage "checkout-local-qa-runtime" python3 "$QA_RUNTIME_SETUP" --verify-only
  run_verify_stage "wsl2-isolated-paths" check_wsl_paths
  run_verify_stage "wsl2-opencode" wsl_command "$WSL_SETUP" --config-dir "$WSL_CONFIG_DIR" --verify-only
  run_verify_stage "wsl2-plugin-registration" wsl_command "$WSL_DEPLOY" --config-dir "$WSL_CONFIG_DIR" --plugins all --verify-only
  run_verify_stage "wsl2-mcp-runtimes" wsl_command "$WSL_MCP" --pilot-dir "$WSL_PILOT_DIR" --verify-only
  run_verify_stage "wsl2-source" wsl_command "$WSL_VERIFY" --source
  run_verify_stage "wsl2-host-integration" check_wsl_host_integration
  return "$VERIFY_STATUS"
}

apply_wsl() {
  run_apply_stage "prerequisites" check_prerequisites
  run_hash_apply_stage "portable-config-hash-before" record_hash_before
  run_apply_stage "checkout-local-qa-runtime" python3 "$QA_RUNTIME_SETUP" --apply
  run_apply_stage "wsl2-isolated-paths" check_wsl_paths
  run_apply_stage "wsl2-opencode" wsl_command "$WSL_SETUP" --config-dir "$WSL_CONFIG_DIR" --apply
  run_apply_stage "wsl2-plugin-registration" wsl_command "$WSL_DEPLOY" --config-dir "$WSL_CONFIG_DIR" --plugins all --apply
  run_apply_stage "wsl2-mcp-runtimes" wsl_command "$WSL_MCP" --pilot-dir "$WSL_PILOT_DIR" --apply
  run_apply_stage "wsl2-source" wsl_command "$WSL_VERIFY" --source
  run_apply_stage "wsl2-host-integration" check_wsl_host_integration
  run_hash_apply_stage "portable-config-hash-after" record_hash_after
}

main() {
  parse_args "$@"
  select_platform
  if [[ -n "${OPENCODE_WSL2_CONFIG_DIR:-}" ]]; then
    WSL_CONFIG_DIR="$OPENCODE_WSL2_CONFIG_DIR"
    WSL_PILOT_DIR="${OPENCODE_WSL2_PILOT_DIR:-${WSL_CONFIG_DIR%/config}}"
  else
    WSL_PILOT_DIR="${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}"
    WSL_CONFIG_DIR="$WSL_PILOT_DIR/config"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'Dry run: platform=%s mode=%s user-only=%s\n' "$PLATFORM" "$MODE" "$USER_ONLY"
    print_plan
    printf 'No changes made.\n'
    exit 0
  fi

  if [[ "$MODE" == "verify" ]]; then
    if [[ "$PLATFORM" == "native" ]]; then
      if verify_native; then
        exit 0
      else
        local_status="$?"
        exit "$local_status"
      fi
    fi
    if verify_wsl; then
      exit 0
    else
      local_status="$?"
      exit "$local_status"
    fi
  fi

  if [[ "$PLATFORM" == "wsl2" && "$USER_ONLY" -eq 1 ]]; then
    notice "--user-only has no additional privileged WSL2 steps; the isolated profile remains selected"
  fi
  umask 077
  if init_journal; then
    :
  else
    printf 'ERROR: apply stage failed: journal-initialization\n' >&2
    printf 'Journal: %s\n' "$JOURNAL_PATH" >&2
    printf 'Suggested rerun: %s\n' "$(suggested_rerun)" >&2
    exit 4
  fi
  if [[ "$PLATFORM" == "native" ]]; then
    apply_native
  else
    apply_wsl
  fi
  journal_event "COMPLETE platform=$PLATFORM mode=$MODE" || true
  printf '\nOK: bootstrap apply completed for %s\n' "$PLATFORM"
  printf 'Journal: %s\n' "$JOURNAL_PATH"
}

main "$@"
