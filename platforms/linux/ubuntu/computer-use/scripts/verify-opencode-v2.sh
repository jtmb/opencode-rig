#!/usr/bin/env bash
# Read-only health check for the isolated OpenCode v2 pilot stack.
#
# It inspects the v2 binary, config, skills, commands, plugins, tools, and MCP
# declarations without connecting any MCP server (so it never launches
# Firefox). Override paths with OPENCODE_V2_PILOT_DIR, OPENCODE_V2_BIN,
# OPENCODE_V2_REPO, OPENCODE_V2_CONFIG_DIR, or OPENCODE_V2_ROLE_CATALOG.
set -euo pipefail

PILOT="${OPENCODE_V2_PILOT_DIR:-$HOME/.opencode-v2-pilot}"
BIN="${OPENCODE_V2_BIN:-$HOME/.local/opt/opencode-v2/opencode}"
REPO="${OPENCODE_V2_REPO:-$HOME/repos/opencode-rig}"
CONFIG="${OPENCODE_V2_CONFIG_DIR:-$PILOT/config}"
PLUGINS="$REPO/platforms/linux/ubuntu/computer-use/plugins-v2"
COMPUTER_USE_ROOT="$REPO/platforms/linux/ubuntu/computer-use"
ROLE_CATALOG="${OPENCODE_V2_ROLE_CATALOG:-$COMPUTER_USE_ROOT/config/v2-plugin-roles.json}"
CATALOG_TOOL="$REPO/platforms/linux/ubuntu/computer-use/scripts/v2-plugin-catalog.py"

status=0
ok() { printf 'OK: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; status=1; }

if [ -x "$BIN" ]; then
  ok "v2 binary: $BIN"
else
  fail "v2 binary missing: $BIN"
fi
version="$("$BIN" --version 2>/dev/null || true)"
case "$version" in
  "opencode v2."*) ok "version: $version" ;;
  *) fail "unexpected version: ${version:-<none>}" ;;
esac

if [ -f "$CONFIG/opencode.jsonc" ]; then
  ok "server config present"
else
  fail "missing $CONFIG/opencode.jsonc"
fi
if [ -f "$CONFIG/cli.json" ]; then
  ok "cli config present"
else
  fail "missing $CONFIG/cli.json"
fi

catalog_json='{"plugins": []}'
if [ -f "$ROLE_CATALOG" ] && [ -f "$CATALOG_TOOL" ]; then
  if catalog_json="$(python3 "$CATALOG_TOOL" --catalog "$ROLE_CATALOG" --root "$COMPUTER_USE_ROOT" --json 2>&1)"; then
    ok "v2 plugin role catalog valid"
  else
    fail "v2 plugin role catalog invalid: $catalog_json"
  fi
else
  fail "v2 plugin role catalog or validator missing"
fi

python3 - "$CONFIG" "$PLUGINS" "$REPO" "$catalog_json" <<'PY'
import json
import os
import re
import sys

config, plugins_root, repo, catalog_text = sys.argv[1:5]
failures: list[str] = []


def ok(message: str) -> None:
    print(f"OK: {message}")


def fail(message: str) -> None:
    failures.append(message)


def load_jsonc(path: str):
    text = open(path, encoding="utf-8").read()
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    return json.loads(text)


try:
    server = load_jsonc(os.path.join(config, "opencode.jsonc"))
except (OSError, ValueError) as error:
    server = {}
    failures.append(f"cannot read server config: {error}")
try:
    cli = json.load(open(os.path.join(config, "cli.json"), encoding="utf-8"))
except (OSError, ValueError) as error:
    cli = {}
    failures.append(f"cannot read cli config: {error}")
try:
    catalog = json.loads(catalog_text)
except ValueError as error:
    catalog = {"plugins": []}
    failures.append(f"cannot read normalized role catalog: {error}")

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

expected = {"server": {}, "cli": {}}
for plugin in catalog.get("plugins", []) if isinstance(catalog, dict) else []:
    if not isinstance(plugin, dict):
        failures.append("role catalog contains a malformed plugin")
        continue
    name = plugin.get("name")
    package = plugin.get("package")
    roles = plugin.get("roles")
    if not isinstance(name, str) or not isinstance(package, str) or not isinstance(roles, dict):
        failures.append("role catalog contains an incomplete plugin")
        continue
    for role, descriptor in roles.items():
        if role not in expected or not isinstance(descriptor, dict):
            failures.append(f"role catalog contains an invalid role for {name}")
            continue
        expected[role][name] = (os.path.realpath(package), descriptor.get("entrypoint"))


def config_entries(data, role):
    entries = data.get("plugins") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        failures.append(f"{role} plugins is not a list")
        return {}
    result = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("package"), str):
            failures.append(f"{role} plugin entry {index} is malformed")
            continue
        package = entry["package"]
        canonical = os.path.realpath(package)
        if not os.path.isabs(package) or package != canonical:
            failures.append(f"{role} plugin entry {index} is not a canonical absolute path")
        if canonical in result:
            failures.append(f"{role} plugin is declared more than once: {canonical}")
        result[canonical] = entry
    return result


server_entries = config_entries(server, "server")
cli_entries = config_entries(cli, "cli")
actual_by_role = {"server": server_entries, "cli": cli_entries}
known_packages = {}
for role, plugins in expected.items():
    for name, (package, entrypoint) in plugins.items():
        known_packages.setdefault(package, set()).add(role)
        if not os.path.isfile(entrypoint):
            failures.append(f"plugin role entrypoint missing: {name} ({role})")
        else:
            ok(f"plugin role entrypoint: {name} ({role})")

for role, plugins in expected.items():
    actual = actual_by_role[role]
    missing = [name for name, (package, _) in plugins.items() if package not in actual]
    if missing:
        fail(f"{role} plugins missing: {missing}")
    else:
        ok(f"{role} plugins declared: {list(plugins)}")
    for package in actual:
        allowed_roles = known_packages.get(package)
        if allowed_roles is not None and role not in allowed_roles:
            failures.append(f"{role} contains plugin registered for another role: {package}")

for role, actual in actual_by_role.items():
    for package in actual:
        for name, (expected_package, _) in expected[role].items():
            if expected_package == package:
                ok(f"plugin package canonical: {name} ({role})")
                break

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
