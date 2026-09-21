#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="${OPENCODE_WSL2_CONFIG_DIR:-${OPENCODE_WSL2_PILOT_DIR:-$HOME/.opencode-wsl2-pilot}/config}"
MODE="${1:---source}"

if [ "$MODE" != "--source" ] && [ "$MODE" != "--live" ]; then
  echo "Usage: $0 [--source|--live]" >&2
  exit 2
fi

"$SCRIPT_DIR/run-bounded-command.sh" -- /usr/bin/python3 "$SCRIPT_DIR/check-ownership-boundary.py"
"$SCRIPT_DIR/run-bounded-command.sh" -- /usr/bin/python3 "$SCRIPT_DIR/self-test.py"
"$SCRIPT_DIR/run-bounded-command.sh" -- npm --prefix "$ROOT/plugins-v2" run check

if [ "$MODE" = "--source" ]; then
  echo "OK: WSL2 source verification passed; no live runtime claim"
  exit 0
fi

release="$(cat /proc/sys/kernel/osrelease)"
if ! grep -Eqi 'microsoft-standard|wsl2' <<<"$release"; then
  echo "ERROR: live verification requires WSL2; kernel is $release" >&2
  exit 1
fi
if [ "$(cat /proc/1/comm)" != "systemd" ]; then
  echo "ERROR: systemd is not PID 1" >&2
  exit 1
fi
if [[ ! -f /proc/sys/fs/binfmt_misc/WSLInterop ]]; then
  echo "ERROR: WSL interoperability is not registered" >&2
  exit 1
fi
interop_registration="$(cat /proc/sys/fs/binfmt_misc/WSLInterop)"
if ! grep -Fxq "enabled" <<<"$interop_registration" || ! grep -Eq '^interpreter /[^[:space:]]+$' <<<"$interop_registration"; then
  echo "ERROR: WSL interoperability registration is not effective" >&2
  exit 1
fi
if [[ -z "$(type -P pwsh.exe || true)" && -z "$(type -P powershell.exe || true)" ]]; then
  echo "ERROR: neither pwsh.exe nor powershell.exe is available through WSL interoperability" >&2
  exit 1
fi
"$SCRIPT_DIR/run-bounded-command.sh" -- /usr/bin/python3 "$SCRIPT_DIR/configure.py" verify --config-dir "$CONFIG_DIR"
OPENCODE_WSL2_PILOT_DIR="$(cd "$CONFIG_DIR/.." && pwd)" "$SCRIPT_DIR/setup-mcps.sh" --verify-only
"$SCRIPT_DIR/run-bounded-command.sh" -- /usr/bin/python3 "$SCRIPT_DIR/verify-websearch.py" --config-dir "$CONFIG_DIR" --network
"$SCRIPT_DIR/run-bounded-command.sh" -- node --experimental-strip-types "$ROOT/plugins-v2/wsl-interop/live-wsl2.ts"
echo "OK: live WSL2/systemd/interop prerequisites verified"
