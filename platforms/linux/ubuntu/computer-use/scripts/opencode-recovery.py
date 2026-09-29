#!/usr/bin/env python3
"""Provide bounded, agent-free OpenCode V2 recovery orchestration.

The native flow verifies the clone's canonical MCP runtime marker, offers a
state-bound repair preview when verification fails, and invokes the canonical
runtime helper only after an explicit one-shot apply approval. It then requests
the existing OpenCode MCP reconnect and rechecks readiness within a startup-
aware finite window. A zero exit code means only that the target reached
``connected-awaiting_read_note`` readiness; it is not full recovery,
service authentication proof, or note-readability proof. If the selected location
offers a usable connected live MCP ``read_note`` tool, the caller may make a
separate direct call and retain the final recovery decision. If that tool is
unavailable or the call fails, the result remains pending. This script never
starts a Basic Memory process and never invokes ``read_note`` itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Callable, Literal, Protocol


SCRIPT_DIR = Path(__file__).resolve().parent
CANONICAL_RUNTIME = SCRIPT_DIR / "mcp_runtime.py"
DEFAULT_PROJECT = "computer-assistant"
STARTUP_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_RECHECKS = 64
DEFAULT_RETRY_DELAY_SECONDS = 2.0
DEFAULT_DEADLINE_SECONDS = 90.0
DEFAULT_RUNTIME_TIMEOUT_SECONDS = 60.0
DEFAULT_API_TIMEOUT_SECONDS = 5.0
MAX_RECHECKS = 128
MAX_RETRY_DELAY_SECONDS = 2.0
MIN_DEADLINE_SECONDS = STARTUP_TIMEOUT_SECONDS
MAX_DEADLINE_SECONDS = 180.0
MAX_RUNTIME_TIMEOUT_SECONDS = 120.0
MAX_API_TIMEOUT_SECONDS = 60.0
MAX_SUBPROCESS_STREAM_BYTES = 64 * 1024
MAX_SUBPROCESS_TOTAL_BYTES = 128 * 1024
SUBPROCESS_READ_BYTES = 64 * 1024
SUBPROCESS_TERMINATION_SECONDS = 0.5
SUBPROCESS_CLEANUP_DEADLINE_SECONDS = 1.0
MAX_NOTE_IDENTIFIER_LENGTH = 512
MAX_PROJECT_LENGTH = 128
MAX_FINGERPRINT_BYTES = 4 * 1024 * 1024
MAX_FINGERPRINT_TIMEOUT_SECONDS = 5.0
TARGET_PROFILE = "native"
TARGET_SERVER = "basic-memory"
READINESS_STATUS = "connected-awaiting_read_note"
SUPPORTED_OPENCODE_MAJOR = 2
OPENCODE_VERSION_PATTERN = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$")


class RecoveryError(RuntimeError):
    """Raised for a bounded recovery transport or input failure."""


class RecoveryTimeout(RecoveryError):
    """Raised when a bounded API request timed out but may complete asynchronously."""


class FingerprintError(RecoveryError):
    """Raised when an approved marker/config fingerprint cannot be read safely."""


class FingerprintTimeout(RecoveryTimeout):
    """Raised when approved marker/config fingerprinting exceeds its monotonic budget."""


class RecoveryOutputOverflow(RecoveryError):
    """Raised when a bounded child process exceeds its output allowance."""


class RecoveryProcessCleanupError(RecoveryError):
    """Raised when a failed child cannot be reaped within the cleanup bound."""


class RecoveryApi(Protocol):
    """Describe the supported OpenCode V2 calls used by recovery."""

    def connect_basic_memory(self, timeout_seconds: float) -> None:
        """Connect the existing configured Basic Memory MCP entry once."""

    def location(self, timeout_seconds: float) -> object:
        """Read the location selected by this API client for binding checks."""

    def list_mcp(self, timeout_seconds: float) -> object:
        """Return the location-scoped MCP status response."""

    def list_plugins(self, timeout_seconds: float) -> object:
        """Return the location-scoped plugin status response."""


class NativeRuntimeRepair(Protocol):
    """Describe the canonical native marker verification and repair boundary."""

    def verify_native(self, timeout_seconds: float) -> bool:
        """Run the canonical native runtime command in verify-only mode."""

    def preview_native(self, timeout_seconds: float | None = None) -> "NativeRuntimePreview":
        """Return target and state digests for a later stale-state guard."""

    def apply_native(
        self,
        preview: "NativeRuntimePreview | None",
        approval: bool,
        timeout_seconds: float,
    ) -> Literal["applied", "already-verified", "rejected"]:
        """Explicitly apply after a fresh verify-only check and digest comparison."""


@dataclass(frozen=True)
class RecoveryPolicy:
    """Bound marker verification, reconnect checks, and canonical command time."""

    max_rechecks: int = DEFAULT_MAX_RECHECKS
    retry_delay_seconds: float = DEFAULT_RETRY_DELAY_SECONDS
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS
    runtime_timeout_seconds: float = DEFAULT_RUNTIME_TIMEOUT_SECONDS
    api_timeout_seconds: float = DEFAULT_API_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        """Reject unbounded or unusably small policy values."""
        if not 0 < self.retry_delay_seconds <= MAX_RETRY_DELAY_SECONDS:
            raise ValueError(f"retry_delay_seconds must be in (0, {MAX_RETRY_DELAY_SECONDS}]")
        if not MIN_DEADLINE_SECONDS <= self.deadline_seconds <= MAX_DEADLINE_SECONDS:
            raise ValueError(
                f"deadline_seconds must be between {MIN_DEADLINE_SECONDS} and {MAX_DEADLINE_SECONDS}"
            )
        required_rechecks = max(1, int(self.deadline_seconds / self.retry_delay_seconds) + 1)
        if not required_rechecks <= self.max_rechecks <= MAX_RECHECKS:
            raise ValueError(
                f"max_rechecks must cover the full deadline ({required_rechecks}) and be at most {MAX_RECHECKS}"
            )
        if not 0 < self.runtime_timeout_seconds <= MAX_RUNTIME_TIMEOUT_SECONDS:
            raise ValueError(
                f"runtime_timeout_seconds must be in (0, {MAX_RUNTIME_TIMEOUT_SECONDS}]"
            )
        if not 0 < self.api_timeout_seconds <= MAX_API_TIMEOUT_SECONDS:
            raise ValueError(f"api_timeout_seconds must be in (0, {MAX_API_TIMEOUT_SECONDS}]")


@dataclass(frozen=True)
class ServerIdentity:
    """The only service identity retained from the documented server.info response."""

    version: str
    pid: int

    def as_dict(self) -> dict[str, str | int]:
        """Return version and PID without retaining URL or temporary-path fields."""
        return {"version": self.version, "pid": self.pid}


def _validate_server_identity(identity: object) -> ServerIdentity:
    """Validate a bound service identity even across injected/test API boundaries."""
    if not isinstance(identity, ServerIdentity):
        raise RecoveryError("selected server identity is unavailable")
    if (
        not identity.version
        or len(identity.version) > 128
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in identity.version)
        or isinstance(identity.pid, bool)
        or not isinstance(identity.pid, int)
        or identity.pid <= 0
    ):
        raise RecoveryError("selected server identity is unavailable")
    version_match = OPENCODE_VERSION_PATTERN.fullmatch(identity.version)
    if version_match is None or int(version_match.group(1)) != SUPPORTED_OPENCODE_MAJOR:
        raise RecoveryError("selected server identity is unsupported")
    return identity


@dataclass(frozen=True)
class RecoveryReport:
    """Describe readiness and repair evidence without claiming read_note proof."""

    recovered: Literal[False]
    status: str
    reason: str
    reconnect_requested: bool
    status_checks: int
    read_note_proof: Literal["not-verified"]
    marker_repair: str
    target: dict[str, str]
    preview: dict[str, str] | None = None
    server_identity: dict[str, str | int] | None = None
    plugins: dict[str, object] | None = None
    ownership: str = "control-plane-only"
    qa: str = "not-run"
    screen_fallback: str = "use-screen_terminal-with-preview-apply"

    def as_dict(self) -> dict[str, object]:
        """Return the safe JSON report shape."""
        return asdict(self)


def _validate_identifier(value: str, label: str, maximum: int) -> str:
    """Validate a bounded identifier without logging or transforming it."""
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{label} must be non-empty and at most {maximum} characters")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ValueError(f"{label} must not contain control characters")
    return value


def _validate_digest(value: str, label: str) -> str:
    """Validate a caller-supplied preview digest without treating it as authority."""
    if not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value.lower()):
        raise ValueError(f"{label} must be a 64-character hexadecimal digest")
    return value.lower()


def _normalized_directory(value: str | Path) -> str:
    """Normalize one location directory for exact target comparison."""
    return str(Path(value).expanduser().resolve())


def _target_identity(directory: str | Path, project_id: str | None = None) -> dict[str, str]:
    """Return stable target labels without exposing a private path."""
    directory_digest = hashlib.sha256(_normalized_directory(directory).encode("utf-8")).hexdigest()[:16]
    identity = {
        "profile": TARGET_PROFILE,
        "server": TARGET_SERVER,
        "location": f"sha256:{directory_digest}",
    }
    if project_id:
        identity["project"] = f"sha256:{hashlib.sha256(project_id.encode('utf-8')).hexdigest()[:16]}"
    else:
        identity["project"] = "unknown"
    return identity


def _location_from_response(payload: object) -> tuple[str, str | None] | None:
    """Extract only the public directory and project identity from location.get."""
    if not isinstance(payload, dict):
        return None
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        return None
    directory = data.get("directory")
    project = data.get("project")
    if not isinstance(directory, str):
        return None
    project_id = project.get("id") if isinstance(project, dict) and isinstance(project.get("id"), str) else None
    return _normalized_directory(directory), project_id


def _server_identity_from_response(payload: object) -> ServerIdentity:
    """Extract and validate only stable version/PID from server.info."""
    if not isinstance(payload, dict):
        raise RecoveryError("selected server identity is unavailable")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        raise RecoveryError("selected server identity is unavailable")
    version = data.get("version")
    pid = data.get("pid")
    if (
        not isinstance(version, str)
        or not version.strip()
        or len(version) > 128
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in version)
        or isinstance(pid, bool)
        or not isinstance(pid, int)
        or pid <= 0
    ):
        raise RecoveryError("selected server identity is unavailable")
    return _validate_server_identity(ServerIdentity(version=version, pid=pid))


def _status_from_mcp_response(payload: object) -> str:
    """Extract a bounded Basic Memory status from an OpenCode API response."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return "unavailable"
    for item in payload["data"]:
        if not isinstance(item, dict) or item.get("name") != "basic-memory":
            continue
        status = item.get("status")
        if isinstance(status, dict) and isinstance(status.get("status"), str):
            value = status["status"]
            if value in {"connected", "pending", "failed", "needs_auth", "disabled"}:
                return value
        return "unknown"
    return "missing"


