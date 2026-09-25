#!/usr/bin/env python3
"""Exercise canonical MCP parity, GitHub provisioning, and credential boundaries."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
from collections.abc import Callable
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
SCRIPT_ROOT = ROOT / "platforms/linux/ubuntu/computer-use/scripts"
RUNTIME_PATH = SCRIPT_ROOT / "mcp_runtime.py"
WRAPPER = SCRIPT_ROOT / "github-mcp.sh"
POLICY_PATH = ROOT / "platforms/linux/ubuntu/computer-use/config/mcp-versions.json"

_spec = importlib.util.spec_from_file_location("mcp_runtime_self_test", RUNTIME_PATH)
assert _spec and _spec.loader
MCP = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MCP)


def write_executable(path: Path, content: str) -> None:
    """Write one private executable fixture."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o700)


def add_archive_file(archive: tarfile.TarFile, name: str, content: bytes, mode: int) -> None:
    """Add one bounded regular file to a tar fixture."""
    member = tarfile.TarInfo(name)
    member.size = len(content)
    member.mode = mode
    archive.addfile(member, io.BytesIO(content))


def build_archive(path: Path, version: str, *, extra_member: bool = False) -> str:
    """Build the exact upstream archive shape and return its SHA-256."""
    binary = (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "case \"${1:-}\" in\n"
        f"  --version) printf 'GitHub MCP Server\\nVersion: {version}\\n';;\n"
        "  stdio)\n"
        "    [ \"${GITHUB_PERSONAL_ACCESS_TOKEN:-}\" = gh-session-token ] || exit 41\n"
        "    [ \"${2:-}\" = --toolsets=context,repos,issues,pull_requests,actions,users ] || exit 42\n"
        "    [ \"${3:-}\" = --lockdown-mode ] || exit 43\n"
        "    [ -z \"${GH_TOKEN:-}\" ] && [ -z \"${GITHUB_TOOLSETS:-}\" ] || exit 44\n"
        "    printf 'sanitized-github-child\\n';;\n"
        "  *) exit 2;;\n"
        "esac\n"
    ).encode()
    with tarfile.open(path, mode="w:gz") as archive:
        add_archive_file(archive, "LICENSE", b"test license\n", 0o644)
        add_archive_file(archive, "README.md", b"test readme\n", 0o644)
        add_archive_file(archive, "github-mcp-server", binary, 0o755)
        if extra_member:
            add_archive_file(archive, "unexpected", b"not allowed\n", 0o644)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_policy(path: Path, checksum: str) -> None:
    """Copy canonical policy with a fixture archive checksum."""
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    policy["githubSha256"] = checksum
    path.write_text(json.dumps(policy) + "\n", encoding="utf-8")


def expect_runtime_error(action: Callable[[], object]) -> None:
    """Require a callable to fail with the canonical runtime error."""
    try:
        action()
    except MCP.McpRuntimeError:
        return
    raise AssertionError("expected McpRuntimeError")


