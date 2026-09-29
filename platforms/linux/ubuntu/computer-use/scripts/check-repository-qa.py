#!/usr/bin/env python3
"""Run the repository's bounded, read-only QA evidence with fixed argv."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable


# Dynamic imports of repository helpers must not leave ignored artifacts behind.
sys.dont_write_bytecode = True

COMMAND_TIMEOUT = 180.0
OVERALL_TIMEOUT = 540.0
MAX_OUTPUT_BYTES = 256 * 1024
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)")
SEMVER_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
IGNORED_DIRECTORIES = {".git", "node_modules", "__pycache__"}
HEAD_WHITESPACE_EXCLUSIONS = (
    "wsl-session.md",
    ":(exclude,glob)evidence/ui-acceptance/**/v3/characters/*.txt",
    ":(exclude,glob)evidence/ui-acceptance/**/v3/snapshots/**/*.txt",
)
QA_RUNTIME_CONFIG = ".opencode/rig-gates.json"
MAX_RUNTIME_BYTES = 256 * 1024 * 1024
# Package checks keep the declared Node/npm directory first on the child PATH.
# The fixed system directories are appended only so npm can spawn its script
# shell (`sh`) and the `bash` used by the curated package scripts. Node and npm
# themselves remain selected by absolute, digest-verified path, never from PATH.
QA_RUNTIME_PATH_SUFFIX = "/usr/bin:/bin"
EXPECTED_PACKAGE_WORKSPACES = (
    "codex-fallback",
    "codex-usage",
    "source-control",
    "file-manager",
    "orchestration-policy",
    "ponytail-adapter",
    "git-tool",
    "repo-learning",
    "chatgpt-connector",
    "rig-tools",
    "rig-todo",
    "resource-monitor",
)
SELF_TEST_NAMES = (
    "check-skill-docs-self-test.py",
    "check-progress-tracking-self-test.py",
    "check-git-safety-policy-self-test.py",
    "check-plugin-resource-guards-self-test.py",
    "check-doc-coverage-self-test.py",
    "deploy-plugins-self-test.py",
    "deploy-hermes-plugin-self-test.py",
    "check-run-bounded-command-self-test.py",
    "mcp-runtime-self-test.py",
    "chatgpt-private-self-test.py",
    "setup-opencode-self-test.py",
    "setup-plugin-dependencies-self-test.py",
    "setup-qa-runtime-self-test.py",
    "opencode-launcher-self-test.py",
    "opencode-recovery-self-test.py",
    "recover-orchestration-lockout-self-test.py",
    "check-acceptance-evidence-self-test.py",
    "check-repository-qa-self-test.py",
)


class QAError(RuntimeError):
    """A concise fail-closed QA error."""


class QARuntime:
    """Repository-declared runtime used for package checks."""

    def __init__(
        self,
        name: str,
        version: str,
        executable: Path,
        package_manager: Path,
        path: str,
    ) -> None:
        """Store the verified runtime paths without importing project code."""
        self.name = name
        self.version = version
        self.executable = executable
        self.package_manager = package_manager
        self.path = path


def _now() -> float:
    return time.monotonic()


def check_deadline(deadline: float | None, activity: str) -> None:
    if deadline is not None and _now() >= deadline:
        raise QAError(
            f"overall QA timeout after {OVERALL_TIMEOUT:g}s during {activity}"
        )


def load_jsonc(path: str) -> object:
    """Load JSONC with a local standard-library parser for copied QA scripts."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise QAError(f"cannot read JSONC file: {path}") from exc
    characters: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        character = text[index]
        if in_string:
            characters.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            characters.append(character)
            index += 1
            continue
        if character == "/" and index + 1 < len(text) and text[index + 1] == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
            continue
        if character == "/" and index + 1 < len(text) and text[index + 1] == "*":
            index += 2
            while index + 1 < len(text) and text[index : index + 2] != "*/":
                index += 1
            if index + 1 >= len(text):
                raise QAError(f"unterminated JSONC comment: {path}")
            index += 2
            continue
        characters.append(character)
        index += 1
    if in_string:
        raise QAError(f"unterminated JSONC string: {path}")
    cleaned = re.sub(r",(\s*[}\]])", r"\1", "".join(characters))
    try:
        return json.loads(cleaned, object_pairs_hook=_reject_duplicates)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise QAError(f"invalid JSONC: {path}") from exc