def _configured_mcp_status(payload: object, name: str) -> str:
    """Return the configured target entry state without trusting it as proof."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return "unavailable"
    matches = [item for item in payload["data"] if isinstance(item, dict) and item.get("name") == name]
    if len(matches) != 1:
        return "missing" if not matches else "duplicate"
    for item in matches:
        if not isinstance(item, dict) or item.get("name") != name:
            continue
        status = item.get("status")
        if isinstance(status, dict) and isinstance(status.get("status"), str):
            return status["status"]
        return "unknown"
    return "missing"


def _summarize_mcp_response(payload: object) -> dict[str, object]:
    """Return names and state only, excluding MCP diagnostics and secrets."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return {"status": "unavailable", "servers": []}
    servers: list[dict[str, str]] = []
    for item in payload["data"][:128]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        status = item.get("status")
        state = status.get("status") if isinstance(status, dict) else "unknown"
        servers.append({"name": item["name"][:128], "status": state if isinstance(state, str) else "unknown"})
    return {"status": "ok", "servers": servers, "truncated": len(payload["data"]) > 128}


def _summarize_plugin_response(payload: object) -> dict[str, object]:
    """Return bounded plugin identities and states without failure details."""
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        return {"status": "unavailable", "plugins": []}
    plugins: list[dict[str, str]] = []
    for item in payload["data"][:128]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        state = item.get("state")
        value = state.get("status") if isinstance(state, dict) else "unknown"
        plugins.append({"id": item["id"][:256], "status": value if isinstance(value, str) else "unknown"})
    return {"status": "ok", "plugins": plugins, "truncated": len(payload["data"]) > 128}


def _unavailable_plugin_summary() -> dict[str, object]:
    """Return bounded plugin-list failure evidence without exposing child errors."""
    return {
        "status": "unavailable",
        "plugins": [],
        "reason": "live-plugin-list-unavailable",
    }


def _remaining(deadline: float, clock: Callable[[], float]) -> float:
    """Return remaining time until an absolute monotonic deadline."""
    return max(0.0, deadline - clock())


