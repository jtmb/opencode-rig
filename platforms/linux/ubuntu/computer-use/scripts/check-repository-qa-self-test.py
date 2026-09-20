#!/usr/bin/env python3
"""Focused negative tests for the repository QA helpers."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).with_name("check-repository-qa.py")


def load_module():
    spec = importlib.util.spec_from_file_location("repository_qa", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load repository QA module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expect_failure(action, label: str, expected: str | None = None) -> Exception:
    try:
        action()
    except Exception as exc:
        if expected is not None and expected not in str(exc):
            raise AssertionError(
                f"{label} failed without expected diagnostic {expected!r}: {exc}"
            ) from exc
        return exc
    raise AssertionError(f"{label} was accepted")


def read_pid(path: Path) -> int:
    if not path.is_file():
        raise AssertionError(f"command did not record PID in {path}")
    return int(path.read_text(encoding="utf-8"))


def process_state(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2]
    except (FileNotFoundError, ProcessLookupError):
        return None


def assert_reaped(pid: int, label: str) -> None:
    if process_state(pid) is not None:
        raise AssertionError(f"{label} process {pid} was not reaped")


def assert_not_running(pid: int, label: str) -> None:
    end = time.monotonic() + 1
    while time.monotonic() < end:
        state = process_state(pid)
        if state is None or state == "Z":
            return
        time.sleep(0.01)
    raise AssertionError(f"{label} process {pid} survived process-group cleanup")


def test_command_failures(qa, root: Path) -> None:
    expect_failure(
        lambda: qa.run_command(["definitely-missing-repository-qa-command"], root, 1),
        "missing command",
        "missing command",
    )

    parent_pid = root / "timeout-parent.pid"
    descendant_pid = root / "timeout-descendant.pid"
    ready = root / "timeout-descendant.ready"
    child_code = (
        "import pathlib,signal,time; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"pathlib.Path({str(ready)!r}).write_text('ready'); "
        "time.sleep(10)"
    )
    command_code = (
        "import os,pathlib,subprocess,sys,time\n"
        f"pathlib.Path({str(parent_pid)!r}).write_text(str(os.getpid()))\n"
        f"child=subprocess.Popen([sys.executable, '-c', {child_code!r}])\n"
        f"ready=pathlib.Path({str(ready)!r})\n"
        "limit=time.monotonic()+2\n"
        "while not ready.exists() and time.monotonic()<limit: time.sleep(0.005)\n"
        "assert ready.exists()\n"
        f"pathlib.Path({str(descendant_pid)!r}).write_text(str(child.pid))\n"
        "time.sleep(10)\n"
    )
    expect_failure(
        lambda: qa.run_command(["python3", "-c", command_code], root, 0.4),
        "command timeout",
        "timeout after",
    )
    assert_reaped(read_pid(parent_pid), "timed-out command")
    assert_not_running(read_pid(descendant_pid), "timed-out descendant")

    output_pid = root / "output.pid"
    output_code = (
        "import os,pathlib,time; "
        f"pathlib.Path({str(output_pid)!r}).write_text(str(os.getpid())); "
        "os.write(1, b'o' * 3072); os.write(2, b'e' * 3072); time.sleep(10)"
    )
    original_cap = qa.MAX_OUTPUT_BYTES
    qa.MAX_OUTPUT_BYTES = 4096
    try:
        expect_failure(
            lambda: qa.run_command(["python3", "-c", output_code], root, 2),
            "combined stdout and stderr overflow",
            "combined output exceeded",
        )
    finally:
        qa.MAX_OUTPUT_BYTES = original_cap
    assert_reaped(read_pid(output_pid), "output-overflow command")

    overall_pid = root / "overall.pid"
    overall_code = (
        "import os,pathlib,time; "
        f"pathlib.Path({str(overall_pid)!r}).write_text(str(os.getpid())); "
        "time.sleep(10)"
    )
    original_overall = qa.OVERALL_TIMEOUT
    qa.OVERALL_TIMEOUT = 0.2
    try:
        expect_failure(
            lambda: qa.run_command(
                ["python3", "-c", overall_code],
                root,
                2,
                deadline=qa._now() + qa.OVERALL_TIMEOUT,
            ),
            "overall deadline during command",
            "overall QA timeout",
        )
    finally:
        qa.OVERALL_TIMEOUT = original_overall
    assert_reaped(read_pid(overall_pid), "overall-timeout command")


def test_in_process_failures(qa, root: Path) -> None:
    json_root = root / "json"
    json_root.mkdir()
    bad_json = json_root / "bad.json"
    bad_json.write_text('{"broken": [}', encoding="utf-8")
    expect_failure(lambda: qa.check_json(json_root), "malformed JSON")
    bad_json.write_text('{"duplicate": 1, "duplicate": 2}', encoding="utf-8")
    expect_failure(lambda: qa.check_json(json_root), "duplicate JSON", "duplicate JSON")

    jsonc_root = root / "jsonc"
    jsonc_root.mkdir()
    bad_jsonc = jsonc_root / "bad.jsonc"
    bad_jsonc.write_text('{"broken": [}', encoding="utf-8")
    expect_failure(lambda: qa.check_jsonc(jsonc_root), "malformed JSONC")
    bad_jsonc.write_text(
        '{"duplicate": 1, "duplicate": 2}', encoding="utf-8"
    )
    expect_failure(
        lambda: qa.check_jsonc(jsonc_root),
        "duplicate JSONC key",
        "duplicate JSON object key",
    )

    svg_root = root / "svg"
    svg_root.mkdir()
    (svg_root / "bad.svg").write_text("<svg>", encoding="utf-8")
    expect_failure(lambda: qa.check_svg(svg_root), "malformed SVG")

    markdown_root = root / "markdown"
    markdown_root.mkdir()
    (markdown_root / "README.md").write_text(
        "[missing](docs/not-present.md)\n", encoding="utf-8"
    )
    expect_failure(
        lambda: qa.check_markdown_links(markdown_root),
        "broken Markdown link",
        "broken local Markdown link",
    )

    traversal_root = root / "deadline-traversal"
    traversal_root.mkdir()
    (traversal_root / "a.json").write_text("{}\n", encoding="utf-8")
    (traversal_root / "b.json").write_text("{}\n", encoding="utf-8")
    original_now = qa._now
    original_overall = qa.OVERALL_TIMEOUT
    calls = 0

    def synthetic_now() -> float:
        nonlocal calls
        calls += 1
        return 0.0 if calls < 4 else 2.0

    qa._now = synthetic_now
    qa.OVERALL_TIMEOUT = 1.0
    try:
        expect_failure(
            lambda: qa.check_json(traversal_root, deadline=1.0),
            "overall deadline during in-process traversal",
            "overall QA timeout",
        )
    finally:
        qa._now = original_now
        qa.OVERALL_TIMEOUT = original_overall


def test_self_test_discovery(qa, root: Path) -> None:
    scripts = root / "scripts"
    scripts.mkdir()
    original_names = qa.SELF_TEST_NAMES
    qa.SELF_TEST_NAMES = ("z-self-test.py", "a-self-test.py")
    try:
        for name in reversed(qa.SELF_TEST_NAMES):
            (scripts / name).write_text("# test\n", encoding="utf-8")
        first = qa.discover_self_tests(root, scripts)
        second = qa.discover_self_tests(root, scripts)
        expected = tuple(scripts / name for name in qa.SELF_TEST_NAMES)
        assert first == expected and second == expected

        (scripts / "a-self-test.py").unlink()
        expect_failure(
            lambda: qa.discover_self_tests(root, scripts),
            "missing allowlisted self-test",
            "missing:",
        )
        (scripts / "a-self-test.py").write_text("# test\n", encoding="utf-8")

        nested = root / "nested"
        nested.mkdir()
        extra = nested / "new-self-test.py"
        extra.write_text("# test\n", encoding="utf-8")
        expect_failure(
            lambda: qa.discover_self_tests(root, scripts),
            "unallowlisted self-test",
            "unexpected:",
        )
    finally:
        qa.SELF_TEST_NAMES = original_names


def test_child_environment_and_bytecode(qa, root: Path) -> None:
    helper = root / "bytecode_helper.py"
    report = root / "environment.json"
    helper.write_text("VALUE = 42\n", encoding="utf-8")
    code = f"""