def _runtime_relative_parts(raw_path: object, label: str) -> tuple[str, ...]:
    """Return safe relative components for a repository-declared runtime path."""
    if not isinstance(raw_path, str) or not raw_path:
        raise QAError(f"{label} must be a non-empty relative path")
    if "\x00" in raw_path or "\\" in raw_path:
        raise QAError(f"{label} must use a relative forward-slash path")
    posix = PurePosixPath(raw_path)
    windows = PureWindowsPath(raw_path)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise QAError(f"{label} must be relative; absolute developer paths are forbidden")
    parts = posix.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise QAError(f"{label} must remain beneath the repository root")
    return parts


def _runtime_file(
    root: Path,
    raw_path: object,
    label: str,
    *,
    require_executable: bool = True,
) -> Path:
    """Resolve a declared runtime file without following symlink components."""
    parts = _runtime_relative_parts(raw_path, label)
    candidate = root.joinpath(*parts)
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise QAError(f"{label} rejects symlink path: {raw_path}")
    try:
        candidate.resolve(strict=True).relative_to(root)
        mode = candidate.stat().st_mode
    except (OSError, RuntimeError, ValueError) as exc:
        raise QAError(f"{label} is not a readable repository file: {raw_path}") from exc
    if not stat.S_ISREG(mode):
        raise QAError(f"{label} must name a regular file: {raw_path}")
    if require_executable and not mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
        raise QAError(f"{label} must be executable: {raw_path}")
    return candidate


def _runtime_file_digest(path: Path, expected: object, label: str) -> None:
    """Require a declared runtime file's bytes to match its SHA-256 digest."""
    if not isinstance(expected, str) or SHA256_PATTERN.fullmatch(expected) is None:
        raise QAError(f"{label} must be a lowercase SHA-256 digest")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise QAError(f"{label} cannot be read") from exc
    if len(raw) > MAX_RUNTIME_BYTES:
        raise QAError(f"{label} exceeds the {MAX_RUNTIME_BYTES}-byte limit")
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise QAError(f"{label} does not match the declared runtime bytes")


def load_qa_runtime(root: Path, *, deadline: float | None = None) -> QARuntime:
    """Load and verify the repository-declared Node/npm QA runtime.

    QA deliberately refuses to resolve a runtime from ``PATH``. The consuming
    repository must commit relative executable paths and their SHA-256 digests
    in ``.opencode/rig-gates.json``.
    """
    check_deadline(deadline, "QA runtime selection")
    try:
        root = root.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise QAError("repository root is not readable while selecting QA runtime") from exc
    config_path = _runtime_file(
        root,
        QA_RUNTIME_CONFIG,
        "QA runtime configuration",
        require_executable=False,
    )
    try:
        raw_config = config_path.read_bytes()
    except OSError as exc:
        raise QAError("cannot read QA runtime configuration") from exc
    if len(raw_config) > 1024 * 1024:
        raise QAError("QA runtime configuration exceeds the 1 MiB limit")
    try:
        config = json.loads(raw_config, object_pairs_hook=_reject_duplicates)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise QAError("QA runtime configuration must be valid UTF-8 JSON") from exc
    if not isinstance(config, dict):
        raise QAError("QA runtime configuration must be a JSON object")
    runtime_value = config.get("qaRuntime")
    if not isinstance(runtime_value, dict):
        raise QAError(
            "qaRuntime is required in .opencode/rig-gates.json; declare relative "
            "Node/npm paths and SHA-256 digests instead of relying on PATH"
        )
    runtime = runtime_value
    allowed_runtime = {"name", "version", "executable", "sha256", "packageManager"}
    unknown = set(runtime) - allowed_runtime
    if unknown:
        raise QAError("qaRuntime has unsupported field(s): " + ", ".join(sorted(unknown)))
    name = runtime.get("name")
    version = runtime.get("version")
    if name != "node":
        raise QAError(f"unsupported QA runtime {name!r}; only declared node is supported")
    if not isinstance(version, str) or SEMVER_PATTERN.fullmatch(version) is None:
        raise QAError("qaRuntime.version must be a semantic version")
    executable = _runtime_file(root, runtime.get("executable"), "qaRuntime.executable")
    _runtime_file_digest(executable, runtime.get("sha256"), "qaRuntime.sha256")
    package_value = runtime.get("packageManager")
    if not isinstance(package_value, dict):
        raise QAError("qaRuntime.packageManager must declare the npm executable and digest")
    unknown_package = set(package_value) - {"name", "executable", "sha256"}
    if unknown_package:
        raise QAError(
            "qaRuntime.packageManager has unsupported field(s): "
            + ", ".join(sorted(unknown_package))
        )
    if package_value.get("name") != "npm":
        raise QAError("unsupported QA package manager; qaRuntime.packageManager.name must be npm")
    package_manager = _runtime_file(
        root,
        package_value.get("executable"),
        "qaRuntime.packageManager.executable",
    )
    _runtime_file_digest(
        package_manager,
        package_value.get("sha256"),
        "qaRuntime.packageManager.sha256",
    )
    check_deadline(deadline, "QA runtime selection")
    return QARuntime(
        name=name,
        version=version,
        executable=executable,
        package_manager=package_manager,
        path=f"{executable.parent}:{QA_RUNTIME_PATH_SUFFIX}",
    )


