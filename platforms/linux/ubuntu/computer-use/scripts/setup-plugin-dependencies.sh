#!/usr/bin/env bash
# Verify or install the exact repository-owned v2 plugin dependency workspace.
set -euo pipefail

APPLY=0
MODE_SET=0

usage() {
  cat <<'EOF'
Usage: setup-plugin-dependencies.sh [--apply|--verify-only]

Verification is the default. --apply installs the checked-in plugin lockfile
with npm lifecycle scripts disabled, then verifies the pinned Ponytail surface.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --apply)
      [[ "$MODE_SET" -eq 0 ]] || { usage >&2; exit 2; }
      APPLY=1
      MODE_SET=1
      shift
      ;;
    --verify-only)
      [[ "$MODE_SET" -eq 0 ]] || { usage >&2; exit 2; }
      MODE_SET=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_USE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGINS_ROOT="$COMPUTER_USE_ROOT/plugins-v2"
ADAPTER_ROOT="$PLUGINS_ROOT/ponytail-adapter"
ADAPTER_MANIFEST="$ADAPTER_ROOT/package.json"
WORKSPACE_MANIFEST="$PLUGINS_ROOT/package.json"
LOCKFILE="$PLUGINS_ROOT/package-lock.json"
BOUNDED_RUNNER="$SCRIPT_DIR/run-bounded-command.sh"
PACKAGE_VERIFIER="$ADAPTER_ROOT/scripts/verify-package.mjs"

ok() { printf 'OK: %s\n' "$*"; }
fail() { printf 'MISSING/STALE: %s\n' "$*" >&2; }

workspace_contract_ok() {
  [ -f "$WORKSPACE_MANIFEST" ] || { fail "plugin workspace manifest is missing: $WORKSPACE_MANIFEST"; return 1; }
  [ -f "$ADAPTER_MANIFEST" ] || { fail "Ponytail adapter manifest is missing: $ADAPTER_MANIFEST"; return 1; }
  [ -f "$LOCKFILE" ] || { fail "plugin workspace lockfile is missing: $LOCKFILE"; return 1; }
  node - "$WORKSPACE_MANIFEST" "$ADAPTER_MANIFEST" <<'NODE'
const fs = require("node:fs")
const [workspacePath, adapterPath] = process.argv.slice(2)
const workspace = JSON.parse(fs.readFileSync(workspacePath, "utf8"))
const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf8"))
if (!Array.isArray(workspace.workspaces) || !workspace.workspaces.includes("ponytail-adapter")) process.exit(1)
if (adapter.dependencies?.["@dietrichgebert/ponytail"] !== "4.10.0") process.exit(1)
NODE
}

verify_surface() {
  command -v node >/dev/null 2>&1 || { fail "node is required to verify the pinned Ponytail package"; return 1; }
  [ -x "$BOUNDED_RUNNER" ] || { fail "bounded command runner is missing or not executable: $BOUNDED_RUNNER"; return 1; }
  [ -f "$PACKAGE_VERIFIER" ] || { fail "Ponytail package verifier is missing: $PACKAGE_VERIFIER"; return 1; }
  if "$BOUNDED_RUNNER" -- node --experimental-strip-types "$PACKAGE_VERIFIER"; then
    return 0
  fi
  fail "pinned official @dietrichgebert/ponytail@4.10.0 dependency or six-command/six-skill surface is missing"
  return 1
}

install_dependencies() {
  command -v npm >/dev/null 2>&1 || { fail "npm is required to install the pinned plugin workspace"; return 1; }
  [ -x "$BOUNDED_RUNNER" ] || { fail "bounded command runner is missing or not executable: $BOUNDED_RUNNER"; return 1; }
  if (
    cd "$PLUGINS_ROOT"
    "$BOUNDED_RUNNER" -- npm ci --ignore-scripts --no-audit --no-fund
  ); then
    ok "installed the pinned v2 plugin workspace with lifecycle scripts disabled"
  else
    fail "pinned v2 plugin workspace installation failed"
    return 1
  fi
}

workspace_contract_ok || exit 1
if [ "$APPLY" -eq 1 ]; then
  if ! verify_surface; then
    install_dependencies
  else
    ok "pinned Ponytail dependency is already installed"
  fi
fi
verify_surface
ok "repository plugin dependency workspace is ready"