def _assert_bound_server_identity(api: object, timeout_seconds: float) -> None:
    """Recheck the selected service when the API client supports identity binding."""
    checker = getattr(api, "assert_server_identity", None)
    if callable(checker):
        if timeout_seconds <= 0:
            raise RecoveryTimeout("selected service identity")
        checker(timeout_seconds)


@dataclass(frozen=True)
class BoundedSubprocessResult:
    """Contain the bounded stdout/stderr result of one fixed-argv child."""

    returncode: int
    stdout: bytes
    stderr: bytes


def _close_process_pipes(process: subprocess.Popen[bytes]) -> None:
    """Close child pipes without retaining output after a bounded run."""
    for stream in (process.stdout, process.stderr):
        if stream is None:
            continue
        try:
            stream.close()
        except OSError:
            pass


def _terminate_and_reap(
    process: subprocess.Popen[bytes],
    *,
    clock: Callable[[], float] | None = None,
) -> None:
    """Terminate and reap a failed child within one strict total deadline."""
    clock = clock or time.monotonic
    if process.poll() is not None:
        return
    deadline = clock() + SUBPROCESS_CLEANUP_DEADLINE_SECONDS
    last_error: BaseException | None = None

    try:
        process.terminate()
    except OSError as error:
        last_error = error

    def wait_bounded(maximum: float) -> bool:
        """Wait only for the remaining bounded cleanup interval."""
        nonlocal last_error
        remaining = deadline - clock()
        if remaining <= 0:
            return False
        try:
            process.wait(timeout=min(maximum, remaining))
        except subprocess.TimeoutExpired as error:
            last_error = error
            return False
        except (OSError, subprocess.SubprocessError) as error:
            last_error = error
            return False
        return True

    if wait_bounded(SUBPROCESS_TERMINATION_SECONDS):
        return

    try:
        process.kill()
    except OSError as error:
        last_error = error
    if wait_bounded(SUBPROCESS_TERMINATION_SECONDS):
        return

    if last_error is not None:
        raise RecoveryProcessCleanupError("failed child could not be reaped within the cleanup deadline") from last_error
    raise RecoveryProcessCleanupError("failed child could not be reaped within the cleanup deadline")


def _run_bounded_subprocess(
    arguments: list[str],
    timeout_seconds: float,
    *,
    cwd: Path,
) -> BoundedSubprocessResult:
    """Run fixed argv with concurrent, bounded stdout/stderr capture.

    Output is consumed from both pipes as the child runs. An overflow or
    timeout terminates and reaps the child, and no partial output is returned.
    """
    if timeout_seconds <= 0:
        raise RecoveryTimeout("bounded child process")
    try:
        process = subprocess.Popen(
            arguments,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            close_fds=True,
        )
    except (FileNotFoundError, PermissionError, OSError) as error:
        raise RecoveryError("bounded child process could not start") from error

    selector = selectors.DefaultSelector()
    streams: dict[int, tuple[str, object]] = {}
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        if process.stdout is None or process.stderr is None:
            raise RecoveryError("bounded child process pipes were unavailable")
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            os.set_blocking(stream.fileno(), False)
            streams[stream.fileno()] = (name, stream)
            selector.register(stream, selectors.EVENT_READ, stream.fileno())

        total_bytes = 0
        deadline = time.monotonic() + timeout_seconds
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RecoveryTimeout("bounded child process")
            events = selector.select(remaining)
            if not events:
                raise RecoveryTimeout("bounded child process")
            for key, _ in events:
                file_descriptor = int(key.data)
                name, stream = streams[file_descriptor]
                buffer = buffers[name]
                try:
                    chunk = os.read(file_descriptor, SUBPROCESS_READ_BYTES)
                except BlockingIOError:
                    continue
                if not chunk:
                    try:
                        selector.unregister(stream)
                    except (KeyError, ValueError):
                        pass
                    stream.close()
                    continue
                if (
                    len(buffer) + len(chunk) > MAX_SUBPROCESS_STREAM_BYTES
                    or total_bytes + len(chunk) > MAX_SUBPROCESS_TOTAL_BYTES
                ):
                    raise RecoveryOutputOverflow(f"bounded child {name} output exceeded its limit")
                buffer.extend(chunk)
                total_bytes += len(chunk)

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RecoveryTimeout("bounded child process")
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired as error:
            raise RecoveryTimeout("bounded child process") from error
        return BoundedSubprocessResult(
            returncode=returncode,
            stdout=bytes(buffers["stdout"]),
            stderr=bytes(buffers["stderr"]),
        )
    except (RecoveryTimeout, RecoveryOutputOverflow):
        _terminate_and_reap(process)
        raise
    except RecoveryError:
        _terminate_and_reap(process)
        raise
    except (OSError, subprocess.SubprocessError) as error:
        _terminate_and_reap(process)
        raise RecoveryError("bounded child process failed") from error
    finally:
        selector.close()
        _close_process_pipes(process)


def _check_fingerprint_deadline(deadline: float, clock: Callable[[], float]) -> None:
    """Refuse more fingerprint work once its monotonic deadline expires."""
    if clock() >= deadline:
        raise FingerprintTimeout("approved marker/config fingerprint")


def _hash_path(
    path: Path,
    digest: hashlib._Hash,
    budget: list[int],
    label: str,
    *,
    deadline: float,
    clock: Callable[[], float],
) -> None:
    """Hash one approved regular file within a deadline and no-follow size/race bounds."""
    _check_fingerprint_deadline(deadline, clock)
    digest.update(label.encode("utf-8"))
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        digest.update(b":missing")
        return
    except OSError:
        raise FingerprintError("approved fingerprint input is unreadable")
    _check_fingerprint_deadline(deadline, clock)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise FingerprintError("approved fingerprint input is not a regular file")
    if metadata.st_size > budget[0] or metadata.st_size > MAX_FINGERPRINT_BYTES:
        raise FingerprintError("approved fingerprint input exceeds its bounded size")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise FingerprintError("approved fingerprint input could not be opened safely") from error
    try:
        _check_fingerprint_deadline(deadline, clock)
        opened = os.fstat(descriptor)
        if (
            opened.st_dev != metadata.st_dev
            or opened.st_ino != metadata.st_ino
            or opened.st_size != metadata.st_size
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_size > budget[0]
        ):
            raise FingerprintError("approved fingerprint input changed before reading")
        remaining = opened.st_size
        digest.update(b":file:")
        while remaining:
            _check_fingerprint_deadline(deadline, clock)
            chunk = os.read(descriptor, min(65_536, remaining))
            _check_fingerprint_deadline(deadline, clock)
            if not chunk:
                raise FingerprintError("approved fingerprint input ended early")
            digest.update(chunk)
            remaining -= len(chunk)
        _check_fingerprint_deadline(deadline, clock)
        final = os.fstat(descriptor)
        _check_fingerprint_deadline(deadline, clock)
        if final.st_dev != opened.st_dev or final.st_ino != opened.st_ino or final.st_size != opened.st_size:
            raise FingerprintError("approved fingerprint input changed while reading")
        budget[0] -= opened.st_size
    except OSError as error:
        raise FingerprintError("approved fingerprint input could not be read safely") from error
    finally:
        os.close(descriptor)


