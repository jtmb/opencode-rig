#!/usr/bin/env python3
"""Deterministic, disposable coverage for the v2 setup/parser integration."""

from __future__ import annotations

import os
import json
import importlib.util
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
SETUP = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh"
DEPLOY = ROOT / "platforms/linux/ubuntu/computer-use/scripts/deploy-plugins.sh"
ASSISTANT = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-computer-assistant.sh"
MCP_RUNTIME = ROOT / "platforms/linux/ubuntu/computer-use/scripts/mcp_runtime.py"
PARSER = ROOT / "platforms/linux/ubuntu/computer-use/plugins-v2/file-manager/scripts/install-parsers.mjs"
HELPER = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-opencode-jsonc.py"
ROLE_CATALOG = ROOT / "platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json"
SERVER_PLUGIN_NAMES = {
    "orchestration-policy",
    "ponytail-adapter",
    "git-tool",
    "repo-learning",
    "rig-tools",
    "rig-todo",
    "codex-fallback",
    "codex-usage",
    "chatgpt-connector",
}
CLI_PLUGIN_NAMES = {
    "repo-learning",
    "rig-tools",
    "rig-todo",
    "source-control",
    "codex-usage",
    "file-manager",
    "resource-monitor",
}

_spec = importlib.util.spec_from_file_location("setup_jsonc", HELPER)
assert _spec and _spec.loader
_jsonc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_jsonc)


def run(command: list[str], *, env: dict[str, str], check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, check=False, timeout=120)
    if check and result.returncode:
        raise AssertionError(f"{command} failed:\n{result.stdout}\n{result.stderr}")
    return result


def run_mcp_config(path: Path, *, scope: str, apply: bool = False) -> subprocess.CompletedProcess[str]:
    """Run canonical MCP configuration verification or normalization."""
    command = [sys.executable, str(MCP_RUNTIME), "config", "--scope", scope, "--config", str(path)]
    if apply:
        command.append("--apply")
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False, timeout=60)


