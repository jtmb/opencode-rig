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
JSONC_HELPER="$REPO/platforms/linux/ubuntu/computer-use/scripts/setup-opencode-jsonc.py"

preflight_config_paths() {
  python3 - "$CONFIG" "$CONFIG/opencode.jsonc" "$CONFIG/cli.json" "$REPO/opencode.json" <<'PY'
import os
import sys

root, *files = sys.argv[1:]
def check(path, label):
    absolute = os.path.abspath(path)
    if os.path.islink(absolute):
        raise SystemExit(f"refusing symlinked {label}: {path}")
    parent = os.path.dirname(absolute)
    while parent != os.path.dirname(parent):
        if os.path.islink(parent):
            raise SystemExit(f"refusing symlink ancestor for {label}: {path}")
        parent = os.path.dirname(parent)
for path in [root, *files]:
    check(path, "config root" if path == root else "config file")
PY
}

if ! preflight_config_paths; then
  printf 'FAIL: unsafe v2 config path\n' >&2
  exit 1
fi

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

if python3 - "$CONFIG" "$PLUGINS" "$REPO" "$catalog_json" "$JSONC_HELPER" <<'PY'
import json
import importlib.util
import os
import sys

config, plugins_root, repo, catalog_text, helper_path = sys.argv[1:6]
failures: list[str] = []
spec = importlib.util.spec_from_file_location("setup_opencode_jsonc", helper_path)
helper = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(helper)


def ok(message: str) -> None:
    print(f"OK: {message}")


def fail(message: str) -> None:
    failures.append(message)


def load_jsonc(path: str):
    return helper.load_jsonc(path)


try:
    server = load_jsonc(os.path.join(config, "opencode.jsonc"))
except (OSError, ValueError, json.JSONDecodeError) as error:
    server = {}
    failures.append(f"cannot read server config: {error}")
try:
    cli = load_jsonc(os.path.join(config, "cli.json"))
except (OSError, ValueError, json.JSONDecodeError) as error:
    cli = {}
    failures.append(f"cannot read cli config: {error}")
try:
    project = load_jsonc(os.path.join(repo, "opencode.json"))
except (OSError, ValueError, json.JSONDecodeError) as error:
    project = {}
    failures.append(f"cannot read project config: {error}")
try:
    catalog = json.loads(catalog_text)
except ValueError as error:
    catalog = {"plugins": []}
    failures.append(f"cannot read normalized role catalog: {error}")

skills_dir = os.path.join(config, "skills")
try:
    skills = [name for name in os.listdir(skills_dir) if os.path.isdir(os.path.join(skills_dir, name))]
    if len(skills) == 19:
        ok(f"skills source has 19 entries")
    else:
        fail(f"skills source has {len(skills)} entries (expected 19)")
except OSError:
    fail(f"skills source missing: {skills_dir}")

try:
    skill_symlinks = []
    for root, dirs, files in os.walk(skills_dir, followlinks=False):
        skill_symlinks.extend(
            os.path.join(root, name)
            for name in dirs + files
            if os.path.islink(os.path.join(root, name))
        )
    if skill_symlinks:
        fail(f"skills source/deployed tree contains symlinks: {skill_symlinks}")
    else:
        ok("skills source/deployed tree contains no symlinks")
except OSError as error:
    fail(f"cannot inspect skills for symlinks: {error}")

commands_dir = os.path.join(config, "commands")
try:
    commands = [name for name in os.listdir(commands_dir) if name.endswith(".md")]
    if len(commands) >= 4:
        ok(f"commands: {len(commands)}")
    else:
        fail(f"commands: {len(commands)} (expected at least 4)")
except OSError:
    fail(f"commands dir missing: {commands_dir}")

mcp_config = server.get("mcp", {})
mcp = mcp_config.get("servers", {}) if isinstance(mcp_config, dict) else {}
if not isinstance(mcp_config, dict) or not isinstance(mcp, dict):
    fail("mcp.servers is not an object")