def _native_state_fingerprints(
    timeout_seconds: float = MAX_FINGERPRINT_TIMEOUT_SECONDS,
    *,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[str, str]:
    """Return policy and native marker/config digests within a shared time bound."""
    if not 0 < timeout_seconds <= MAX_FINGERPRINT_TIMEOUT_SECONDS:
        raise FingerprintTimeout("approved marker/config fingerprint")
    deadline = clock() + timeout_seconds
    policy_digest = hashlib.sha256()
    _hash_path(
        SCRIPT_DIR.parent / "config" / "mcp-versions.json",
        policy_digest,
        [MAX_FINGERPRINT_BYTES],
        "policy",
        deadline=deadline,
        clock=clock,
    )
    state_digest = hashlib.sha256()
    root = Path(os.environ.get("OPENCODE_MCP_NATIVE_ROOT", str(Path.home() / ".local" / "share" / "opencode" / "mcp")))
    budget = [MAX_FINGERPRINT_BYTES]
    _hash_path(root / "provisioned.json", state_digest, budget, "marker", deadline=deadline, clock=clock)
    _hash_path(
        root / "basic-memory" / "config" / "config.json",
        state_digest,
        budget,
        "basic-memory-config",
        deadline=deadline,
        clock=clock,
    )
    _check_fingerprint_deadline(deadline, clock)
    return policy_digest.hexdigest(), state_digest.hexdigest()


@dataclass(frozen=True)
class NativeRuntimePreview:
    """Describe the canonical target state observed by a repair preview."""

    target: str
    profile: str
    policy_digest: str
    state_digest: str


class CanonicalNativeRuntime:
    """Run the clone's canonical native marker verifier and repair command."""

    target = "canonical-mcp-runtime-marker"
    profile = "native"

    def __init__(
        self,
        script: Path = CANONICAL_RUNTIME,
        *,
        runner: Callable[[list[str], float], bool] | None = None,
        fingerprints: Callable[[], tuple[str, str]] | None = None,
        clock: Callable[[], float] | None = None,
        before_apply: Callable[[float], None] | None = None,
    ) -> None:
        """Store the canonical script boundary without starting any MCP server."""
        self.script = script
        self.runner = runner or self._run
        self.clock = clock or time.monotonic
        self.fingerprints = fingerprints
        self.before_apply = before_apply

    def _fingerprint_snapshot(self, timeout_seconds: float) -> tuple[str, str]:
        """Read the state snapshot within one bounded monotonic fingerprint window."""
        budget = min(timeout_seconds, MAX_FINGERPRINT_TIMEOUT_SECONDS)
        if budget <= 0:
            raise FingerprintTimeout("approved marker/config fingerprint")
        deadline = self.clock() + budget
        if self.fingerprints is None:
            snapshot = _native_state_fingerprints(budget, clock=self.clock)
        else:
            snapshot = self.fingerprints()
        _check_fingerprint_deadline(deadline, self.clock)
        return snapshot

    def _run(self, arguments: list[str], timeout_seconds: float) -> bool:
        """Run only mcp_runtime.py and discard its potentially sensitive output."""
        completed = _run_bounded_subprocess(
            [sys.executable, str(self.script), *arguments],
            cwd=SCRIPT_DIR.parents[2],
            timeout_seconds=max(0.001, timeout_seconds),
        )
        return completed.returncode == 0

    def verify_native(self, timeout_seconds: float) -> bool:
        """Run native mcp-runtime verification without applying or editing state."""
        return self.runner(["mcp-runtime", "--profile", self.profile, "--quiet"], timeout_seconds)

    def preview_native(self, timeout_seconds: float | None = None) -> NativeRuntimePreview:
        """Capture target and current policy/marker digests without applying."""
        policy_digest, state_digest = self._fingerprint_snapshot(
            MAX_FINGERPRINT_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
        )
        return NativeRuntimePreview(self.target, self.profile, policy_digest, state_digest)

    def apply_native(
        self,
        preview: NativeRuntimePreview | None,
        approval: bool,
        timeout_seconds: float,
    ) -> Literal["applied", "already-verified", "rejected"]:
        """Freshly verify and apply only when the explicit preview state remains current."""
        deadline = self.clock() + max(0.0, timeout_seconds)

        def remaining() -> float:
            """Return the one apply operation's remaining monotonic budget."""
            return max(0.0, deadline - self.clock())

        if not approval or preview is None:
            return "rejected"
        if preview.target != self.target or preview.profile != self.profile:
            return "rejected"
        if remaining() <= 0:
            return "rejected"
        try:
            policy_digest, state_digest = self._fingerprint_snapshot(remaining())
        except FingerprintTimeout:
            return "rejected"
        if remaining() <= 0:
            return "rejected"
        if (
            preview.policy_digest != policy_digest
            or preview.state_digest != state_digest
        ):
            return "rejected"
        verify_timeout = remaining()
        if verify_timeout <= 0:
            return "rejected"
        if self.verify_native(verify_timeout):
            if remaining() <= 0:
                return "rejected"
            return "already-verified"
        if self.before_apply is not None:
            identity_timeout = remaining()
            if identity_timeout <= 0:
                return "rejected"
            try:
                self.before_apply(identity_timeout)
            except (RecoveryError, OSError, subprocess.SubprocessError):
                return "rejected"
            if remaining() <= 0:
                return "rejected"
        apply_timeout = remaining()
        if apply_timeout <= 0:
            return "rejected"
        applied = self.runner(
            ["mcp-runtime", "--profile", self.profile, "--apply", "--quiet"], apply_timeout
        )
        return "applied" if applied and remaining() > 0 else "rejected"


def recover_basic_memory(
    api: RecoveryApi,
    identifier: str = "readiness-only",
    project: str = DEFAULT_PROJECT,
    policy: RecoveryPolicy = RecoveryPolicy(),
    *,
    runtime: NativeRuntimeRepair | None = None,
    marker_action: Literal["preview", "apply"] = "preview",
    preview: NativeRuntimePreview | None = None,
    approval: bool = False,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> RecoveryReport:
    """Repair canonical native state, reconnect once, and await caller proof.

    ``identifier`` and ``project`` are bounded internal labels for callers that
    embed this function; they do not select, read, or verify note content. This
    function deliberately has no read-note callback. A connected MCP
    status is only readiness; the caller may invoke a usable connected live
    MCP ``read_note`` tool belonging to the selected location separately. If
    that tool is unavailable or the call fails, the caller must leave recovery
    pending.
    """
    _validate_identifier(identifier, "note identifier", MAX_NOTE_IDENTIFIER_LENGTH)
    _validate_identifier(project, "project", MAX_PROJECT_LENGTH)
    if marker_action not in {"preview", "apply"}:
        raise ValueError("marker_action must be preview or apply")
    runtime = runtime or CanonicalNativeRuntime(
        before_apply=lambda timeout: _assert_bound_server_identity(
            api,
            min(policy.api_timeout_seconds, timeout),
        ),
    )
    requested_directory = getattr(api, "directory", None)
    if not isinstance(requested_directory, (str, Path)):
        target = {"profile": TARGET_PROFILE, "server": TARGET_SERVER, "location": "unknown", "project": "unknown"}
    else:
        target = _target_identity(requested_directory)
    started = clock()
    deadline = started + policy.deadline_seconds

    def remaining() -> float:
        """Return the remaining overall recovery budget."""
        return _remaining(deadline, clock)

    def report(
        status: str,
        reason: str,
        status_checks: int,
        *,
        reconnect_requested: bool = False,
        marker_repair: str = "not-run",
        preview: NativeRuntimePreview | None = None,
    ) -> RecoveryReport:
        """Build a fail-closed report that never claims note proof."""
        return RecoveryReport(
            recovered=False,
            status=status,
            reason=reason,
            reconnect_requested=reconnect_requested,
            status_checks=status_checks,
            read_note_proof="not-verified",
            marker_repair=marker_repair,
            target=target,
            **({"preview": asdict(preview)} if preview is not None else {}),
        )

    location = getattr(api, "location", None)
    if not callable(location) or not isinstance(requested_directory, (str, Path)):
        return report("target-location-unavailable", "selected-target-location-is-unavailable", 0)
    try:
        location_value = _location_from_response(location(min(policy.api_timeout_seconds, remaining())))
    except (RecoveryTimeout, RecoveryError, OSError, subprocess.SubprocessError):
        location_value = None
    if location_value is None:
        return report("target-location-unavailable", "selected-target-location-is-unknown", 0)
    actual_directory, project_id = location_value
    if actual_directory != _normalized_directory(requested_directory):
        return report("target-location-mismatch", "selected-target-location-does-not-match-request", 0)
    target = _target_identity(requested_directory, project_id)
    if remaining() <= 0:
        return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-marker-verification", 0)

    marker_verified = False
    try:
        runtime_timeout = min(policy.runtime_timeout_seconds, remaining())
        if runtime_timeout <= 0:
            return report("marker-verification-timeout", "canonical-marker-verification-budget-expired", 0, marker_repair="verification-timeout")
        marker_verified = runtime.verify_native(runtime_timeout)
        if remaining() <= 0:
            return report("marker-verification-timeout", "canonical-marker-verification-exceeded-recovery-deadline", 0, marker_repair="verification-timeout")
    except RecoveryOutputOverflow:
        return report(
            "marker-verification-output-overflow",
            "canonical-marker-output-limit-exceeded",
            0,
            marker_repair="verification-output-overflow",
        )
    except RecoveryProcessCleanupError:
        return report(
            "marker-verification-cleanup-failed",
            "canonical-marker-child-cleanup-failed",
            0,
            marker_repair="verification-cleanup-failed",
        )
    except RecoveryTimeout:
        return report(
            "marker-verification-timeout",
            "canonical-marker-verification-timed-out",
            0,
            marker_repair="verification-timeout",
        )
    except (RecoveryError, OSError, subprocess.SubprocessError):
        return report(
            "marker-verification-failed",
            "canonical-marker-verification-failed",
            0,
            marker_repair="verification-failed",
        )
    if not marker_verified:
        if remaining() <= 0:
            return report("marker-verification-timeout", "canonical-marker-verification-budget-expired", 0, marker_repair="verification-timeout")
        if marker_action != "apply":
            try:
                preview = runtime.preview_native(min(policy.runtime_timeout_seconds, remaining()))
            except (RecoveryError, OSError, subprocess.SubprocessError):
                return report("marker-repair-unavailable", "canonical-marker-verification-failed", 0, marker_repair="preview-failed")
            return report(
                "marker-repair-required",
                "explicit-marker-repair-preview-required",
                0,
                marker_repair="preview-required",
                preview=preview,
            )
        if not approval or preview is None:
            return report("marker-repair-approval-required", "explicit-apply-approval-and-preview-state-required", 0, marker_repair="approval-required")
        if remaining() <= 0:
            return report("marker-repair-failed", "canonical-marker-apply-budget-expired", 0, marker_repair="apply-timeout")
        try:
            identity_timeout = min(policy.api_timeout_seconds, remaining())
            _assert_bound_server_identity(api, identity_timeout)
            apply_timeout = min(policy.runtime_timeout_seconds, remaining())
            if apply_timeout <= 0:
                return report("marker-repair-failed", "canonical-marker-apply-budget-expired", 0, marker_repair="apply-timeout")
            applied = runtime.apply_native(preview, approval, apply_timeout)
            if remaining() > 0:
                _assert_bound_server_identity(api, min(policy.api_timeout_seconds, remaining()))
        except RecoveryOutputOverflow:
            return report(
                "marker-verification-output-overflow",
                "canonical-marker-output-limit-exceeded-before-apply",
                0,
                marker_repair="apply-verification-output-overflow",
            )
        except RecoveryProcessCleanupError:
            return report(
                "marker-verification-cleanup-failed",
                "canonical-marker-child-cleanup-failed-before-apply",
                0,
                marker_repair="apply-verification-cleanup-failed",
            )
        except RecoveryTimeout:
            return report(
                "marker-verification-timeout",
                "canonical-marker-verification-timed-out-before-apply",
                0,
                marker_repair="apply-verification-timeout",
            )
        except (RecoveryError, OSError, subprocess.SubprocessError):
            applied = False
        if applied not in {"applied", "already-verified"}:
            return report("marker-repair-rejected", "preview-state-stale-or-canonical-apply-failed", 0, marker_repair="apply-rejected")
        if remaining() <= 0:
            return report("marker-repair-failed", "canonical-marker-apply-exceeded-recovery-deadline", 0, marker_repair="apply-timeout")
        try:
            postcheck_timeout = min(policy.runtime_timeout_seconds, remaining())
            if postcheck_timeout <= 0:
                return report("marker-repair-failed", "post-apply-marker-verification-budget-expired", 0, marker_repair="post-apply-verification-timeout")
            marker_verified = runtime.verify_native(postcheck_timeout)
            if remaining() <= 0:
                return report("marker-repair-failed", "post-apply-marker-verification-exceeded-recovery-deadline", 0, marker_repair="post-apply-verification-timeout")
        except RecoveryOutputOverflow:
            return report(
                "marker-repair-failed",
                "post-apply-marker-output-limit-exceeded",
                0,
                marker_repair="post-apply-output-overflow",
            )
        except RecoveryProcessCleanupError:
            return report(
                "marker-repair-failed",
                "post-apply-marker-child-cleanup-failed",
                0,
                marker_repair="post-apply-cleanup-failed",
            )
        except RecoveryTimeout:
            return report(
                "marker-repair-failed",
                "post-apply-marker-verification-timed-out",
                0,
                marker_repair="post-apply-verification-timeout",
            )
        except (RecoveryError, OSError, subprocess.SubprocessError):
            marker_verified = False
        if not marker_verified:
            return report("marker-repair-failed", "post-apply-marker-verification-failed", 0, marker_repair="post-apply-verify-failed")

    if remaining() <= 0:
        return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-status-check", 0, marker_repair="verified")

    status_checks = 0
    try:
        configured = api.list_mcp(min(policy.api_timeout_seconds, remaining()))
        configured_status = _configured_mcp_status(configured, TARGET_SERVER)
    except (RecoveryError, OSError, subprocess.SubprocessError):
        return report("configured-entry-unavailable", "configured-basic-memory-entry-could-not-be-verified", status_checks, marker_repair="verified")
    status_checks += 1
    if remaining() <= 0:
        return report("startup-deadline-exceeded", "recovery-deadline-exceeded-after-status-check", status_checks, marker_repair="verified")
    if configured_status == "connected":
        return report(
            READINESS_STATUS,
            "caller-must-verify-selected-location-read_note-if-available",
            status_checks,
            reconnect_requested=False,
            marker_repair="verified",
        )
    if configured_status in {"missing", "disabled", "duplicate", "unavailable", "unknown"}:
        return report(configured_status, "configured-basic-memory-entry-is-not-connectable", status_checks, marker_repair="verified")

    if remaining() <= 0:
        return report("startup-deadline-exceeded", "recovery-deadline-exceeded-before-reconnect", status_checks, marker_repair="verified")
    connect_attempted = True
    try:
        api.connect_basic_memory(min(policy.api_timeout_seconds, remaining()))
    except RecoveryTimeout:
        pass
    except (RecoveryError, OSError, subprocess.SubprocessError):
        return report("reconnect-failed", "supported-basic-memory-reconnect-failed", status_checks, marker_repair="verified")
    if remaining() <= 0:
        return report("startup-deadline-exceeded", "recovery-deadline-exceeded-after-reconnect", status_checks, reconnect_requested=connect_attempted, marker_repair="verified")

    last_status = "unavailable"
    rechecks = 0
    while rechecks < policy.max_rechecks and remaining() > 0:
        timeout_seconds = min(policy.api_timeout_seconds, _remaining(deadline, clock))
        if timeout_seconds <= 0:
            break
        try:
            payload = api.list_mcp(timeout_seconds)
            last_status = _configured_mcp_status(payload, TARGET_SERVER)
        except (RecoveryError, OSError, subprocess.SubprocessError):
            last_status = "unavailable"
        status_checks += 1
        rechecks += 1
        if remaining() <= 0:
            if last_status == "connected":
                last_status = "startup-deadline-exceeded"
            break
        if last_status == "connected":
            return report(
                READINESS_STATUS,
                "caller-must-verify-selected-location-read_note-if-available",
                status_checks,
                reconnect_requested=connect_attempted,
                marker_repair="verified",
            )

        left = remaining()
        if left <= 0:
            break
        sleep(min(policy.retry_delay_seconds, left))

    return report(
        last_status,
        "status-recheck-timeout-without-direct-read_note",
        status_checks,
        reconnect_requested=connect_attempted,
        marker_repair="verified",
    )


class OpenCodeCliApi:
    """Call only supported OpenCode V2 API operations on one selected service."""

    def __init__(self, binary: str, directory: Path, server: str | None = None) -> None:
        """Store an argv-only API client bound to one explicit service URL."""
        self.binary = binary
        self.directory = directory
        self.server = server
        self._bound_server_identity: ServerIdentity | None = None

    def _call(
        self,
        operation: str,
        timeout_seconds: float,
        *,
        parameter_server: str | None = None,
        include_location: bool = True,
    ) -> object:
        """Run one bounded operation against the exact selected service."""
        if timeout_seconds <= 0:
            raise RecoveryError("operation budget expired")
        if (
            not isinstance(self.server, str)
            or not self.server
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in self.server)
        ):
            raise RecoveryError("an explicit OpenCode server is required")
        arguments = [self.binary, "api"]
        arguments.extend(["--server", self.server])
        if include_location:
            arguments.extend(["--param", f"location[directory]={self.directory}"])
        if parameter_server is not None:
            arguments.extend(["--param", f"server={parameter_server}"])
        arguments.append(operation)
        try:
            completed = _run_bounded_subprocess(
                arguments,
                timeout_seconds=max(0.001, timeout_seconds),
                cwd=self.directory,
            )
        except RecoveryTimeout as error:
            raise RecoveryTimeout("OpenCode API operation timed out") from error
        except RecoveryError:
            raise
        if completed.returncode != 0:
            raise RecoveryError("OpenCode API operation failed")
        try:
            stdout = completed.stdout.decode("utf-8")
        except UnicodeDecodeError as error:
            raise RecoveryError("OpenCode API returned invalid UTF-8") from error
        if not stdout.strip():
            return None
        try:
            return json.loads(stdout)
        except json.JSONDecodeError as error:
            raise RecoveryError("OpenCode API returned invalid JSON") from error

    def server_info(self, timeout_seconds: float) -> ServerIdentity:
        """Read GET /api/info through server.info without retaining URL fields."""
        return _server_identity_from_response(
            self._call("server.info", timeout_seconds, include_location=False)
        )

    def bind_server_identity(self, identity: ServerIdentity) -> None:
        """Bind later mutating API calls to the initially selected service process."""
        self._bound_server_identity = _validate_server_identity(identity)

    def assert_server_identity(self, timeout_seconds: float) -> None:
        """Fail before a mutation if the explicitly selected service has changed."""
        if self._bound_server_identity is None:
            return
        if timeout_seconds <= 0:
            raise RecoveryTimeout("selected service identity")
        if self.server_info(timeout_seconds) != self._bound_server_identity:
            raise RecoveryError("selected OpenCode service identity changed before mutation")

    def connect_basic_memory(self, timeout_seconds: float) -> None:
        """Connect once, rechecking service identity immediately before and after."""
        deadline = time.monotonic() + max(0.0, timeout_seconds)

        def remaining() -> float:
            """Return the time left for identity checks and the single connect."""
            return max(0.0, deadline - time.monotonic())

        self.assert_server_identity(remaining())
        connect_timeout = remaining()
        if connect_timeout <= 0:
            raise RecoveryTimeout("Basic Memory reconnect")
        self._call("experimental.mcp.connect", connect_timeout, parameter_server="basic-memory")
        self.assert_server_identity(remaining())

    def location(self, timeout_seconds: float) -> object:
        """Read the location selected by this client for directory binding."""
        return self._call("location.get", timeout_seconds)

    def list_mcp(self, timeout_seconds: float) -> object:
        """Read the location-scoped MCP status."""
        return self._call("mcp.list", timeout_seconds)

    def list_plugins(self, timeout_seconds: float) -> object:
        """Read the location-scoped plugin status."""
        return self._call("plugin.list", timeout_seconds)


def classify_caller_read_note_result(result: object, identifier: str) -> Literal[
    "malformed-or-unmatched", "structured-identity-match-unproven"
]:
    """Classify a caller-supplied result without establishing tool provenance.

    A text-only response, boolean, or error is rejected. The structured shape
    can help a caller inspect its own direct MCP result, but this module never
    treats the classification as authentication/content proof or changes its recovery
    report based on it.
    """
    if not isinstance(result, dict) or result.get("isError") is True:
        return "malformed-or-unmatched"
    structured = result.get("structuredContent")
    if not isinstance(structured, dict):
        return "malformed-or-unmatched"
    note = structured.get("note") if isinstance(structured.get("note"), dict) else structured
    if not isinstance(note, dict):
        return "malformed-or-unmatched"
    identities = (note.get("identifier"), note.get("permalink"), note.get("memory_url"), note.get("uri"), note.get("title"))
    if not any(candidate == identifier for candidate in identities):
        return "malformed-or-unmatched"
    if not isinstance(note.get("content"), str) or not note["content"].strip():
        return "malformed-or-unmatched"
    content = result.get("content")
    if not isinstance(content, list) or not any(
        isinstance(item, dict)
        and item.get("type") == "text"
        and isinstance(item.get("text"), str)
        and item["text"].strip()
        for item in content
    ):
        return "malformed-or-unmatched"
    return "structured-identity-match-unproven"


def diagnose(
    api: RecoveryApi,
    timeout_seconds: float,
    *,
    plugin_summary: dict[str, object] | None = None,
) -> dict[str, object]:
    """Collect safe MCP/plugin diagnostics and explicit control-plane limits."""
    try:
        mcp = _summarize_mcp_response(api.list_mcp(timeout_seconds))
    except (RecoveryError, OSError, subprocess.SubprocessError):
        mcp = {"status": "unavailable", "servers": []}
    if plugin_summary is None:
        try:
            plugins = _summarize_plugin_response(api.list_plugins(timeout_seconds))
        except (RecoveryError, OSError, subprocess.SubprocessError):
            plugins = {"status": "unavailable", "plugins": []}
    else:
        plugins = plugin_summary
    diagnostic_status = "ok" if mcp.get("status") == "ok" and plugins.get("status") == "ok" else "unavailable"
    return {
        "status": diagnostic_status,
        "mcp": mcp,
        "plugins": plugins,
        "ownership": {
            "status": "control-plane-only",
            "next": "Use task_ownership_status inside the owning OpenCode session.",
            "repair": "never-bypass",
        },
        "qa": {
            "status": "not-run",
            "next": "Use repo_qa_gate with its normal preview/apply approval flow.",
            "auto_approve": False,
        },
        "screen_fallback": {
            "status": "delegated",
            "next": "Use screen_terminal with its bounded preview/apply token for TUI-only steps.",
            "raw_screen_commands": False,
        },
    }


def _identity_failure_report(
    directory: Path,
    status: str,
    reason: str,
    *,
    plugins: dict[str, object] | None = None,
    server_identity: ServerIdentity | None = None,
) -> RecoveryReport:
    """Build a recovery failure without exposing service or filesystem paths."""
    return RecoveryReport(
        recovered=False,
        status=status,
        reason=reason,
        reconnect_requested=False,
        status_checks=0,
        read_note_proof="not-verified",
        marker_repair="not-run",
        target=_target_identity(directory),
        server_identity=server_identity.as_dict() if server_identity is not None else None,
        plugins=plugins,
    )


def _identity_failure_diagnostics(
    status: str,
    reason: str,
    *,
    plugins: dict[str, object] | None = None,
    server_identity: ServerIdentity | None = None,
) -> dict[str, object]:
    """Build a safe diagnosis for missing or changed service identity."""
    return {
        "status": status,
        "reason": reason,
        "server_identity": server_identity.as_dict() if server_identity is not None else {"status": "unavailable"},
        "mcp": {"status": "unavailable", "servers": []},
        "plugins": plugins or {"status": "unavailable", "plugins": []},
        "ownership": {
            "status": "control-plane-only",
            "next": "Use task_ownership_status inside the owning OpenCode session.",
            "repair": "never-bypass",
        },
        "qa": {
            "status": "not-run",
            "next": "Use repo_qa_gate with its normal preview/apply approval flow.",
            "auto_approve": False,
        },
        "screen_fallback": {
            "status": "delegated",
            "next": "Use screen_terminal with its bounded preview/apply token for TUI-only steps.",
            "raw_screen_commands": False,
        },
    }


def _common_arguments(parser: argparse.ArgumentParser) -> None:
    """Add non-secret OpenCode API client options to a subcommand."""
    parser.add_argument("--opencode-bin", default=os.environ.get("OPENCODE_V2_BIN", "opencode"), help="OpenCode V2 executable")
    parser.add_argument("--server", required=True, help="Exact selected OpenCode service URL; never inferred from the default service")
    parser.add_argument("--directory", type=Path, required=True, help="Exact selected location directory sent to the V2 API")
    parser.add_argument("--api-timeout", type=float, default=DEFAULT_API_TIMEOUT_SECONDS, help="Per-API-call timeout in seconds")


def _parser() -> argparse.ArgumentParser:
    """Build the bounded recovery CLI parser."""
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    diagnose_parser = subcommands.add_parser("diagnose", help="Read MCP/plugin state and show safe control-plane handoffs")
    _common_arguments(diagnose_parser)
    recover_parser = subcommands.add_parser(
        "basic-memory",
        help="Verify/repair native MCP state, reconnect once, and await optional selected-location read_note verification (exit 0 is readiness only)",
    )
    _common_arguments(recover_parser)
    recover_parser.add_argument("--max-rechecks", type=int, default=DEFAULT_MAX_RECHECKS)
    recover_parser.add_argument("--retry-delay", type=float, default=DEFAULT_RETRY_DELAY_SECONDS)
    recover_parser.add_argument("--deadline", type=float, default=DEFAULT_DEADLINE_SECONDS)
    recover_parser.add_argument("--runtime-timeout", type=float, default=DEFAULT_RUNTIME_TIMEOUT_SECONDS)
    recover_parser.add_argument("--apply", action="store_true", help="Explicitly apply a fresh preview's canonical native marker repair")
    recover_parser.add_argument("--expected-policy-digest", help="Policy digest returned by the marker preview")
    recover_parser.add_argument("--expected-state-digest", help="Marker/config digest returned by the marker preview")
    recover_parser.add_argument("--approval", action="store_true", help="Explicitly approve the canonical native marker apply")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run diagnostics or Basic Memory recovery and emit bounded JSON."""
    arguments = _parser().parse_args(argv)
    directory = arguments.directory.resolve()
    if not directory.is_dir():
        raise SystemExit("directory must be an existing directory")
    if arguments.api_timeout <= 0 or arguments.api_timeout > MAX_API_TIMEOUT_SECONDS:
        raise SystemExit(f"api-timeout must be in (0, {MAX_API_TIMEOUT_SECONDS}]")

    policy: RecoveryPolicy | None = None
    preview: NativeRuntimePreview | None = None
    if arguments.command != "diagnose":
        try:
            policy = RecoveryPolicy(
                max_rechecks=arguments.max_rechecks,
                retry_delay_seconds=arguments.retry_delay,
                deadline_seconds=arguments.deadline,
                runtime_timeout_seconds=arguments.runtime_timeout,
                api_timeout_seconds=arguments.api_timeout,
            )
            if (arguments.expected_policy_digest is None) != (arguments.expected_state_digest is None):
                raise ValueError("expected policy and state digests must be supplied together")
            if arguments.expected_policy_digest is not None and arguments.expected_state_digest is not None:
                preview = NativeRuntimePreview(
                    target="canonical-mcp-runtime-marker",
                    profile=TARGET_PROFILE,
                    policy_digest=_validate_digest(arguments.expected_policy_digest, "expected-policy-digest"),
                    state_digest=_validate_digest(arguments.expected_state_digest, "expected-state-digest"),
                )
        except ValueError as error:
            raise SystemExit(str(error)) from error

    api = OpenCodeCliApi(arguments.opencode_bin, directory, arguments.server)
    try:
        start_identity = _validate_server_identity(api.server_info(arguments.api_timeout))
    except (RecoveryError, OSError, subprocess.SubprocessError):
        if arguments.command == "diagnose":
            output: dict[str, object] = _identity_failure_diagnostics(
                "server-identity-unavailable",
                "explicit-server-info-could-not-be-verified-at-start",
            )
        else:
            output = _identity_failure_report(
                directory,
                "server-identity-unavailable",
                "explicit-server-info-could-not-be-verified-at-start",
            ).as_dict()
        json.dump(output, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 1

    api.bind_server_identity(start_identity)
    try:
        plugin_summary = _summarize_plugin_response(api.list_plugins(arguments.api_timeout))
        if plugin_summary.get("status") != "ok":
            plugin_summary = {**plugin_summary, "reason": "live-plugin-list-unavailable"}
    except (RecoveryError, OSError, subprocess.SubprocessError):
        plugin_summary = _unavailable_plugin_summary()

    if arguments.command == "diagnose":
        output = diagnose(api, arguments.api_timeout, plugin_summary=plugin_summary)
        output["server_identity"] = start_identity.as_dict()
    else:
        assert policy is not None
        report = recover_basic_memory(
            api,
            policy=policy,
            marker_action="apply" if arguments.apply else "preview",
            preview=preview,
            approval=arguments.approval,
        )
        output = replace(
            report,
            server_identity=start_identity.as_dict(),
            plugins=plugin_summary,
        ).as_dict()

    try:
        end_identity = _validate_server_identity(api.server_info(arguments.api_timeout))
    except (RecoveryError, OSError, subprocess.SubprocessError):
        if arguments.command == "diagnose":
            output = _identity_failure_diagnostics(
                "server-identity-unavailable",
                "explicit-server-info-could-not-be-verified-at-end",
                plugins=plugin_summary,
                server_identity=start_identity,
            )
        else:
            output = replace(
                report,
                status="server-identity-unavailable",
                reason="explicit-server-info-could-not-be-verified-at-end",
                server_identity=start_identity.as_dict(),
                plugins=plugin_summary,
            ).as_dict()
        json.dump(output, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 1
    if end_identity != start_identity:
        if arguments.command == "diagnose":
            output = _identity_failure_diagnostics(
                "server-identity-changed",
                "explicit-server-info-identity-changed-during-operation",
                plugins=plugin_summary,
                server_identity=start_identity,
            )
        else:
            output = replace(
                report,
                status="server-identity-changed",
                reason="explicit-server-info-identity-changed-during-operation",
                server_identity=start_identity.as_dict(),
                plugins=plugin_summary,
            ).as_dict()
        json.dump(output, sys.stdout, sort_keys=True)
        sys.stdout.write("\n")
        return 1

    json.dump(output, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    if arguments.command == "diagnose":
        return 0 if output.get("status") == "ok" else 1
    return 0 if output.get("status") == READINESS_STATUS else 1


if __name__ == "__main__":
    raise SystemExit(main())