test_root = Path(os.environ.get("OPENCODE_SETUP_TEST_ROOT", "/tmp/opencode"))
test_root.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="opencode-setup-self-test-", dir=test_root) as temporary:
    root = Path(temporary)
    basic_notes = root / "basic-memory-notes"
    basic_notes.mkdir()
    basic_config = root / "basic-memory-config.json"
    basic_config.write_text(
        json.dumps(
            {
                "projects": {
                    "computer-assistant": {
                        "path": str(basic_notes),
                        "mode": "local",
                    }
                },
                "default_project": "computer-assistant",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    basic_project_command = [
        sys.executable,
        str(MCP_RUNTIME),
        "basic-project",
        "--config",
        str(basic_config),
        "--notes",
        str(basic_notes),
        "--project",
        "computer-assistant",
    ]
    assert subprocess.run(basic_project_command, cwd=ROOT, check=False).returncode == 0
    wrong_default = json.loads(basic_config.read_text(encoding="utf-8"))
    wrong_default["default_project"] = "main"
    basic_config.write_text(json.dumps(wrong_default) + "\n", encoding="utf-8")
    assert subprocess.run(basic_project_command, cwd=ROOT, check=False).returncode != 0
    assert subprocess.run(
        [*basic_project_command, "--allow-non-default"],
        cwd=ROOT,
        check=False,
    ).returncode == 0
    wrong_default["default_project"] = "computer-assistant"
    wrong_default["projects"]["computer-assistant"]["path"] = str(root / "other-notes")
    (root / "other-notes").mkdir()
    basic_config.write_text(json.dumps(wrong_default) + "\n", encoding="utf-8")
    assert subprocess.run(basic_project_command, cwd=ROOT, check=False).returncode != 0

    config = root / "config"
    parsers = root / "parsers"
    runtime = root / "runtime"
    bin_dir = root / "bin"
    npm_dir = root / "npm-bin"
    bin_dir.mkdir()
    npm_dir.mkdir()
    runtime.mkdir()
    runtime.chmod(0o700)
    fake_binary = bin_dir / "opencode"
    fake_binary.write_text("#!/bin/sh\nprintf 'opencode v2.0.7\\n'\n")
    fake_binary.chmod(0o755)

    # Keep this setup fixture on the same bounded-runner branch as a normal
    # user session; Node 22's built-in Wasm modules cannot start under the
    # fallback's virtual-address ceiling.
    fake_systemctl = bin_dir / "systemctl"
    fake_systemctl.write_text(
        "#!/bin/sh\n"
        "[ \"$1\" = --user ] && [ \"$2\" = show-environment ]\n",
        encoding="utf-8",
    )
    fake_systemctl.chmod(0o755)
    fake_systemd_run = bin_dir / "systemd-run"
    fake_systemd_run.write_text(
        "#!/bin/sh\n"
        "while [ $# -gt 0 ] && [ \"$1\" != -- ]; do shift; done\n"
        "[ $# -gt 0 ] || exit 125\n"
        "shift\n"
        "exec \"$@\"\n",
        encoding="utf-8",
    )
    fake_systemd_run.chmod(0o755)

    # Use the checked-in installer directly, with already-installed pinned assets;
    # this avoids network access and does not replace the installer under test.
    npm = npm_dir / "npm"
    npm.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "script=\n"
        "prefix=.\n"
        "while [ $# -gt 0 ]; do case \"$1\" in --prefix) prefix=$2; shift 2;; ci) exit 0;; run) script=$2; shift 2; break;; *) shift;; esac; done\n"
        "[ \"${1:-}\" = -- ] && shift\n"
        "case \"$script\" in parsers:install) exec node " + str(PARSER) + " \"$@\";; parsers:verify) exec node " + str(PARSER) + " --verify-only \"$@\";; *) exit 2;; esac\n"
    )
    npm.chmod(0o755)

    env = os.environ.copy()
    env.update(
        PATH=f"{npm_dir}:{bin_dir}:{env['PATH']}",
        OPENCODE_V2_BIN=str(fake_binary),
        OPENCODE_V2_ACTIVE_CLI_CONFIG=str(root / "active-native/opencode/cli.json"),
        OPENCODE_V2_REPO=str(ROOT),
        OPENCODE_V2_ROLE_CATALOG=str(ROLE_CATALOG),
        RIG_PARSERS_DIR=str(parsers),
        XDG_RUNTIME_DIR=str(runtime),
    )

    project = _jsonc.load_jsonc(str(ROOT / "opencode.json"))
    _jsonc.verify_agent_models(project, source=True)
    invalid_variant = json.loads(json.dumps(project))
    invalid_variant["agents"]["plan"]["model"] = "openai/gpt-6-sol#unsupported"
    try:
        _jsonc.verify_agent_models(invalid_variant)
    except ValueError as error:
        assert "unsupported model variant" in str(error)
    else:
        raise AssertionError("agent-model verification accepted an unsupported variant")
    assert project["agents"]["architect"]["mode"] == "subagent"
    architect_permissions = {rule["action"]: rule for rule in project["agents"]["architect"]["permissions"]}
    assert architect_permissions["edit"] == {"action": "edit", "resource": "*", "effect": "deny"}
    assert architect_permissions["shell"] == {"action": "shell", "resource": "*", "effect": "deny"}
    assert project["mcp"]["servers"]["chatgpt"]["command"] == [
        "./platforms/linux/ubuntu/computer-use/scripts/chatgpt-mcp.sh"
    ]
    assert set(project["mcp"]["servers"]) == {"basic-memory", "github", "chatgpt"}
    assert "default_agent" not in project
    assert project["mcp"]["servers"]["github"]["command"] == [
        "./platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh"
    ]
    portable_ponytail = "./platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter"
    project_plugins = [entry for entry in project["plugins"] if entry.get("package") == portable_ponytail]
    assert project_plugins == [{"package": portable_ponytail, "options": {}}]

    # Seed parser assets with the pinned package, then exercise the real
    # prepare -> plugin registration -> final health-check sequence.
    run(["node", str(PARSER), "--target", str(parsers)], env=env)
    clean_apply = root / "clean-apply"
    clean_prepared = run([str(SETUP), "--config-dir", str(clean_apply), "--prepare"], env=env)
    assert "health verification deferred" in clean_prepared.stdout
    run([str(DEPLOY), "--config-dir", str(clean_apply), "--plugins", "all", "--apply"], env=env)
    first_apply = run([str(SETUP), "--config-dir", str(clean_apply), "--apply"], env=env)
    assert "OK: v2 deployment verified" in first_apply.stdout
    agent_source = ROOT / "platforms/linux/ubuntu/computer-use/agents/chatgpt-private.md"
    clean_agent = clean_apply / "agents/chatgpt-private.md"
    assert clean_agent.is_file() and not clean_agent.is_symlink()
    assert clean_agent.read_bytes() == agent_source.read_bytes()
    apply_bytes = {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    second_apply = run([str(SETUP), "--config-dir", str(clean_apply), "--apply"], env=env)
    assert "OK: v2 deployment verified" in second_apply.stdout
    assert apply_bytes == {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    assert clean_agent.read_bytes() == agent_source.read_bytes()
    verify_bytes = {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    run([str(SETUP), "--config-dir", str(clean_apply), "--verify-only"], env=env)
    assert verify_bytes == {path.name: path.read_bytes() for path in clean_apply.iterdir() if path.is_file()}
    prepared = run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    assert "health verification deferred" in prepared.stdout
    server = _jsonc.load_jsonc(str(config / "opencode.jsonc"))
    cli = _jsonc.load_jsonc(str(config / "cli.json"))
    _jsonc.verify_agent_models(server)
    assert {name: server["agents"][name]["model"] for name in _jsonc.AGENT_MODELS} == _jsonc.AGENT_MODELS
    assert server["agents"]["architect"]["mode"] == "subagent"
    assert {rule["action"]: rule for rule in server["agents"]["architect"]["permissions"]}["shell"] == {"action": "shell", "resource": "*", "effect": "deny"}
    assert set(server["mcp"]["servers"]) == {"github", "basic-memory", "chatgpt"}
    assert server.get("default_agent") is None
    agent_copy = config / "agents/chatgpt-private.md"
    agent_source_bytes = agent_source.read_bytes()
    assert agent_copy.is_file() and not agent_copy.is_symlink()
    assert agent_copy.read_bytes() == agent_source_bytes
    unrelated_agent = config / "agents/custom-agent.md"
    unrelated_agent.write_text("preserve this unmanaged agent\n", encoding="utf-8")
    run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    assert unrelated_agent.read_text(encoding="utf-8") == "preserve this unmanaged agent\n"
    agent_copy.write_text("stale agent content\n", encoding="utf-8")
    stale_agent_bytes = agent_copy.read_bytes()
    stale_agent_verify = run(
        [str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False
    )
    assert stale_agent_verify.returncode != 0
    assert agent_copy.read_bytes() == stale_agent_bytes
    run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    assert agent_copy.read_bytes() == agent_source_bytes

    agent_sentinel = root / "agent-target"
    agent_sentinel.write_text("outside agent target\n", encoding="utf-8")
    agent_copy.unlink()
    agent_copy.symlink_to(agent_sentinel)
    for mode in ("--verify-only", "--prepare"):
        symlink_agent = run(
            [str(SETUP), "--config-dir", str(config), mode], env=env, check=False
        )
        assert symlink_agent.returncode != 0
        assert agent_copy.is_symlink()
        assert agent_sentinel.read_text(encoding="utf-8") == "outside agent target\n"
    agent_copy.unlink()
    run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    assert agent_copy.read_bytes() == agent_source_bytes

    symlink_agents = root / "symlink-agents-config"
    run([str(SETUP), "--config-dir", str(symlink_agents), "--prepare"], env=env)
    symlink_agent_dir = symlink_agents / "agents"
    (symlink_agent_dir / "chatgpt-private.md").unlink()
    symlink_agent_dir.rmdir()
    outside_agents = root / "outside-agents"
    outside_agents.mkdir()
    agent_dir_sentinel = outside_agents / "sentinel"
    agent_dir_sentinel.write_text("untouched\n", encoding="utf-8")
    symlink_agent_dir.symlink_to(outside_agents, target_is_directory=True)
    for mode in ("--verify-only", "--prepare"):
        symlink_ancestor = run(
            [str(SETUP), "--config-dir", str(symlink_agents), mode], env=env, check=False
        )
        assert symlink_ancestor.returncode != 0
        assert symlink_agent_dir.is_symlink()
        assert agent_dir_sentinel.read_text(encoding="utf-8") == "untouched\n"

    assert cli["theme"]["name"] == "aura"
    run([str(DEPLOY), "--config-dir", str(config), "--plugins", "all", "--apply"], env=env)
    run([str(DEPLOY), "--config-dir", str(config), "--retire-integrated-browser", "--apply"], env=env)
    migrated_server = _jsonc.load_jsonc(str(config / "opencode.jsonc"))
    cli = _jsonc.load_jsonc(str(config / "cli.json"))
    (config / "opencode.jsonc").write_text(json.dumps(migrated_server, indent=2) + "\n", encoding="utf-8")
    server = migrated_server
    verify_server_bytes = (config / "opencode.jsonc").read_bytes()
    verify_cli_bytes = (config / "cli.json").read_bytes()
    first = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env)
    assert "OK: v2 deployment verified" in first.stdout
    assert (config / "opencode.jsonc").read_bytes() == verify_server_bytes
    assert (config / "cli.json").read_bytes() == verify_cli_bytes
    old_models = _jsonc.load_jsonc(str(config / "opencode.jsonc"))
    old_models["agents"]["plan"]["model"] = "openai/gpt-5.6-sol#xhigh"
    old_models["agents"]["general"]["model"] = "openai/gpt-5.6-luna#max"
    old_models["agents"]["explore"]["model"] = {"providerID": "openai", "model": "gpt-6-sol", "variant": "xhigh"}
    old_models["agents"]["reviewer"] = {"model": "custom/provider-model"}
    (config / "opencode.jsonc").write_text(json.dumps(old_models) + "\n", encoding="utf-8")
    legacy_bytes = (config / "opencode.jsonc").read_bytes()
    legacy_check = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False)
    assert legacy_check.returncode != 0 and "agent role models" in legacy_check.stderr
    assert (config / "opencode.jsonc").read_bytes() == legacy_bytes
    run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env)
    upgraded_models = _jsonc.load_jsonc(str(config / "opencode.jsonc"))["agents"]
    assert upgraded_models["plan"]["model"] == "openai/gpt-6-sol#xhigh"
    assert upgraded_models["general"]["model"] == "openai/gpt-6-luna#max"
    assert upgraded_models["explore"]["model"] == {"providerID": "openai", "model": "gpt-6-luna", "variant": "max"}
    assert upgraded_models["reviewer"]["model"] == "custom/provider-model"
    run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env)
    unknown_old = _jsonc.load_jsonc(str(config / "opencode.jsonc"))
    unknown_old["agents"]["reviewer"]["model"] = "openai/gpt-5.6-sol#max"
    (config / "opencode.jsonc").write_text(json.dumps(unknown_old) + "\n", encoding="utf-8")
    unknown_bytes = (config / "opencode.jsonc").read_bytes()
    unknown_check = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False)
    assert unknown_check.returncode != 0 and "agent role models" in unknown_check.stderr
    unknown_apply = run([str(SETUP), "--config-dir", str(config), "--prepare"], env=env, check=False)
    assert unknown_apply.returncode != 0 and (config / "opencode.jsonc").read_bytes() == unknown_bytes
    unknown_old["agents"]["reviewer"]["model"] = "custom/provider-model"
    (config / "opencode.jsonc").write_text(json.dumps(unknown_old) + "\n", encoding="utf-8")
    bad_cli = _jsonc.load_jsonc(str(config / "cli.json"))
    bad_cli["session"]["permissions"] = "autoaccept"
    (config / "cli.json").write_text(json.dumps(bad_cli, indent=2) + "\n", encoding="utf-8")
    negative_permissions = run([str(SETUP), "--config-dir", str(config), "--verify-only"], env=env, check=False)
    assert negative_permissions.returncode != 0
    (config / "cli.json").write_bytes(verify_cli_bytes)
    assert len(server["plugins"]) == 9
    assert {Path(entry["package"]).name for entry in server["plugins"]} == SERVER_PLUGIN_NAMES
    assert any(
        entry["package"] == str((ROOT / "platforms/linux/ubuntu/computer-use/plugins-v2/codex-usage").resolve())
        for entry in server["plugins"]
    )
    assert len(cli["plugins"]) == 7
    assert {Path(entry["package"]).name for entry in cli["plugins"]} == CLI_PLUGIN_NAMES
    assert cli["session"]["permissions"] == "prompt"
    assert cli["attention"]["sound"] is False
    assert len(list((config / "skills").iterdir())) == 19
    assert sorted(path.name for path in (config / "commands").glob("*.md")) == ["deploy.md", "handoff.md", "promote-skills.md", "resume.md"]

    active_cli = root / "active-native/opencode/cli.json"
    active_cli.parent.mkdir(parents=True)
    active_cli.write_text(
        json.dumps(
            {
                "$schema": "https://opencode.ai/v2/cli.json",
                "attention": {"notifications": True, "sound": True},
                "session": {"permissions": "autoaccept"},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    active_verify = run(
        [str(DEPLOY), "--config-dir", str(config), "--cli-config", str(active_cli), "--plugins", "cli", "--verify-only"],
        env=env,
        check=False,
    )
    assert active_verify.returncode != 0
    assert "attention.sound=false" in active_verify.stderr
    run(
        [str(DEPLOY), "--config-dir", str(config), "--cli-config", str(active_cli), "--plugins", "cli", "--apply"],
        env=env,
    )
    normalized_active_cli = _jsonc.load_jsonc(str(active_cli))
    assert normalized_active_cli["attention"] == {"notifications": True, "sound": False}
    assert normalized_active_cli["session"]["permissions"] == "prompt"
    assert _jsonc.load_jsonc(str(config / "cli.json"))["attention"]["sound"] is False
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

    # Normalize only global Basic Memory/GitHub/ChatGPT declarations. The portable
    # project config is verification-only and must remain byte-identical.
    pilot = root / "pilot"
    pilot.mkdir()
    global_config = pilot / "opencode.jsonc"
    project_config = pilot / "opencode.json"
    global_config.write_text(
        '// legacy pilot JSONC\n{\n  "model": "keep/model",\n  "mcp": {\n'
        '    "timeout": {"startup": 12000},\n'
        '    "github": {"type": "local", "command": ["legacy"], "note": "http://x//y"},\n'
        '    "chatgpt": {"command": ["legacy-chatgpt"]},\n'
        '    "playwright": {"command": ["legacy-playwright"]},\n'
        '    "basic-memory": {"command": ["legacy-memory"]},\n'
        '    "servers": {"unrelated": {"type": "remote", "url": "https://keep/*"}, "playwright": {"command": ["old"]}, "chatgpt": {"command": ["old-chatgpt"]}},\n'
        '  },\n}\n',
        encoding="utf-8",
    )
    project_config.write_bytes((ROOT / "opencode.json").read_bytes())
    os.chmod(global_config, 0o600)
    os.chmod(project_config, 0o640)
    project_before = project_config.read_bytes()
    migrated = run_mcp_config(global_config, scope="global", apply=True)
    assert migrated.returncode == 0, migrated.stderr
    migrated_global = _jsonc.load_jsonc(str(global_config))
    global_mcp = migrated_global["mcp"]
    assert set(global_mcp["servers"]) == {"github", "basic-memory", "chatgpt", "unrelated"}
    assert global_mcp["timeout"] == {"startup": 12000}
    assert migrated_global["model"] == "keep/model"
    assert all(name not in global_mcp for name in ("github", "playwright", "basic-memory", "chatgpt"))
    assert global_mcp["servers"]["github"]["timeout"]["startup"] == 30000
    assert global_mcp["servers"]["github"]["type"] == "local"
    assert Path(global_mcp["servers"]["github"]["command"][0]).resolve() == (
        ROOT / "platforms/linux/ubuntu/computer-use/scripts/github-mcp.sh"
    ).resolve()
    assert Path(global_mcp["servers"]["chatgpt"]["command"][0]).resolve() == (
        ROOT / "platforms/linux/ubuntu/computer-use/scripts/chatgpt-mcp.sh"
    ).resolve()
    assert all(
        key not in global_mcp["servers"]["github"]
        for key in ("authorization", "headers", "environment", "client_secret", "clientSecret", "token", "url")
    )
    assert all(
        key not in global_mcp["servers"]["chatgpt"]
        for key in ("authorization", "headers", "environment", "client_secret", "clientSecret", "token", "url")
    )
    assert (global_config.stat().st_mode & 0o777) == 0o600
    assert (project_config.stat().st_mode & 0o777) == 0o640
    first_global = global_config.read_bytes()
    assert run_mcp_config(global_config, scope="global", apply=True).returncode == 0
    assert global_config.read_bytes() == first_global
    assert run_mcp_config(project_config, scope="project").returncode == 0
    assert project_config.read_bytes() == project_before
    rejected_project_apply = run_mcp_config(project_config, scope="project", apply=True)
    assert rejected_project_apply.returncode != 0
    assert project_config.read_bytes() == project_before

    malformed_global = pilot / "malformed.jsonc"
    malformed_global.write_text('{"mcp": {"github": 1, "github": 2}}\n', encoding="utf-8")
    malformed_before = malformed_global.read_bytes()
    assert run_mcp_config(malformed_global, scope="global", apply=True).returncode != 0
    assert malformed_global.read_bytes() == malformed_before
    outside = root / "migration-outside"
    outside.mkdir()
    sentinel = outside / "sentinel"
    sentinel.write_text("untouched", encoding="utf-8")
    symlink_global = pilot / "symlink.jsonc"
    symlink_global.symlink_to(sentinel)
    assert run_mcp_config(symlink_global, scope="global", apply=True).returncode != 0
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
    assert run_mcp_config(stale / "opencode.jsonc", scope="global", apply=True).returncode == 0
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
    assert 'ACTIVE_CLI_CONFIG="${OPENCODE_V2_ACTIVE_CLI_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/cli.json}"' in assistant_text
    assert '--cli-config "$ACTIVE_CLI_CONFIG" --plugins cli --apply' in assistant_text
    assert '--cli-config "$ACTIVE_CLI_CONFIG" --plugins cli --verify-only' in assistant_text
    assert '--cli-config "$ACTIVE_CLI_CONFIG" --retire-integrated-browser --apply' in assistant_text
    assert '--cli-config "$ACTIVE_CLI_CONFIG" --retire-integrated-browser --verify-only' in assistant_text
    assert 'for name in basic-memory github chatgpt; do' in assistant_text
    assert "playwright" not in assistant_text.casefold() and "chrome" not in assistant_text.casefold()
    help_result = run([str(ASSISTANT), "--help"], env=env)
    assert "--user-only" in help_result.stdout
    duplicate_user_only = run(
        [str(ASSISTANT), "--user-only", "--user-only"], env=env, check=False
    )
    assert duplicate_user_only.returncode == 2

    apply_start = assistant_text.index("apply() {")
    apply_end = assistant_text.index("\n}\n", apply_start) + 3
    apply_file = sequence / "apply.sh"
    apply_file.write_text(assistant_text[apply_start:apply_end], encoding="utf-8")
    apply_log = sequence / "apply.log"
    user_only_apply = subprocess.run(
        [
            "bash",
            "-e",
            "-c",
            'source "$1"; install_system_dependencies() { printf "system\\n" >> "$LOG"; }; '
            'initialize_local_state() { printf "local\\n" >> "$LOG"; }; USER_ONLY=1; apply',
            "bash",
            str(apply_file),
        ],
        cwd=ROOT,
        env=dict(env, LOG=str(apply_log)),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert user_only_apply.returncode == 0
    assert apply_log.read_text(encoding="utf-8") == "local\n"
    apply_log.unlink()
    full_apply = subprocess.run(
        [
            "bash",
            "-e",
            "-c",
            'source "$1"; install_system_dependencies() { printf "system\\n" >> "$LOG"; }; '
            'initialize_local_state() { printf "local\\n" >> "$LOG"; }; USER_ONLY=0; apply',
            "bash",
            str(apply_file),
        ],
        cwd=ROOT,
        env=dict(env, LOG=str(apply_log)),
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert full_apply.returncode == 0
    assert apply_log.read_text(encoding="utf-8") == "system\nlocal\n"

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
