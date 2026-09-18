#!/usr/bin/env bash
# Read-only health check for the isolated OpenCode v2 pilot stack.
#
# It inspects the v2 binary, config, skills, commands, plugins, tools, and MCP
# declarations without connecting any MCP server (so it never launches
# Firefox). Override paths with OPENCODE_V2_PILOT_DIR, OPENCODE_V2_BIN,
# OPENCODE_V2_REPO, or OPENCODE_V2_CONFIG_DIR.
set -euo pipefail

PILOT="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}"
BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
REPO="${OPENCODE_V2_REPO:-$HOME/repos/opencode-rig}"
CONFIG="${OPENCODE_V2_CONFIG_DIR:-$PILOT/config}"
PLUGINS="$REPO/platforms/linux/ubuntu/computer-use/plugins-v2"
SERVER_PLUGINS=(rig-tools rig-todo codex-fallback)
CLI_PLUGINS=(source-control codex-usage file-manager)

status=0
ok() { printf 'OK: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; status=1; }

[ -x "$BIN" ] && ok "v2 binary: $BIN" || fail "v2 binary missing: $BIN"
version="$("$BIN" --version 2>/dev/null || true)"
case "$version" in
  "opencode v2."*) ok "version: $version" ;;
  *) fail "unexpected version: ${version:-<none>}" ;;
esac

[ -f "$CONFIG/opencode.jsonc" ] && ok "server config present" || fail "missing $CONFIG/opencode.jsonc"
[ -f "$CONFIG/cli.json" ] && ok "cli config present" || fail "missing $CONFIG/cli.json"

python3 - "$CONFIG" "$PLUGINS" "$REPO" "${SERVER_PLUGINS[@]}" -- "${CLI_PLUGINS[@]}" <<'PY'
import json
import os
import re
import sys

config, plugins_root, repo = sys.argv[1], sys.argv[2], sys.argv[3]
separator = sys.argv.index("--")
server_plugins = sys.argv[4:separator]
cli_plugins = sys.argv[separator + 1 :]
failures: list[str] = []


def ok(message: str) -> None:
    print(f"OK: {message}")


def fail(message: str) -> None:
    failures.append(message)


def load_jsonc(path: str):
    text = open(path, encoding="utf-8").read()
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    return json.loads(text)


server = load_jsonc(os.path.join(config, "opencode.jsonc"))
cli = json.load(open(os.path.join(config, "cli.json"), encoding="utf-8"))

skills_dir = os.path.join(config, "skills")
try:
    skills = [name for name in os.listdir(skills_dir) if os.path.isdir(os.path.join(skills_dir, name))]
    if len(skills) == 16:
        ok(f"skills source has 16 entries")
    else:
        fail(f"skills source has {len(skills)} entries (expected 16)")
except OSError:
    fail(f"skills source missing: {skills_dir}")

commands_dir = os.path.join(config, "commands")
try:
    commands = [name for name in os.listdir(commands_dir) if name.endswith(".md")]
    if len(commands) >= 4:
        ok(f"commands: {len(commands)}")
    else:
        fail(f"commands: {len(commands)} (expected at least 4)")
except OSError:
    fail(f"commands dir missing: {commands_dir}")

mcp = server.get("mcp", {})
if isinstance(mcp, dict):
    if "github" in mcp:
        ok("github MCP declared")
    else:
        fail("github MCP not declared")
    play = [name for name in mcp if "playwright" in name]
    if len(play) == 1:
        ok("exactly one playwright MCP declared")
    elif not play:
        print("NOTICE: pilot declares no playwright MCP (expected until cutover; never register two)")
    else:
        fail(f"more than one playwright MCP declared: {play}")

server_entries = [entry.get("package", "").split("/")[-1] for entry in server.get("plugins", []) if isinstance(entry, dict)]
cli_entries = [entry.get("package", "").split("/")[-1] for entry in cli.get("plugins", []) if isinstance(entry, dict)]
missing_server = [name for name in server_plugins if name not in server_entries]
missing_cli = [name for name in cli_plugins if name not in cli_entries]
if missing_server:
    fail(f"server plugins missing: {missing_server}")
else:
    ok(f"server plugins declared: {server_plugins}")
if missing_cli:
    fail(f"cli plugins missing: {missing_cli}")
else:
    ok(f"cli plugins declared: {cli_plugins}")

for name in server_plugins + cli_plugins:
    shim = os.path.join(plugins_root, name, "server.ts")
    shim_tui = os.path.join(plugins_root, name, "tui.tsx")
    if os.path.exists(shim) or os.path.exists(shim_tui):
        ok(f"plugin package present: {name}")
    else:
        fail(f"plugin package missing entry shim: {name}")

theme = cli.get("theme")
if isinstance(theme, dict) and theme.get("name") == "aura":
    ok("theme is aura (v1 colour parity)")
else:
    fail(f"theme is not aura: {theme!r}")

example = os.path.join(repo, "platforms/linux/ubuntu/computer-use/config/v2-opencode.example.jsonc")
try:
    example_mcp = load_jsonc(example).get("mcp", {})
    example_play = [name for name in example_mcp if "playwright" in name]
    if example_play == ["playwright"]:
        ok("v2 cutover example declares exactly one playwright MCP")
    else:
        fail(f"v2 cutover example playwright declarations: {example_play or '<none>'}")
except (OSError, ValueError) as error:
    fail(f"cannot read v2 cutover example: {error}")

for message in failures:
    print(f"FAIL: {message}", file=sys.stderr)
sys.exit(1 if failures else 0)
PY
py_status=$?
[ "$py_status" -eq 0 ] || status=1

if [ "$status" -eq 0 ]; then
  echo "OK: v2 pilot health check passed"
else
  echo "FAIL: v2 pilot health check failed" >&2
fi
exit "$status"