import json
import os
import pathlib
import bytecode_helper

assert bytecode_helper.VALUE == 42
values = {{
    "CI": os.environ.get("CI"),
    "HOME": os.environ.get("HOME"),
    "LANG": os.environ.get("LANG"),
    "LANGUAGE": os.environ.get("LANGUAGE"),
    "LC_ALL": os.environ.get("LC_ALL"),
    "PATH": os.environ.get("PATH"),
    "PYTHONDONTWRITEBYTECODE": os.environ.get("PYTHONDONTWRITEBYTECODE"),
    "npm_config_offline": os.environ.get("npm_config_offline"),
}}
pathlib.Path({str(report)!r}).write_text(
    json.dumps(values, sort_keys=True), encoding="utf-8"
)
"""
    qa.run_command(["python3", "-c", code], root, 2)
    environment = json.loads(report.read_text(encoding="utf-8"))
    assert environment["CI"] == "1"
    assert environment["HOME"] == os.environ.get("HOME")
    assert environment["PATH"] == os.environ.get("PATH")
    assert environment["LANG"] == "C.UTF-8"
    assert environment["LANGUAGE"] == "C"
    assert environment["LC_ALL"] == "C.UTF-8"
    assert environment["PYTHONDONTWRITEBYTECODE"] == "1"
    assert environment["npm_config_offline"] == "true"
    assert not list(root.rglob("*.pyc"))
    assert not list(root.rglob("__pycache__"))


def test_workspace_count(qa, root: Path) -> None:
    workspace = root / "plugins-v2"
    workspace.mkdir()
    packages = [f"package-{index}" for index in range(12)]
    (workspace / "package.json").write_text(
        json.dumps({"workspaces": packages}), encoding="utf-8"
    )
    calls = []
    original_run = qa.run_command
    qa.run_command = lambda argv, cwd, **kwargs: calls.append((argv, cwd))
    try:
        assert qa.run_package_checks(root, workspace) == 12
        assert len(calls) == 12
        (workspace / "package.json").write_text(
            json.dumps({"workspaces": packages[:-1]}), encoding="utf-8"
        )
        expect_failure(
            lambda: qa.run_package_checks(root, workspace),
            "incomplete workspace catalog",
            "exactly twelve",
        )
    finally:
        qa.run_command = original_run


def test_staged_diff_check(qa, root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    path = root / "staged.txt"
    path.write_text("clean\n", encoding="utf-8")
    subprocess.run(["git", "add", "staged.txt"], cwd=root, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Repository QA",
            "-c",
            "user.email=qa@example.invalid",
            "commit",
            "-q",
            "-m",
            "clean fixture",
        ],
        cwd=root,
        check=True,
    )
    qa.check_git_diff(root)

    path.write_text("trailing whitespace  \n", encoding="utf-8")
    subprocess.run(["git", "add", "staged.txt"], cwd=root, check=True)
    expect_failure(
        lambda: qa.check_git_diff(root),
        "staged whitespace error",
        "command failed",
    )


def main() -> int:
    qa = load_module()
    with tempfile.TemporaryDirectory(prefix="repository-qa-self-test-") as directory:
        root = Path(directory)
        command_root = root / "commands"
        command_root.mkdir()
        test_command_failures(qa, command_root)

        in_process_root = root / "in-process"
        in_process_root.mkdir()
        test_in_process_failures(qa, in_process_root)

        discovery_root = root / "discovery"
        discovery_root.mkdir()
        test_self_test_discovery(qa, discovery_root)

        bytecode_root = root / "bytecode"
        bytecode_root.mkdir()
        test_child_environment_and_bytecode(qa, bytecode_root)

        workspace_root = root / "workspace"
        workspace_root.mkdir()
        test_workspace_count(qa, workspace_root)

        staged_root = root / "staged"
        staged_root.mkdir()
        test_staged_diff_check(qa, staged_root)

    print(
        "OK: repository QA self-test rejects command, deadline, output, format, "
        "link, self-test discovery, and workspace-count failures; cleanup, "
        "environment, ordering, staged diff, and no-bytecode invariants passed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
