#!/usr/bin/env python3
"""Disposable regression checks for the OpenCode v2 launcher."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[5]
LAUNCHER = ROOT / "platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh"
TMP_ROOT = Path(os.environ.get("OPENCODE_LAUNCHER_TEST_ROOT", "/tmp/opencode"))


def run(args: list[str], env: dict[str, str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(LAUNCHER), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )
    if check and result.returncode:
        raise AssertionError(f"{args} failed:\n{result.stdout}\n{result.stderr}")
    return result


TMP_ROOT.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="opencode-launcher-test-", dir=TMP_ROOT) as temporary:
    root = Path(temporary)
    calls = root / "calls"
    project_env = root / "project-env"
    parser_env = root / "parser-env"
    opened = root / "opened"
    binary = root / "opencode"
    opener = root / "open-url"

    binary.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        f"printf '%s\\n' \"$*\" >> {calls}\n"
        f"printf '%s\\n' \"${{OPENCODE_DISABLE_PROJECT_CONFIG-unset}}\" >> {project_env}\n"
        f"printf '%s\\n' \"${{RIG_PARSERS_DIR-unset}}\" >> {parser_env}\n"
        "case \"$*\" in\n"
        "  '--version') printf 'opencode v2.test\\n' ;;\n"
        "  'service start') printf 'http://127.0.0.1:49374\\n' ;;\n"
        "  'service status') printf 'http://127.0.0.1:49374\\n' ;;\n"
        "  'api get /api/info') printf '{\"version\":\"v2.test\"}\\n' ;;\n"
        "  'pair --url http://127.0.0.1:49374') printf 'pair complete\\n' ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    opener.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        f"printf '%s\\n' \"$1\" > {opened}\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    opener.chmod(0o755)

    env = os.environ.copy()
    env.update(
        HOME=str(root / "home"),
        OPENCODE_V2_BIN=str(binary),
        OPENCODE_V2_PILOT_DIR=str(root / "pilot"),
        OPENCODE_WEB_OPENER=str(opener),
        OPENCODE_LEGACY_AUTH_FILE=str(root / "missing-auth.json"),
    )
    env.pop("OPENCODE_DISABLE_PROJECT_CONFIG", None)
    env.pop("RIG_PARSERS_DIR", None)

    for args, expected in (
        (["service", "status"], "http://127.0.0.1:49374\n"),
        (["api", "get", "/api/info"], '{"version":"v2.test"}\n'),
    ):
        probe_pilot = root / f"pilot-{args[0]}"
        probe_env = dict(env, OPENCODE_V2_PILOT_DIR=str(probe_pilot))
        calls.write_text("", encoding="utf-8")
        probe = run(args, probe_env)
        assert probe.stdout == expected
        assert not probe_pilot.exists(), f"{args} created pilot state"
        assert calls.read_text(encoding="utf-8").splitlines() == [" ".join(args)]

    start_pilot = root / "pilot-start"
    start_env = dict(env, OPENCODE_V2_PILOT_DIR=str(start_pilot))
    calls.write_text("", encoding="utf-8")
    started = run(["service", "start"], start_env)
    assert started.stdout == "http://127.0.0.1:49374\n"
    assert calls.read_text(encoding="utf-8").splitlines() == ["service start"]
    assert all(
        (start_pilot / name).is_dir()
        for name in ("config", "data", "state", "cache")
    )

    calls.write_text("", encoding="utf-8")
    project_env.write_text("", encoding="utf-8")
    parser_env.write_text("", encoding="utf-8")
    version = run(["--version"], env)
    assert version.stdout == "opencode v2.test\n"
    assert calls.read_text(encoding="utf-8").splitlines() == ["--version"]
    assert project_env.read_text(encoding="utf-8").splitlines() == ["unset"]
    assert parser_env.read_text(encoding="utf-8").splitlines() == [str(root / "pilot/cache/opencode-rig/parsers")]

    calls.write_text("", encoding="utf-8")
    web_pilot = root / "pilot-web"
    web_env = dict(env, OPENCODE_V2_PILOT_DIR=str(web_pilot))
    web = run(["web"], web_env)
    assert web.stdout == "pair complete\n"
    assert all(
        (web_pilot / name).is_dir()
        for name in ("config", "data", "state", "cache")
    )
    assert opened.read_text(encoding="utf-8").strip() == "http://127.0.0.1:49374"
    assert calls.read_text(encoding="utf-8").splitlines() == [
        "service start",
        "pair --url http://127.0.0.1:49374",
    ]

    calls.write_text("", encoding="utf-8")
    opened.unlink()
    run(["web", "--no-open"], web_env)
    assert not opened.exists()
    assert calls.read_text(encoding="utf-8").splitlines() == [
        "service start",
        "pair --url http://127.0.0.1:49374",
    ]
    assert set(project_env.read_text(encoding="utf-8").splitlines()) == {"unset"}

    explicit = dict(env, OPENCODE_DISABLE_PROJECT_CONFIG="1")
    project_env.write_text("", encoding="utf-8")
    calls.write_text("", encoding="utf-8")
    run(["--version"], explicit)
    run(["web", "--no-open"], dict(explicit, OPENCODE_V2_PILOT_DIR=str(web_pilot)))
    assert project_env.read_text(encoding="utf-8").splitlines() == ["1", "1", "1"]

    calls.write_text("", encoding="utf-8")
    help_result = run(["web", "--help"], env)
    assert "Usage: opencode web" in help_result.stdout
    assert calls.read_text(encoding="utf-8") == ""

    invalid = run(["web", "project"], env, check=False)
    assert invalid.returncode == 2
    assert "unsupported opencode web argument" in invalid.stderr

print("OK: OpenCode launcher web compatibility checks passed")