def _terminate(process: subprocess.Popen[bytes]) -> None:
    """Terminate the complete command process group and reap its leader."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

    try:
        process.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        pass

    # The leader may exit before a descendant that ignored SIGTERM. Always
    # follow with SIGKILL while the process group still exists.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired as exc:
        raise QAError(f"could not reap timed-out command process {process.pid}") from exc


def _child_environment(path_override: str | None = None) -> dict[str, str]:
    """Build deterministic child settings, optionally with a declared runtime PATH."""
    environment = os.environ.copy()
    environment.update(
        {
            "CI": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "LANG": "C.UTF-8",
            "LANGUAGE": "C",
            "LC_ALL": "C.UTF-8",
            "NO_COLOR": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONHASHSEED": "0",
            # Package checks and setup integration must use installed lockfile
            # assets; canonical QA never resolves or downloads packages.
            "npm_config_offline": "true",
        }
    )
    if path_override is not None:
        environment["PATH"] = path_override
    return environment


def run_command(
    argv: list[str],
    root: Path,
    timeout: float = COMMAND_TIMEOUT,
    *,
    deadline: float | None = None,
    path_override: str | None = None,
) -> str:
    """Run direct argv with bounded output and timeout; never invoke a shell."""
    if not argv or any(not isinstance(part, str) or not part for part in argv):
        raise QAError("invalid empty command argv")
    if timeout <= 0:
        raise QAError("command timeout must be positive")

    started = _now()
    check_deadline(deadline, f"command {argv[0]}")
    command_deadline = started + timeout
    effective_deadline = (
        min(command_deadline, deadline) if deadline is not None else command_deadline
    )
    try:
        process = subprocess.Popen(
            argv,
            cwd=root,
            env=_child_environment(path_override),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except FileNotFoundError as exc:
        raise QAError(f"missing command: {argv[0]}") from exc
    except OSError as exc:
        raise QAError(f"cannot start {argv[0]}: {exc}") from exc

    selector = selectors.DefaultSelector()
    assert process.stdout is not None and process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    chunks: list[bytes] = []
    total = 0
    try:
        while selector.get_map() or process.poll() is None:
            now = _now()
            remaining = effective_deadline - now
            if remaining <= 0:
                _terminate(process)
                if deadline is not None and now >= deadline:
                    raise QAError(
                        f"overall QA timeout after {OVERALL_TIMEOUT:g}s "
                        f"while running command: {argv[0]}"
                    )
                raise QAError(f"timeout after {timeout:g}s: {argv[0]}")
            for key, _ in selector.select(min(remaining, 0.25)):
                now = _now()
                if now >= effective_deadline:
                    _terminate(process)
                    if deadline is not None and now >= deadline:
                        raise QAError(
                            f"overall QA timeout after {OVERALL_TIMEOUT:g}s "
                            f"while running command: {argv[0]}"
                        )
                    raise QAError(f"timeout after {timeout:g}s: {argv[0]}")
                data = key.fileobj.read1(8192)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                total += len(data)
                if total > MAX_OUTPUT_BYTES:
                    _terminate(process)
                    raise QAError(
                        f"combined output exceeded {MAX_OUTPUT_BYTES} bytes: {argv[0]}"
                    )
                chunks.append(data)
        process.wait()
    finally:
        selector.close()

    check_deadline(deadline, f"command {argv[0]}")
    output = b"".join(chunks).decode("utf-8", errors="replace")
    if process.returncode:
        detail = output.strip().replace("\n", " ")
        if len(detail) > 400:
            detail = f"{detail[:180]} ... {detail[-215:]}"
        raise QAError(
            f"command failed ({process.returncode}): {argv[0]}"
            f"{': ' + detail if detail else ''}"
        )
    return output


def _files(root: Path, suffix: str, *, deadline: float | None = None) -> Iterable[Path]:
    """Yield matching repository files in deterministic path order."""
    check_deadline(deadline, f"{suffix} file traversal")
    for directory, directories, filenames in os.walk(root):
        check_deadline(deadline, f"{suffix} file traversal")
        directories[:] = sorted(
            name for name in directories if name not in IGNORED_DIRECTORIES
        )
        for filename in sorted(filenames):
            check_deadline(deadline, f"{suffix} file traversal")
            if filename.endswith(suffix):
                yield Path(directory) / filename
    check_deadline(deadline, f"{suffix} file traversal")


def _reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise QAError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def check_json(root: Path, *, deadline: float | None = None) -> int:
    count = 0
    for path in _files(root, ".json", deadline=deadline):
        check_deadline(deadline, f"JSON parse: {path.relative_to(root)}")
        with path.open(encoding="utf-8") as handle:
            json.load(handle, object_pairs_hook=_reject_duplicates)
        check_deadline(deadline, f"JSON parse: {path.relative_to(root)}")
        count += 1
    return count


def check_jsonc(root: Path, *, deadline: float | None = None) -> int:
    count = 0
    for path in _files(root, ".jsonc", deadline=deadline):
        check_deadline(deadline, f"JSONC parse: {path.relative_to(root)}")
        load_jsonc(str(path))
        check_deadline(deadline, f"JSONC parse: {path.relative_to(root)}")
        count += 1
    return count


def check_svg(root: Path, *, deadline: float | None = None) -> int:
    count = 0
    for path in _files(root, ".svg", deadline=deadline):
        check_deadline(deadline, f"SVG parse: {path.relative_to(root)}")
        ET.parse(path)
        check_deadline(deadline, f"SVG parse: {path.relative_to(root)}")
        count += 1
    return count


def markdown_target(source: Path, target: str, root: Path) -> Path | None:
    target = urllib.parse.unquote(target.strip())
    if not target or target.startswith("#") or re.match(
        r"^(?:https?|mailto|data):", target, re.I
    ):
        return None
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target:
        return None
    return root / target.lstrip("/") if target.startswith("/") else source.parent / target


def check_markdown_links(root: Path, *, deadline: float | None = None) -> int:
    count = 0
    for source in _files(root, ".md", deadline=deadline):
        check_deadline(deadline, f"Markdown link scan: {source.relative_to(root)}")
        text = source.read_text(encoding="utf-8")
        for match in MARKDOWN_LINK.finditer(text):
            check_deadline(deadline, f"Markdown link scan: {source.relative_to(root)}")
            target = match.group(1) or match.group(2)
            candidate = markdown_target(source, target, root)
            if candidate is not None and not candidate.exists():
                relative = source.relative_to(root)
                raise QAError(f"broken local Markdown link: {relative} -> {target}")
        check_deadline(deadline, f"Markdown link scan: {source.relative_to(root)}")
        count += 1
    return count


def check_git_diff(root: Path, *, deadline: float | None = None) -> None:
    head_check = ["git", "show", "--check", "--format=", "HEAD", "--", "."]
    head_check.extend(
        path if path.startswith(":(") else f":(exclude){path}"
        for path in HEAD_WHITESPACE_EXCLUSIONS
    )
    run_command(head_check, root, deadline=deadline)
    frames = HEAD_WHITESPACE_EXCLUSIONS[1:]
    run_command(["git", "diff", "--check", "--", ".", *frames], root, deadline=deadline)
    run_command(["git", "diff", "--cached", "--check", "--", ".", *frames], root, deadline=deadline)


def run_python(
    root: Path, script: str, *args: str, deadline: float | None = None
) -> None:
    run_command([sys.executable, script, *args], root, deadline=deadline)


def run_package_checks(
    root: Path,
    workspace: Path,
    runtime: QARuntime | None = None,
    *,
    deadline: float | None = None,
) -> int:
    check_deadline(deadline, "package workspace discovery")
    selected_runtime = runtime if runtime is not None else load_qa_runtime(root, deadline=deadline)
    package_file = json.loads(
        (workspace / "package.json").read_text(encoding="utf-8"),
        object_pairs_hook=_reject_duplicates,
    )
    check_deadline(deadline, "package workspace discovery")
    packages = package_file.get("workspaces")
    if (
        not isinstance(packages, list)
        or len(packages) != len(EXPECTED_PACKAGE_WORKSPACES)
        or any(not isinstance(item, str) or not item for item in packages)
        or len(set(packages)) != len(EXPECTED_PACKAGE_WORKSPACES)
        or set(packages) != set(EXPECTED_PACKAGE_WORKSPACES)
    ):
        raise QAError(
            "plugins-v2/package.json must declare exactly twelve unique curated "
            "workspaces, including chatgpt-connector and excluding integrated-browser"
        )
    for package in sorted(packages):
        check_deadline(deadline, f"package workspace {package}")
        run_command(
            [
                str(selected_runtime.package_manager),
                "--prefix",
                str(workspace / package),
                "run",
                "check",
            ],
            root,
            deadline=deadline,
            path_override=selected_runtime.path,
        )
    return len(packages)


def discover_self_tests(
    root: Path, scripts: Path, *, deadline: float | None = None
) -> tuple[Path, ...]:
    """Fail closed if the fixed self-test manifest and repository diverge."""
    expected = tuple(scripts / name for name in SELF_TEST_NAMES)
    actual = tuple(_files(root, "-self-test.py", deadline=deadline))
    expected_set = set(expected)
    actual_set = set(actual)
    missing = sorted(
        path.relative_to(root).as_posix() for path in expected_set - actual_set
    )
    unexpected = sorted(
        path.relative_to(root).as_posix() for path in actual_set - expected_set
    )
    if missing or unexpected:
        details = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if unexpected:
            details.append(f"unexpected: {', '.join(unexpected)}")
        raise QAError(f"self-test discovery mismatch ({'; '.join(details)})")
    return expected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=None, help="repository root")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve() if args.root else Path.cwd().resolve()
    workspace = root / "platforms/linux/ubuntu/computer-use/plugins-v2"
    scripts = root / "platforms/linux/ubuntu/computer-use/scripts"
    deadline = _now() + OVERALL_TIMEOUT

    def evidence(label: str, function, *function_args):
        check_deadline(deadline, label)
        print(f"QA: {label}", flush=True)
        try:
            result = function(*function_args, deadline=deadline)
            check_deadline(deadline, label)
            return result
        except (QAError, OSError, ValueError, json.JSONDecodeError, ET.ParseError) as exc:
            raise QAError(f"{label}: {exc}") from exc

    try:
        runtime = evidence("declared QA runtime", load_qa_runtime, root)
        evidence(
            "acceptance-evidence manifest",
            run_python,
            root,
            str(scripts / "check-acceptance-evidence.py"),
            "--root",
            str(root),
        )
        evidence(
            "twelve curated v2 package checks",
            run_package_checks,
            root,
            workspace,
            runtime,
        )
        shell_files = [
            str(path)
            for path in sorted(scripts.glob("*.sh"), key=lambda path: path.as_posix())
        ]
        hook = str(root / ".githooks/pre-push")
        evidence("bash syntax", run_command, ["bash", "-n", *shell_files, hook], root)
        evidence(
            "ShellCheck",
            run_command,
            ["shellcheck", "--severity=error", *shell_files, hook],
            root,
        )
        python_files = [str(path) for path in _files(root, ".py", deadline=deadline)]
        compile_code = (
            "import pathlib,sys; "
            "[compile(pathlib.Path(p).read_text(encoding='utf-8'), p, 'exec') "
            "for p in sys.argv[1:]]"
        )
        evidence(
            "Python compile",
            run_command,
            [sys.executable, "-c", compile_code, *python_files],
            root,
        )
        self_tests = evidence(
            "complete self-test discovery", discover_self_tests, root, scripts
        )
        for name in (
            "check-skill-docs.py",
            "check-progress-tracking.py",
            "check-git-safety-policy.py",
            "check-plugin-resource-guards.py",
            "check-doc-coverage.py",
        ):
            evidence(name, run_python, root, str(scripts / name))
        for self_test in self_tests:
            evidence(self_test.name, run_python, root, str(self_test))
        evidence(
            "v2 role catalog",
            run_python,
            root,
            str(scripts / "v2-plugin-catalog.py"),
            "--catalog",
            str(root / "platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json"),
            "--root",
            str(root / "platforms/linux/ubuntu/computer-use"),
        )
        evidence("JSON parse and duplicate-key validation", check_json, root)
        evidence("JSONC parse and duplicate-key validation", check_jsonc, root)
        evidence("SVG XML parse", check_svg, root)
        evidence("local Markdown links", check_markdown_links, root)
        evidence("HEAD, unstaged, and staged git whitespace checks", check_git_diff, root)
    except QAError as exc:
        print(f"ERROR: repository QA failed: {exc}", file=sys.stderr)
        return 1
    print(
        "OK: repository QA evidence complete "
        "(acceptance evidence; 12 curated packages; shell, Python, all self-tests, policy, deployment, setup, "
        "launcher, catalog, JSON/JSONC, SVG, Markdown links, and Git diff checks)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
