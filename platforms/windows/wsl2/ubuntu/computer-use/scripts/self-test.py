#!/usr/bin/env python3
"""Disposable integration tests for WSL2 delegation and deployment."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Callable


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parent / "configure.py"
DEPLOY_SCRIPT = Path(__file__).resolve().parent / "deploy-plugins.sh"
SETUP_SCRIPT = Path(__file__).resolve().parent / "setup-opencode.sh"
SETUP_MCPS_SCRIPT = Path(__file__).resolve().parent / "setup-mcps.sh"
WSL_PLUGIN_DEPENDENCY_SETUP = Path(__file__).resolve().parent / "setup-wsl-plugin-dependencies.sh"
WSL_PLUGIN_DEPENDENCY_RUNNER = Path(__file__).resolve().parent / "run-bounded-command.sh"
WSL_PLUGIN_ROOT = Path(__file__).resolve().parent.parent / "plugins-v2"
SPEC = importlib.util.spec_from_file_location("wsl2_configure", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("cannot import configure.py")
configure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configure)

WEBSEARCH_SCRIPT = Path(__file__).resolve().parent / "verify-websearch.py"
WEBSEARCH_SPEC = importlib.util.spec_from_file_location("wsl2_verify_websearch", WEBSEARCH_SCRIPT)
if WEBSEARCH_SPEC is None or WEBSEARCH_SPEC.loader is None:
    raise SystemExit("cannot import verify-websearch.py")
verify_websearch = importlib.util.module_from_spec(WEBSEARCH_SPEC)
WEBSEARCH_SPEC.loader.exec_module(verify_websearch)

OWNERSHIP_SCRIPT = Path(__file__).resolve().parent / "check-ownership-boundary.py"
OWNERSHIP_SPEC = importlib.util.spec_from_file_location("wsl2_ownership_boundary", OWNERSHIP_SCRIPT)
if OWNERSHIP_SPEC is None or OWNERSHIP_SPEC.loader is None:
    raise SystemExit("cannot import check-ownership-boundary.py")
ownership = importlib.util.module_from_spec(OWNERSHIP_SPEC)
OWNERSHIP_SPEC.loader.exec_module(ownership)


def expect_error(run: Callable[[], object], contains: str) -> None:
    """Require one ConfigError containing the expected text."""
    try:
        run()
    except configure.ConfigError as error:
        if contains.lower() not in str(error).lower():
            raise AssertionError(f"expected {contains!r}, received {error!r}") from error
    else:
        raise AssertionError(f"expected ConfigError containing {contains!r}")


def assert_owned_configuration(server: Path, cli: Path, target: Path) -> None:
    """Assert the exact owned config fields after full deployment."""
    parsed = configure.load_json(server)
    permissions = {
        rule["action"]: rule["effect"]
        for rule in parsed["permissions"]
        if isinstance(rule, dict)
    }
    if parsed.get("websearch") != {"provider": "random"}:
        raise AssertionError("websearch provider is not exactly random")
    for action in configure.SERVER_PERMISSIONS:
        if permissions.get(action) != "ask":
            raise AssertionError(f"missing ask permission for {action}")
    if configure.load_json(cli).get("session", {}).get("permissions") != "prompt":
        raise AssertionError("CLI prompt permission is missing")
    servers = parsed.get("mcp", {}).get("servers", {})
    if sorted(servers) != ["basic-memory", "chatgpt", "github"]:
        raise AssertionError(f"unexpected MCP set: {sorted(servers)}")
    expected = configure.mcp_servers(target)
    if servers != expected:
        raise AssertionError("WSL MCP declarations do not match canonical Ubuntu ownership")
    if "playwright_*" in configure.SERVER_PERMISSIONS:
        raise AssertionError("WSL permissions still include the retired Playwright MCP tools")
    if not {"wsl_browser_open", "wsl_browser_act"}.issubset(configure.SERVER_PERMISSIONS):
        raise AssertionError("WSL default-browser actions are missing their exact ask permissions")
    github = servers["github"]
    if github.get("type") != "local" or Path(github.get("command", [""])[0]).name != "github-mcp.sh":
        raise AssertionError("GitHub MCP does not use the canonical local wrapper")
    if github.get("environment", {}).get("OPENCODE_MCP_PROFILE") != "wsl2":
        raise AssertionError("GitHub MCP does not select the isolated WSL2 profile")
    chatgpt = servers["chatgpt"]
    if chatgpt.get("type") != "local" or Path(chatgpt.get("command", [""])[0]).name != "chatgpt-mcp.sh":
        raise AssertionError("ChatGPT MCP does not use the canonical local wrapper")
    if chatgpt.get("codemode") is not False:
        raise AssertionError("ChatGPT MCP tools are not exposed directly")
    if chatgpt.get("environment", {}).get("OPENCODE_MCP_PROFILE") != "wsl2":
        raise AssertionError("ChatGPT MCP does not select the isolated WSL2 profile")
    if cli != target.parent / "xdg" / "opencode" / "cli.json":
        raise AssertionError(f"CLI config is not under the isolated XDG root: {cli}")


def assert_browser_example_permissions() -> None:
    """Verify the example asks for browser actions and no longer includes Playwright."""
    example_path = configure.CONFIG_ROOT / "opencode.example.jsonc"
    example = json.loads(configure.strip_jsonc(example_path.read_text(encoding="utf-8")))
    permissions = example.get("permissions")
    if not isinstance(permissions, list) or not all(isinstance(rule, dict) for rule in permissions):
        raise AssertionError("WSL example permissions must be an array of objects")
    for action in ("wsl_browser_open", "wsl_browser_act"):
        matching = [rule for rule in permissions if rule.get("action") == action]
        if matching != [{"action": action, "resource": "*", "effect": "ask"}]:
            raise AssertionError(f"WSL example must contain one exact ask permission for {action}")
    if any(rule.get("action") == "playwright_*" for rule in permissions):
        raise AssertionError("WSL example still asks for retired Playwright tools")


def test_wsl_plugin_dependency_setup() -> None:
    """Verify missing dependencies fail closed and apply uses the WSL lockfile workspace."""
    setup_source = SETUP_SCRIPT.read_text(encoding="utf-8")
    if '"$WSL_PLUGIN_DEPENDENCY_SETUP" --apply' not in setup_source:
        raise AssertionError("WSL apply does not provision its plugin workspace dependencies")
    if '"$WSL_PLUGIN_DEPENDENCY_SETUP" --verify-only' not in setup_source:
        raise AssertionError("WSL setup verification does not check its plugin workspace dependencies")
    verify_source = (Path(__file__).resolve().parent / "verify-wsl2.sh").read_text(encoding="utf-8")
    if 'setup-wsl-plugin-dependencies.sh" --verify-only' not in verify_source:
        raise AssertionError("WSL source verification does not check its plugin workspace dependencies")

    with tempfile.TemporaryDirectory(prefix="open-rig-wsl-plugin-dependencies-") as temporary:
        root = Path(temporary)
        computer_use = root / "platforms/windows/wsl2/ubuntu/computer-use"
        scripts = computer_use / "scripts"
        plugins = computer_use / "plugins-v2"
        scripts.mkdir(parents=True)
        plugins.mkdir()
        shutil.copy2(WSL_PLUGIN_DEPENDENCY_SETUP, scripts / WSL_PLUGIN_DEPENDENCY_SETUP.name)
        shutil.copy2(WSL_PLUGIN_DEPENDENCY_RUNNER, scripts / WSL_PLUGIN_DEPENDENCY_RUNNER.name)
        shutil.copy2(WSL_PLUGIN_ROOT / "package.json", plugins / "package.json")
        shutil.copy2(WSL_PLUGIN_ROOT / "package-lock.json", plugins / "package-lock.json")

        home = root / "home"
        home.mkdir()
        env = {**os.environ, "HOME": str(home)}
        missing = subprocess.run(
            [str(scripts / WSL_PLUGIN_DEPENDENCY_SETUP.name), "--verify-only"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        if missing.returncode == 0 or "dependencies are missing" not in missing.stderr:
            raise AssertionError(f"missing WSL dependencies did not fail clearly:\n{missing.stdout}\n{missing.stderr}")

        fake_bin = root / "fake-bin"
        fake_bin.mkdir()
        invocation_log = root / "npm-invocations.jsonl"
        fake_npm = fake_bin / "npm"
        fake_npm.write_text(
            "#!/usr/bin/env python3\n"
            "import json, pathlib, sys\n"
            f"log = pathlib.Path({str(invocation_log)!r})\n"
            "args = sys.argv[1:]\n"
            "with log.open('a', encoding='utf-8') as stream: stream.write(json.dumps(args) + '\\n')\n"
            "prefix = pathlib.Path(args[args.index('--prefix') + 1])\n"
            "tsc = prefix / 'node_modules/.bin/tsc'\n"
            "tsc.parent.mkdir(parents=True, exist_ok=True)\n"
            "tsc.write_text('#!/bin/sh\\nexit 0\\n', encoding='utf-8')\n"
            "tsc.chmod(0o755)\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        applied = subprocess.run(
            [str(scripts / WSL_PLUGIN_DEPENDENCY_SETUP.name), "--apply"],
            check=False,
            capture_output=True,
            text=True,
            env={**env, "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}"},
            timeout=30,
        )
        if applied.returncode != 0 or "WSL plugin workspace dependencies are ready" not in applied.stdout:
            raise AssertionError(f"WSL plugin dependency apply failed:\n{applied.stdout}\n{applied.stderr}")
        invocations = [json.loads(line) for line in invocation_log.read_text(encoding="utf-8").splitlines()]
        expected = ["--prefix", str(plugins), "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
        if invocations != [expected]:
            raise AssertionError(f"WSL dependencies were not installed from the workspace lockfile: {invocations!r}")

        verified = subprocess.run(
            [str(scripts / WSL_PLUGIN_DEPENDENCY_SETUP.name), "--verify-only"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        if verified.returncode != 0 or len(invocation_log.read_text(encoding="utf-8").splitlines()) != 1:
            raise AssertionError(f"installed WSL dependencies did not verify read-only:\n{verified.stdout}\n{verified.stderr}")


def main() -> int:
    """Run disposable setup, deployment, rollback, and launcher tests."""
    assert_browser_example_permissions()
    test_wsl_plugin_dependency_setup()
    with tempfile.TemporaryDirectory(prefix="open-rig-wsl2-self-test-") as temporary:
        root = Path(temporary)
        boundary_root = root / "boundary"
        boundary_root.mkdir()
        (boundary_root / "delegation.py").write_text(
            "CANONICAL = 'platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py'\n",
            encoding="utf-8",
        )
        if ownership.scan(boundary_root, configure.CANONICAL_ROOT):
            raise AssertionError("ownership boundary rejected an intentional canonical reference")
        (boundary_root / "developer.py").write_text(
            "OLD = '" + "/" + "home/other-user/repos/duplicate-mcp.py'\n",
            encoding="utf-8",
        )
        if not ownership.scan(boundary_root, configure.CANONICAL_ROOT):
            raise AssertionError("ownership boundary accepted a developer-specific path")
        link_target = boundary_root / "target.py"
        link_target.write_text("pass\n", encoding="utf-8")
        (boundary_root / "linked.py").symlink_to(link_target)
        if not any("symlink" in failure for failure in ownership.scan(boundary_root, configure.CANONICAL_ROOT)):
            raise AssertionError("ownership boundary accepted a symlink")
        target = root / "pilot" / "config"
        configure.seed(target, apply=True)
        configure.deploy(target, "all", apply=True)
        configure.verify_deployment(target)
        verify_websearch.verify_config(target)

        server, cli = configure.config_paths(target)
        assert_owned_configuration(server, cli, target)
        assert {
            name: configure.load_json(server)["agents"][name]["model"]
            for name in configure.AGENT_MODELS.AGENT_MODELS
        } == configure.AGENT_MODELS.AGENT_MODELS
        architect = configure.load_json(server)["agents"]["architect"]
        if architect["mode"] != "subagent" or not any(
            rule == {"action": "edit", "resource": "*", "effect": "deny"}
            for rule in architect["permissions"]
        ) or not any(
            rule == {"action": "shell", "resource": "*", "effect": "deny"}
            for rule in architect["permissions"]
        ):
            raise AssertionError("WSL Architect must be a read-only Sol planning subagent")

        shared_target = root / "shared-pilot" / "config"
        configure.seed(shared_target, apply=True)
        subprocess.run(
            [
                str(DEPLOY_SCRIPT),
                "--config-dir", str(shared_target),
                "--plugins", "all",
                "--apply",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        shared_server, shared_cli = configure.config_paths(shared_target)
        shared_server_packages = {
            Path(entry["package"])
            for entry in configure.load_json(shared_server)["plugins"]
        }
        shared_cli_packages = {
            Path(entry["package"])
            for entry in configure.load_json(shared_cli)["plugins"]
        }
        if not any(path.name == "rig-tools" for path in shared_server_packages & shared_cli_packages):
            raise AssertionError("shared deployment omitted a dual-role canonical rig-tools package")
        if not any(path.name == "repo-learning" for path in shared_server_packages & shared_cli_packages):
            raise AssertionError("shared deployment omitted canonical repo-learning roles")
        if not any(path.name == "ponytail-adapter" for path in shared_server_packages):
            raise AssertionError("shared deployment omitted the canonical Ponytail server role")
        if any(path.name == "ponytail-adapter" for path in shared_cli_packages):
            raise AssertionError("shared deployment registered the server-only Ponytail adapter in CLI")
        if not any(path.name == "wsl-interop" for path in shared_server_packages & shared_cli_packages):
            raise AssertionError("shared deployment omitted the WSL-only interop package")
        generic_packages = (shared_server_packages | shared_cli_packages) - {
            path for path in shared_server_packages | shared_cli_packages
            if path.name == "wsl-interop"
        }
        canonical_root = configure.PLATFORM_ROOT.parents[3] / "linux" / "ubuntu" / "computer-use" / "plugins-v2"
        if any(canonical_root not in path.parents for path in generic_packages):
            raise AssertionError("generic WSL profile packages are not owned by canonical Ubuntu")
        if any(".local/opt/opencode-ponytail" in str(path) for path in shared_server_packages | shared_cli_packages):
            raise AssertionError("WSL deployment retained the retired HOME-based Ponytail dependency")
        if (shared_target / "cli.json").exists():
            raise AssertionError("shared WSL deployment wrote a duplicate CLI config")
        setup_source = SETUP_SCRIPT.read_text(encoding="utf-8")
        if '"$SCRIPT_DIR/deploy-plugins.sh"' not in setup_source:
            raise AssertionError("WSL setup does not delegate plugin deployment to the shared wrapper")
        versions = configure.MCP.load_policy()
        if versions.get("nodeVersion") != "22.22.2":
            raise AssertionError("WSL MCP Node runtime must remain pinned to 22.22.2")
        wrappers = {
            "basicMemory": configure.CANONICAL_ROOT / "scripts" / "basic-memory-mcp.sh",
            "githubVersion": configure.CANONICAL_ROOT / "scripts" / "github-mcp.sh",
        }
        chatgpt_wrapper = configure.CANONICAL_ROOT / "scripts" / "chatgpt-mcp.sh"
        if (Path(__file__).resolve().parent / "basic-memory-mcp.sh").exists():
            raise AssertionError("WSL keeps a duplicate Basic Memory wrapper")
        if (Path(__file__).resolve().parent / "playwright-mcp.sh").exists():
            raise AssertionError("WSL keeps a duplicate Playwright wrapper")
        if (Path(__file__).resolve().parent / "github-mcp.sh").exists():
            raise AssertionError("WSL keeps a duplicate GitHub wrapper")
        if (Path(__file__).resolve().parent / "chatgpt-mcp.sh").exists():
            raise AssertionError("WSL keeps a duplicate ChatGPT wrapper")
        legacy_servers = {
            **configure.mcp_servers(target),
            "playwright": {"type": "local", "command": ["retired-project-entry"]},
        }
        try:
            configure.MCP.verify_mcp_servers(
                {"mcp": {"servers": legacy_servers}}, profile="wsl2", profile_root=target.parent
            )
        except configure.MCP.McpRuntimeError:
            pass
        else:
            raise AssertionError("WSL configuration accepted a retired project-only Playwright MCP")
        if chatgpt_wrapper.is_symlink() or not chatgpt_wrapper.is_file() or not os.access(chatgpt_wrapper, os.X_OK):
            raise AssertionError("ChatGPT MCP wrapper is not a canonical executable regular file")
        if (configure.CONFIG_ROOT / "mcp-versions.json").exists():
            raise AssertionError("WSL keeps a duplicate MCP version policy")
        for key, wrapper in wrappers.items():
            source = wrapper.read_text(encoding="utf-8")
            if str(versions[key]) not in source:
                if "mcp_runtime.py" not in source:
                    raise AssertionError(f"{wrapper.name} does not use the canonical policy")
            if "mcp_runtime.py" not in source:
                raise AssertionError(f"{wrapper.name} is not environment-isolated through canonical runtime")
            if key != "githubVersion" and "/usr/bin/env -i" not in source:
                raise AssertionError(f"{wrapper.name} does not launch with an isolated environment")
            if key == "githubVersion" and ("auth token" not in source or "inherited GitHub token/control" not in source):
                raise AssertionError("GitHub wrapper does not authenticate from gh while rejecting inherited controls")
            if "@latest" in source:
                raise AssertionError(f"{wrapper.name} uses an unpinned latest package")
        windows_setup = (Path(__file__).resolve().parent / "setup-open-rig-wsl.ps1").read_text(encoding="utf-8")
        if '-replace "`0", ""' not in windows_setup or '"\\s2\\s*$"' not in windows_setup:
            raise AssertionError("Windows prerequisite verifier does not normalize WSL UTF-16 output")
        writable_runner = root / "writable-uvx"
        writable_runner.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        writable_runner.chmod(0o722)
        rejected_runner = subprocess.run(
            [str(wrappers["basicMemory"]), "--provision"],
            check=False,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "OPENCODE_WSL2_PILOT_DIR": str(target.parent),
                "OPENCODE_MCP_PROFILE": "wsl2",
                "OPENCODE_MCP_PROFILE_ROOT": str(target.parent),
                "OPENCODE_MCP_UVX_BIN": str(writable_runner),
            },
        )
        if rejected_runner.returncode == 0 or "no trusted uvx runner" not in rejected_runner.stderr:
            raise AssertionError("Basic Memory wrapper accepted a writable package runner")
        unsupported_profile = subprocess.run(
            [str(wrappers["basicMemory"]), "--verify-only"],
            check=False,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "OPENCODE_MCP_PROFILE": "unsupported",
                "OPENCODE_MCP_PROFILE_ROOT": str(target.parent),
            },
        )
        if unsupported_profile.returncode == 0 or "unsupported MCP profile" not in unsupported_profile.stderr:
            raise AssertionError("Basic Memory wrapper accepted an unsupported profile")
        limiter_profile = root / "limiter-profile"
        fake_bin = root / "limiter-bin"
        fake_bin.mkdir()
        systemd_log = root / "systemd-run.log"
        prlimit_log = root / "prlimit.log"
        fake_uvx = fake_bin / "uvx"
        fake_uvx.write_text(
            "#!/usr/bin/python3\n"
            "import json\n"
            "import os\n"
            "from pathlib import Path\n"
            "import sys\n"
            "arguments = sys.argv[1:]\n"
            "if 'project' in arguments and 'add' in arguments:\n"
            "    index = arguments.index('add')\n"
            "    project = arguments[index + 1]\n"
            "    notes = arguments[index + 2]\n"
            "    config = Path(os.environ['BASIC_MEMORY_CONFIG_DIR']) / 'config.json'\n"
            "    config.write_text(json.dumps({'projects': {project: {'path': notes, 'mode': 'local'}}, "
            "'default_project': project}) + '\\n', encoding='utf-8')\n"
            "elif 'project' in arguments and 'default' in arguments:\n"
            "    index = arguments.index('default')\n"
            "    project = arguments[index + 1]\n"
            "    config = Path(os.environ['BASIC_MEMORY_CONFIG_DIR']) / 'config.json'\n"
            "    value = json.loads(config.read_text(encoding='utf-8'))\n"
            "    value['default_project'] = project\n"
            "    config.write_text(json.dumps(value) + '\\n', encoding='utf-8')\n"
            "else:\n"
            f"    print('Basic Memory version: {versions['basicMemory']}')\n",
            encoding="utf-8",
        )
        (fake_bin / "systemctl").write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
        (fake_bin / "systemd-run").write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"printf 'called\\n' >> {str(systemd_log)!r}\n"
            "while [[ \"$#\" -gt 0 && \"$1\" != '--' ]]; do shift; done\n"
            "[[ \"$#\" -gt 0 ]] && shift\n"
            "exec \"$@\"\n",
            encoding="utf-8",
        )
        (fake_bin / "prlimit").write_text(
            "#!/usr/bin/env sh\n"
            f"printf 'called\\n' >> {str(prlimit_log)!r}\n"
            "exit 99\n",
            encoding="utf-8",
        )
        for executable in fake_bin.iterdir():
            executable.chmod(0o700)
        limited = subprocess.run(
            [str(wrappers["basicMemory"]), "--provision"],
            check=False,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
                "OPENCODE_MCP_PROFILE": "wsl2",
                "OPENCODE_MCP_PROFILE_ROOT": str(limiter_profile),
                "OPENCODE_MCP_UVX_BIN": str(fake_uvx),
            },
        )
        if limited.returncode != 0:
            raise AssertionError(f"Basic Memory systemd limiter path failed: {limited.stderr}")
        if not systemd_log.is_file():
            raise AssertionError("Basic Memory wrapper did not use the selected systemd limiter")
        if prlimit_log.exists():
            raise AssertionError("Basic Memory wrapper invoked prlimit after a successful systemd-run")
        limiter_config = limiter_profile / "mcp" / "basic-memory" / "home" / "config.json"
        limiter_value = json.loads(limiter_config.read_text(encoding="utf-8"))
        limiter_value["default_project"] = "other"
        limiter_config.write_text(json.dumps(limiter_value) + "\n", encoding="utf-8")
        repaired_default = subprocess.run(
            [str(wrappers["basicMemory"]), "--provision"],
            check=False,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PATH": f"{fake_bin}:{os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
                "OPENCODE_MCP_PROFILE": "wsl2",
                "OPENCODE_MCP_PROFILE_ROOT": str(limiter_profile),
                "OPENCODE_MCP_UVX_BIN": str(fake_uvx),
            },
        )
        if repaired_default.returncode != 0:
            raise AssertionError(f"Basic Memory default-project repair failed: {repaired_default.stderr}")
        if json.loads(limiter_config.read_text(encoding="utf-8"))["default_project"] != "computer-assistant":
            raise AssertionError("Basic Memory provisioning did not restore the canonical default project")
        if prlimit_log.exists():
            raise AssertionError("Basic Memory default-project repair invoked both memory limiters")

        fallback_profile = root / "fallback-profile"
        fallback_bin = root / "fallback-bin"
        fallback_bin.mkdir()
        fallback_home = root / "fallback-home"
        fallback_home.mkdir(mode=0o700)
        fallback_runtime = root / "fallback-runtime"
        fallback_runtime.mkdir(mode=0o700)
        fallback_uvx = fallback_bin / "uvx"
        fallback_uvx.write_text(
            "#!/usr/bin/python3\n"
            "import json\n"
            "import mmap\n"
            "import os\n"
            "import sys\n"
            "from pathlib import Path\n"
            "mapping = mmap.mmap(-1, 2 * 1024**3, flags=mmap.MAP_PRIVATE | mmap.MAP_ANONYMOUS | mmap.MAP_NORESERVE, prot=mmap.PROT_READ | mmap.PROT_WRITE)\n"
            "mapping.close()\n"
            "arguments = sys.argv[1:]\n"
            "if 'project' in arguments and 'add' in arguments:\n"
            "    index = arguments.index('add')\n"
            "    project = arguments[index + 1]\n"
            "    notes = arguments[index + 2]\n"
            "    config = Path(os.environ['BASIC_MEMORY_CONFIG_DIR']) / 'config.json'\n"
            "    config.write_text(json.dumps({'projects': {project: {'path': notes, 'mode': 'local'}}, 'default_project': project}) + '\\n', encoding='utf-8')\n"
            "elif 'project' in arguments and 'default' in arguments:\n"
            "    index = arguments.index('default')\n"
            "    project = arguments[index + 1]\n"
            "    config = Path(os.environ['BASIC_MEMORY_CONFIG_DIR']) / 'config.json'\n"
            "    value = json.loads(config.read_text(encoding='utf-8'))\n"
            "    value['default_project'] = project\n"
            "    config.write_text(json.dumps(value) + '\\n', encoding='utf-8')\n"
            "elif 'mcp' in arguments:\n"
            "    print('FAKE MCP STARTED')\n"
            "else:\n"
            f"    print('Basic Memory version: {versions['basicMemory']}')\n",
            encoding="utf-8",
        )
        fallback_uvx.chmod(0o700)
        (fallback_bin / "systemctl").write_text("#!/usr/bin/env sh\nexit 1\n", encoding="utf-8")
        real_prlimit = shutil.which("prlimit", path=os.defpath)
        setsid_path = shutil.which("setsid", path=os.defpath)
        if not real_prlimit or not setsid_path:
            raise AssertionError("focused Basic Memory fallback test requires prlimit and setsid")
        (fallback_bin / "prlimit").write_text(
            "#!/usr/bin/env bash\n"
            "if [[ \"${3##*/}\" != setsid || \"${4:-}\" != --wait || \"${5:-}\" != -- ]]; then\n"
            "  printf 'Basic Memory reused its RSS budget as an address-space ceiling\\n' >&2\n"
            "  exit 97\n"
            "fi\n"
            f"exec {real_prlimit} \"$@\"\n",
            encoding="utf-8",
        )
        for executable in (fallback_bin / "systemctl", fallback_bin / "prlimit"):
            executable.chmod(0o700)
        fallback_environment = {
            **os.environ,
            "HOME": str(fallback_home),
            "PATH": f"{fallback_bin}:{os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}",
            "XDG_RUNTIME_DIR": str(fallback_runtime),
            "OPENCODE_MCP_PROFILE": "wsl2",
            "OPENCODE_MCP_PROFILE_ROOT": str(fallback_profile),
            "OPENCODE_MCP_UVX_BIN": str(fallback_uvx),
        }
        fallback_provision = subprocess.run(
            [str(wrappers["basicMemory"]), "--provision"],
            check=False,
            capture_output=True,
            text=True,
            env=fallback_environment,
            timeout=30,
        )
        if fallback_provision.returncode != 0:
            raise AssertionError(f"Basic Memory RSS fallback provisioning failed: {fallback_provision.stderr}")

        configure.MCP.prepare_profile(fallback_profile, apply=True)
        fallback_paths = configure.MCP.profile_paths(fallback_profile)
        basic_environment = fallback_paths["uv_environments"] / "scope" / "environment"
        basic_executable = basic_environment / "bin" / "basic-memory"
        basic_executable.parent.mkdir(parents=True)
        basic_executable.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
        basic_executable.chmod(0o700)
        basic_package = basic_environment / "lib" / "python3.12" / "site-packages" / f"basic_memory-{versions['basicMemory']}.dist-info"
        basic_package.mkdir(parents=True)
        node_bin = fallback_paths["node_root"] / "bin"
        node_bin.mkdir(parents=True)
        (node_bin / "node").write_text(f"#!/usr/bin/env sh\nprintf 'v{versions['nodeVersion']}\\n'\n", encoding="utf-8")
        (node_bin / "npm").write_text("#!/usr/bin/env sh\nprintf '10.9.4\\n'\n", encoding="utf-8")
        for runner in (node_bin / "node", node_bin / "npm"):
            runner.chmod(0o700)
        github = fallback_paths["github_binary"]
        github.write_text(
            "#!/usr/bin/env sh\n"
            f"printf 'GitHub MCP Server\\nVersion: {versions['githubVersion']}\\n'\n",
            encoding="utf-8",
        )
        github.chmod(0o700)
        configure.MCP.mcp_provisioning(fallback_profile, profile="wsl2", apply=True, quiet=True)

        timeout_log = root / "persistent-timeout.log"
        (fallback_bin / "timeout").write_text(
            "#!/usr/bin/env sh\n"
            f"printf 'called\\n' >> {str(timeout_log)!r}\n"
            "exit 99\n",
            encoding="utf-8",
        )
        (fallback_bin / "timeout").chmod(0o700)
        invalid_runtime = root / "invalid-runtime"
        invalid_runtime.symlink_to(fallback_runtime, target_is_directory=True)
        live_environment = {**fallback_environment, "XDG_RUNTIME_DIR": str(invalid_runtime)}
        live = subprocess.run(
            [str(wrappers["basicMemory"])],
            check=False,
            capture_output=True,
            text=True,
            env=live_environment,
            timeout=30,
        )
        if live.returncode != 0 or "FAKE MCP STARTED" not in live.stdout or timeout_log.exists():
            raise AssertionError(f"Basic Memory persistent RSS fallback failed: {live.stderr or live.stdout}")

        basic_environment = target.parent / "cache" / "uv" / "environments-v2" / "scope" / "environment"
        basic_executable = basic_environment / "bin" / "basic-memory"
        basic_executable.parent.mkdir(parents=True)
        basic_executable.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
        basic_executable.chmod(0o700)
        basic_package = basic_environment / "lib" / "python3.12" / "site-packages" / f"basic_memory-{versions['basicMemory']}.dist-info"
        basic_package.mkdir(parents=True)
        node_bin = target.parent / "mcp" / "node" / f"node-v{versions['nodeVersion']}-linux-x64" / "bin"
        node_bin.mkdir(parents=True)
        (node_bin / "node").write_text(
            f"#!/usr/bin/env sh\nprintf 'v{versions['nodeVersion']}\\n'\n",
            encoding="utf-8",
        )
        (node_bin / "npm").write_text("#!/usr/bin/env sh\nprintf '10.9.4\\n'\n", encoding="utf-8")
        (node_bin / "npx").write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
        for runner in (node_bin / "node", node_bin / "npm", node_bin / "npx"):
            runner.chmod(0o700)
        basic_config = target.parent / "mcp" / "basic-memory" / "home" / "config.json"
        basic_config.parent.mkdir(parents=True, exist_ok=True)
        basic_config.write_text(
            json.dumps(
                {
                    "projects": {
                        "computer-assistant": {
                            "path": str(target.parent / "mcp" / "basic-memory" / "notes"),
                            "mode": "local",
                        }
                    },
                    "default_project": "computer-assistant",
                }
            )
            + "\n",
            encoding="utf-8",
        )
        if (target.parent / "mcp" / "playwright").exists():
            raise AssertionError("isolated WSL global MCP profile created project-only Playwright state")
        if (target.parent / "cache" / "ms-playwright").exists():
            raise AssertionError("isolated WSL global MCP profile created project-only Playwright browser state")
        github = target.parent / "mcp" / "github" / "github-mcp-server"
        github.parent.mkdir(parents=True, exist_ok=True)
        github.write_text(
            "#!/usr/bin/env sh\n"
            f"printf 'GitHub MCP Server\\nVersion: {versions['githubVersion']}\\n'\n",
            encoding="utf-8",
        )
        github.chmod(0o700)
        fake_home = root / "fake-home"
        fake_gh = fake_home / ".local" / "bin" / "gh"
        fake_gh.parent.mkdir(parents=True)
        fake_gh.write_text(
            "#!/usr/bin/env sh\n"
            "[ \"${1:-}\" = auth ] && [ \"${2:-}\" = token ] || exit 2\n"
            "printf 'self-test-token\\n'\n",
            encoding="utf-8",
        )
        fake_gh.chmod(0o700)
        configure.mcp_provisioning(target, apply=True)
        configure.mcp_provisioning(target, apply=False)
        profile_before_verify = {
            path.relative_to(target.parent): (path.read_bytes(), path.stat().st_mode & 0o777)
            for path in target.parent.rglob("*")
            if path.is_file() and not path.is_symlink()
        }
        delegated = subprocess.run(
            [str(SETUP_MCPS_SCRIPT), "--pilot-dir", str(target.parent), "--verify-only"],
            check=False,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "HOME": str(fake_home),
                "OPENCODE_MCP_UVX_BIN": str(configure.MCP.resolve_runner("uvx")),
            },
        )
        if delegated.returncode != 0:
            raise AssertionError(f"WSL MCP setup did not delegate to canonical verification: {delegated.stderr}")
        profile_after_verify = {
            path.relative_to(target.parent): (path.read_bytes(), path.stat().st_mode & 0o777)
            for path in target.parent.rglob("*")
            if path.is_file() and not path.is_symlink()
        }
        if profile_after_verify != profile_before_verify:
            raise AssertionError("WSL MCP verify-only changed isolated profile state")
        marker = target.parent / "mcp" / "provisioned.json"
        marker_data = configure.load_json(marker)
        marker_data["githubVersion"] = "stale"
        configure.atomic_write(marker, marker_data)
        expect_error(lambda: configure.mcp_provisioning(target, apply=False), "missing or stale")
        configure.mcp_provisioning(target, apply=True)
        quiet = subprocess.run(
            [sys.executable, str(SCRIPT), "check-path", "--config-dir", str(target), "--quiet"],
            check=True,
            capture_output=True,
            text=True,
        )
        if quiet.stdout or quiet.stderr:
            raise AssertionError("quiet path validation emitted transport-corrupting output")
        before = (server.read_bytes(), cli.read_bytes())
        configure.deploy(target, "all", apply=False)
        if before != (server.read_bytes(), cli.read_bytes()):
            raise AssertionError("read-only deployment verification changed bytes")
        configure.seed(target, apply=True)
        configure.deploy(target, "all", apply=True)
        after = (server.read_bytes(), cli.read_bytes())
        if before != after:
            raise AssertionError("idempotent setup/deployment changed bytes")

        server_data = configure.load_json(server)
        server_data["unrelated"] = {"preserved": True}
        server_data["agents"]["general"]["model"] = "custom/provider-model"
        configure.atomic_write(server, server_data)
        configure.deploy(target, "all", apply=True)
        if configure.load_json(server).get("unrelated") != {"preserved": True}:
            raise AssertionError("deployment did not preserve unrelated server configuration")
        if configure.load_json(server)["agents"]["general"]["model"] != "custom/provider-model":
            raise AssertionError("deployment overwrote an unrelated custom agent model")

        stale_models = configure.load_json(server)
        stale_models["agents"]["plan"]["model"] = "openai/gpt-5.6-sol#max"
        stale_models["agents"]["explore"]["model"] = "openai/gpt-5.6-luna#max"
        configure.atomic_write(server, stale_models)
        stale_bytes = server.read_bytes()
        expect_error(lambda: configure.seed(target, apply=False), "GPT-5.6")
        expect_error(lambda: configure.verify_deployment(target), "GPT-5.6")
        if server.read_bytes() != stale_bytes:
            raise AssertionError("WSL model verification changed isolated configuration")
        configure.seed(target, apply=True)
        upgraded = configure.load_json(server)
        if upgraded["agents"]["plan"]["model"] != "openai/gpt-6-sol#max":
            raise AssertionError("WSL Plan was not migrated to GPT-6 Sol")
        if upgraded["agents"]["explore"]["model"] != "openai/gpt-6-luna#max":
            raise AssertionError("WSL Explore was not migrated to GPT-6 Luna")
        if upgraded["agents"]["general"]["model"] != "custom/provider-model":
            raise AssertionError("WSL migration overwrote unrelated custom model")
        configure.verify_deployment(target)

        disabled = configure.load_json(server)
        package = configure.validate_catalog()[0]["package"]
        for entry in disabled["plugins"]:
            if configure.configured_package(entry) == package:
                entry["options"]["enabled"] = False
        configure.atomic_write(server, disabled)
        configure.deploy(target, "server", apply=True)
        matches = [
            entry for entry in configure.load_json(server)["plugins"]
            if configure.configured_package(entry) == package
        ]
        if matches != [configure.plugin_object(package)]:
            raise AssertionError("deployment did not normalize disabled plugin options")

        duplicate = root / "duplicate.jsonc"
        duplicate.write_text('{"value": 1, "value": 2}\n', encoding="utf-8")
        expect_error(lambda: configure.load_json(duplicate), "duplicate")
        malformed = root / "malformed.jsonc"
        malformed.write_text('{"value": }\n', encoding="utf-8")
        expect_error(lambda: configure.load_json(malformed), "parse")
        invalid_utf8 = root / "invalid.json"
        invalid_utf8.write_bytes(b'{"value":"\xff"}')
        expect_error(lambda: configure.load_json(invalid_utf8), "parse")
        oversized = root / "oversized.json"
        oversized.write_bytes(b" " * (configure.MAX_CONFIG_BYTES + 1))
        expect_error(lambda: configure.load_json(oversized), "exceeds")
        fifo = root / "config.fifo"
        os.mkfifo(fifo)
        expect_error(lambda: configure.load_json(fifo), "regular")

        symlink_target = root / "real"
        symlink_target.mkdir()
        symlink = root / "linked"
        symlink.symlink_to(symlink_target, target_is_directory=True)
        expect_error(lambda: configure.seed(symlink / "config", apply=True), "symlink")
        file_link = root / "linked.json"
        file_link.symlink_to(server)
        expect_error(lambda: configure.load_json(file_link), "open")
        expect_error(
            lambda: configure.ensure_safe_path(Path.home() / "repos" / "unsafe-wsl2-config"),
            "repository workspace",
        )
        expect_error(lambda: configure.pilot_root(root / "not-config"), "<pilot>/config")

        safe_bytes = (server.read_bytes(), cli.read_bytes())
        server_update = configure.load_json(server)
        cli_update = configure.load_json(cli)
        server_update["transaction"] = "server"
        cli_update["transaction"] = "cli"
        replacements = 0

        def fail_second(source: str, destination: str, parent: int) -> None:
            nonlocal replacements
            replacements += 1
            if replacements == 2:
                raise OSError("injected second replacement failure")
            configure.replace_entry(source, destination, parent)

        expect_error(
            lambda: configure.write_transaction(
                {server: server_update, cli: cli_update},
                replacer=fail_second,
            ),
            "transaction failed",
        )
        if safe_bytes != (server.read_bytes(), cli.read_bytes()):
            raise AssertionError("pair transaction did not restore the first replacement")

        denied = configure.load_json(server)
        denied["permissions"].append(
            {"action": "wsl_windows_act", "resource": "*", "effect": "deny"}
        )
        configure.atomic_write(server, denied)
        configure.deploy(target, "server", apply=True)
        action_rules = [
            rule for rule in configure.load_json(server)["permissions"]
            if rule.get("action") == "wsl_windows_act"
        ]
        if action_rules != [{"action": "wsl_windows_act", "resource": "*", "effect": "ask"}]:
            raise AssertionError("deployment did not remove competing permission rules")

        noncanonical = configure.load_json(server)
        noncanonical["plugins"].append({"package": "./plugins-v2/wsl-interop"})
        configure.atomic_write(server, noncanonical)
        noncanonical_bytes = server.read_bytes()
        expect_error(lambda: configure.deploy(target, "server", apply=True), "non-canonical")
        if server.read_bytes() != noncanonical_bytes:
            raise AssertionError("non-canonical plugin deployment wrote partial configuration")
        server.write_bytes(safe_bytes[0])

        selective = root / "selective" / "config"
        configure.seed(selective, apply=True)
        selective_server, selective_cli = configure.config_paths(selective)
        cli_seed = selective_cli.read_bytes()
        configure.deploy(selective, "server", apply=True)
        configure.verify_deployment(selective, "server")
        if selective_cli.read_bytes() != cli_seed:
            raise AssertionError("server-only deployment mutated CLI configuration")
        expect_error(lambda: configure.verify_deployment(selective, "cli"), "not registered")
        server_only = selective_server.read_bytes()
        configure.deploy(selective, "cli", apply=True)
        configure.verify_deployment(selective, "cli")
        if selective_server.read_bytes() != server_only:
            raise AssertionError("CLI-only deployment mutated server configuration")

        fake_binary = root / "fake-opencode"
        fake_binary.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            "printf 'cwd=%s\\n' \"$PWD\"\n"
            "printf 'config=%s\\n' \"$OPENCODE_CONFIG_DIR\"\n"
            "printf 'xdg=%s\\n' \"$XDG_CONFIG_HOME\"\n"
            "printf 'args=%s\\n' \"$*\"\n",
            encoding="utf-8",
        )
        fake_binary.chmod(0o700)
        pilot = root / "launcher"
        launcher = Path(__file__).resolve().parent / "opencode-wsl2.sh"
        environment = {
            **os.environ,
            "OPENCODE_V2_BIN": str(fake_binary),
            "OPENCODE_WSL2_PILOT_DIR": str(pilot),
            "OPENCODE_CLI_CONFIG_CONTENT": '{"plugins":["leak"]}',
        }
        launched = subprocess.run(
            [str(launcher), "run", "status"],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        expected_lines = {
            f"cwd={pilot / 'workspace'}",
            f"config={pilot / 'config'}",
            f"xdg={pilot / 'xdg'}",
            "args=run --standalone status",
        }
        if not expected_lines.issubset(set(launched.stdout.splitlines())):
            raise AssertionError(f"isolated launcher output was unexpected: {launched.stdout}")
        rejected = subprocess.run(
            [str(launcher), str(root)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
        if rejected.returncode == 0 or "directory arguments" not in rejected.stderr:
            raise AssertionError("isolated launcher accepted a project directory argument")
        writable_binary = root / "writable-opencode"
        writable_binary.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        writable_binary.chmod(0o722)
        writable_environment = {**environment, "OPENCODE_V2_BIN": str(writable_binary)}
        writable = subprocess.run(
            [str(launcher), "--version"],
            check=False,
            capture_output=True,
            text=True,
            env=writable_environment,
        )
        if writable.returncode == 0 or "group- or world-writable" not in writable.stderr:
            raise AssertionError("isolated launcher accepted a writable OpenCode executable")

        summary = {
            "server": str(server),
            "cli": str(cli),
            "roles": [entry["name"] for entry in configure.validate_catalog()],
            "mcps": list(configure.MCP_NAMES),
        }
        print(json.dumps(summary, indent=2))
    print("OK: isolated WSL2 setup/deployment self-test passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