test_root = Path(os.environ.get("OPENCODE_MCP_TEST_ROOT", "/tmp/opencode"))
test_root.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="mcp-runtime-self-test-", dir=test_root) as temporary:
    root = Path(temporary)
    archive = root / "github-mcp.tar.gz"
    checksum = build_archive(archive, "1.12.1")
    policy = root / "policy.json"
    write_policy(policy, checksum)
    MCP.POLICY_PATH = policy
    MCP.urlopen = lambda *_args, **_kwargs: archive.open("rb")

    repository_project = MCP.load_config(ROOT / "opencode.json")
    MCP.verify_mcp_servers(repository_project, profile="native")

    retired_policy = json.loads(policy.read_text(encoding="utf-8"))
    retired_policy.update(
        {"playwright": "0.0.80", "playwrightBrowser": "retired", "playwrightBrowserRevision": 1243}
    )
    policy.write_text(json.dumps(retired_policy) + "\n", encoding="utf-8")
    expect_runtime_error(MCP.load_policy)
    write_policy(policy, checksum)

    profile = root / "profile"
    installed = MCP.ensure_github(profile="wsl2", profile_root=profile, apply=True)
    assert installed == profile / "mcp/github/github-mcp-server"
    assert installed.stat().st_mode & 0o777 == 0o700
    assert MCP.ensure_github(profile="wsl2", profile_root=profile, apply=False) == installed
    assert MCP.github_binary("wsl2", profile) != MCP.github_binary("native")

    checksum_profile = root / "checksum-profile"
    write_policy(policy, "0" * 64)
    expect_runtime_error(lambda: MCP.ensure_github(profile="wsl2", profile_root=checksum_profile, apply=True))
    assert not (checksum_profile / "mcp/github/github-mcp-server").exists()

    extra_archive = root / "github-mcp-extra.tar.gz"
    extra_checksum = build_archive(extra_archive, "1.12.1", extra_member=True)
    write_policy(policy, extra_checksum)
    MCP.urlopen = lambda *_args, **_kwargs: extra_archive.open("rb")
    extra_profile = root / "extra-profile"
    expect_runtime_error(lambda: MCP.ensure_github(profile="wsl2", profile_root=extra_profile, apply=True))
    assert not (extra_profile / "mcp/github/github-mcp-server").exists()

    wrong_archive = root / "github-mcp-wrong-version.tar.gz"
    wrong_checksum = build_archive(wrong_archive, "9.9.9")
    write_policy(policy, wrong_checksum)
    MCP.urlopen = lambda *_args, **_kwargs: wrong_archive.open("rb")
    wrong_profile = root / "wrong-profile"
    expect_runtime_error(lambda: MCP.ensure_github(profile="wsl2", profile_root=wrong_profile, apply=True))
    assert not (wrong_profile / "mcp/github/github-mcp-server").exists()

    symlink_profile = root / "symlink-profile"
    symlink_target = root / "outside-binary"
    write_executable(symlink_target, "#!/bin/sh\nexit 0\n")
    symlink_binary = symlink_profile / "mcp/github/github-mcp-server"
    symlink_binary.parent.mkdir(parents=True)
    symlink_binary.symlink_to(symlink_target)
    write_policy(policy, checksum)
    MCP.urlopen = lambda *_args, **_kwargs: archive.open("rb")
    expect_runtime_error(lambda: MCP.ensure_github(profile="wsl2", profile_root=symlink_profile, apply=True))
    assert symlink_binary.is_symlink() and symlink_target.exists()

    wrapper_home = root / "wrapper-home"
    wrapper_profile = root / "wrapper-profile"
    wrapper_binary = wrapper_profile / "mcp/github/github-mcp-server"
    wrapper_binary.parent.mkdir(parents=True)
    wrapper_binary.write_bytes(installed.read_bytes())
    wrapper_binary.chmod(0o700)
    fake_gh = wrapper_home / ".local/bin/gh"
    write_executable(
        fake_gh,
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "[ -z \"${GH_TOKEN:-}\" ] && [ -z \"${GITHUB_PERSONAL_ACCESS_TOKEN:-}\" ] || exit 45\n"
        "[ \"${1:-}\" = auth ] && [ \"${2:-}\" = token ] && [ \"${3:-}\" = --hostname ] || exit 2\n"
        "printf 'gh-session-token\\n'\n",
    )
    wrapper_env = {
        "HOME": str(wrapper_home),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "OPENCODE_MCP_PROFILE": "wsl2",
        "OPENCODE_MCP_PROFILE_ROOT": str(wrapper_profile),
    }
    wrapper_result = subprocess.run(
        [str(WRAPPER)],
        cwd=ROOT,
        env=wrapper_env,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    assert wrapper_result.returncode == 0, wrapper_result.stderr
    assert wrapper_result.stdout == "sanitized-github-child\n"
    assert "gh-session-token" not in f"{wrapper_result.stdout}\n{wrapper_result.stderr}"

    for name in ("GH_TOKEN", "GITHUB_TOOLSETS", "OPENCODE_MCP_GH_BIN"):
        rejected = subprocess.run(
            [str(WRAPPER), "--verify-only"],
            cwd=ROOT,
            env={**wrapper_env, name: "must-not-appear"},
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
        assert rejected.returncode != 0
        assert "must-not-appear" not in f"{rejected.stdout}\n{rejected.stderr}"

    wrapper_root = root / "canonical-wrappers"
    for name in MCP.MCP_NAMES:
        write_executable(wrapper_root / f"{name}-mcp.sh", "#!/usr/bin/env sh\nexit 0\n")
    original_script_root = MCP.SCRIPT_ROOT
    MCP.SCRIPT_ROOT = wrapper_root
    project_servers = MCP.mcp_servers("native")
    assert set(project_servers) == {"basic-memory", "github", "chatgpt"}
    assert project_servers["chatgpt"] == {
        "type": "local",
        "command": [MCP.NATIVE_CHATGPT_COMMAND],
        "codemode": False,
        "disabled": False,
        "timeout": {"startup": 30_000},
    }
    MCP.verify_mcp_servers({"mcp": {"servers": project_servers}}, profile="native")
    assert set(project_servers) == set(MCP.global_mcp_servers())
    assert not {"playwright", "playwrightBrowser", "playwrightBrowserRevision"}.intersection(
        MCP.expected_marker("native")
    )
    assert "playwright" not in MCP.profile_paths(root / "isolated-wsl-profile")
    original_native_root = os.environ.get("OPENCODE_MCP_NATIVE_ROOT")
    original_notes_root = os.environ.get("BASIC_MEMORY_HOME")
    os.environ["OPENCODE_MCP_NATIVE_ROOT"] = str(root / "native-profile")
    os.environ["BASIC_MEMORY_HOME"] = str(root / "native-notes")
    try:
        assert "browser_cache" not in MCP.native_paths()
    finally:
        if original_native_root is None:
            os.environ.pop("OPENCODE_MCP_NATIVE_ROOT", None)
        else:
            os.environ["OPENCODE_MCP_NATIVE_ROOT"] = original_native_root
        if original_notes_root is None:
            os.environ.pop("BASIC_MEMORY_HOME", None)
        else:
            os.environ["BASIC_MEMORY_HOME"] = original_notes_root
    legacy_project_servers = {**project_servers, "playwright": {"type": "local"}}
    expect_runtime_error(
        lambda: MCP.verify_mcp_servers({"mcp": {"servers": legacy_project_servers}}, profile="native")
    )
    expect_runtime_error(
        lambda: MCP.verify_mcp_servers(
            {"mcp": {"playwright": {"command": ["legacy-flat"]}, "servers": project_servers}},
            profile="native",
        )
    )

    wsl_root = root / "isolated-wsl-profile"
    MCP.prepare_profile(wsl_root, apply=True)
    assert not (wsl_root / "mcp" / "playwright").exists()
    assert not (wsl_root / "cache" / "ms-playwright").exists()
    wsl_servers = MCP.mcp_servers("wsl2", wsl_root)
    assert set(wsl_servers) == {"basic-memory", "github", "chatgpt"}
    assert wsl_servers["chatgpt"] == {
        "type": "local",
        "command": [str(wrapper_root / "chatgpt-mcp.sh")],
        "codemode": False,
        "disabled": False,
        "timeout": {"startup": 30_000},
        "cwd": str(wsl_root / "workspace"),
        "environment": {
            "OPENCODE_MCP_PROFILE": "wsl2",
            "OPENCODE_MCP_PROFILE_ROOT": str(wsl_root),
        },
    }
    MCP.verify_mcp_servers({"mcp": {"servers": wsl_servers}}, profile="wsl2", profile_root=wsl_root)
    wsl_config = {
        "custom-root": {"preserved": True},
        "mcp": {
            "timeout": {"custom": 45_000},
            "playwright": {"command": ["legacy-flat"]},
            "servers": {"playwright": {"type": "local", "command": ["project-only"]}},
        },
    }
    MCP.ensure_mcp_servers(wsl_config, profile="wsl2", profile_root=wsl_root)
    assert wsl_config["custom-root"] == {"preserved": True}
    assert wsl_config["mcp"]["timeout"]["custom"] == 45_000
    assert "playwright" not in wsl_config["mcp"]
    assert set(wsl_config["mcp"]["servers"]) == {"basic-memory", "github", "chatgpt"}
    MCP.verify_mcp_servers(wsl_config, profile="wsl2", profile_root=wsl_root)

    global_config = {
        "model": "keep/model",
        "mcp": {
            "timeout": {"startup": 12_000},
            "unrelated-option": {"keep": True},
            "github": {"command": ["legacy-github"]},
            "playwright": {"command": ["legacy-playwright"]},
            "basic-memory": {"command": ["legacy-memory"]},
            "chatgpt": {"command": ["legacy-chatgpt"]},
            "servers": {
                "unrelated": {"type": "remote", "url": "https://example.test/mcp"},
                "playwright": {"command": ["project-only"]},
            },
        },
    }
    MCP.ensure_global_mcp_servers(global_config)
    assert global_config["model"] == "keep/model"
    assert global_config["mcp"]["timeout"] == {"startup": 12_000}
    assert global_config["mcp"]["unrelated-option"] == {"keep": True}
    global_servers = global_config["mcp"]["servers"]
    assert set(global_servers) == {"basic-memory", "github", "chatgpt", "unrelated"}
    assert "playwright" not in global_config["mcp"]
    assert global_servers["unrelated"] == {"type": "remote", "url": "https://example.test/mcp"}
    assert global_servers["chatgpt"]["codemode"] is False
    MCP.verify_global_mcp_servers(global_config)
    first_global = json.dumps(global_config, sort_keys=True)
    MCP.ensure_global_mcp_servers(global_config)
    assert json.dumps(global_config, sort_keys=True) == first_global
    legacy_global = json.loads(first_global)
    legacy_global["mcp"]["servers"]["playwright"] = {"type": "local"}
    expect_runtime_error(lambda: MCP.verify_global_mcp_servers(legacy_global))
    legacy_flat_global = json.loads(first_global)
    legacy_flat_global["mcp"]["playwright"] = {"command": ["legacy-flat"]}
    expect_runtime_error(lambda: MCP.verify_global_mcp_servers(legacy_flat_global))
    credential_config = json.loads(first_global)
    credential_config["mcp"]["servers"]["chatgpt"]["environment"] = {
        "OPENAI_API_KEY": "non-secret-test-fixture"
    }
    expect_runtime_error(lambda: MCP.verify_global_mcp_servers(credential_config))
    MCP.SCRIPT_ROOT = original_script_root

print("OK: MCP runtime self-tests passed")
