#!/usr/bin/env python3
"""Disposable integration tests for WSL2 delegation and deployment."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Callable


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parent / "configure.py"
DEPLOY_SCRIPT = Path(__file__).resolve().parent / "deploy-plugins.sh"
SETUP_SCRIPT = Path(__file__).resolve().parent / "setup-opencode.sh"
SETUP_MCPS_SCRIPT = Path(__file__).resolve().parent / "setup-mcps.sh"
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
    if sorted(servers) != ["basic-memory", "github", "playwright"]:
        raise AssertionError(f"unexpected MCP set: {sorted(servers)}")
    expected = configure.mcp_servers(target)
    if servers != expected:
        raise AssertionError("WSL MCP declarations do not match canonical Ubuntu ownership")
    if servers["github"].get("url") != "https://api.githubcopilot.com/mcp/":
        raise AssertionError("GitHub MCP does not use the credential-free remote endpoint")
    if cli != target.parent / "xdg" / "opencode" / "cli.json":
        raise AssertionError(f"CLI config is not under the isolated XDG root: {cli}")


def main() -> int:
    """Run disposable setup, deployment, rollback, and launcher tests."""
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
        if not any(path.name == "wsl-interop" for path in shared_server_packages & shared_cli_packages):
            raise AssertionError("shared deployment omitted the WSL-only interop package")
        generic_packages = (shared_server_packages | shared_cli_packages) - {
            path for path in shared_server_packages | shared_cli_packages
            if path.name == "wsl-interop"
        }
        canonical_root = configure.PLATFORM_ROOT.parents[3] / "linux" / "ubuntu" / "computer-use" / "plugins-v2"
        if any(canonical_root not in path.parents for path in generic_packages):
            raise AssertionError("generic WSL profile packages are not owned by canonical Ubuntu")
        if (shared_target / "cli.json").exists():
            raise AssertionError("shared WSL deployment wrote a duplicate CLI config")
        setup_source = SETUP_SCRIPT.read_text(encoding="utf-8")
        if '"$SCRIPT_DIR/deploy-plugins.sh"' not in setup_source:
            raise AssertionError("WSL setup does not delegate plugin deployment to the shared wrapper")
        versions = configure.MCP.load_policy()
        wrappers = {
            "basicMemory": configure.CANONICAL_ROOT / "scripts" / "basic-memory-mcp.sh",
            "playwright": configure.CANONICAL_ROOT / "scripts" / "playwright-mcp.sh",
        }
        if (Path(__file__).resolve().parent / "basic-memory-mcp.sh").exists():
            raise AssertionError("WSL keeps a duplicate Basic Memory wrapper")
        if (Path(__file__).resolve().parent / "playwright-mcp.sh").exists():
            raise AssertionError("WSL keeps a duplicate Playwright wrapper")
        if (configure.CONFIG_ROOT / "mcp-versions.json").exists():
            raise AssertionError("WSL keeps a duplicate MCP version policy")
        for key, wrapper in wrappers.items():
            source = wrapper.read_text(encoding="utf-8")
            if str(versions["basicMemory" if key == "basicMemory" else "playwright"]) not in source:
                if "mcp_runtime.py" not in source:
                    raise AssertionError(f"{wrapper.name} does not use the canonical policy")
            if "/usr/bin/env -i" not in source or "mcp_runtime.py" not in source:
                raise AssertionError(f"{wrapper.name} is not environment-isolated through canonical runtime")
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
        playwright_package = target.parent / "cache" / "npm" / "_npx" / "run" / "node_modules" / "@playwright" / "mcp" / "package.json"
        playwright_package.parent.mkdir(parents=True)
        playwright_package.write_text(json.dumps({"version": versions["playwright"]}) + "\n", encoding="utf-8")
        revision = versions["playwrightBrowserRevision"]
        browser = target.parent / "cache" / "ms-playwright" / f"chromium-{revision}" / "chrome-linux64" / "chrome"
        browser.parent.mkdir(parents=True)
        browser.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8")
        browser.chmod(0o700)
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
        playwright_package.write_text('{"version":"stale"}\n', encoding="utf-8")
        expect_error(lambda: configure.mcp_provisioning(target, apply=False), "Playwright MCP's canonical pinned")
        playwright_package.write_text(json.dumps({"version": versions["playwright"]}) + "\n", encoding="utf-8")
        marker = target.parent / "mcp" / "provisioned.json"
        marker_data = configure.load_json(marker)
        marker_data["playwright"] = "stale"
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
        configure.atomic_write(server, server_data)
        configure.deploy(target, "all", apply=True)
        if configure.load_json(server).get("unrelated") != {"preserved": True}:
            raise AssertionError("deployment did not preserve unrelated server configuration")

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
