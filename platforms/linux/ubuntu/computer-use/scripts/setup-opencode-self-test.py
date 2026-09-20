#!/usr/bin/env python3
"""Deterministic, disposable coverage for the v2 setup/parser integration."""

from __future__ import annotations

import os
import json
import importlib.util
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
SETUP = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh"
DEPLOY = ROOT / "platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh"
ASSISTANT = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh"
PARSER = ROOT / "platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/scripts/install-parsers.mjs"
HELPER = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-opencode-jsonc.py"

_spec = importlib.util.spec_from_file_location("setup_jsonc", HELPER)
assert _spec and _spec.loader
_jsonc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_jsonc)


def run(command: list[str], *, env: dict[str, str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, check=False, timeout=120)
    if check and result.returncode:
        raise AssertionError(f"{command} failed:\n{result.stdout}\n{result.stderr}")
    return result


def run_mcp_migration(assistant: Path, global_path: Path, project_path: Path) -> subprocess.CompletedProcess[str]:
    text = assistant.read_text(encoding="utf-8")
    start = text.index("global_mcp_config_path() {")
    end = text.index("\nmcp_file_matches() {", start)
    functions = text[start:end]
    scripts = ROOT / "platforms/linux/ubuntu/computer-use/scripts"
    values = {
        "SCRIPT_DIR": scripts,
        "PROJECT_CONFIG_JSON": project_path,
        "OPENCODE_CONFIG_JSON": global_path.parent / "pilot.json",
        "OPENCODE_CONFIG_JSONC": global_path,
        "GITHUB_MCP_WRAPPER": scripts / "github-mcp.sh",
        "BASIC_MEMORY_WRAPPER": scripts / "basic-memory-mcp.sh",
        "LIVE_MCP_WRAPPER": scripts / "playwright-mcp.sh",
    }
    assignments = "\n".join(f"{key}={shlex.quote(str(value))}" for key, value in values.items())
    conflict = 'has_conflicting_opencode_configs() { [ -f "$OPENCODE_CONFIG_JSON" ] && [ -f "$OPENCODE_CONFIG_JSONC" ]; }'
    script = f"set -euo pipefail\n{assignments}\nfail() {{ printf '%s\\n' \"$*\" >&2; }}\n{conflict}\n{functions}\nmigrate_mcp_configs\n"
    return subprocess.run(["bash", "-c", script], cwd=ROOT, text=True, capture_output=True, check=False, timeout=60)


test_root = Path(os.environ.get("OPENCODE_SETUP_TEST_ROOT", "/tmp/opencode"))
test_root.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="opencode-setup-self-test-", dir=test_root) as temporary:
    root = Path(temporary)
    config = root / "config"
    parsers = root / "parsers"
    runtime = root / "runtime"
    bin_dir = root / "bin"
    npm_dir = root / "npm-bin"
    bin_dir.mkdir()
    npm_dir.mkdir()
    runtime.mkdir()
    fake_binary = bin_dir / "opencode"
    fake_binary.write_text("#!/bin/sh\nprintf 'opencode v2.0.7\\n'\n")
    fake_binary.chmod(0o755)

    # Use the checked-in installer directly, with already-installed pinned assets;
    # this avoids network access and does not replace the installer under test.
    npm = npm_dir / "npm"
    npm.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "prefix=.\n"
        "while [ $# -gt 0 ]; do case \"$1\" in --prefix) prefix=$2; shift 2;; run) script=$2; shift 2; break;; *) shift;; esac; done\n"
        "[ \"${1:-}\" = -- ] && shift\n"
        "case \"$script\" in parsers:install) exec node " + str(PARSER) + " \"$@\";; parsers:verify) exec node " + str(PARSER) + " --verify-only \"$@\";; *) exit 2;; esac\n"
    )
    npm.chmod(0o755)

    env = os.environ.copy()
    env.update(
        PATH=f"{npm_dir}:{env['PATH']}",
        OPENCODE_V2_BIN=str(fake_binary),
        RIG_PARSERS_DIR=str(parsers),
        XDG_RUNTIME_DIR=str(runtime),
    )

    # Seed parser assets with the pinned package, then exercise the real
    # prepare -> plugin registration -> final health-check sequence.
    run(["node", str(PARSER), "--target", str(parsers)], env=env)
    clean_apply = root / "clean-apply"
    first_apply = run([str(SETUP), "--config-dir", str(clean_apply), "--apply"], env=env)
    assert "OK: v2 deployment verified" in first_apply.stdout
    apply_bytes = {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    second_apply = run([str(SETUP), "--config-dir", str(clean_apply), "--apply"], env=env)
    assert "OK: v2 deployment verified" in second_apply.stdout
    assert apply_bytes == {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    verify_bytes = {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    run([str(SETUP), "--config-dir", str(clean_apply), "--verify-only"], env=env)
    assert verify_bytes == {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    prepared = run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    assert "health verification deferred" in prepared.stdout
    server = _jsonc.load_jsonc(str(config / "opencode.jsonc"))
    cli = _jsonc.load_jsonc(str(config / "cli.json"))
    assert set(server["mcp"]["servers"]) == {"github", "basic-memory"}
    assert cli["theme"]["name"] == "aura"
    run([str(DEPLOY), "--config-dir", str(config), "--plugins", "all", "--apply"], env=env)
    migrated_server = _jsonc.load_jsonc(str(config / "opencode.jsonc"))
    migrated_server["mcp"]["servers"].pop("playwright", None)
    (config / "opencode.jsonc").write_text(json.dumps(migrated_server, indent=2) + "\n", encoding="utf-8")
    verify_server_bytes = (config / "opencode.jsonc").read_bytes()
    verify_cli_bytes = (config / "cli.json").read_bytes()
    first = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env)
    assert "OK: v2 deployment verified" in first.stdout
    assert (config / "opencode.jsonc").read_bytes() == verify_server_bytes
    assert (config / "cli.json").read_bytes() == verify_cli_bytes
    bad_cli = _jsonc.load_jsonc(str(config / "cli.json"))
    bad_cli["session"]["permissions"] = "autoaccept"
    (config / "cli.json").write_text(json.dumps(bad_cli, indent=2) + "\n", encoding="utf-8")
    negative_permissions = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False)
    assert negative_permissions.returncode != 0
    (config / "cli.json").write_bytes(verify_cli_bytes)
    assert len(server["plugins"]) == 7
    assert len(cli["plugins"]) == 7
    assert cli["session"]["permissions"] == "prompt"
    assert len(list((config / "skills").iterdir())) == 19
    assert sorted(path.name for path in (config / "commands").glob("*.md")) == ["deploy.md", "handoff.md", "promote-skills.md", "resume.md"]
    command_source = ROOT / "platforms/linux/ubuntu/computer-use/commands"
    assert all(
        path.stat().st_mode & 0o777 == (command_source / path.name).stat().st_mode & 0o777
        for path in (config / "commands").glob("*.md")
    )

    default_pilot = root / "default-pilot"
    default_parsers = default_pilot / "cache/opencode-rig/parsers"
    default_env = dict(env, OPENCODE_V2_PILOT_DIR=str(default_pilot))
    default_env.pop("RIG_PARSERS_DIR", None)
    run([str(SETUP), "--config-dir", str(root / "default-config"), "--prepare"], env=default_env)
    assert default_parsers.is_dir()

    # Migrate the actual legacy pilot shape through the real setup-computer
    # migration function, without reading the live pilot.
    pilot = root / "pilot"
    pilot.mkdir()
    global_config = pilot / "opencode.jsonc"
    project_config = pilot / "opencode.json"
    global_config.write_text(
        '// legacy pilot JSONC\n{\n  "model": "keep/model",\n  "mcp": {\n'
        '    "timeout": {"startup": 12000},\n'
        '    "github": {"type": "local", "command": ["legacy"], "note": "http://x//y"},\n'
        '    "playwright": {"command": ["legacy-playwright"]},\n'
        '    "basic-memory": {"command": ["legacy-memory"]},\n'
        '    "servers": {"unrelated": {"type": "remote", "url": "https://keep/*"}, "playwright": {"command": ["old"]}},\n'
        '  },\n}\n',
        encoding="utf-8",
    )
    project_config.write_text(
        '{/* project JSONC */ "mcp": {"playwright": {"command": ["legacy-project"]}, '
        '"servers": {"github": {"command": ["wrong"]}, "basic-memory": {}}}, '
        '"model": "project/model",}\n',
        encoding="utf-8",
    )
    os.chmod(global_config, 0o600)
    os.chmod(project_config, 0o640)
    migrated = run_mcp_migration(ASSISTANT, global_config, project_config)
    assert migrated.returncode == 0, migrated.stderr
    migrated_global = _jsonc.load_jsonc(str(global_config))
    migrated_project = _jsonc.load_jsonc(str(project_config))
    global_mcp = migrated_global["mcp"]
    project_mcp = migrated_project["mcp"]
    assert set(global_mcp["servers"]) == {"github", "basic-memory", "unrelated"}
    assert project_mcp["servers"].keys() == {"playwright"}
    assert global_mcp["timeout"] == {"startup": 12000}
    assert migrated_global["model"] == "keep/model"
    assert migrated_project["model"] == "project/model"
    assert all(name not in global_mcp for name in ("github", "playwright", "basic-memory"))
    assert all(name not in project_mcp for name in ("github", "playwright", "basic-memory"))
    assert global_mcp["servers"]["github"]["timeout"]["startup"] == 30000
    assert migrated_project["mcp"]["servers"]["playwright"]["disabled"] is False
    assert (global_config.stat().st_mode & 0o777) == 0o600
    assert (project_config.stat().st_mode & 0o777) == 0o640
    first_global = global_config.read_bytes()
    first_project = project_config.read_bytes()
    assert run_mcp_migration(ASSISTANT, global_config, project_config).returncode == 0
    assert global_config.read_bytes() == first_global
    assert project_config.read_bytes() == first_project
    assert not list(pilot.glob(".mcp.*"))

    malformed_global = pilot / "malformed.jsonc"
    malformed_project = pilot / "malformed-project.json"
    malformed_global.write_text('{"mcp": {"github": 1, "github": 2}}\n', encoding="utf-8")
    malformed_project.write_bytes(first_project)
    before_malformed = malformed_project.read_bytes()
    assert run_mcp_migration(ASSISTANT, malformed_global, malformed_project).returncode != 0
    assert malformed_project.read_bytes() == before_malformed
    outside = root / "migration-outside"
    outside.mkdir()
    sentinel = outside / "sentinel"
    sentinel.write_text("untouched", encoding="utf-8")
    symlink_global = pilot / "symlink.jsonc"
    symlink_global.symlink_to(sentinel)
    assert run_mcp_migration(ASSISTANT, symlink_global, project_config).returncode != 0
    assert sentinel.read_text(encoding="utf-8") == "untouched"
    symlink_global.unlink()

    path_outside = root / "path-outside"
    path_outside.mkdir()
    path_sentinel = path_outside / "sentinel"
    path_sentinel.write_text("untouched", encoding="utf-8")
    root_link = root / "root-link"
    root_link.symlink_to(path_outside, target_is_directory=True)
    for command in (SETUP, DEPLOY):
        result = run([str(command), "--config-dir", str(root_link), "--plugins", "all", "--apply"] if command == DEPLOY else [str(command), "--config-dir", str(root_link), "--prepare"], env=env, check=False)
        assert result.returncode != 0
    assert path_sentinel.read_text(encoding="utf-8") == "untouched"
    root_link.unlink()
    ancestor = root / "ancestor"
    ancestor_target = root / "ancestor-target"
    ancestor_target.mkdir()
    ancestor.symlink_to(ancestor_target, target_is_directory=True)
    ancestor_result = run([str(SETUP), "--config-dir", str(ancestor / "config"), "--prepare"], env=env, check=False)
    assert ancestor_result.returncode != 0
    ancestor.unlink()
    for filename in ("opencode.jsonc", "cli.json"):
        symlink_root = root / f"symlink-{filename}"
        symlink_root.mkdir()
        target = path_outside / f"{filename}.target"
        target.write_text("outside", encoding="utf-8")
        (symlink_root / filename).symlink_to(target)
        result = run([str(SETUP), "--config-dir", str(symlink_root), "--prepare"], env=env, check=False)
        assert result.returncode != 0 and target.read_text(encoding="utf-8") == "outside"
        assert run([str(DEPLOY), "--config-dir", str(symlink_root), "--plugins", "all", "--apply"], env=env, check=False).returncode != 0

    conflict_root = root / "conflict-root"
    conflict_root.mkdir()
    (conflict_root / "opencode.json").write_text("{}\n", encoding="utf-8")
    (conflict_root / "opencode.jsonc").write_text("{}\n", encoding="utf-8")
    for mode in ("--verify-only", "--apply"):
        conflict = run([str(ASSISTANT), mode], env=dict(env, OPENCODE_V2_CONFIG_DIR=str(conflict_root)), check=False)
        assert conflict.returncode != 0 and "both" in conflict.stderr

    # Upgrade a stale but otherwise valid target. Preparation must not replace
    # either config; deployment fills missing roles and normalizes only the
    # fields it owns.
    stale = root / "stale"
    stale.mkdir()
    stale_server = dict(server)
    stale_server["agents"]["general"]["model"] = "custom/provider-model"
    stale_server["plugins"] = [entry for entry in stale_server["plugins"] if "codex-fallback" not in entry["package"]]
    stale_server["plugins"].append({"package": str(ROOT / "platforms/linux/ubuntu/computer-use/plugins-v2/codex-fallback"), "options": {"defaultChain": ["custom/model"]}})
    stale_cli = dict(cli)
    stale_cli["customSetting"] = {"keep": True}
    stale_cli["session"] = dict(stale_cli["session"])
    stale_cli["session"]["permissions"] = "deny"
    stale_cli["plugins"] = [entry for entry in stale_cli["plugins"] if "resource-monitor" not in entry["package"]]
    (stale / "opencode.jsonc").write_text("// stale config\n" + json.dumps(stale_server) + "\n", encoding="utf-8")
    (stale / "cli.json").write_text("/* stale config */\n" + json.dumps(stale_cli) + "\n", encoding="utf-8")
    os.chmod(stale / "opencode.jsonc", 0o600)
    os.chmod(stale / "cli.json", 0o640)
    run([str(SETUP), "--config-dir", str(stale), "--prepare"], env=env)
    run([str(DEPLOY), "--config-dir", str(stale), "--plugins", "all", "--apply"], env=env)
    assert run_mcp_migration(ASSISTANT, stale / "opencode.jsonc", stale / "opencode.json").returncode == 0
    stale_health = run([str(SETUP), "--config-dir", str(stale), "--verify-only"], env=env)
    assert "OK: v2 deployment verified" in stale_health.stdout
    upgraded_server = _jsonc.load_jsonc(str(stale / "opencode.jsonc"))
    upgraded_cli = _jsonc.load_jsonc(str(stale / "cli.json"))
    assert upgraded_server["agents"]["general"]["model"] == "custom/provider-model"
    assert any(entry["options"].get("defaultChain") == ["custom/model"] for entry in upgraded_server["plugins"])
    assert upgraded_cli["customSetting"] == {"keep": True}
    assert upgraded_cli["session"]["permissions"] == "prompt"
    assert (stale / "opencode.jsonc").stat().st_mode & 0o777 == 0o600
    assert (stale / "cli.json").stat().st_mode & 0o777 == 0o640

    canonical = ROOT / "platforms/linux/ubuntu/computer-use/skills/app-setup"
    shutil.rmtree(config / "skills/app-setup")
    (config / "skills/app-setup").symlink_to(canonical, target_is_directory=True)
    run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    assert not (config / "skills/app-setup").is_symlink()

    outside = root / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel"
    sentinel.write_text("untouched")
    hostile_config = root / "hostile-config"
    run([str(SETUP), "--config-dir", str(hostile_config), "--prepare"], env=env)
    (hostile_config / "skills/blender/hostile").symlink_to(outside, target_is_directory=True)
    hostile = run([str(SETUP), "--config-dir", str(hostile_config), "--prepare"], env=env, check=False)
    assert hostile.returncode != 0
    assert "OK: v2 deployment prepared" not in hostile.stdout
    assert "FAIL: v2 deployment preparation incomplete" in hostile.stderr
    assert sentinel.read_text() == "untouched"
    assert not (hostile_config / "next-phase.marker").exists()
    (hostile_config / "skills/blender/hostile").unlink()

    extra_file = config / "skills/app-setup/extra.txt"
    extra_dir = config / "skills/app-setup/extra-dir"
    extra_file.write_text("preserve")
    extra_dir.mkdir()
    extra = run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env, check=False)
    assert extra.returncode != 0
    assert "OK: v2 deployment prepared" not in extra.stdout
    assert "FAIL: v2 deployment preparation incomplete" in extra.stderr
    assert extra_file.read_text() == "preserve" and extra_dir.is_dir()
    extra_file.unlink()
    extra_dir.rmdir()

    parser_fail_bin = root / "parser-fail-bin"
    parser_fail_bin.mkdir()
    failing_npm = parser_fail_bin / "npm"
    failing_npm.write_text("#!/bin/sh\nexit 73\n", encoding="utf-8")
    failing_npm.chmod(0o755)
    parser_failure_env = dict(env)
    parser_failure_env["PATH"] = f"{parser_fail_bin}:{env['PATH']}"
    parser_failure_config = root / "parser-failure-config"
    parser_failure = run(
        [str(SETUP), "--config-dir", str(parser_failure_config), "--prepare"],
        env=parser_failure_env,
        check=False,
    )
    assert parser_failure.returncode != 0
    assert "OK: v2 deployment prepared" not in parser_failure.stdout
    assert not (parser_failure_config / "plugins.marker").exists()
    assert not list(root.rglob(".seed.*"))

    # The real assistant sequencing function must stop at prepare failure and
    # never invoke the plugin/next phase.
    sequence = root / "sequence"
    sequence.mkdir()
    sequence_log = sequence / "next-phase.marker"
    (sequence / "setup-opencode.sh").write_text(
        "#!/bin/sh\nexit 19\n", encoding="utf-8"
    )
    (sequence / "deploy-plugins.sh").write_text(
        f"#!/bin/sh\ntouch {sequence_log}\n", encoding="utf-8"
    )
    for path in (sequence / "setup-opencode.sh", sequence / "deploy-plugins.sh"):
        path.chmod(0o755)
    assistant_text = ASSISTANT.read_text(encoding="utf-8")
    start = assistant_text.index("initialize_local_state() {")
    end = assistant_text.index("\n}\n", start) + 3
    function_file = sequence / "initialize.sh"
    function_file.write_text(assistant_text[start:end], encoding="utf-8")
    sequence_env = dict(env, SCRIPT_DIR=str(sequence), V2_CONFIG_DIR=str(sequence / "config"))
    sequence_result = subprocess.run(
        ["bash", "-e", "-c", f"source {function_file}; initialize_local_state"],
        cwd=ROOT,
        env=sequence_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert sequence_result.returncode != 0 and not sequence_log.exists()

    server_config = config / "opencode.jsonc"
    server_bytes = server_config.read_bytes()
    server_config.write_text('{"duplicate": 1, "duplicate": 2}\n')
    malformed = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False)
    assert malformed.returncode != 0
    server_config.write_bytes(server_bytes)

    valid = root / "valid.jsonc"
    valid.write_text('{/* comment */ "text": "//not a comment", "items": [1,],}\n')
    run(["python3", str(HELPER), str(valid)], env=env)
    for content in ['{"duplicate": 1, "duplicate": 2}', '{"broken": [}']:
        invalid = root / "invalid.jsonc"
        invalid.write_text(content)
        assert run(["python3", str(HELPER), str(invalid)], env=env, check=False).returncode != 0

    parser_link = root / "parser-link"
    parser_link.symlink_to(outside, target_is_directory=True)
    parser_result = run(["node", str(PARSER), "--target", str(parser_link)], env=env, check=False)
    assert parser_result.returncode != 0 and sentinel.read_text() == "untouched"
    before = (config / "cli.json").read_bytes()
    verify = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False)
    assert verify.returncode == 0
    assert (config / "cli.json").read_bytes() == before
    extra_file.unlink(missing_ok=True)
    extra_dir.rmdir() if extra_dir.exists() else None
    run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    run([str(DEPLOY), "--config-dir", str(config), "--plugins", "all", "--apply"], env=env)
    second = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env)
    assert "OK: v2 deployment verified" in second.stdout
    assert not list(root.rglob(".seed.*")) and not list(root.rglob("*.tmp-*"))

    prep_blocker = root / "prep-blocker"
    prep_blocker.write_text("not a directory")
    assert run([str(SETUP), "--config-dir", str(prep_blocker), "--prepare"], env=env, check=False).returncode != 0
    deploy_failure = root / "deploy-failure"
    deploy_failure.mkdir()
    (deploy_failure / "opencode.jsonc").write_text('{"plugins": [}', encoding="utf-8")
    assert run([str(DEPLOY), "--config-dir", str(deploy_failure), "--plugins", "all", "--apply"], env=env, check=False).returncode != 0
    missing_command = config / "commands/deploy.md"
    command_backup = missing_command.read_bytes()
    missing_command.unlink()
    assert run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False).returncode != 0
    missing_command.write_bytes(command_backup)