else:
    basic_wrapper = os.path.join(repo, "platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh")
    playwright_wrapper = os.path.join(repo, "platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh")
    policy_path = os.path.join(repo, "platforms/linux/ubuntu/computer-use/config/mcp-versions.json")
    try:
        with open(policy_path, encoding="utf-8") as handle:
            github_remote = json.load(handle)["githubRemote"]
    except (OSError, ValueError, KeyError) as error:
        github_remote = ""
        failures.append(f"cannot read canonical MCP policy: {error}")
    portable_playwright_command = ["./platforms/linux/ubuntu/computer-use/scripts/playwright-mcp.sh"]
    portable_basic_command = ["./platforms/linux/ubuntu/computer-use/scripts/basic-memory-mcp.sh"]
    github = mcp.get("github")
    if isinstance(github, dict) and github.get("type") == "remote" and github.get("url") == github_remote \
            and github.get("disabled", False) is not True \
            and not any(key in github for key in ("authorization", "headers", "environment", "client_secret", "clientSecret", "token")):
        ok("global GitHub MCP uses the hosted OAuth endpoint")
    else:
        fail("global GitHub MCP is not the credential-free hosted OAuth endpoint")
    for name, wrapper in (("basic-memory", basic_wrapper),):
        entry = mcp.get(name)
        if isinstance(entry, dict) and (
            entry.get("command") == [wrapper]
            or (entry.get("command") == portable_basic_command and entry.get("cwd", ".") == ".")
        ) and entry.get("disabled", False) is not True:
            ok(f"global {name} MCP declared with exact local wrapper")
        else:
            fail(f"global {name} MCP is not the exact enabled local wrapper")
    if any(name in mcp for name in ("playwright",)):
        fail("global Playwright MCP must be absent")
    else:
        ok("global Playwright MCP absent")
    for name in ("github", "playwright", "basic-memory"):
        if name in mcp_config:
            fail(f"legacy flat MCP key remains: mcp.{name}")
        else:
            ok(f"legacy flat MCP key absent: mcp.{name}")

session = cli.get("session") if isinstance(cli, dict) else None
if isinstance(session, dict) and session.get("permissions") == "prompt":
    ok("CLI session permissions are prompt")
else:
    fail("CLI session.permissions must be prompt")

project_mcp_config = project.get("mcp", {}) if isinstance(project, dict) else {}
project_servers = project_mcp_config.get("servers", {}) if isinstance(project_mcp_config, dict) else {}
project_playwright = project_servers.get("playwright") if isinstance(project_servers, dict) else None
project_basic = project_servers.get("basic-memory") if isinstance(project_servers, dict) else None
project_github = project_servers.get("github") if isinstance(project_servers, dict) else None
project_command = project_playwright.get("command") if isinstance(project_playwright, dict) else None
portable_cwd = project_playwright.get("cwd", ".") if isinstance(project_playwright, dict) else None
if isinstance(project_playwright, dict) and (
    project_command == [playwright_wrapper]
    or (project_command == portable_playwright_command and portable_cwd == ".")
) and project_playwright.get("disabled", False) is not True:
    ok("project Playwright MCP uses the local wrapper")
else:
    fail("project Playwright MCP is not the exact enabled local or workspace-relative wrapper")
if isinstance(project_basic, dict) and project_basic.get("command") == portable_basic_command \
        and project_basic.get("disabled", False) is not True:
    ok("portable project Basic Memory MCP uses the workspace-relative wrapper")
else:
    fail("portable project Basic Memory MCP is not the exact enabled workspace-relative wrapper")
if isinstance(project_github, dict) and project_github.get("type") == "remote" \
        and project_github.get("url") == github_remote \
        and project_github.get("disabled", False) is not True \
        and not any(key in project_github for key in ("authorization", "headers", "environment", "client_secret", "clientSecret", "token")):
    ok("portable project GitHub MCP uses the credential-free hosted OAuth endpoint")
else:
    fail("portable project GitHub MCP is not the credential-free hosted OAuth endpoint")
if isinstance(project_servers, dict) and set(project_servers) != {"basic-memory", "github", "playwright"}:
    fail(f"portable project MCP server set is not exactly canonical: {sorted(project_servers)}")
if isinstance(project_mcp_config, dict) and any(name in project_mcp_config for name in ("github", "playwright", "basic-memory")):
    fail("legacy flat MCP key remains in project config")

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
    ok("theme is aura")
else:
    fail(f"theme is not aura: {theme!r}")

example = os.path.join(repo, "platforms/linux/ubuntu/computer-use/config/v2-opencode.example.jsonc")
try:
    example_config = load_jsonc(example).get("mcp", {})
    example_mcp = example_config.get("servers", {}) if isinstance(example_config, dict) else {}
    example_play = [name for name in example_mcp if "playwright" in name]
    if example_play == ["playwright"]:
        ok("v2 example declares exactly one playwright MCP")
    else:
        fail(f"v2 example playwright declarations: {example_play or '<none>'}")
except (OSError, ValueError, json.JSONDecodeError) as error:
    fail(f"cannot read v2 example: {error}")

for message in failures:
    print(f"FAIL: {message}", file=sys.stderr)
sys.exit(1 if failures else 0)
PY
then
  :
else
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: v2 pilot health check passed"
else
  echo "FAIL: v2 pilot health check failed" >&2
fi
exit "$status"
