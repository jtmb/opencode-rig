#!/usr/bin/env python3
"""Validate a repository-owned, digest-bound acceptance-evidence manifest."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import stat
import struct
import sys
import unicodedata
import zlib
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable


DEFAULT_MANIFEST = "acceptance-evidence.json"
EVIDENCE_KINDS = {"automated", "interaction", "rendered_visual"}
SUPPORTED_VERSIONS = {3}
UI_ACCEPTANCE_VERSION = 3
EXECUTION_EVIDENCE_VERSION = 2
CAPTURE_ARTIFACT_VERSION = 3
CAPTURE_EVENT_VERSION = 3
HOST_EVIDENCE_VERSION = 1
HOST_RECEIPT_VERSION = 1
HOST_ACTION_TOOL_IDS = {
    "screen_terminal",
    "subagent",
    "subagent_cancel",
    "task_declare",
    "todowrite",
}
MAX_HOST_ACTION_EVENT = 256
MAX_HOST_ACTION_SELECTOR = 256
MAX_HOST_WINDOW_TITLE = 256
MAX_HOST_WINDOW_CLASS = 256
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_CLAIMS = 256
MAX_EVIDENCE_PATHS = 256
MAX_ALLOWLIST_ENTRIES = 64
MAX_CONCURRENCY = 64
MAX_PATH_LENGTH = 4096
MAX_UI_SOURCES = 64
MAX_UI_TESTS = 64
MAX_TEST_BYTES = 4 * 1024 * 1024
MAX_EXECUTION_EVIDENCE_BYTES = 1024 * 1024
MAX_CAPTURE_BYTES = 1024 * 1024
MAX_CAPTURE_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_HOST_RECORD_BYTES = 64 * 1024
MAX_HOST_IMAGE_BYTES = 6 * 1024 * 1024
MAX_HOST_IMAGE_DIMENSION = 32_768
MAX_HOST_IMAGE_PIXELS = 16_777_216
MAX_HOST_IMAGE_DECODED_BYTES = 80 * 1024 * 1024
MAX_HOST_PNG_CHUNKS = 4096
MAX_HOST_EVIDENCE_PAIRS = 64
MAX_RUNTIME_BYTES = 256 * 1024 * 1024
MAX_VIEWPORT_ROWS = 1000
MAX_VIEWPORT_COLUMNS = 1000
MAX_ASSERTIONS = 16
MAX_NATIVE_SNAPSHOTS = 32
SOURCE_DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
RUN_ID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MONOTONIC_NS_PATTERN = re.compile(r"[1-9][0-9]*")
HOST_TIMESTAMP_PATTERN = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,6})?(?:Z|\+00:00)"
)
HOST_HWND_PATTERN = re.compile(r"0x[0-9a-f]{1,16}")
SEMVER_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?")
TEST_DECLARATION_PATTERN = re.compile(r"\b(?:test|it|describe)\s*\(")
SKIPPED_TEST_PATTERN = re.compile(
    r"\b(?:test|it|describe)\.(?:skip|todo|only)\s*\(|"
    r"\b(?:test|it)\s*\([^\n]*\{\s*skip\s*:"
)
NARRATIVE_SUFFIXES = {".md", ".markdown"}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
ANSI_CSI_PATTERN = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
ANSI_OSC_PATTERN = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
NATIVE_CAPTURE_API = "OpenTUI.testRender.captureCharFrame+captureSpans"
NATIVE_TEST_RENDERER_SCOPE = "native-test-renderer"
NULL_TEST_RENDER_PATTERN = re.compile(
    r"\btestRender\s*\(\s*\(\s*\)\s*=>\s*(?:null|undefined|void\s+0)\s*\)"
)
NATIVE_CAPTURE_FORBIDDEN = (
    "actionFor",
    "TAP version",
    "pass 3",
    "fail 0",
    "skipped 0",
    "duration_ms",
)


class EvidenceError(ValueError):
    """Raised when an acceptance-evidence manifest is unsafe or invalid."""


def _reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON object keys instead of silently choosing one."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _object(value: object, label: str) -> dict[str, object]:
    """Return a JSON object or raise a manifest-specific error."""
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be an object")
    return value


def _reject_unknown(data: dict[str, object], allowed: set[str], label: str) -> None:
    """Reject fields outside the versioned manifest schema."""
    unknown = set(data) - allowed
    if unknown:
        raise EvidenceError(
            f"{label} has unsupported field(s): " + ", ".join(sorted(unknown))
        )


def _string(value: object, label: str) -> str:
    """Return a non-empty JSON string or raise a manifest-specific error."""
    if not isinstance(value, str) or not value:
        raise EvidenceError(f"{label} must be a non-empty string")
    return value


def _string_list(
    value: object,
    label: str,
    *,
    non_empty: bool = False,
    max_items: int | None = None,
) -> list[str]:
    """Return a list of non-empty strings with optional non-empty enforcement."""
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item for item in value
    ):
        raise EvidenceError(f"{label} must be a list of non-empty strings")
    if non_empty and not value:
        raise EvidenceError(f"{label} must not be empty")
    if max_items is not None and len(value) > max_items:
        raise EvidenceError(f"{label} must contain at most {max_items} items")
    if len(set(value)) != len(value):
        raise EvidenceError(f"{label} must not contain duplicates")
    return value


def _relative_parts(raw_path: str, label: str) -> tuple[str, ...]:
    """Return safe portable path components for a manifest evidence path."""
    if len(raw_path) > MAX_PATH_LENGTH:
        raise EvidenceError(f"{label} exceeds the {MAX_PATH_LENGTH}-character path limit")
    if "\x00" in raw_path or "\\" in raw_path:
        raise EvidenceError(f"{label} must use relative forward-slash paths")
    posix = PurePosixPath(raw_path)
    windows = PureWindowsPath(raw_path)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise EvidenceError(f"{label} must be relative to the project root")
    parts = posix.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise EvidenceError(f"{label} must stay beneath the project root")
    return parts


def _regular_project_file(root: Path, raw_path: object, label: str) -> Path:
    """Validate one relative, non-symlink regular file below ``root``."""
    path_text = _string(raw_path, label)
    parts = _relative_parts(path_text, label)
    candidate = root.joinpath(*parts)
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise EvidenceError(f"{label} rejects symlink path: {path_text}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
        mode = candidate.stat().st_mode
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError(f"{label} is not a readable project file: {path_text}") from exc
    if not stat.S_ISREG(mode):
        raise EvidenceError(f"{label} must name a regular file: {path_text}")
    return candidate


def _project_directory(root: Path, raw_path: object, label: str) -> Path:
    """Validate one relative, non-symlink directory below ``root``."""
    path_text = _string(raw_path, label)
    parts = _relative_parts(path_text, label)
    candidate = root.joinpath(*parts)
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise EvidenceError(f"{label} rejects symlink path: {path_text}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError(f"{label} is not a readable project directory: {path_text}") from exc
    if not candidate.is_dir():
        raise EvidenceError(f"{label} must name a directory: {path_text}")
    return candidate


def _narrative_path(path_text: str, label: str) -> None:
    """Reject prose documents where machine-generated capture bytes are required."""
    if Path(path_text).suffix.lower() in NARRATIVE_SUFFIXES:
        raise EvidenceError(f"{label} must not use a Markdown narrative as capture evidence")


def _read_file(
    root: Path,
    raw_path: object,
    label: str,
    *,
    max_bytes: int,
    forbidden_paths: set[str] | None = None,
    non_empty: bool = True,
) -> tuple[str, bytes]:
    """Read one bounded, safe project file and return its portable path and bytes."""
    path_text = _string(raw_path, label)
    if forbidden_paths is not None and path_text in forbidden_paths:
        raise EvidenceError(f"{label} cites a protected UI source file: {path_text}")
    path = _regular_project_file(root, path_text, label)
    try:
        with path.open("rb") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError as exc:
        raise EvidenceError(f"{label} cannot be read: {path_text}") from exc
    if len(raw) > max_bytes:
        raise EvidenceError(f"{label} exceeds the {max_bytes}-byte limit: {path_text}")
    if non_empty and not raw:
        raise EvidenceError(f"{label} must contain bytes: {path_text}")
    return path_text, raw


def _file_with_digest(
    root: Path,
    raw_path: object,
    expected_digest: object,
    label: str,
    *,
    max_bytes: int,
    forbidden_paths: set[str] | None = None,
) -> tuple[str, bytes, str]:
    """Read one file and require its supplied SHA-256 digest to match its bytes."""
    path_text, raw = _read_file(
        root,
        raw_path,
        label,
        max_bytes=max_bytes,
        forbidden_paths=forbidden_paths,
    )
    digest = _validate_digest(expected_digest, f"{label}_sha256")
    actual = hashlib.sha256(raw).hexdigest()
    if actual != digest:
        raise EvidenceError(
            f"{label} digest mismatch for {path_text}: expected {digest}, found {actual}"
        )
    return path_text, raw, digest


def _external_file_with_digest(
    raw_path: object,
    expected_digest: object,
    label: str,
    *,
    max_bytes: int,
) -> tuple[str, bytes, str]:
    """Read one checksum-bound external regular file without trusting ambient PATH."""
    path_text = _string(raw_path, label)
    path = Path(path_text)
    if not path.is_absolute() or PureWindowsPath(path_text).drive:
        raise EvidenceError(f"{label} must be an absolute POSIX path")
    try:
        if path.is_symlink() or path.resolve(strict=True) != path:
            raise EvidenceError(f"{label} rejects symlink paths: {path_text}")
        file_stat = path.stat()
        raw = path.read_bytes()
    except EvidenceError:
        raise
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError(f"{label} is not a readable external file: {path_text}") from exc
    if not stat.S_ISREG(file_stat.st_mode):
        raise EvidenceError(f"{label} must name a regular file: {path_text}")
    if len(raw) > max_bytes:
        raise EvidenceError(f"{label} exceeds the {max_bytes}-byte limit: {path_text}")
    if not raw:
        raise EvidenceError(f"{label} must contain bytes: {path_text}")
    digest = _validate_digest(expected_digest, f"{label}_sha256")
    actual = hashlib.sha256(raw).hexdigest()
    if actual != digest:
        raise EvidenceError(
            f"{label} digest mismatch for {path_text}: expected {digest}, found {actual}"
        )
    return path_text, raw, digest


def _read_json_file(
    root: Path,
    raw_path: object,
    label: str,
    *,
    max_bytes: int,
    forbidden_paths: set[str] | None = None,
) -> tuple[str, dict[str, object]]:
    """Read one bounded JSON artifact with duplicate-key rejection."""
    path_text, raw = _read_file(
        root,
        raw_path,
        label,
        max_bytes=max_bytes,
        forbidden_paths=forbidden_paths,
    )
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicates)
    except UnicodeError as exc:
        raise EvidenceError(f"{label} must be UTF-8: {path_text}") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"{label} must be a JSON artifact: {path_text}") from exc
    except RecursionError as exc:
        raise EvidenceError(f"{label} nesting is too deep: {path_text}") from exc
    return path_text, _object(value, label)


def _validate_path_list(
    root: Path,
    value: object,
    label: str,
    *,
    non_empty: bool,
    forbidden_paths: set[str] | None = None,
) -> list[str]:
    """Validate all paths in one evidence list and return the validated paths."""
    paths = _string_list(
        value,
        label,
        non_empty=non_empty,
        max_items=MAX_EVIDENCE_PATHS,
    )
    for index, path in enumerate(paths):
        _regular_project_file(root, path, f"{label}[{index}]")
        if forbidden_paths is not None and path in forbidden_paths:
            raise EvidenceError(f"{label}[{index}] cites a protected source file: {path}")
    return paths


def _validate_claim(
    root: Path,
    claim: object,
    index: int,
    *,
    source_paths: set[str],
    visual_paths: set[str],
    interaction_paths: set[str],
    host_pairs: set[tuple[str, str]],
) -> None:
    """Validate one completion claim and require deterministic UI references."""
    data = _object(claim, f"claims[{index}]")
    _reject_unknown(
        data,
        {"id", "status", "user_visible", "runtime", "evidence"},
        f"claims[{index}]",
    )
    claim_id = _string(data.get("id"), f"claims[{index}].id")
    status = _string(data.get("status"), f"claims[{index}].status")
    if status not in {"complete", "limited", "planned"}:
        raise EvidenceError(f"claims[{index}] {claim_id}: unsupported status {status!r}")
    user_visible = data.get("user_visible")
    if not isinstance(user_visible, bool):
        raise EvidenceError(f"claims[{index}] {claim_id}: user_visible must be boolean")
    if not isinstance(data.get("runtime", True), bool):
        raise EvidenceError(f"claims[{index}] {claim_id}: runtime must be boolean")

    evidence = data.get("evidence", {})
    evidence_data = _object(evidence, f"claims[{index}].evidence")
    unknown = set(evidence_data) - EVIDENCE_KINDS
    if unknown:
        raise EvidenceError(
            f"claims[{index}] {claim_id}: unsupported evidence kind(s): "
            + ", ".join(sorted(unknown))
        )
    for kind, paths in evidence_data.items():
        validated = _validate_path_list(
            root,
            paths,
            f"claims[{index}].evidence.{kind}",
            non_empty=False,
            forbidden_paths=source_paths,
        )
        if kind == "rendered_visual" and not set(validated).issubset(visual_paths):
            raise EvidenceError(
                f"claims[{index}] {claim_id}: rendered_visual evidence must reference "
                "an independently retained live image; native span visualizations are test-only"
            )
        if kind == "interaction" and not set(validated).issubset(interaction_paths):
            raise EvidenceError(
                f"claims[{index}] {claim_id}: interaction evidence must reference "
                "retained host-dispatch evidence; native test-renderer events are test-only"
            )

    if status in {"complete", "limited"} and not any(evidence_data.values()):
        raise EvidenceError(
            f"claims[{index}] {claim_id}: {status} claims require evidence"
        )

    if status in {"complete", "limited"} and user_visible:
        for kind in ("rendered_visual", "interaction"):
            if not evidence_data.get(kind):
                raise EvidenceError(
                    f"claims[{index}] {claim_id}: user-visible completion claims "
                    f"require {kind} evidence"
                )
        if not any(
            (visual_path, interaction_path) in host_pairs
            for visual_path in evidence_data.get("rendered_visual", [])
            for interaction_path in evidence_data.get("interaction", [])
        ):
            raise EvidenceError(
                f"claims[{index}] {claim_id}: rendered_visual and interaction evidence "
                "must cite one matching host-evidence pair"
            )


def _validate_subagent_policy(policy: object) -> tuple[set[str], set[str], int]:
    """Validate and return the configured subagent policy."""
    data = _object(policy, "subagent_policy")
    _reject_unknown(
        data,
        {"allowed_agents", "allowed_models", "max_concurrency"},
        "subagent_policy",
    )
    agents = set(
        _string_list(
            data.get("allowed_agents"),
            "subagent_policy.allowed_agents",
            non_empty=True,
            max_items=MAX_ALLOWLIST_ENTRIES,
        )
    )
    models = set(
        _string_list(
            data.get("allowed_models"),
            "subagent_policy.allowed_models",
            non_empty=True,
            max_items=MAX_ALLOWLIST_ENTRIES,
        )
    )
    maximum = data.get("max_concurrency")
    if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
        raise EvidenceError("subagent_policy.max_concurrency must be a positive integer")
    if maximum > MAX_CONCURRENCY:
        raise EvidenceError(
            f"subagent_policy.max_concurrency must be at most {MAX_CONCURRENCY}"
        )
    return agents, models, maximum


def _validate_subagent_evidence(
    root: Path,
    entries: object,
    allowed_agents: set[str],
    allowed_models: set[str],
    max_concurrency: int,
    source_paths: set[str],
) -> None:
    """Validate a bounded batch of background-subagent evidence records."""
    if not isinstance(entries, list) or not entries:
        raise EvidenceError("subagent_evidence must be a non-empty list")
    if len(entries) > max_concurrency:
        raise EvidenceError(
            f"subagent_evidence has {len(entries)} records, above max_concurrency "
            f"{max_concurrency}"
        )
    identifiers: set[str] = set()
    for index, entry in enumerate(entries):
        data = _object(entry, f"subagent_evidence[{index}]")
        _reject_unknown(
            data,
            {"id", "agent", "model", "background", "evidence"},
            f"subagent_evidence[{index}]",
        )
        entry_id = _string(data.get("id"), f"subagent_evidence[{index}].id")
        if entry_id in identifiers:
            raise EvidenceError(f"duplicate subagent evidence id: {entry_id}")
        identifiers.add(entry_id)
        agent = _string(data.get("agent"), f"subagent_evidence[{index}].agent")
        if agent not in allowed_agents:
            raise EvidenceError(f"subagent_evidence[{index}] uses disallowed agent: {agent}")
        model = _string(data.get("model"), f"subagent_evidence[{index}].model")
        if model not in allowed_models:
            raise EvidenceError(f"subagent_evidence[{index}] uses disallowed model: {model}")
        if data.get("background") is not True:
            raise EvidenceError(f"subagent_evidence[{index}] must set background to true")
        _validate_path_list(
            root,
            data.get("evidence"),
            f"subagent_evidence[{index}].evidence",
            non_empty=True,
            forbidden_paths=source_paths,
        )


def _source_digest(source: Path, label: str) -> str:
    """Return the SHA-256 digest of one validated source file."""
    try:
        return hashlib.sha256(source.read_bytes()).hexdigest()
    except OSError as exc:
        raise EvidenceError(f"{label} cannot be read for digest validation") from exc


def _validate_digest(value: object, label: str) -> str:
    """Return a canonical lowercase SHA-256 digest."""
    digest = _string(value, label)
    if SOURCE_DIGEST_PATTERN.fullmatch(digest) is None:
        raise EvidenceError(f"{label} must be a lowercase SHA-256 digest")
    return digest


def _discover_ui_sources(
    root: Path,
    source_roots: object,
    source_extensions: object,
    source_files: object,
) -> set[str]:
    """Discover regular UI source files covered by the manifest inventory."""
    roots = _string_list(
        source_roots,
        "ui_acceptance.source_roots",
        non_empty=True,
        max_items=MAX_UI_SOURCES,
    )
    extensions = _string_list(
        source_extensions,
        "ui_acceptance.source_extensions",
        non_empty=True,
        max_items=8,
    )
    if any(not extension.startswith(".") for extension in extensions):
        raise EvidenceError("ui_acceptance.source_extensions must start with a dot")
    explicit_files = _string_list(
        source_files,
        "ui_acceptance.source_files",
        non_empty=False,
        max_items=MAX_UI_SOURCES,
    )

    discovered: set[str] = set()
    for index, raw_root in enumerate(roots):
        directory = _project_directory(root, raw_root, f"ui_acceptance.source_roots[{index}]")
        try:
            candidates = sorted(directory.rglob("*"), key=lambda path: path.as_posix())
        except OSError as exc:
            raise EvidenceError(f"cannot enumerate UI source root: {raw_root}") from exc
        for candidate in candidates:
            if candidate.is_symlink():
                if candidate.suffix in extensions:
                    relative = candidate.relative_to(root).as_posix()
                    _regular_project_file(root, relative, "UI source")
                continue
            if not candidate.is_file() or candidate.suffix not in extensions:
                continue
            relative = candidate.relative_to(root).as_posix()
            _regular_project_file(root, relative, "UI source")
            discovered.add(relative)
            if len(discovered) > MAX_UI_SOURCES:
                raise EvidenceError(
                    f"ui_acceptance discovers more than {MAX_UI_SOURCES} source files"
                )
    for index, raw_path in enumerate(explicit_files):
        _regular_project_file(root, raw_path, f"ui_acceptance.source_files[{index}]")
        discovered.add(raw_path)
        if len(discovered) > MAX_UI_SOURCES:
            raise EvidenceError(
                f"ui_acceptance discovers more than {MAX_UI_SOURCES} source files"
            )
    if not discovered:
        raise EvidenceError("ui_acceptance.source_roots contain no UI source files")
    return discovered


def _test_file_text(root: Path, path_text: str, label: str) -> str:
    """Read a bounded test file for skip and declaration checks."""
    path = _regular_project_file(root, path_text, label)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise EvidenceError(f"{label} cannot be read: {path_text}") from exc
    if len(raw) > MAX_TEST_BYTES:
        raise EvidenceError(f"{label} exceeds the {MAX_TEST_BYTES}-byte limit: {path_text}")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EvidenceError(f"{label} must be UTF-8: {path_text}") from exc


def _utc_timestamp(value: object, label: str) -> dt.datetime:
    """Parse a timezone-explicit UTC timestamp used by execution receipts."""
    text = _string(value, label)
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError(f"{label} must be an ISO-8601 UTC timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != dt.timedelta(0):
        raise EvidenceError(f"{label} must include a UTC timezone")
    return parsed.astimezone(dt.timezone.utc)


def _run_id(value: object, label: str) -> str:
    """Return a canonical UUID-shaped run identifier."""
    run_id = _string(value, label)
    if RUN_ID_PATTERN.fullmatch(run_id) is None:
        raise EvidenceError(f"{label} must be a lowercase UUID run identifier")
    return run_id


def _monotonic_ns(value: object, label: str) -> int:
    """Parse a lossless decimal monotonic-clock reading in nanoseconds."""
    text = _string(value, label)
    if MONOTONIC_NS_PATTERN.fullmatch(text) is None:
        raise EvidenceError(f"{label} must be a positive monotonic nanosecond value")
    return int(text)


def _validate_execution_invocation(
    root: Path,
    value: object,
    *,
    test_path: str,
    test_digest: str,
    source_digest: str,
    exit_code: int,
    command: str,
    label: str,
) -> tuple[dt.datetime, dt.datetime]:
    """Validate the retained command receipt against the files present at run time."""
    invocation = _object(value, f"{label}.invocation")
    _reject_unknown(
        invocation,
        {
            "run_id",
            "argv",
            "cwd",
            "started_at",
            "finished_at",
            "started_monotonic_ns",
            "finished_monotonic_ns",
            "exit_code",
            "source_sha256_before",
            "source_sha256_after",
            "test_sha256_before",
            "test_sha256_after",
        },
        f"{label}.invocation",
    )
    _run_id(invocation.get("run_id"), f"{label}.invocation.run_id")
    argv = invocation.get("argv")
    if (
        not isinstance(argv, list)
        or not argv
        or len(argv) > 128
        or any(not isinstance(argument, str) or not argument for argument in argv)
    ):
        raise EvidenceError(f"{label}.invocation.argv must contain command arguments")
    cwd = _string(invocation.get("cwd"), f"{label}.invocation.cwd")
    if cwd == ".":
        working_directory = root
    else:
        working_directory = _project_directory(root, cwd, f"{label}.invocation.cwd")
    relative_cwd = working_directory.relative_to(root).as_posix()
    invokes_test = False
    for argument in argv[1:]:
        if Path(argument).is_absolute() or PureWindowsPath(argument).is_absolute():
            continue
        resolved_argument = (
            PurePosixPath(argument)
            if relative_cwd == "."
            else PurePosixPath(relative_cwd) / PurePosixPath(argument)
        )
        if resolved_argument.as_posix() == test_path:
            invokes_test = True
            break
    if not invokes_test:
        raise EvidenceError(
            f"{label}.invocation.argv does not invoke focused test {test_path}"
        )
    expected_command = json.dumps(argv, ensure_ascii=False, separators=(",", ":"))
    if command != expected_command:
        raise EvidenceError(f"{label}.command does not match the exact invocation argv")

    started_at = _utc_timestamp(invocation.get("started_at"), f"{label}.invocation.started_at")
    finished_at = _utc_timestamp(invocation.get("finished_at"), f"{label}.invocation.finished_at")
    if finished_at < started_at:
        raise EvidenceError(f"{label}.invocation timestamps are not monotonic")
    started_monotonic = _monotonic_ns(
        invocation.get("started_monotonic_ns"), f"{label}.invocation.started_monotonic_ns"
    )
    finished_monotonic = _monotonic_ns(
        invocation.get("finished_monotonic_ns"), f"{label}.invocation.finished_monotonic_ns"
    )
    if finished_monotonic <= started_monotonic:
        raise EvidenceError(f"{label}.invocation monotonic clock did not advance")
    invocation_exit_code = invocation.get("exit_code")
    if (
        isinstance(invocation_exit_code, bool)
        or not isinstance(invocation_exit_code, int)
        or invocation_exit_code != exit_code
    ):
        raise EvidenceError(f"{label}.invocation.exit_code contradicts the test result")
    for field, expected in (
        ("source_sha256_before", source_digest),
        ("source_sha256_after", source_digest),
        ("test_sha256_before", test_digest),
        ("test_sha256_after", test_digest),
    ):
        if _validate_digest(invocation.get(field), f"{label}.invocation.{field}") != expected:
            raise EvidenceError(
                f"{label}.invocation.{field} does not match the source/test bytes at run time"
            )
    return started_at, finished_at


def _validate_execution_evidence(
    root: Path,
    value: object,
    *,
    test_path: str,
    test_digest: str,
    source_digest: str,
    kind: str,
    source_paths: set[str],
    source_label: str,
) -> set[str]:
    """Require a digest-bound result artifact produced by a focused test run."""
    label = f"{source_label}.execution_evidence"
    if isinstance(value, dict):
        if value.get("status") == "pending":
            reason = _string(value.get("reason"), f"{label}.reason")
            raise EvidenceError(f"{label} is pending: {reason}")
        raise EvidenceError(f"{label} must be a result-artifact path")
    evidence_path = _string(value, label)
    if evidence_path in source_paths:
        raise EvidenceError(f"{label} cites a protected UI source file: {evidence_path}")
    report_path, report = _read_json_file(
        root,
        evidence_path,
        label,
        max_bytes=MAX_EXECUTION_EVIDENCE_BYTES,
        forbidden_paths=source_paths,
    )
    _reject_unknown(
        report,
        {
            "version",
            "kind",
            "test",
            "test_sha256",
            "source_sha256",
            "result",
            "exit_code",
            "runner",
            "command",
            "observed_at",
            "max_age_days",
            "output",
            "output_sha256",
            "invocation",
        },
        label,
    )
    version = report.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != EXECUTION_EVIDENCE_VERSION:
        raise EvidenceError(f"{label}.version must be {EXECUTION_EVIDENCE_VERSION}")
    if _string(report.get("kind"), f"{label}.kind") != kind:
        raise EvidenceError(f"{label}.kind does not match focused test kind {kind}")
    if _string(report.get("test"), f"{label}.test") != test_path:
        raise EvidenceError(f"{label}.test does not match focused test path {test_path}")
    report_test_digest = _validate_digest(report.get("test_sha256"), f"{label}.test_sha256")
    test_file = _regular_project_file(root, test_path, f"{source_label}.focused test")
    actual_test_digest = _source_digest(test_file, f"{source_label}.focused test")
    if report_test_digest != actual_test_digest or report_test_digest != test_digest:
        raise EvidenceError(f"{label}.test_sha256 does not match the focused test source")
    if _validate_digest(report.get("source_sha256"), f"{label}.source_sha256") != source_digest:
        raise EvidenceError(f"{label}.source_sha256 does not match the mapped UI source")
    if _string(report.get("result"), f"{label}.result") != "passed":
        raise EvidenceError(f"{label}.result must be passed")
    exit_code = report.get("exit_code")
    if isinstance(exit_code, bool) or not isinstance(exit_code, int) or exit_code != 0:
        raise EvidenceError(f"{label}.exit_code must be zero")
    _string(report.get("runner"), f"{label}.runner")
    command = _string(report.get("command"), f"{label}.command")
    invocation_start, invocation_finish = _validate_execution_invocation(
        root,
        report.get("invocation"),
        test_path=test_path,
        test_digest=report_test_digest,
        source_digest=source_digest,
        exit_code=exit_code,
        command=command,
        label=label,
    )
    observed_at = _utc_timestamp(report.get("observed_at"), f"{label}.observed_at")
    if observed_at != invocation_finish:
        raise EvidenceError(f"{label}.observed_at must match the invocation finish time")
    observed = observed_at.date()
    maximum_age = report.get("max_age_days")
    if isinstance(maximum_age, bool) or not isinstance(maximum_age, int) or maximum_age < 0:
        raise EvidenceError(f"{label}.max_age_days must be a non-negative integer")
    if maximum_age > 30:
        raise EvidenceError(f"{label}.max_age_days must be at most 30")
    age = (dt.datetime.now(dt.timezone.utc).date() - observed).days
    if age < 0:
        raise EvidenceError(f"{label}.observed_at cannot be in the future")
    if age > maximum_age:
        raise EvidenceError(f"{label} is stale ({age} days old; maximum {maximum_age})")
    if invocation_start > invocation_finish:
        raise EvidenceError(f"{label}.invocation timestamps are contradictory")
    output_path_text, output, _ = _file_with_digest(
        root,
        report.get("output"),
        report.get("output_sha256"),
        f"{label}.output",
        max_bytes=MAX_EXECUTION_EVIDENCE_BYTES,
        forbidden_paths=source_paths,
    )
    if not output:
        raise EvidenceError(f"{label}.output must contain captured test output")
    return {report_path, output_path_text}


def _validate_focused_tests(
    root: Path,
    value: object,
    source_paths: set[str],
    source_digest: str,
    source_label: str,
) -> tuple[set[str], dict[str, str]]:
    """Require passed behavioral and render tests for one UI source."""
    data = _object(value, f"{source_label}.focused_tests")
    _reject_unknown(data, {"behavioral", "render"}, f"{source_label}.focused_tests")
    evidence_paths: set[str] = set()
    render_test_digests: dict[str, str] = {}
    for kind in ("behavioral", "render"):
        entries = data.get(kind)
        if not isinstance(entries, list) or not entries:
            raise EvidenceError(
                f"{source_label}.focused_tests.{kind} must contain a passed test"
            )
        if len(entries) > MAX_UI_TESTS:
            raise EvidenceError(f"{source_label}.focused_tests.{kind} has too many tests")
        kind_paths: set[str] = set()
        for index, entry in enumerate(entries):
            entry_data = _object(entry, f"{source_label}.focused_tests.{kind}[{index}]")
            _reject_unknown(
                entry_data,
                {"path", "execution_evidence"},
                f"{source_label}.focused_tests.{kind}[{index}]",
            )
            path_text = _string(
                entry_data.get("path"),
                f"{source_label}.focused_tests.{kind}[{index}].path",
            )
            if path_text in kind_paths:
                raise EvidenceError(
                    f"{source_label}.focused_tests.{kind} contains duplicate test: {path_text}"
                )
            kind_paths.add(path_text)
            if path_text in source_paths:
                raise EvidenceError(
                    f"{source_label}.focused_tests.{kind}[{index}] cites its UI source: {path_text}"
                )
            test_file = _regular_project_file(
                root,
                path_text,
                f"{source_label}.focused_tests.{kind}[{index}].path",
            )
            test_digest = _source_digest(test_file, f"{source_label}.focused test")
            text = _test_file_text(
                root,
                path_text,
                f"{source_label}.focused_tests.{kind}[{index}].path",
            )
            if SKIPPED_TEST_PATTERN.search(text):
                raise EvidenceError(
                    f"{source_label}.focused_tests.{kind}[{index}] contains a skipped, todo, "
                    "or focused-only test"
                )
            if TEST_DECLARATION_PATTERN.search(text) is None:
                raise EvidenceError(
                    f"{source_label}.focused_tests.{kind}[{index}] has no test declaration"
                )
            evidence_paths.update(
                _validate_execution_evidence(
                    root,
                    entry_data.get("execution_evidence"),
                    test_path=path_text,
                    test_digest=test_digest,
                    source_digest=source_digest,
                    kind=kind,
                    source_paths=source_paths,
                    source_label=f"{source_label}.focused_tests.{kind}[{index}]",
                )
            )
            if kind == "render":
                render_test_digests[path_text] = test_digest
    return evidence_paths, render_test_digests


def _review_date(value: object, label: str) -> dt.date:
    """Parse a UTC date or a UTC ISO timestamp for evidence freshness."""
    text = _string(value, label)
    try:
        if "T" in text:
            parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("timestamp must include a timezone")
            return parsed.astimezone(dt.timezone.utc).date()
        return dt.date.fromisoformat(text)
    except ValueError as exc:
        raise EvidenceError(f"{label} must be an ISO-8601 UTC date or timestamp") from exc


def _validate_freshness(data: dict[str, object], label: str) -> dt.date:
    """Validate bounded freshness and return the observed UTC date."""
    observed = _review_date(data.get("observed_at"), f"{label}.observed_at")
    maximum_age = data.get("max_age_days")
    if isinstance(maximum_age, bool) or not isinstance(maximum_age, int) or maximum_age < 0:
        raise EvidenceError(f"{label}.max_age_days must be a non-negative integer")
    if maximum_age > 30:
        raise EvidenceError(f"{label}.max_age_days must be at most 30")
    age = (dt.datetime.now(dt.timezone.utc).date() - observed).days
    if age < 0:
        raise EvidenceError(f"{label}.observed_at cannot be in the future")
    if age > maximum_age:
        raise EvidenceError(
            f"{label} is stale ({age} days old; maximum {maximum_age})"
        )
    return observed


def _validate_runtime_catalog(
    root: Path,
    value: object,
    source_paths: set[str],
) -> dict[str, dict[str, object]]:
    """Validate the repository-declared, checksum-bound render runtimes."""
    if not isinstance(value, list) or not value:
        raise EvidenceError("ui_acceptance.supported_runtimes must be a non-empty list")
    if len(value) > MAX_ALLOWLIST_ENTRIES:
        raise EvidenceError(
            f"ui_acceptance.supported_runtimes must contain at most {MAX_ALLOWLIST_ENTRIES} items"
        )
    result: dict[str, dict[str, object]] = {}
    for index, item in enumerate(value):
        label = f"ui_acceptance.supported_runtimes[{index}]"
        data = _object(item, label)
        _reject_unknown(
            data,
            {
                "id",
                "name",
                "version",
                "identity",
                "provisioning",
                "executable",
                "executable_sha256",
                "package_manager",
                "package_manager_version",
                "package_manager_identity",
                "package_manager_executable",
                "package_manager_executable_sha256",
            },
            label,
        )
        runtime_id = _string(data.get("id"), f"{label}.id")
        if runtime_id in result:
            raise EvidenceError(f"duplicate supported runtime id: {runtime_id}")
        name = _string(data.get("name"), f"{label}.name")
        if name != "node":
            raise EvidenceError(f"unsupported runtime: {name}")
        version = _string(data.get("version"), f"{label}.version")
        if SEMVER_PATTERN.fullmatch(version) is None:
            raise EvidenceError(f"{label}.version must be a semantic version")
        if _string(data.get("identity"), f"{label}.identity") != f"{name}@{version}":
            raise EvidenceError(f"{label}.identity contradicts its runtime name/version")
        provisioning = _string(data.get("provisioning"), f"{label}.provisioning")
        if provisioning == "project":
            executable_path, _, executable_digest = _file_with_digest(
                root,
                data.get("executable"),
                data.get("executable_sha256"),
                f"{label}.executable",
                max_bytes=MAX_RUNTIME_BYTES,
                forbidden_paths=source_paths,
            )
            manager_path, _, manager_digest = _file_with_digest(
                root,
                data.get("package_manager_executable"),
                data.get("package_manager_executable_sha256"),
                f"{label}.package_manager_executable",
                max_bytes=MAX_RUNTIME_BYTES,
                forbidden_paths=source_paths,
            )
            executable = root.joinpath(*_relative_parts(executable_path, label))
            manager_executable = root.joinpath(*_relative_parts(manager_path, label))
        elif provisioning == "external-checksum":
            executable_path, _, executable_digest = _external_file_with_digest(
                data.get("executable"),
                data.get("executable_sha256"),
                f"{label}.executable",
                max_bytes=MAX_RUNTIME_BYTES,
            )
            manager_path, _, manager_digest = _external_file_with_digest(
                data.get("package_manager_executable"),
                data.get("package_manager_executable_sha256"),
                f"{label}.package_manager_executable",
                max_bytes=MAX_RUNTIME_BYTES,
            )
            executable = Path(executable_path)
            manager_executable = Path(manager_path)
        else:
            raise EvidenceError(
                f"{label}.provisioning must be 'project' or 'external-checksum'"
            )
        if not executable.stat().st_mode & stat.S_IXUSR:
            raise EvidenceError(f"{label}.executable must be executable: {executable_path}")
        if not manager_executable.stat().st_mode & stat.S_IXUSR:
            raise EvidenceError(
                f"{label}.package_manager_executable must be executable: {manager_path}"
            )
        package_manager = _string(data.get("package_manager"), f"{label}.package_manager")
        if package_manager != "npm":
            raise EvidenceError(f"unsupported package manager: {package_manager}")
        package_manager_version = _string(
            data.get("package_manager_version"), f"{label}.package_manager_version"
        )
        if SEMVER_PATTERN.fullmatch(package_manager_version) is None:
            raise EvidenceError(f"{label}.package_manager_version must be a semantic version")
        if _string(
            data.get("package_manager_identity"), f"{label}.package_manager_identity"
        ) != f"{package_manager}@{package_manager_version}":
            raise EvidenceError(
                f"{label}.package_manager_identity contradicts its name/version"
            )
        canonical = dict(data)
        canonical["executable"] = executable_path
        canonical["executable_sha256"] = executable_digest
        canonical["package_manager_executable"] = manager_path
        canonical["package_manager_executable_sha256"] = manager_digest
        result[runtime_id] = canonical
    return result


def _validate_renderer_catalog(value: object) -> dict[str, dict[str, object]]:
    """Validate renderer identities declared by the consuming repository."""
    if not isinstance(value, list) or not value:
        raise EvidenceError("ui_acceptance.supported_renderers must be a non-empty list")
    if len(value) > MAX_ALLOWLIST_ENTRIES:
        raise EvidenceError(
            f"ui_acceptance.supported_renderers must contain at most {MAX_ALLOWLIST_ENTRIES} items"
        )
    result: dict[str, dict[str, object]] = {}
    for index, item in enumerate(value):
        label = f"ui_acceptance.supported_renderers[{index}]"
        data = _object(item, label)
        _reject_unknown(data, {"id", "name", "version", "identity"}, label)
        renderer_id = _string(data.get("id"), f"{label}.id")
        if renderer_id in result:
            raise EvidenceError(f"duplicate supported renderer id: {renderer_id}")
        name = _string(data.get("name"), f"{label}.name")
        version = _string(data.get("version"), f"{label}.version")
        if _string(data.get("identity"), f"{label}.identity") != f"{name}@{version}":
            raise EvidenceError(f"{label}.identity contradicts its renderer name/version")
        result[renderer_id] = dict(data)
    return result


def _validate_viewport(value: object, label: str) -> dict[str, int]:
    """Validate a fixed character viewport."""
    data = _object(value, label)
    _reject_unknown(data, {"columns", "rows"}, label)
    columns = data.get("columns")
    rows = data.get("rows")
    if (
        isinstance(columns, bool)
        or not isinstance(columns, int)
        or columns < 1
        or columns > MAX_VIEWPORT_COLUMNS
    ):
        raise EvidenceError(f"{label}.columns must be between 1 and {MAX_VIEWPORT_COLUMNS}")
    if (
        isinstance(rows, bool)
        or not isinstance(rows, int)
        or rows < 1
        or rows > MAX_VIEWPORT_ROWS
    ):
        raise EvidenceError(f"{label}.rows must be between 1 and {MAX_VIEWPORT_ROWS}")
    return {"columns": columns, "rows": rows}


def _canonical_digest(value: object) -> str:
    """Digest JSON semantics independently of pretty-printing or key order."""
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _cell_width(text: str) -> int:
    """Return the bounded terminal-cell width used by native frame validation."""
    width = 0
    for character in text:
        if character == "\t":
            width += 8 - (width % 8)
            continue
        if unicodedata.combining(character) or unicodedata.category(character) in {
            "Cc",
            "Cf",
            "Me",
        }:
            continue
        width += 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
    return width


def _json_bytes_value(raw: bytes, label: str) -> dict[str, object]:
    """Parse one bounded UTF-8 JSON object with duplicate-key rejection."""
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicates)
    except UnicodeError as exc:
        raise EvidenceError(f"{label} must be UTF-8 JSON") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"{label} must be JSON") from exc
    except RecursionError as exc:
        raise EvidenceError(f"{label} nesting is too deep") from exc
    return _object(value, label)


def _validate_rgba(value: object, label: str) -> list[int]:
    """Validate one native RGBA color tuple."""
    if (
        not isinstance(value, list)
        or len(value) != 4
        or any(isinstance(item, bool) or not isinstance(item, int) or not 0 <= item <= 255 for item in value)
    ):
        raise EvidenceError(f"{label} must contain four byte values")
    return value


def _validate_native_spans_value(
    value: object,
    viewport: dict[str, int],
    label: str,
) -> tuple[str, list[str]]:
    """Validate OpenTUI captureSpans positions, colors, attributes, and text."""
    data = _object(value, label)
    _reject_unknown(data, {"version", "cols", "rows", "cursor", "lines"}, label)
    if data.get("version") != 1:
        raise EvidenceError(f"{label}.version must be 1")
    if data.get("cols") != viewport["columns"] or data.get("rows") != viewport["rows"]:
        raise EvidenceError(f"{label} dimensions contradict the capture viewport")
    cursor = data.get("cursor")
    if (
        not isinstance(cursor, list)
        or len(cursor) != 2
        or any(isinstance(item, bool) or not isinstance(item, int) or item < 0 for item in cursor)
    ):
        raise EvidenceError(f"{label}.cursor must be a non-negative [column, row] pair")
    lines = data.get("lines")
    if not isinstance(lines, list) or len(lines) != viewport["rows"]:
        raise EvidenceError(f"{label}.lines must contain one line per viewport row")
    joined_lines: list[str] = []
    for row, raw_line in enumerate(lines):
        line_label = f"{label}.lines[{row}]"
        line = _object(raw_line, line_label)
        _reject_unknown(line, {"y", "spans"}, line_label)
        if line.get("y") != row:
            raise EvidenceError(f"{line_label}.y must equal its native row position")
        spans = line.get("spans")
        if not isinstance(spans, list) or not spans:
            raise EvidenceError(f"{line_label}.spans must be a non-empty list")
        column = 0
        text_parts: list[str] = []
        for span_index, raw_span in enumerate(spans):
            span_label = f"{line_label}.spans[{span_index}]"
            span = _object(raw_span, span_label)
            _reject_unknown(span, {"x", "y", "text", "width", "fg", "bg", "attributes"}, span_label)
            if span.get("x") != column or span.get("y") != row:
                raise EvidenceError(f"{span_label} has contradictory native coordinates")
            text = _string(span.get("text"), f"{span_label}.text")
            width = span.get("width")
            if isinstance(width, bool) or not isinstance(width, int) or width < 1:
                raise EvidenceError(f"{span_label}.width must be positive")
            if _cell_width(text) != width:
                raise EvidenceError(f"{span_label}.width contradicts its text cells")
            _validate_rgba(span.get("fg"), f"{span_label}.fg")
            _validate_rgba(span.get("bg"), f"{span_label}.bg")
            attributes = span.get("attributes")
            if isinstance(attributes, bool) or not isinstance(attributes, int) or attributes < 0:
                raise EvidenceError(f"{span_label}.attributes must be a non-negative integer")
            column += width
            if column > viewport["columns"]:
                raise EvidenceError(f"{span_label} exceeds the native viewport width")
            text_parts.append(text)
        if column != viewport["columns"]:
            raise EvidenceError(f"{line_label} does not cover the native viewport width")
        joined_lines.append("".join(text_parts))
    return _canonical_digest(data), joined_lines


def _validate_native_frame_text(
    raw: bytes,
    spans_value: object,
    viewport: dict[str, int],
    label: str,
) -> tuple[str, list[str]]:
    """Bind native character bytes to the exact semantic span text."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EvidenceError(f"{label} must be UTF-8") from exc
    if not text.endswith("\n"):
        raise EvidenceError(f"{label} must retain the native frame row terminator")
    lines = text.split("\n")[:-1]
    if len(lines) != viewport["rows"]:
        raise EvidenceError(f"{label} must contain exactly the native viewport rows")
    if any(_cell_width(line) > viewport["columns"] for line in lines):
        raise EvidenceError(f"{label} exceeds the native viewport width")
    span_digest, span_lines = _validate_native_spans_value(spans_value, viewport, f"{label}.semantic_spans")
    if lines != span_lines:
        raise EvidenceError(f"{label} does not match the native semantic spans")
    return hashlib.sha256(raw).hexdigest(), lines


def _validate_native_state(
    value: object,
    label: str,
) -> tuple[str, dict[str, object]]:
    """Validate a native fixture state snapshot and return its semantic digest."""
    data = _object(value, label)
    if not isinstance(data.get("visible"), bool):
        raise EvidenceError(f"{label}.visible must be boolean")
    return _canonical_digest(data), data


def _validate_native_source_code(
    root: Path,
    raw_path: object,
    expected_digest: object,
    label: str,
    *,
    required: tuple[str, ...],
) -> tuple[str, bytes, str]:
    """Bind native capture evidence to a real OpenTUI fixture, not a TAP renderer."""
    path_text, raw, digest = _file_with_digest(
        root,
        raw_path,
        expected_digest,
        label,
        max_bytes=MAX_TEST_BYTES,
    )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EvidenceError(f"{label} must be UTF-8 source") from exc
    if NULL_TEST_RENDER_PATTERN.search(text):
        raise EvidenceError(f"{label} testRender callback returns no native frame")
    for forbidden in NATIVE_CAPTURE_FORBIDDEN:
        if forbidden in text:
            raise EvidenceError(f"{label} contains forbidden synthetic evidence marker: {forbidden}")
    for marker in required:
        if marker not in text:
            raise EvidenceError(f"{label} must contain native capture marker: {marker}")
    return path_text, raw, digest


def _native_utf8_binding(
    root: Path,
    value: object,
    label: str,
    *,
    allowed: set[str],
    source_paths: set[str],
    max_bytes: int,
    format_value: str | None = None,
) -> tuple[dict[str, object], str, bytes, str]:
    """Read one digest-bound UTF-8 native capture file and its binding."""
    data = _object(value, label)
    _reject_unknown(data, allowed, label)
    if _string(data.get("encoding"), f"{label}.encoding") != "utf-8":
        raise EvidenceError(f"{label}.encoding must be utf-8")
    if format_value is not None and _string(data.get("format"), f"{label}.format") != format_value:
        raise EvidenceError(f"{label}.format must be {format_value}")
    path_text, raw, digest = _file_with_digest(
        root,
        data.get("path"),
        data.get("sha256"),
        f"{label}.path",
        max_bytes=max_bytes,
        forbidden_paths=source_paths,
    )
    return data, path_text, raw, digest


def _validate_native_snapshot_value(
    value: object,
    viewport: dict[str, int],
    label: str,
) -> dict[str, object]:
    """Validate the embedded OpenTUI frame, spans, and state for one snapshot."""
    data = _object(value, label)
    _reject_unknown(
        data,
        {"id", "frame", "spans", "state", "frame_sha256", "spans_sha256", "state_sha256"},
        label,
    )
    _string(data.get("id"), f"{label}.id")
    frame = _string(data.get("frame"), f"{label}.frame")
    spans = _object(data.get("spans"), f"{label}.spans")
    state = _object(data.get("state"), f"{label}.state")
    frame_digest = _validate_digest(data.get("frame_sha256"), f"{label}.frame_sha256")
    spans_digest = _validate_digest(data.get("spans_sha256"), f"{label}.spans_sha256")
    state_digest = _validate_digest(data.get("state_sha256"), f"{label}.state_sha256")
    actual_frame_digest, _ = _validate_native_frame_text(
        frame.encode("utf-8"), spans, viewport, f"{label}.frame"
    )
    if actual_frame_digest != frame_digest:
        raise EvidenceError(f"{label}.frame_sha256 contradicts its embedded frame")
    actual_spans_digest, _ = _validate_native_spans_value(spans, viewport, f"{label}.spans")
    if actual_spans_digest != spans_digest:
        raise EvidenceError(f"{label}.spans_sha256 contradicts its embedded spans")
    actual_state_digest, _ = _validate_native_state(state, f"{label}.state")
    if actual_state_digest != state_digest:
        raise EvidenceError(f"{label}.state_sha256 contradicts its embedded state")
    return data


def _validate_native_snapshot_files(
    root: Path,
    value: object,
    embedded: dict[str, object],
    viewport: dict[str, int],
    source_paths: set[str],
    label: str,
) -> set[str]:
    """Bind one retained snapshot's files to the embedded native snapshot."""
    frame_binding, frame_path, frame_raw, frame_digest = _native_utf8_binding(
        root,
        _object(value, label).get("frame"),
        f"{label}.frame",
        allowed={"path", "sha256", "encoding"},
        source_paths=source_paths,
        max_bytes=MAX_CAPTURE_OUTPUT_BYTES,
    )
    try:
        frame_text = frame_raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EvidenceError(f"{label}.frame must be UTF-8") from exc
    if frame_digest != embedded["frame_sha256"] or frame_text != embedded["frame"]:
        raise EvidenceError(f"{label}.frame does not match the native fixture snapshot")
    spans_binding, spans_path, spans_raw, spans_file_digest = _native_utf8_binding(
        root,
        _object(value, label).get("semantic_spans"),
        f"{label}.semantic_spans",
        allowed={"path", "sha256", "semantic_sha256", "encoding", "format"},
        source_paths=source_paths,
        max_bytes=MAX_CAPTURE_OUTPUT_BYTES,
        format_value="opentui-captureSpans-v1",
    )
    spans_value = _json_bytes_value(spans_raw, f"{label}.semantic_spans")
    spans_digest, _ = _validate_native_spans_value(spans_value, viewport, f"{label}.semantic_spans")
    if spans_value != embedded["spans"] or spans_digest != embedded["spans_sha256"]:
        raise EvidenceError(f"{label}.semantic_spans does not match the native fixture snapshot")
    if _validate_digest(spans_binding.get("semantic_sha256"), f"{label}.semantic_spans.semantic_sha256") != spans_digest:
        raise EvidenceError(f"{label}.semantic_spans semantic digest is contradictory")
    state_binding, state_path, state_raw, state_file_digest = _native_utf8_binding(
        root,
        _object(value, label).get("state"),
        f"{label}.state",
        allowed={"path", "sha256", "semantic_sha256", "encoding", "format"},
        source_paths=source_paths,
        max_bytes=MAX_CAPTURE_OUTPUT_BYTES,
        format_value="native-state-v1",
    )
    state_value = _json_bytes_value(state_raw, f"{label}.state")
    state_digest, _ = _validate_native_state(state_value, f"{label}.state")
    if state_value != embedded["state"] or state_digest != embedded["state_sha256"]:
        raise EvidenceError(f"{label}.state does not match the native fixture snapshot")
    if _validate_digest(state_binding.get("semantic_sha256"), f"{label}.state.semantic_sha256") != state_digest:
        raise EvidenceError(f"{label}.state semantic digest is contradictory")
    if frame_binding.get("sha256") != frame_digest or spans_binding.get("sha256") != spans_file_digest:
        raise EvidenceError(f"{label} contains contradictory retained-file digests")
    if state_binding.get("sha256") != state_file_digest:
        raise EvidenceError(f"{label}.state contains a contradictory retained-file digest")
    return {frame_path, spans_path, state_path}


def _native_snapshot_reference(
    value: object,
    snapshots: dict[str, dict[str, object]],
    label: str,
) -> dict[str, object]:
    """Validate an event's binding to one retained native snapshot."""
    data = _object(value, label)
    _reject_unknown(data, {"snapshot_id", "frame_sha256", "spans_sha256", "state_sha256"}, label)
    snapshot_id = _string(data.get("snapshot_id"), f"{label}.snapshot_id")
    snapshot = snapshots.get(snapshot_id)
    if snapshot is None:
        raise EvidenceError(f"{label}.snapshot_id is not a retained native snapshot")
    for field in ("frame_sha256", "spans_sha256", "state_sha256"):
        if _validate_digest(data.get(field), f"{label}.{field}") != snapshot[field]:
            raise EvidenceError(f"{label}.{field} contradicts the retained native snapshot")
    return snapshot


def _validate_native_action(value: object, phase: str, label: str) -> dict[str, object]:
    """Validate the action observed by the native OpenTUI fixture."""
    data = _object(value, label)
    _reject_unknown(data, {"type", "target", "input"}, label)
    action_type = _string(data.get("type"), f"{label}.type")
    allowed = {
        "test-setup": {"setup"},
        "test-dispatch": {"click", "key", "command", "input", "scroll"},
        "test-teardown": {"teardown"},
    }
    if phase not in allowed:
        raise EvidenceError(f"{label} has an unsupported native phase: {phase}")
    if action_type not in allowed[phase]:
        raise EvidenceError(f"{label}.type is invalid for phase {phase}")
    _string(data.get("target"), f"{label}.target")
    if phase == "test-dispatch" and "input" not in data:
        raise EvidenceError(f"{label}.input is required for a native interaction")
    if phase != "test-dispatch" and "input" in data:
        raise EvidenceError(f"{label}.input is only valid for a native interaction")
    return data


def _validate_native_dispatch(value: object, phase: str, label: str) -> dict[str, object]:
    """Validate the concrete mouse/keyboard/lifecycle dispatch metadata."""
    data = _object(value, label)
    _reject_unknown(data, {"device", "method", "target", "input"}, label)
    device = _string(data.get("device"), f"{label}.device")
    method = _string(data.get("method"), f"{label}.method")
    _string(data.get("target"), f"{label}.target")
    if phase == "test-setup":
        if device != "lifecycle" or method != "mount":
            raise EvidenceError(f"{label} must describe a test-renderer mount dispatch")
    elif phase == "test-teardown":
        if device != "lifecycle" or method != "unmount":
            raise EvidenceError(f"{label} must describe a test-renderer unmount dispatch")
    else:
        if device not in {"mouse", "keyboard"} or "input" not in data:
            raise EvidenceError(f"{label} must retain a test-renderer mouse or keyboard input")
    return data


def _validate_native_result(
    value: object,
    phase: str,
    action: dict[str, object],
    before: dict[str, object],
    after: dict[str, object],
    label: str,
) -> dict[str, object]:
    """Recompute the native transition result from retained snapshot bindings."""
    data = _object(value, label)
    _reject_unknown(data, {"status", "target", "observed"}, label)
    if _string(data.get("status"), f"{label}.status") != "passed":
        raise EvidenceError(f"{label}.status must be passed")
    if _string(data.get("target"), f"{label}.target") != action["target"]:
        raise EvidenceError(f"{label}.target contradicts the native action")
    observed = _object(data.get("observed"), f"{label}.observed")
    _reject_unknown(
        observed,
        {"visibility_before", "visibility_after", "frame_changed", "spans_changed", "state_changed"},
        f"{label}.observed",
    )
    expected = {
        "visibility_before": before["state"]["visible"],
        "visibility_after": after["state"]["visible"],
        "frame_changed": before["frame_sha256"] != after["frame_sha256"],
        "spans_changed": before["spans_sha256"] != after["spans_sha256"],
        "state_changed": before["state_sha256"] != after["state_sha256"],
    }
    if any(not isinstance(observed.get(key), bool) for key in expected):
        raise EvidenceError(f"{label}.observed values must be boolean")
    if observed != expected:
        raise EvidenceError(f"{label}.observed contradicts the retained native snapshots")
    if not any(expected[key] for key in ("frame_changed", "spans_changed", "state_changed")):
        raise EvidenceError(f"{label} does not observe a native frame or state transition")
    if phase == "test-setup" and not expected["visibility_after"]:
        raise EvidenceError(f"{label} test setup did not show the fixture surface")
    if phase == "test-teardown" and (
        not expected["visibility_before"] or expected["visibility_after"]
    ):
        raise EvidenceError(f"{label} test teardown did not hide the fixture surface")
    return data


def _validate_native_provenance(
    value: object,
    *,
    expected_run_id: str,
    label: str,
) -> dict[str, object]:
    """Require retained test-renderer dispatch/transition identities and clock order."""
    data = _object(value, label)
    _reject_unknown(
        data,
        {
            "scope",
            "run_id",
            "dispatch_id",
            "transition_id",
            "dispatch_monotonic_ns",
            "transition_monotonic_ns",
        },
        label,
    )
    if _string(data.get("scope"), f"{label}.scope") != NATIVE_TEST_RENDERER_SCOPE:
        raise EvidenceError(f"{label}.scope must identify test-renderer evidence")
    if _run_id(data.get("run_id"), f"{label}.run_id") != expected_run_id:
        raise EvidenceError(f"{label}.run_id does not match the native capture run")
    _string(data.get("dispatch_id"), f"{label}.dispatch_id")
    _string(data.get("transition_id"), f"{label}.transition_id")
    dispatch_time = _monotonic_ns(
        data.get("dispatch_monotonic_ns"), f"{label}.dispatch_monotonic_ns"
    )
    transition_time = _monotonic_ns(
        data.get("transition_monotonic_ns"), f"{label}.transition_monotonic_ns"
    )
    if transition_time <= dispatch_time:
        raise EvidenceError(f"{label} transition time must follow its dispatch")
    return data


def _validate_native_event_value(
    value: object,
    *,
    phase: str,
    event_id: str,
    run_id: str,
    snapshots: dict[str, dict[str, object]],
    label: str,
) -> dict[str, object]:
    """Validate one event emitted by the native fixture and its transition hash."""
    data = _object(value, label)
    _reject_unknown(
        data,
        {
            "version",
            "phase",
            "event_id",
            "action",
            "dispatch",
            "provenance",
            "before",
            "after",
            "result",
            "native_event_sha256",
        },
        label,
    )
    if data.get("version") != CAPTURE_EVENT_VERSION:
        raise EvidenceError(f"{label}.version must be {CAPTURE_EVENT_VERSION}")
    if _string(data.get("phase"), f"{label}.phase") != phase or _string(data.get("event_id"), f"{label}.event_id") != event_id:
        raise EvidenceError(f"{label} identity contradicts the event reference")
    action = _validate_native_action(data.get("action"), phase, f"{label}.action")
    dispatch = _validate_native_dispatch(data.get("dispatch"), phase, f"{label}.dispatch")
    provenance = _validate_native_provenance(
        data.get("provenance"), expected_run_id=run_id, label=f"{label}.provenance"
    )
    before = _native_snapshot_reference(data.get("before"), snapshots, f"{label}.before")
    after = _native_snapshot_reference(data.get("after"), snapshots, f"{label}.after")
    result = _validate_native_result(data.get("result"), phase, action, before, after, f"{label}.result")
    core = {key: value for key, value in data.items() if key != "native_event_sha256"}
    if _validate_digest(data.get("native_event_sha256"), f"{label}.native_event_sha256") != _canonical_digest(core):
        raise EvidenceError(f"{label}.native_event_sha256 does not match the native event")
    return {
        "data": data,
        "action": action,
        "dispatch": dispatch,
        "provenance": provenance,
        "before": before,
        "after": after,
        "result": result,
    }


def _validate_native_capture_output(
    root: Path,
    value: object,
    viewport: dict[str, int],
    source_paths: set[str],
    label: str,
) -> tuple[str, str, dict[str, object], dict[str, dict[str, object]], dict[str, dict[str, object]]]:
    """Validate the retained per-capture output emitted by the OpenTUI fixture."""
    _, output_path, output_raw, output_digest = _native_utf8_binding(
        root,
        value,
        label,
        allowed={"path", "sha256", "encoding", "format"},
        source_paths=source_paths,
        max_bytes=MAX_CAPTURE_BYTES,
        format_value="native-opentui-capture-v1",
    )
    output = _json_bytes_value(output_raw, label)
    _reject_unknown(
        output,
        {
            "version",
            "id",
            "run_id",
            "viewport",
            "snapshots",
            "final_snapshot_id",
            "reachable_targets",
            "events",
        },
        label,
    )
    if output.get("version") != 1:
        raise EvidenceError(f"{label}.version must be 1")
    _string(output.get("id"), f"{label}.id")
    run_id = _run_id(output.get("run_id"), f"{label}.run_id")
    if _validate_viewport(output.get("viewport"), f"{label}.viewport") != viewport:
        raise EvidenceError(f"{label}.viewport contradicts the capture viewport")
    raw_snapshots = _object(output.get("snapshots"), f"{label}.snapshots")
    if not raw_snapshots or len(raw_snapshots) > MAX_NATIVE_SNAPSHOTS:
        raise EvidenceError(f"{label}.snapshots must contain between 1 and {MAX_NATIVE_SNAPSHOTS} items")
    snapshots: dict[str, dict[str, object]] = {}
    for snapshot_id, raw_snapshot in raw_snapshots.items():
        snapshot = _validate_native_snapshot_value(raw_snapshot, viewport, f"{label}.snapshots[{snapshot_id}]")
        if snapshot["id"] != snapshot_id:
            raise EvidenceError(f"{label}.snapshots[{snapshot_id}] has a contradictory id")
        snapshots[snapshot_id] = snapshot
    final_snapshot_id = _string(output.get("final_snapshot_id"), f"{label}.final_snapshot_id")
    if final_snapshot_id not in snapshots:
        raise EvidenceError(f"{label}.final_snapshot_id is not retained in snapshots")
    _string_list(output.get("reachable_targets"), f"{label}.reachable_targets", non_empty=True, max_items=MAX_ASSERTIONS)
    raw_events = output.get("events")
    if not isinstance(raw_events, list) or len(raw_events) != 3:
        raise EvidenceError(f"{label}.events must contain exactly three native events")
    events: dict[str, dict[str, object]] = {}
    for index, raw_event in enumerate(raw_events):
        event_data = _object(raw_event, f"{label}.events[{index}]")
        event_phase = _string(event_data.get("phase"), f"{label}.events[{index}].phase")
        event_id = _string(event_data.get("event_id"), f"{label}.events[{index}].event_id")
        if event_id in events:
            raise EvidenceError(f"{label}.events contains duplicate event id: {event_id}")
        events[event_id] = _validate_native_event_value(
            event_data,
            phase=event_phase,
            event_id=event_id,
            run_id=run_id,
            snapshots=snapshots,
            label=f"{label}.events[{index}]",
        )
    phases = {event["data"]["phase"] for event in events.values()}
    if phases != {"test-setup", "test-dispatch", "test-teardown"}:
        raise EvidenceError(f"{label}.events must contain test setup, dispatch, and teardown")
    prior_transition = 0
    ordered_events = {
        event["data"]["phase"]: event
        for event in events.values()
    }
    for phase in ("test-setup", "test-dispatch", "test-teardown"):
        provenance = ordered_events[phase]["provenance"]
        dispatch_time = _monotonic_ns(
            provenance.get("dispatch_monotonic_ns"), f"{label}.events.{phase}.dispatch_monotonic_ns"
        )
        transition_time = _monotonic_ns(
            provenance.get("transition_monotonic_ns"), f"{label}.events.{phase}.transition_monotonic_ns"
        )
        if dispatch_time <= prior_transition:
            raise EvidenceError(f"{label}.events test-renderer timings are not strictly monotonic")
        prior_transition = transition_time
    dispatch_ids = [event["provenance"]["dispatch_id"] for event in events.values()]
    transition_ids = [event["provenance"]["transition_id"] for event in events.values()]
    if len(set(dispatch_ids)) != 3 or len(set(transition_ids)) != 3:
        raise EvidenceError(f"{label}.events must retain unique dispatch and transition ids")
    return output_path, output_digest, output, snapshots, events


def _validate_native_capture_run(
    root: Path,
    value: object,
    *,
    capture_run_id: str,
    native_capture_test: str,
    expected_inputs: dict[str, str],
    label: str,
) -> None:
    """Bind fixture frames and events to one exact native test invocation."""
    data = _object(value, label)
    _reject_unknown(
        data,
        {
            "scope",
            "run_id",
            "argv",
            "cwd",
            "started_at",
            "finished_at",
            "started_monotonic_ns",
            "finished_monotonic_ns",
            "exit_code",
            "inputs",
        },
        label,
    )
    if _string(data.get("scope"), f"{label}.scope") != NATIVE_TEST_RENDERER_SCOPE:
        raise EvidenceError(f"{label}.scope must identify test-renderer evidence")
    if _run_id(data.get("run_id"), f"{label}.run_id") != capture_run_id:
        raise EvidenceError(f"{label}.run_id does not match the retained native capture output")
    argv = data.get("argv")
    if (
        not isinstance(argv, list)
        or not argv
        or len(argv) > 128
        or any(not isinstance(argument, str) or not argument for argument in argv)
    ):
        raise EvidenceError(f"{label}.argv must contain the exact native test command")
    cwd = _string(data.get("cwd"), f"{label}.cwd")
    working_directory = (
        root if cwd == "." else _project_directory(root, cwd, f"{label}.cwd")
    )
    relative_cwd = working_directory.relative_to(root).as_posix()
    test_invoked = False
    for argument in argv[1:]:
        if Path(argument).is_absolute() or PureWindowsPath(argument).is_absolute():
            continue
        resolved_argument = (
            PurePosixPath(argument)
            if relative_cwd == "."
            else PurePosixPath(relative_cwd) / PurePosixPath(argument)
        )
        if resolved_argument.as_posix() == native_capture_test:
            test_invoked = True
            break
    if not test_invoked:
        raise EvidenceError(f"{label}.argv does not invoke the retained native capture test")
    started_at = _utc_timestamp(data.get("started_at"), f"{label}.started_at")
    finished_at = _utc_timestamp(data.get("finished_at"), f"{label}.finished_at")
    started_monotonic = _monotonic_ns(data.get("started_monotonic_ns"), f"{label}.started_monotonic_ns")
    finished_monotonic = _monotonic_ns(data.get("finished_monotonic_ns"), f"{label}.finished_monotonic_ns")
    if finished_at < started_at or finished_monotonic <= started_monotonic:
        raise EvidenceError(f"{label} invocation timestamps are not monotonic")
    exit_code = data.get("exit_code")
    if isinstance(exit_code, bool) or not isinstance(exit_code, int) or exit_code != 0:
        raise EvidenceError(f"{label}.exit_code must be zero")
    inputs = data.get("inputs")
    if not isinstance(inputs, list) or len(inputs) > MAX_UI_SOURCES + MAX_UI_TESTS + 8:
        raise EvidenceError(f"{label}.inputs must be a bounded digest list")
    observed_inputs: dict[str, str] = {}
    for index, raw_input in enumerate(inputs):
        input_label = f"{label}.inputs[{index}]"
        input_data = _object(raw_input, input_label)
        _reject_unknown(input_data, {"path", "sha256"}, input_label)
        path_text = _string(input_data.get("path"), f"{input_label}.path")
        if path_text in observed_inputs:
            raise EvidenceError(f"{label}.inputs contains a duplicate path: {path_text}")
        _, _, digest = _file_with_digest(
            root,
            path_text,
            input_data.get("sha256"),
            f"{input_label}.path",
            max_bytes=MAX_TEST_BYTES,
        )
        observed_inputs[path_text] = digest
    for path_text, expected_digest in expected_inputs.items():
        if observed_inputs.get(path_text) != expected_digest:
            raise EvidenceError(
                f"{label}.inputs does not bind current source/test {path_text}"
            )


def _validate_layout_assertions(
    value: object,
    viewport: dict[str, int],
    character_text: str,
    label: str,
) -> None:
    """Recompute density and reachability from retained character output."""
    if not isinstance(value, list) or not value:
        raise EvidenceError(f"{label} must be a non-empty list")
    if len(value) > MAX_ASSERTIONS:
        raise EvidenceError(f"{label} must contain at most {MAX_ASSERTIONS} items")
    required = {
        "visible_rows": "<=",
        "max_line_columns": "<=",
        "reachable_sections": "==",
    }
    plain_text = ANSI_CSI_PATTERN.sub("", ANSI_OSC_PATTERN.sub("", character_text))
    lines = plain_text.splitlines()
    visible_lines = [line for line in lines if line.strip()]

    def cell_width(text: str) -> int:
        width = 0
        for character in text:
            if character == "\t":
                width += 8 - (width % 8)
                continue
            if unicodedata.combining(character) or unicodedata.category(character) in {
                "Cc",
                "Cf",
                "Me",
            }:
                continue
            width += 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
        return width

    observed_ids: set[str] = set()
    for index, item in enumerate(value):
        item_label = f"{label}[{index}]"
        data = _object(item, item_label)
        _reject_unknown(data, {"id", "operator", "limit", "targets"}, item_label)
        assertion_id = _string(data.get("id"), f"{item_label}.id")
        if assertion_id in observed_ids:
            raise EvidenceError(f"{label} contains duplicate assertion: {assertion_id}")
        observed_ids.add(assertion_id)
        if assertion_id not in required:
            raise EvidenceError(f"{item_label}.id is not a supported deterministic assertion")
        limit = data.get("limit")
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise EvidenceError(f"{item_label}.limit must be a non-negative integer")
        operator = _string(data.get("operator"), f"{item_label}.operator")
        if operator != required[assertion_id]:
            raise EvidenceError(
                f"{item_label}.operator must be {required[assertion_id]!r}"
            )
        if assertion_id == "visible_rows" and limit != viewport["rows"]:
            raise EvidenceError(f"{item_label}.limit must equal viewport rows")
        if assertion_id == "max_line_columns" and limit != viewport["columns"]:
            raise EvidenceError(f"{item_label}.limit must equal viewport columns")
        if assertion_id == "reachable_sections" and limit < 1:
            raise EvidenceError(f"{item_label}.limit must identify at least one section")
        targets_value = data.get("targets")
        if assertion_id == "reachable_sections":
            targets = _string_list(
                targets_value,
                f"{item_label}.targets",
                non_empty=True,
                max_items=MAX_ASSERTIONS,
            )
            if len(targets) != limit:
                raise EvidenceError(f"{item_label}.targets must contain exactly limit entries")
            observed = sum(1 for target in targets if target in plain_text)
        else:
            if targets_value is not None:
                raise EvidenceError(f"{item_label}.targets is only valid for reachable_sections")
            observed = (
                len(visible_lines)
                if assertion_id == "visible_rows"
                else max((cell_width(line) for line in lines), default=0)
            )
        if not (
            (operator == "<=" and observed <= limit)
            or (operator == ">=" and observed >= limit)
            or (operator == "==" and observed == limit)
        ):
            raise EvidenceError(f"{item_label} observed value violates its limit")
    missing = sorted(set(required) - observed_ids)
    if missing:
        raise EvidenceError(f"{label} is missing required assertion(s): {', '.join(missing)}")


def _validate_image(raw: bytes, mime: str, label: str) -> tuple[int, int]:
    """Return dimensions for retained bytes with a recognizable image structure."""
    if mime == "image/png":
        valid = raw.startswith(PNG_SIGNATURE) and len(raw) >= 24 and raw[12:16] == b"IHDR"
        dimensions = struct.unpack(">II", raw[16:24]) if valid else None
    elif mime == "image/jpeg":
        valid = raw.startswith(b"\xff\xd8\xff") and raw.endswith(b"\xff\xd9")
        dimensions = None
        offset = 2
        while valid and offset + 9 < len(raw):
            if raw[offset] != 0xFF:
                offset += 1
                continue
            marker = raw[offset + 1]
            if marker in {0xD8, 0xD9}:
                offset += 2
                continue
            if offset + 4 > len(raw):
                break
            length = int.from_bytes(raw[offset + 2 : offset + 4], "big")
            if length < 2 or offset + 2 + length > len(raw):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height = int.from_bytes(raw[offset + 5 : offset + 7], "big")
                width = int.from_bytes(raw[offset + 7 : offset + 9], "big")
                dimensions = (width, height)
                break
            offset += 2 + length
    elif mime == "image/webp":
        valid = raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"
        dimensions = None
        if valid and len(raw) >= 30 and raw[12:16] == b"VP8X":
            width = int.from_bytes(raw[24:27], "little") + 1
            height = int.from_bytes(raw[27:30], "little") + 1
            dimensions = (width, height)
        elif valid and len(raw) >= 30 and raw[12:16] == b"VP8 ":
            if raw[23:26] == b"\x9d\x01\x2a":
                width = int.from_bytes(raw[26:28], "little") & 0x3FFF
                height = int.from_bytes(raw[28:30], "little") & 0x3FFF
                dimensions = (width, height)
        elif valid and len(raw) >= 25 and raw[12:16] == b"VP8L" and raw[20] == 0x2F:
            bits = int.from_bytes(raw[21:25], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            dimensions = (width, height)
    else:
        raise EvidenceError(f"{label}.mime is unsupported: {mime}")
    if not valid or dimensions is None or min(dimensions) < 1:
        raise EvidenceError(f"{label} does not contain recognizable image dimensions")
    return dimensions


def _host_timestamp(
    value: object,
    label: str,
    validation_time: dt.datetime,
) -> dt.datetime:
    """Parse a UTC host-capture timestamp and reject future instants."""
    if validation_time.tzinfo is None or validation_time.utcoffset() != dt.timedelta(0):
        raise EvidenceError("host-capture validation time must be timezone-aware UTC")
    text = _string(value, label)
    if HOST_TIMESTAMP_PATTERN.fullmatch(text) is None:
        raise EvidenceError(f"{label} must use an explicit UTC timestamp")
    timestamp = _utc_timestamp(text, label)
    if timestamp > validation_time:
        raise EvidenceError(f"{label} cannot be in the future")
    return timestamp


def _printable_string(value: object, label: str, max_length: int) -> str:
    """Return a non-empty printable string within a bounded length."""
    text = _string(value, label)
    if len(text) > max_length or any(unicodedata.category(char) == "Cc" for char in text):
        raise EvidenceError(
            f"{label} must be at most {max_length} printable characters"
        )
    return text


def _validate_host_bounds(value: object, label: str) -> dict[str, int]:
    """Validate bounded host window screen coordinates."""
    bounds = _object(value, label)
    _reject_unknown(bounds, {"x", "y", "width", "height"}, label)
    coordinates: dict[str, int] = {}
    for field in ("x", "y"):
        coordinate = bounds.get(field)
        if (
            isinstance(coordinate, bool)
            or not isinstance(coordinate, int)
            or abs(coordinate) > MAX_HOST_IMAGE_DIMENSION
        ):
            raise EvidenceError(f"{label}.{field} is outside the screen-coordinate limit")
        coordinates[field] = coordinate
    for field in ("width", "height"):
        dimension = bounds.get(field)
        if (
            isinstance(dimension, bool)
            or not isinstance(dimension, int)
            or dimension < 1
            or dimension > MAX_HOST_IMAGE_DIMENSION
        ):
            raise EvidenceError(f"{label}.{field} is outside the positive dimension limit")
        coordinates[field] = dimension
    if coordinates["width"] * coordinates["height"] > MAX_HOST_IMAGE_PIXELS:
        raise EvidenceError(f"{label} exceeds the host pixel limit")
    return coordinates


def _validate_host_window(value: object, label: str) -> dict[str, object]:
    """Validate declared host window identity and bounded screen coordinates."""
    data = _object(value, label)
    _reject_unknown(data, {"identity_sha256", "process", "bounds"}, label)
    identity = _validate_digest(data.get("identity_sha256"), f"{label}.identity_sha256")
    process = _printable_string(data.get("process"), f"{label}.process", 256)
    bounds = _validate_host_bounds(data.get("bounds"), f"{label}.bounds")
    return {"identity_sha256": identity, "process": process, "bounds": bounds}


def _validate_host_exact_window(value: object, label: str) -> dict[str, object]:
    """Validate an exact host window identity bound to its own canonical digest."""
    data = _object(value, label)
    _reject_unknown(
        data,
        {"window_sha256", "pid", "hwnd", "title", "wm_class", "bounds"},
        label,
    )
    pid = data.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1 or pid > 2**31 - 1:
        raise EvidenceError(f"{label}.pid must be a positive process id")
    hwnd = _string(data.get("hwnd"), f"{label}.hwnd")
    if HOST_HWND_PATTERN.fullmatch(hwnd) is None:
        raise EvidenceError(f"{label}.hwnd must be a lowercase 0x-prefixed window handle")
    title = _printable_string(data.get("title"), f"{label}.title", MAX_HOST_WINDOW_TITLE)
    wm_class = _printable_string(
        data.get("wm_class"), f"{label}.wm_class", MAX_HOST_WINDOW_CLASS
    )
    bounds = _validate_host_bounds(data.get("bounds"), f"{label}.bounds")
    core = {
        "pid": pid,
        "hwnd": hwnd,
        "title": title,
        "wm_class": wm_class,
        "bounds": bounds,
    }
    digest = _validate_digest(data.get("window_sha256"), f"{label}.window_sha256")
    if digest != _canonical_digest(core):
        raise EvidenceError(f"{label}.window_sha256 does not match its exact window identity")
    return {**core, "window_sha256": digest}


def _validate_host_action_receipt(value: object, label: str) -> dict[str, object]:
    """Validate a digest-bound causal action receipt for one allowlisted host action."""
    data = _object(value, label)
    _reject_unknown(
        data,
        {
            "version",
            "action_tool_id",
            "target_window_sha256",
            "target_selector",
            "action_monotonic_ns",
            "receipt_sha256",
        },
        label,
    )
    version = data.get("version")
    if (
        isinstance(version, bool)
        or not isinstance(version, int)
        or version != HOST_RECEIPT_VERSION
    ):
        raise EvidenceError(f"{label}.version must be the integer {HOST_RECEIPT_VERSION}")
    action_tool_id = _string(data.get("action_tool_id"), f"{label}.action_tool_id")
    if action_tool_id not in HOST_ACTION_TOOL_IDS:
        raise EvidenceError(f"{label}.action_tool_id is unsupported")
    target = _validate_digest(
        data.get("target_window_sha256"), f"{label}.target_window_sha256"
    )
    selector = _printable_string(
        data.get("target_selector"), f"{label}.target_selector", MAX_HOST_ACTION_SELECTOR
    )
    action_ns = _monotonic_ns(
        data.get("action_monotonic_ns"), f"{label}.action_monotonic_ns"
    )
    core = {
        "version": HOST_RECEIPT_VERSION,
        "action_tool_id": action_tool_id,
        "target_window_sha256": target,
        "target_selector": selector,
        "action_monotonic_ns": str(action_ns),
    }
    digest = _validate_digest(data.get("receipt_sha256"), f"{label}.receipt_sha256")
    if digest != _canonical_digest(core):
        raise EvidenceError(f"{label}.receipt_sha256 does not match its causal action receipt")
    return {**core, "action_monotonic_ns": action_ns, "receipt_sha256": digest}


def _validate_host_png(raw: bytes, label: str) -> tuple[int, int]:
    """Validate bounded PNG chunks, CRCs, image stream, and retained dimensions."""
    if not raw.startswith(PNG_SIGNATURE):
        raise EvidenceError(f"{label} is not a PNG")
    offset = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = interlace = None
    palette_entries = 0
    saw_palette = False
    saw_idat = False
    idat_closed = False
    saw_iend = False
    chunk_count = 0
    compressed = bytearray()
    channels_by_type = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    while offset + 12 <= len(raw):
        chunk_count += 1
        if chunk_count > MAX_HOST_PNG_CHUNKS:
            raise EvidenceError(f"{label} exceeds the PNG chunk limit")
        length = int.from_bytes(raw[offset : offset + 4], "big")
        kind = raw[offset + 4 : offset + 8]
        end = offset + 12 + length
        if length > MAX_HOST_IMAGE_BYTES or end > len(raw):
            raise EvidenceError(f"{label} contains an invalid PNG chunk")
        if not kind.isalpha() or kind[2] & 0x20:
            raise EvidenceError(f"{label} contains an invalid PNG chunk type")
        payload = raw[offset + 8 : offset + 8 + length]
        checksum = int.from_bytes(raw[offset + 8 + length : end], "big")
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != checksum:
            raise EvidenceError(f"{label} contains a corrupt PNG chunk")
        if chunk_count == 1 and kind != b"IHDR":
            raise EvidenceError(f"{label} must start with IHDR")
        if chunk_count > 1 and kind == b"IHDR":
            raise EvidenceError(f"{label} contains a duplicate PNG header")
        if kind == b"IHDR":
            if len(payload) != 13:
                raise EvidenceError(f"{label} contains an invalid PNG header")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if (
                width < 1
                or height < 1
                or width > MAX_HOST_IMAGE_DIMENSION
                or height > MAX_HOST_IMAGE_DIMENSION
                or width * height > MAX_HOST_IMAGE_PIXELS
            ):
                raise EvidenceError(f"{label} has dimensions outside the host image limit")
            if (
                bit_depth not in valid_depths.get(color_type, set())
                or compression != 0
                or filtering != 0
                or interlace not in {0, 1}
            ):
                raise EvidenceError(f"{label} has unsupported PNG image parameters")
        elif kind == b"PLTE":
            if saw_palette or saw_idat or color_type in {0, 4} or not 3 <= length <= 768 or length % 3:
                raise EvidenceError(f"{label} contains an invalid PNG palette")
            saw_palette = True
            palette_entries = length // 3
            if color_type == 3 and palette_entries > 1 << bit_depth:
                raise EvidenceError(f"{label} PNG palette exceeds its bit depth")
        elif kind == b"IDAT":
            if idat_closed or width is None or (color_type == 3 and not saw_palette):
                raise EvidenceError(f"{label} contains an out-of-order PNG image stream")
            saw_idat = True
            compressed.extend(payload)
            if len(compressed) > MAX_HOST_IMAGE_BYTES:
                raise EvidenceError(f"{label} exceeds the PNG compressed-byte limit")
        else:
            if saw_idat:
                idat_closed = True
            if kind == b"IEND":
                if not saw_idat or payload or end != len(raw):
                    raise EvidenceError(f"{label} contains an invalid PNG end chunk")
                saw_iend = True
                offset = end
                break
            if kind not in {b"IHDR", b"PLTE"} and not kind[0] & 0x20:
                raise EvidenceError(f"{label} contains an unknown critical PNG chunk")
        if kind != b"IDAT" and saw_idat:
            idat_closed = True
        offset = end
    if not saw_iend or width is None or height is None or not compressed:
        raise EvidenceError(f"{label} is missing required PNG chunks")
    if color_type == 3 and not saw_palette:
        raise EvidenceError(f"{label} indexed PNG is missing its palette")

    channels = channels_by_type[color_type]
    bits_per_pixel = channels * bit_depth
    if interlace == 0:
        passes = [(0, 0, 1, 1, width, height)]
    else:
        # Adam7's pass origins determine each bounded decoded scanline size.
        pass_origins = [
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
        passes = [
            (
                x_start,
                y_start,
                x_step,
                y_step,
                max(0, (width - x_start + x_step - 1) // x_step),
                max(0, (height - y_start + y_step - 1) // y_step),
            )
            for x_start, y_start, x_step, y_step in pass_origins
        ]
        passes = [item for item in passes if item[4] and item[5]]
    expected = sum(
        pass_height * (((pass_width * bits_per_pixel + 7) // 8) + 1)
        for _, _, _, _, pass_width, pass_height in passes
    )
    if expected > MAX_HOST_IMAGE_DECODED_BYTES:
        raise EvidenceError(f"{label} exceeds the PNG decoded-byte limit")
    try:
        decompressor = zlib.decompressobj()
        pixels = decompressor.decompress(bytes(compressed), expected + 1)
    except zlib.error as exc:
        raise EvidenceError(f"{label} contains invalid compressed PNG pixels") from exc
    if len(pixels) > expected or decompressor.unconsumed_tail:
        raise EvidenceError(f"{label} expands beyond its declared PNG dimensions")
    if decompressor.unused_data or not decompressor.eof or len(pixels) != expected:
        raise EvidenceError(f"{label} contains trailing or incomplete PNG pixels")
    offset = 0
    for _, _, _, _, pass_width, pass_height in passes:
        row_bytes = (pass_width * bits_per_pixel + 7) // 8
        for _ in range(pass_height):
            if pixels[offset] > 4:
                raise EvidenceError(f"{label} contains an unsupported PNG filter")
            offset += row_bytes + 1
    return width, height


def _validate_host_evidence_record(
    root: Path,
    reference_value: object,
    kind: str,
    source_paths: set[str],
    validation_time: dt.datetime,
) -> dict[str, object]:
    """Validate one declared host record and bind it to retained PNG bytes."""
    label = f"host_evidence.{kind}"
    reference = _object(reference_value, f"{label}.reference")
    _reject_unknown(reference, {"path", "sha256"}, f"{label}.reference")
    record_path, record_raw, record_digest = _file_with_digest(
        root,
        reference.get("path"),
        reference.get("sha256"),
        f"{label}.record",
        max_bytes=MAX_HOST_RECORD_BYTES,
        forbidden_paths=source_paths,
    )
    record = _json_bytes_value(record_raw, f"{label}.record")
    allowed = {
        "version",
        "kind",
        "tool_id",
        "capture_method",
        "run_id",
        "captured_at",
        "monotonic_ns",
        "window",
    }
    allowed.update({"image", "exact_window"} if kind == "rendered_visual" else {"action", "result"})
    _reject_unknown(record, allowed, f"{label}.record")
    version = record.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != HOST_EVIDENCE_VERSION:
        raise EvidenceError(f"{label}.record.version must be the integer {HOST_EVIDENCE_VERSION}")
    if _string(record.get("kind"), f"{label}.record.kind") != kind:
        raise EvidenceError(f"{label}.record.kind must be {kind}")
    tool_id = _string(record.get("tool_id"), f"{label}.record.tool_id")
    capture_method = _string(record.get("capture_method"), f"{label}.record.capture_method")
    valid_capture_methods = {
        ("rig-tools.vision_capture", "wsl-interop.windows.screenshot"),
        ("powershell_raw", "bounded-script"),
    }
    if (tool_id, capture_method) not in valid_capture_methods:
        raise EvidenceError(f"{label}.record uses an unsupported host capture tool")
    run_id = _run_id(record.get("run_id"), f"{label}.record.run_id")
    captured_at = _host_timestamp(
        record.get("captured_at"),
        f"{label}.record.captured_at",
        validation_time,
    )
    monotonic_ns = _monotonic_ns(
        record.get("monotonic_ns"), f"{label}.record.monotonic_ns"
    )
    window = _validate_host_window(record.get("window"), f"{label}.record.window")

    if kind == "rendered_visual":
        image_value = record.get("image")
        result_visual_digest = None
        action_tool_id = None
        action_receipt = None
    else:
        action = _object(record.get("action"), f"{label}.record.action")
        _reject_unknown(action, {"tool_id", "event", "receipt"}, f"{label}.record.action")
        action_tool_id = _string(action.get("tool_id"), f"{label}.record.action.tool_id")
        if action_tool_id not in HOST_ACTION_TOOL_IDS:
            raise EvidenceError(f"{label}.record.action.tool_id is unsupported")
        _printable_string(action.get("event"), f"{label}.record.action.event", MAX_HOST_ACTION_EVENT)
        receipt_value = action.get("receipt")
        action_receipt = (
            _validate_host_action_receipt(receipt_value, f"{label}.record.action.receipt")
            if receipt_value is not None
            else None
        )
        result = _object(record.get("result"), f"{label}.record.result")
        _reject_unknown(
            result,
            {"image", "rendered_visual_sha256"},
            f"{label}.record.result",
        )
        result_visual_digest = _validate_digest(
            result.get("rendered_visual_sha256"),
            f"{label}.record.result.rendered_visual_sha256",
        )
        image_value = result.get("image")

    exact_window_value = record.get("exact_window")
    exact_window = (
        _validate_host_exact_window(exact_window_value, f"{label}.record.exact_window")
        if exact_window_value is not None
        else None
    )

    image = _object(image_value, f"{label}.record.image")
    _reject_unknown(image, {"path", "sha256", "width", "height"}, f"{label}.record.image")
    image_path_text = _string(image.get("path"), f"{label}.record.image.path")
    if Path(image_path_text).suffix.lower() != ".png":
        raise EvidenceError(f"{label}.record.image.path must use a .png suffix")
    image_path, image_raw, image_digest = _file_with_digest(
        root,
        image_path_text,
        image.get("sha256"),
        f"{label}.record.image",
        max_bytes=MAX_HOST_IMAGE_BYTES,
        forbidden_paths=source_paths,
    )
    width, height = _validate_host_png(image_raw, f"{label}.record.image")
    if (
        isinstance(image.get("width"), bool)
        or not isinstance(image.get("width"), int)
        or image.get("width") != width
        or isinstance(image.get("height"), bool)
        or not isinstance(image.get("height"), int)
        or image.get("height") != height
    ):
        raise EvidenceError(f"{label}.record.image dimensions contradict the retained PNG")
    if record_path == image_path:
        raise EvidenceError(f"{label}.record cannot also be its PNG image")
    return {
        "record_path": record_path,
        "record_sha256": record_digest,
        "image_path": image_path,
        "image_sha256": image_digest,
        "tool_id": tool_id,
        "capture_method": capture_method,
        "run_id": run_id,
        "captured_at": captured_at,
        "monotonic_ns": monotonic_ns,
        "window": window,
        "result_visual_sha256": result_visual_digest,
        "exact_window": exact_window,
        "action_tool_id": action_tool_id,
        "action_receipt": action_receipt,
    }


def _validate_host_evidence(
    root: Path,
    value: object,
    source_paths: set[str],
    *,
    forbidden_paths: set[str] | None = None,
    validation_time: dt.datetime | None = None,
) -> tuple[set[str], set[str], set[tuple[str, str]], set[str]]:
    """Return validated host visual and interaction records without claiming origin proof."""
    if value is None:
        raise EvidenceError("ui_acceptance.host_evidence must be a non-empty list")
    if not isinstance(value, list) or not value:
        raise EvidenceError("ui_acceptance.host_evidence must be a non-empty list")
    if len(value) > MAX_HOST_EVIDENCE_PAIRS:
        raise EvidenceError(
            f"ui_acceptance.host_evidence must contain at most {MAX_HOST_EVIDENCE_PAIRS} pairs"
        )
    now = validation_time or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None or now.utcoffset() != dt.timedelta(0):
        raise EvidenceError("host-capture validation time must be timezone-aware UTC")
    forbidden = forbidden_paths or set()
    visual_paths: set[str] = set()
    interaction_paths: set[str] = set()
    evidence_paths: set[str] = set()
    image_paths: set[str] = set()
    image_digests: set[str] = set()
    run_ids: set[str] = set()
    pairs: set[tuple[str, str]] = set()
    for index, value_pair in enumerate(value):
        label = f"ui_acceptance.host_evidence[{index}]"
        pair = _object(value_pair, label)
        _reject_unknown(pair, {"rendered_visual", "interaction"}, label)
        visual = _validate_host_evidence_record(
            root,
            pair.get("rendered_visual"),
            "rendered_visual",
            source_paths,
            now,
        )
        interaction = _validate_host_evidence_record(
            root,
            pair.get("interaction"),
            "interaction",
            source_paths,
            now,
        )
        if visual["run_id"] != interaction["run_id"]:
            raise EvidenceError(f"{label} records must share one host capture run_id")
        if interaction["result_visual_sha256"] != visual["record_sha256"]:
            raise EvidenceError(f"{label} interaction result does not bind its rendered_visual record")
        if visual["run_id"] in run_ids:
            raise EvidenceError(f"{label} reuses a host capture run_id")
        run_ids.add(str(visual["run_id"]))
        if (
            visual["tool_id"] != interaction["tool_id"]
            or visual["capture_method"] != interaction["capture_method"]
        ):
            raise EvidenceError(f"{label} records must use one host capture tool")
        if visual["window"] != interaction["window"]:
            raise EvidenceError(f"{label} records must identify the same host window")
        visual_exact_window = visual["exact_window"]
        interaction_receipt = interaction["action_receipt"]
        if (visual_exact_window is None) != (interaction_receipt is None):
            raise EvidenceError(
                f"{label} exact_window and action receipt must be declared together"
            )
        if visual_exact_window is not None and interaction_receipt is not None:
            if visual_exact_window["bounds"] != visual["window"]["bounds"]:
                raise EvidenceError(
                    f"{label} exact_window bounds contradict the declared host window"
                )
            if interaction_receipt["target_window_sha256"] != visual_exact_window["window_sha256"]:
                raise EvidenceError(
                    f"{label} action receipt target does not match the rendered_visual exact window"
                )
            if interaction_receipt["action_tool_id"] != interaction["action_tool_id"]:
                raise EvidenceError(
                    f"{label} action receipt tool does not match the declared interaction action"
                )
            if not (
                visual["monotonic_ns"]
                < interaction_receipt["action_monotonic_ns"]
                < interaction["monotonic_ns"]
            ):
                raise EvidenceError(
                    f"{label} action receipt is not ordered between render and interaction"
                )
        if interaction["monotonic_ns"] <= visual["monotonic_ns"]:
            raise EvidenceError(f"{label} monotonic_ns values must be strictly increasing")
        if interaction["captured_at"] < visual["captured_at"]:
            raise EvidenceError(f"{label} UTC capture times must be non-decreasing")
        current_paths = {
            str(visual["record_path"]),
            str(interaction["record_path"]),
            str(visual["image_path"]),
            str(interaction["image_path"]),
        }
        if len(current_paths) != 4 or evidence_paths.intersection(current_paths):
            raise EvidenceError(f"{label} reuses a host record or PNG path")
        current_images = {
            str(visual["image_path"]),
            str(interaction["image_path"]),
        }
        current_digests = {
            str(visual["image_sha256"]),
            str(interaction["image_sha256"]),
        }
        if len(current_digests) != 2 or image_paths.intersection(current_images) or image_digests.intersection(current_digests):
            raise EvidenceError(f"{label} reuses a retained host PNG")
        if current_paths.intersection(forbidden):
            raise EvidenceError(f"{label} reuses a source or test-renderer artifact")
        evidence_paths.update(current_paths)
        image_paths.update(current_images)
        image_digests.update(current_digests)
        visual_path = str(visual["record_path"])
        interaction_path = str(interaction["record_path"])
        visual_paths.add(visual_path)
        interaction_paths.add(interaction_path)
        pairs.add((visual_path, interaction_path))
    return visual_paths, interaction_paths, pairs, evidence_paths


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    """Encode one PNG chunk for a non-claimable semantic-span diagnostic."""
    return (
        len(payload).to_bytes(4, "big")
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def _png_rgba_scanlines(raw: bytes, label: str) -> tuple[int, int, bytes]:
    """Read bounded unfiltered RGBA PNG scanlines without depending on compression bytes."""
    if not raw.startswith(PNG_SIGNATURE):
        raise EvidenceError(f"{label} is not a PNG")
    offset = len(PNG_SIGNATURE)
    width = height = None
    idat = bytearray()
    ended = False
    while offset + 12 <= len(raw):
        length = int.from_bytes(raw[offset : offset + 4], "big")
        kind = raw[offset + 4 : offset + 8]
        end = offset + 12 + length
        if length > MAX_CAPTURE_OUTPUT_BYTES * 4 or end > len(raw):
            raise EvidenceError(f"{label} contains an invalid PNG chunk")
        payload = raw[offset + 8 : offset + 8 + length]
        checksum = int.from_bytes(raw[offset + 8 + length : end], "big")
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != checksum:
            raise EvidenceError(f"{label} contains a corrupt PNG chunk")
        if kind == b"IHDR":
            if len(payload) != 13 or width is not None:
                raise EvidenceError(f"{label} contains an invalid PNG header")
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if bit_depth != 8 or color_type != 6 or compression != 0 or filtering != 0 or interlace != 0:
                raise EvidenceError(f"{label} must be an 8-bit non-interlaced RGBA PNG")
        elif kind == b"IDAT":
            idat.extend(payload)
        elif kind == b"IEND":
            if payload or end != len(raw):
                raise EvidenceError(f"{label} contains trailing or invalid PNG data")
            ended = True
            break
        offset = end
    if not ended or width is None or height is None or not idat:
        raise EvidenceError(f"{label} is missing required PNG chunks")
    if width < 1 or height < 1:
        raise EvidenceError(f"{label} must have positive PNG dimensions")
    expected = height * (width * 4 + 1)
    if expected > MAX_CAPTURE_OUTPUT_BYTES * 4:
        raise EvidenceError(f"{label} exceeds the native pixel bound")
    try:
        decompressor = zlib.decompressobj()
        scanlines = decompressor.decompress(bytes(idat), expected + 1)
    except zlib.error as exc:
        raise EvidenceError(f"{label} contains invalid compressed pixels") from exc
    if len(scanlines) > expected or decompressor.unconsumed_tail:
        raise EvidenceError(f"{label} expands beyond its declared scanline size")
    if decompressor.unused_data or not decompressor.eof:
        raise EvidenceError(f"{label} contains trailing or incomplete compressed pixels")
    if len(scanlines) != expected or any(scanlines[row * (width * 4 + 1)] != 0 for row in range(height)):
        raise EvidenceError(f"{label} contains unsupported PNG filters or dimensions")
    return width, height, scanlines


def _native_span_visualization_bytes(
    spans: dict[str, object],
    viewport: dict[str, int],
    cell_width: int,
    cell_height: int,
) -> bytes:
    """Recreate the bounded span-color diagnostic grid, not rendered glyph pixels."""
    width = viewport["columns"] * cell_width
    height = viewport["rows"] * cell_height
    stride = width * 4 + 1
    pixels = bytearray(stride * height)

    def fill_pixel(x: int, y: int, color: list[int]) -> None:
        if x < 0 or y < 0 or x >= width or y >= height:
            return
        offset = y * stride + 1 + x * 4
        pixels[offset : offset + 4] = bytes(color)

    for raw_line in spans["lines"]:
        line = _object(raw_line, "span visualization line")
        row = line["y"]
        for raw_span in line["spans"]:
            span = _object(raw_span, "span visualization span")
            attributes = span["attributes"]
            foreground = list(span["fg"])
            background = list(span["bg"])
            if attributes & 32:
                foreground, background = background, foreground
            if attributes & 2:
                foreground = [(value * 65 + 50) // 100 for value in foreground[:3]] + [foreground[3]]
            x_start = span["x"] * cell_width
            for column in range(span["x"], span["x"] + span["width"]):
                cell_x = column * cell_width
                for pixel_y in range(row * cell_height, (row + 1) * cell_height):
                    for pixel_x in range(cell_x, (column + 1) * cell_width):
                        fill_pixel(pixel_x, pixel_y, background)
                if str(span["text"]).strip() and not attributes & 64:
                    glyph_width = cell_width - (1 if attributes & 1 else 2)
                    text = str(span["text"])
                    character = ord(text[min(column - span["x"], max(0, len(text) - 1))]) if text else 32
                    for pixel_y in range(row * cell_height + 1, (row + 1) * cell_height - 1):
                        for pixel_x in range(cell_x + 1, cell_x + 1 + glyph_width):
                            stripe = (character + pixel_x - cell_x + (pixel_y - row * cell_height) * 3) % 5
                            fill_pixel(pixel_x, pixel_y, background if stripe == 0 else foreground)
                if attributes & 8:
                    for pixel_x in range(cell_x, (column + 1) * cell_width):
                        fill_pixel(pixel_x, (row + 1) * cell_height - 1, foreground)
                if attributes & 128:
                    for pixel_x in range(cell_x, (column + 1) * cell_width):
                        fill_pixel(pixel_x, row * cell_height + cell_height // 2, foreground)
            if x_start < 0:
                raise EvidenceError("span visualization contains a negative span position")
    signature = PNG_SIGNATURE
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return signature + _png_chunk(b"IHDR", header) + _png_chunk(b"IDAT", zlib.compress(bytes(pixels), 9)) + _png_chunk(b"IEND", b"")


def _validate_capture_event(
    root: Path,
    value: object,
    *,
    phase: str,
    source_digest: str,
    generator_digest: str,
    render_test_digest: str,
    runtime: dict[str, object],
    renderer: dict[str, object],
    viewport: dict[str, int],
    observed_date: dt.date,
    maximum_age: int,
    source_paths: set[str],
    character_output_path: str,
    native_test_digest: str,
    native_output_digest: str,
    native_capture_id: str,
    native_events: dict[str, dict[str, object]],
    native_snapshots: dict[str, dict[str, object]],
    label: str,
) -> tuple[set[str], str]:
    """Validate one event record against the retained native fixture transition."""
    data = _object(value, label)
    _reject_unknown(data, {"phase", "event_id", "record", "record_sha256"}, label)
    if _string(data.get("phase"), f"{label}.phase") != phase:
        raise EvidenceError(f"{label}.phase does not match {phase}")
    event_id = _string(data.get("event_id"), f"{label}.event_id")
    native_event = native_events.get(event_id)
    if native_event is None:
        raise EvidenceError(f"{label}.event_id is not emitted by the native fixture")
    native_data = _object(native_event.get("data"), f"{label}.native_event")
    _narrative_path(_string(data.get("record"), f"{label}.record"), f"{label}.record")
    record_path, record_raw, _ = _file_with_digest(
        root,
        data.get("record"),
        data.get("record_sha256"),
        f"{label}.record",
        max_bytes=MAX_CAPTURE_BYTES,
        forbidden_paths=source_paths,
    )
    try:
        record = _object(
            json.loads(record_raw, object_pairs_hook=_reject_duplicates),
            f"{label}.record",
        )
    except UnicodeError as exc:
        raise EvidenceError(f"{label}.record must be UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"{label}.record must be JSON") from exc
    except RecursionError as exc:
        raise EvidenceError(f"{label}.record nesting is too deep") from exc
    _reject_unknown(
        record,
        {
            "version",
            "phase",
            "event_id",
            "capture_id",
            "source_sha256",
            "capture_generator_sha256",
            "render_test_sha256",
            "native_capture_test_sha256",
            "native_capture_output_sha256",
            "runtime_id",
            "renderer_id",
            "viewport",
            "action",
            "dispatch",
            "provenance",
            "before",
            "after",
            "result",
            "native_event_sha256",
            "output",
            "output_sha256",
            "observed_at",
        },
        f"{label}.record",
    )
    version = record.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != CAPTURE_EVENT_VERSION:
        raise EvidenceError(f"{label}.record.version must be {CAPTURE_EVENT_VERSION}")
    if _string(record.get("phase"), f"{label}.record.phase") != phase:
        raise EvidenceError(f"{label}.record.phase does not match {phase}")
    if _string(record.get("event_id"), f"{label}.record.event_id") != event_id:
        raise EvidenceError(f"{label}.record.event_id contradicts the event reference")
    if _string(record.get("capture_id"), f"{label}.record.capture_id") != native_capture_id:
        raise EvidenceError(f"{label}.record.capture_id is contradictory")
    if _validate_digest(record.get("source_sha256"), f"{label}.record.source_sha256") != source_digest:
        raise EvidenceError(f"{label}.record.source_sha256 contradicts the mapped source")
    if _validate_digest(
        record.get("capture_generator_sha256"),
        f"{label}.record.capture_generator_sha256",
    ) != generator_digest:
        raise EvidenceError(f"{label}.record.capture_generator_sha256 is contradictory")
    if _validate_digest(
        record.get("render_test_sha256"),
        f"{label}.record.render_test_sha256",
    ) != render_test_digest:
        raise EvidenceError(f"{label}.record.render_test_sha256 is contradictory")
    if _string(record.get("runtime_id"), f"{label}.record.runtime_id") != str(runtime["id"]):
        raise EvidenceError(f"{label}.record.runtime_id is contradictory")
    if _string(record.get("renderer_id"), f"{label}.record.renderer_id") != str(renderer["id"]):
        raise EvidenceError(f"{label}.record.renderer_id is contradictory")
    if _validate_viewport(record.get("viewport"), f"{label}.record.viewport") != viewport:
        raise EvidenceError(f"{label}.record.viewport is contradictory")
    action = _validate_native_action(record.get("action"), phase, f"{label}.record.action")
    dispatch = _validate_native_dispatch(record.get("dispatch"), phase, f"{label}.record.dispatch")
    provenance = _validate_native_provenance(
        record.get("provenance"),
        expected_run_id=_run_id(native_data["provenance"].get("run_id"), f"{label}.native_event.run_id"),
        label=f"{label}.record.provenance",
    )
    before = _native_snapshot_reference(record.get("before"), native_snapshots, f"{label}.record.before")
    after = _native_snapshot_reference(record.get("after"), native_snapshots, f"{label}.record.after")
    result = _validate_native_result(
        record.get("result"),
        phase,
        action,
        before,
        after,
        f"{label}.record.result",
    )
    if (
        action != native_event["action"]
        or dispatch != native_event["dispatch"]
        or provenance != native_event["provenance"]
    ):
        raise EvidenceError(f"{label}.record action or dispatch is not the observed native interaction")
    if before != native_event["before"] or after != native_event["after"] or result != native_event["result"]:
        raise EvidenceError(f"{label}.record transition is not the observed native transition")
    if _validate_digest(
        record.get("native_capture_test_sha256"),
        f"{label}.record.native_capture_test_sha256",
    ) != native_test_digest:
        raise EvidenceError(f"{label}.record.native_capture_test_sha256 is contradictory")
    if _validate_digest(
        record.get("native_capture_output_sha256"),
        f"{label}.record.native_capture_output_sha256",
    ) != native_output_digest:
        raise EvidenceError(f"{label}.record.native_capture_output_sha256 is contradictory")
    native_event_digest = _validate_digest(
        record.get("native_event_sha256"),
        f"{label}.record.native_event_sha256",
    )
    if native_event_digest != native_data.get("native_event_sha256"):
        raise EvidenceError(f"{label}.record.native_event_sha256 is not the observed native event")
    event_date = _review_date(record.get("observed_at"), f"{label}.record.observed_at")
    if event_date != observed_date:
        raise EvidenceError(f"{label}.record.observed_at is contradictory")
    age = (dt.datetime.now(dt.timezone.utc).date() - event_date).days
    if age < 0 or age > maximum_age:
        raise EvidenceError(f"{label}.record is stale or dated in the future")
    output_path, output_raw, output_digest = _file_with_digest(
        root,
        record.get("output"),
        record.get("output_sha256"),
        f"{label}.record.output",
        max_bytes=MAX_CAPTURE_OUTPUT_BYTES,
        forbidden_paths=source_paths,
    )
    _narrative_path(output_path, f"{label}.record.output")
    if output_path == character_output_path:
        raise EvidenceError(f"{label}.record.output reuses the final character capture")
    try:
        output = _object(
            json.loads(output_raw, object_pairs_hook=_reject_duplicates),
            f"{label}.record.output",
        )
    except UnicodeError as exc:
        raise EvidenceError(f"{label}.record.output must be UTF-8 JSON") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"{label}.record.output must be JSON") from exc
    except RecursionError as exc:
        raise EvidenceError(f"{label}.record.output nesting is too deep") from exc
    _reject_unknown(
        output,
        {
            "version",
            "capture_id",
            "phase",
            "event_id",
            "action",
            "dispatch",
            "provenance",
            "before",
            "after",
            "result",
            "native_capture_output_sha256",
            "native_event_sha256",
        },
        f"{label}.record.output",
    )
    if output.get("version") != CAPTURE_EVENT_VERSION:
        raise EvidenceError(f"{label}.record.output.version is contradictory")
    if (
        output.get("capture_id") != native_capture_id
        or output.get("phase") != phase
        or output.get("event_id") != event_id
    ):
        raise EvidenceError(f"{label}.record.output identity is contradictory")
    if (
        output.get("action") != action
        or output.get("dispatch") != dispatch
        or output.get("provenance") != provenance
        or output.get("before") != record.get("before")
        or output.get("after") != record.get("after")
        or output.get("result") != result
        or output.get("native_capture_output_sha256") != native_output_digest
        or output.get("native_event_sha256") != native_event_digest
    ):
        raise EvidenceError(f"{label}.record.output native transition is contradictory")
    return {record_path, output_path}, output_digest


def _validate_capture_artifact(
    root: Path,
    capture_path: str,
    source_digest: str,
    render_test_digests: dict[str, str],
    runtime_catalog: dict[str, dict[str, object]],
    renderer_catalog: dict[str, dict[str, object]],
    source_paths: set[str],
    required_source_digests: dict[str, str],
    label: str,
) -> tuple[set[str], set[str], set[str], set[str], str]:
    """Validate one versioned capture artifact and return claimable paths."""
    _narrative_path(capture_path, label)
    _, data = _read_json_file(
        root,
        capture_path,
        label,
        max_bytes=MAX_CAPTURE_BYTES,
        forbidden_paths=source_paths,
    )
    _reject_unknown(
        data,
        {
            "version",
            "source_sha256",
            "capture_generator",
            "render_test",
            "native_capture_test",
            "native_capture_run",
            "native_capture_output",
            "runtime",
            "renderer",
            "observed_at",
            "max_age_days",
            "viewport",
            "native_snapshots",
            "native_frame",
            "character_output",
            "span_visualization",
            "layout_assertions",
            "events",
            "supplemental_review",
        },
        label,
    )
    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != CAPTURE_ARTIFACT_VERSION:
        raise EvidenceError(f"{label}.version must be {CAPTURE_ARTIFACT_VERSION}")
    if _validate_digest(data.get("source_sha256"), f"{label}.source_sha256") != source_digest:
        raise EvidenceError(f"{label}.source_sha256 does not match the mapped UI source")
    observed_date = _validate_freshness(data, label)
    maximum_age_value = data.get("max_age_days")
    if isinstance(maximum_age_value, bool) or not isinstance(maximum_age_value, int):
        raise EvidenceError(f"{label}.max_age_days must be a non-negative integer")
    maximum_age = maximum_age_value
    generator = _object(data.get("capture_generator"), f"{label}.capture_generator")
    _reject_unknown(generator, {"path", "sha256"}, f"{label}.capture_generator")
    generator_path, _, generator_digest = _validate_native_source_code(
        root,
        generator.get("path"),
        generator.get("sha256"),
        f"{label}.capture_generator.path",
        required=("visualizeNativeSpans", "captureSpans", NATIVE_CAPTURE_API),
    )
    render_test = _object(data.get("render_test"), f"{label}.render_test")
    _reject_unknown(render_test, {"path", "sha256"}, f"{label}.render_test")
    render_test_path, _, render_test_digest = _file_with_digest(
        root,
        render_test.get("path"),
        render_test.get("sha256"),
        f"{label}.render_test.path",
        max_bytes=MAX_TEST_BYTES,
        forbidden_paths=source_paths,
    )
    expected_test_digest = render_test_digests.get(render_test_path)
    if expected_test_digest is None:
        raise EvidenceError(
            f"{label}.render_test.path must be one of the mapped focused render tests"
        )
    if render_test_digest != expected_test_digest:
        raise EvidenceError(f"{label}.render_test.sha256 is contradictory")
    if generator_path == render_test_path:
        raise EvidenceError(f"{label} must bind a separate capture generator and render test")
    native_test_binding = _object(data.get("native_capture_test"), f"{label}.native_capture_test")
    _reject_unknown(native_test_binding, {"path", "sha256"}, f"{label}.native_capture_test")
    native_test_path, _, native_test_digest = _validate_native_source_code(
        root,
        native_test_binding.get("path"),
        native_test_binding.get("sha256"),
        f"{label}.native_capture_test.path",
        required=("testRender", "captureCharFrame", "captureSpans", "mockMouse", "mockInput"),
    )

    runtime_data = _object(data.get("runtime"), f"{label}.runtime")
    runtime_id = _string(runtime_data.get("id"), f"{label}.runtime.id")
    expected_runtime = runtime_catalog.get(runtime_id)
    if expected_runtime is None:
        raise EvidenceError(f"{label} uses unsupported runtime: {runtime_id}")
    if runtime_data != expected_runtime:
        raise EvidenceError(f"{label}.runtime contradicts the declared runtime catalog")
    renderer_data = _object(data.get("renderer"), f"{label}.renderer")
    renderer_id = _string(renderer_data.get("id"), f"{label}.renderer.id")
    expected_renderer = renderer_catalog.get(renderer_id)
    if expected_renderer is None:
        raise EvidenceError(f"{label} uses unsupported renderer: {renderer_id}")
    if renderer_data != expected_renderer:
        raise EvidenceError(f"{label}.renderer contradicts the declared renderer catalog")
    viewport = _validate_viewport(data.get("viewport"), f"{label}.viewport")
    native_output_path, native_output_digest, native_output, native_snapshots, native_events = (
        _validate_native_capture_output(
            root,
            data.get("native_capture_output"),
            viewport,
            source_paths,
            f"{label}.native_capture_output",
        )
    )
    expected_run_inputs = {
        **required_source_digests,
        generator_path: generator_digest,
        render_test_path: render_test_digest,
        native_test_path: native_test_digest,
    }
    _validate_native_capture_run(
        root,
        data.get("native_capture_run"),
        capture_run_id=_run_id(native_output.get("run_id"), f"{label}.native_output.run_id"),
        native_capture_test=native_test_path,
        expected_inputs=expected_run_inputs,
        label=f"{label}.native_capture_run",
    )
    native_snapshot_values = data.get("native_snapshots")
    if not isinstance(native_snapshot_values, list) or not native_snapshot_values:
        raise EvidenceError(f"{label}.native_snapshots must be a non-empty list")
    if len(native_snapshot_values) != len(native_snapshots):
        raise EvidenceError(f"{label}.native_snapshots must retain every native fixture snapshot exactly once")
    retained_snapshot_paths: set[str] = set()
    retained_snapshot_ids: set[str] = set()
    snapshot_bindings: dict[str, dict[str, object]] = {}
    for index, raw_snapshot in enumerate(native_snapshot_values):
        snapshot_label = f"{label}.native_snapshots[{index}]"
        snapshot_binding = _object(raw_snapshot, snapshot_label)
        _reject_unknown(snapshot_binding, {"id", "frame", "semantic_spans", "state"}, snapshot_label)
        snapshot_id = _string(snapshot_binding.get("id"), f"{snapshot_label}.id")
        if snapshot_id in retained_snapshot_ids:
            raise EvidenceError(f"{label}.native_snapshots contains duplicate id: {snapshot_id}")
        retained_snapshot_ids.add(snapshot_id)
        embedded_snapshot = native_snapshots.get(snapshot_id)
        if embedded_snapshot is None:
            raise EvidenceError(f"{snapshot_label}.id is not emitted by the native fixture")
        snapshot_bindings[snapshot_id] = snapshot_binding
        retained_snapshot_paths.update(
            _validate_native_snapshot_files(
                root,
                snapshot_binding,
                embedded_snapshot,
                viewport,
                source_paths,
                snapshot_label,
            )
        )
    if retained_snapshot_ids != set(native_snapshots):
        raise EvidenceError(f"{label}.native_snapshots does not match the native fixture output")
    final_snapshot_id = _string(native_output.get("final_snapshot_id"), f"{label}.native_output.final_snapshot_id")
    final_snapshot = native_snapshots[final_snapshot_id]
    native_frame = _object(data.get("native_frame"), f"{label}.native_frame")
    _reject_unknown(
        native_frame,
        {"snapshot_id", "character_output", "semantic_spans", "frame_sha256", "spans_sha256"},
        f"{label}.native_frame",
    )
    if _string(native_frame.get("snapshot_id"), f"{label}.native_frame.snapshot_id") != final_snapshot_id:
        raise EvidenceError(f"{label}.native_frame.snapshot_id contradicts the native output")
    if _validate_digest(native_frame.get("frame_sha256"), f"{label}.native_frame.frame_sha256") != final_snapshot["frame_sha256"]:
        raise EvidenceError(f"{label}.native_frame.frame_sha256 contradicts the final snapshot")
    if _validate_digest(native_frame.get("spans_sha256"), f"{label}.native_frame.spans_sha256") != final_snapshot["spans_sha256"]:
        raise EvidenceError(f"{label}.native_frame.spans_sha256 contradicts the final snapshot")

    character = _object(data.get("character_output"), f"{label}.character_output")
    _reject_unknown(
        character,
        {"path", "sha256", "encoding"},
        f"{label}.character_output",
    )
    if _string(character.get("encoding"), f"{label}.character_output.encoding") != "utf-8":
        raise EvidenceError(f"{label}.character_output.encoding must be utf-8")
    character_path, character_raw, _ = _file_with_digest(
        root,
        character.get("path"),
        character.get("sha256"),
        f"{label}.character_output.path",
        max_bytes=MAX_CAPTURE_OUTPUT_BYTES,
        forbidden_paths=source_paths,
    )
    _narrative_path(character_path, f"{label}.character_output.path")
    try:
        character_text = character_raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EvidenceError(f"{label}.character_output must be UTF-8") from exc
    final_frame_digest, _ = _validate_native_frame_text(
        character_raw,
        _object(final_snapshot.get("spans"), f"{label}.native_frame.final_spans"),
        viewport,
        f"{label}.character_output",
    )
    if final_frame_digest != final_snapshot["frame_sha256"]:
        raise EvidenceError(f"{label}.character_output is not the final native frame")
    final_binding = snapshot_bindings[final_snapshot_id]
    if native_frame.get("character_output") != character:
        raise EvidenceError(f"{label}.native_frame.character_output is not the retained final character output")
    if native_frame.get("semantic_spans") != final_binding.get("semantic_spans"):
        raise EvidenceError(f"{label}.native_frame.semantic_spans is not the retained final semantic spans")

    visual = _object(data.get("span_visualization"), f"{label}.span_visualization")
    _reject_unknown(
        visual,
        {"path", "sha256", "mime", "width", "height", "derived_from"},
        f"{label}.span_visualization",
    )
    derived = _object(visual.get("derived_from"), f"{label}.span_visualization.derived_from")
    _reject_unknown(
        derived,
        {"snapshot_id", "frame_sha256", "spans_sha256", "renderer", "cell_width", "cell_height"},
        f"{label}.span_visualization.derived_from",
    )
    if _string(derived.get("snapshot_id"), f"{label}.span_visualization.derived_from.snapshot_id") != final_snapshot_id:
        raise EvidenceError(f"{label}.span_visualization is not derived from the final native snapshot")
    if _validate_digest(derived.get("frame_sha256"), f"{label}.span_visualization.derived_from.frame_sha256") != final_snapshot["frame_sha256"]:
        raise EvidenceError(f"{label}.span_visualization.derived_from.frame_sha256 is contradictory")
    if _validate_digest(derived.get("spans_sha256"), f"{label}.span_visualization.derived_from.spans_sha256") != final_snapshot["spans_sha256"]:
        raise EvidenceError(f"{label}.span_visualization.derived_from.spans_sha256 is contradictory")
    if _string(derived.get("renderer"), f"{label}.span_visualization.derived_from.renderer") != "opentui-semantic-span-diagnostic-v1":
        raise EvidenceError(f"{label}.span_visualization.derived_from.renderer is unsupported")
    cell_width = derived.get("cell_width")
    cell_height = derived.get("cell_height")
    for dimension in ("cell_width", "cell_height"):
        value = derived.get(dimension)
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise EvidenceError(f"{label}.span_visualization.derived_from.{dimension} must be positive")
    visual_mime = _string(visual.get("mime"), f"{label}.span_visualization.mime")
    visual_path, visual_raw, visual_digest = _file_with_digest(
        root,
        visual.get("path"),
        visual.get("sha256"),
        f"{label}.span_visualization.path",
        max_bytes=MAX_CAPTURE_OUTPUT_BYTES * 4,
        forbidden_paths=source_paths,
    )
    _narrative_path(visual_path, f"{label}.span_visualization.path")
    actual_width, actual_height = _validate_image(
        visual_raw, visual_mime, f"{label}.span_visualization"
    )
    for dimension, actual in (("width", actual_width), ("height", actual_height)):
        declared = visual.get(dimension)
        if isinstance(declared, bool) or not isinstance(declared, int) or declared < 1:
            raise EvidenceError(f"{label}.span_visualization.{dimension} must be a positive integer")
        if declared != actual:
            raise EvidenceError(
                f"{label}.span_visualization.{dimension} contradicts the retained image"
            )
    if actual_width < viewport["columns"] or actual_height < viewport["rows"]:
        raise EvidenceError(
            f"{label}.span_visualization dimensions are smaller than the character viewport"
        )
    if actual_width != viewport["columns"] * cell_width or actual_height != viewport["rows"] * cell_height:
        raise EvidenceError(f"{label}.span_visualization dimensions contradict its diagnostic cell grid")
    if actual_width * actual_height * 4 > MAX_CAPTURE_OUTPUT_BYTES * 4:
        raise EvidenceError(f"{label}.span_visualization exceeds the bounded diagnostic pixel grid")
    expected_visual = _native_span_visualization_bytes(
        _object(final_snapshot.get("spans"), f"{label}.native_frame.final_spans"),
        viewport,
        cell_width,
        cell_height,
    )
    _, _, actual_pixels = _png_rgba_scanlines(visual_raw, f"{label}.span_visualization")
    _, _, expected_pixels = _png_rgba_scanlines(
        expected_visual, f"{label}.span_visualization_diagnostic"
    )
    if actual_pixels != expected_pixels:
        raise EvidenceError(
            f"{label}.span_visualization pixels are not derived from the retained semantic spans"
        )
    _validate_layout_assertions(
        data.get("layout_assertions"),
        viewport,
        character_text,
        f"{label}.layout_assertions",
    )

    event_values = data.get("events")
    if not isinstance(event_values, list) or len(event_values) != 3:
        raise EvidenceError(f"{label}.events must contain exactly three test-renderer phases")
    event_by_phase: dict[str, dict[str, object]] = {}
    for index, event in enumerate(event_values):
        event_data = _object(event, f"{label}.events[{index}]")
        phase = _string(event_data.get("phase"), f"{label}.events[{index}].phase")
        if phase in event_by_phase:
            raise EvidenceError(f"{label}.events contains duplicate phase: {phase}")
        event_by_phase[phase] = event_data
    if set(event_by_phase) != {"test-setup", "test-dispatch", "test-teardown"}:
        raise EvidenceError(
            f"{label}.events must contain distinct test setup, dispatch, and teardown records"
        )

    deterministic_paths = {capture_path, character_path, visual_path, native_output_path}
    deterministic_paths.update(retained_snapshot_paths)
    interaction_paths: set[str] = set()
    phase_digests: set[str] = set()
    for phase in ("test-setup", "test-dispatch", "test-teardown"):
        event_paths, output_digest = _validate_capture_event(
            root,
            event_by_phase[phase],
            phase=phase,
            source_digest=source_digest,
            generator_digest=generator_digest,
            render_test_digest=render_test_digest,
            runtime=expected_runtime,
            renderer=expected_renderer,
            viewport=viewport,
            observed_date=observed_date,
            maximum_age=maximum_age,
            source_paths=source_paths,
            character_output_path=character_path,
            native_test_digest=native_test_digest,
            native_output_digest=native_output_digest,
            native_capture_id=_string(native_output.get("id"), f"{label}.native_output.id"),
            native_events=native_events,
            native_snapshots=native_snapshots,
            label=f"{label}.events.{phase}",
        )
        if event_paths & deterministic_paths:
            raise EvidenceError(f"{label}.events.{phase} reuses another capture artifact")
        if output_digest in phase_digests:
            raise EvidenceError(f"{label}.events.{phase} reuses another phase artifact")
        phase_digests.add(output_digest)
        deterministic_paths.update(event_paths)
        interaction_paths.update(event_paths)

    supplemental = data.get("supplemental_review")
    if supplemental is not None:
        supplemental_data = _object(supplemental, f"{label}.supplemental_review")
        _reject_unknown(
            supplemental_data,
            {"path", "kind"},
            f"{label}.supplemental_review",
        )
        supplemental_path, _ = _read_file(
            root,
            supplemental_data.get("path"),
            f"{label}.supplemental_review.path",
            max_bytes=MAX_CAPTURE_BYTES,
            forbidden_paths=source_paths,
        )
        _string(supplemental_data.get("kind"), f"{label}.supplemental_review.kind")
        if supplemental_path in deterministic_paths:
            raise EvidenceError(f"{label}.supplemental_review reuses deterministic evidence")

    return deterministic_paths, set(), set(), phase_digests, visual_digest


def _source_set_digest(sources: list[str], digests: dict[str, str]) -> str:
    """Return a stable digest for one ordered multi-source capture binding."""
    payload = [{"path": source, "sha256": digests[source]} for source in sorted(sources)]
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _validate_ui_acceptance(
    root: Path,
    value: object,
) -> tuple[set[str], set[str], set[str]]:
    """Validate the source inventory and machine-generated UI capture contract."""
    data = _object(value, "ui_acceptance")
    _reject_unknown(
        data,
        {
            "version",
            "source_roots",
            "source_extensions",
            "source_files",
            "supported_runtimes",
            "supported_renderers",
            "mappings",
            "integrated_scenarios",
            "host_evidence",
            "status",
            "reason",
        },
        "ui_acceptance",
    )
    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != UI_ACCEPTANCE_VERSION:
        raise EvidenceError(f"ui_acceptance.version must be {UI_ACCEPTANCE_VERSION}")
    discovered = _discover_ui_sources(
        root,
        data.get("source_roots"),
        data.get("source_extensions"),
        data.get("source_files", []),
    )
    status = data.get("status", "ready")
    if status == "pending":
        _reject_unknown(
            data,
            {"version", "status", "reason", "source_roots", "source_extensions", "source_files"},
            "ui_acceptance",
        )
        _string(data.get("reason"), "ui_acceptance.reason")
        return discovered, set(), set(), set()
    if status != "ready":
        raise EvidenceError("ui_acceptance.status must be ready or pending")
    if "reason" in data:
        raise EvidenceError("ui_acceptance.reason is only valid while UI acceptance is pending")
    runtime_catalog = _validate_runtime_catalog(root, data.get("supported_runtimes"), discovered)
    renderer_catalog = _validate_renderer_catalog(data.get("supported_renderers"))
    mappings = data.get("mappings")
    if not isinstance(mappings, list) or not mappings:
        raise EvidenceError("ui_acceptance.mappings must be a non-empty list")
    if len(mappings) > MAX_UI_SOURCES:
        raise EvidenceError(f"ui_acceptance.mappings must contain at most {MAX_UI_SOURCES} items")

    mapped: set[str] = set()
    used_deterministic_paths: set[str] = set()
    used_phase_digests: set[str] = set()
    used_visual_digests: set[str] = set()
    visual_paths: set[str] = set()
    interaction_paths: set[str] = set()
    mapping_digests: dict[str, str] = {}
    mapping_render_tests: dict[str, dict[str, str]] = {}
    for index, mapping in enumerate(mappings):
        label = f"ui_acceptance.mappings[{index}]"
        mapping_data = _object(mapping, label)
        _reject_unknown(
            mapping_data,
            {"source", "source_sha256", "focused_tests", "capture_artifact"},
            label,
        )
        source_path = _string(mapping_data.get("source"), f"{label}.source")
        if source_path in mapped:
            raise EvidenceError(f"duplicate UI source mapping: {source_path}")
        mapped.add(source_path)
        if source_path not in discovered:
            raise EvidenceError(f"{label}.source is not in the UI source inventory: {source_path}")
        source_file = _regular_project_file(root, source_path, f"{label}.source")
        expected_digest = _validate_digest(mapping_data.get("source_sha256"), f"{label}.source_sha256")
        actual_digest = _source_digest(source_file, f"{label}.source")
        if actual_digest != expected_digest:
            raise EvidenceError(
                f"stale UI source digest for {source_path}: expected {expected_digest}, "
                f"found {actual_digest}"
            )
        mapping_digests[source_path] = expected_digest
        source_paths = set(discovered)
        focused_paths, render_test_digests = _validate_focused_tests(
            root,
            mapping_data.get("focused_tests"),
            source_paths,
            expected_digest,
            label,
        )
        mapping_render_tests[source_path] = render_test_digests
        capture_path = _string(mapping_data.get("capture_artifact"), f"{label}.capture_artifact")
        if capture_path in source_paths:
            raise EvidenceError(f"{label}.capture_artifact cites a protected UI source file")
        _narrative_path(capture_path, f"{label}.capture_artifact")
        if capture_path in focused_paths:
            raise EvidenceError(f"{label}.capture_artifact reuses focused execution evidence")
        if capture_path in used_deterministic_paths:
            raise EvidenceError(f"{label}.capture_artifact reuses another mapping artifact")
        paths, mapping_visuals, mapping_interactions, phase_digests, visual_digest = (
            _validate_capture_artifact(
                root,
                capture_path,
                expected_digest,
                render_test_digests,
                runtime_catalog,
                renderer_catalog,
                source_paths,
                {source_path: expected_digest},
                label,
            )
        )
        if paths & used_deterministic_paths:
            raise EvidenceError(f"{label} reuses a capture artifact from another mapping")
        if phase_digests & used_phase_digests:
            raise EvidenceError(f"{label} reuses a phase output from another mapping")
        if visual_digest in used_visual_digests:
            raise EvidenceError(f"{label} reuses a retained visual image")
        used_deterministic_paths.update(paths)
        used_phase_digests.update(phase_digests)
        used_visual_digests.add(visual_digest)
        visual_paths.update(mapping_visuals)
        interaction_paths.update(mapping_interactions)

    missing = sorted(discovered - mapped)
    extra = sorted(mapped - discovered)
    if missing:
        raise EvidenceError("missing UI source mapping(s): " + ", ".join(missing))
    if extra:
        raise EvidenceError("UI source mapping(s) are outside the inventory: " + ", ".join(extra))

    integrated_values = data.get("integrated_scenarios")
    if len(mapped) > 1 and (not isinstance(integrated_values, list) or not integrated_values):
        raise EvidenceError(
            "ui_acceptance.integrated_scenarios must contain a multi-source capture"
        )
    if integrated_values is None:
        integrated_values = []
    if not isinstance(integrated_values, list):
        raise EvidenceError("ui_acceptance.integrated_scenarios must be a list")
    if len(integrated_values) > MAX_UI_SOURCES:
        raise EvidenceError(
            f"ui_acceptance.integrated_scenarios must contain at most {MAX_UI_SOURCES} items"
        )
    scenario_ids: set[str] = set()
    for index, scenario in enumerate(integrated_values):
        label = f"ui_acceptance.integrated_scenarios[{index}]"
        scenario_data = _object(scenario, label)
        _reject_unknown(scenario_data, {"id", "sources", "capture_artifact"}, label)
        scenario_id = _string(scenario_data.get("id"), f"{label}.id")
        if scenario_id in scenario_ids:
            raise EvidenceError(f"duplicate integrated scenario id: {scenario_id}")
        scenario_ids.add(scenario_id)
        sources = _string_list(
            scenario_data.get("sources"),
            f"{label}.sources",
            non_empty=True,
            max_items=MAX_UI_SOURCES,
        )
        if len(sources) < 2:
            raise EvidenceError(f"{label}.sources must contain at least two UI sources")
        unknown_sources = sorted(set(sources) - mapped)
        if unknown_sources:
            raise EvidenceError(
                f"{label}.sources contains unmapped UI source(s): "
                + ", ".join(unknown_sources)
            )
        combined_render_tests: dict[str, str] = {}
        for source in sources:
            combined_render_tests.update(mapping_render_tests[source])
        capture_path = _string(
            scenario_data.get("capture_artifact"), f"{label}.capture_artifact"
        )
        if capture_path in used_deterministic_paths:
            raise EvidenceError(f"{label}.capture_artifact reuses another capture artifact")
        paths, scenario_visuals, scenario_interactions, phase_digests, visual_digest = (
            _validate_capture_artifact(
                root,
                capture_path,
                _source_set_digest(sources, mapping_digests),
                combined_render_tests,
                runtime_catalog,
                renderer_catalog,
                set(discovered),
                {source: mapping_digests[source] for source in sources},
                label,
            )
        )
        if paths & used_deterministic_paths:
            raise EvidenceError(f"{label} reuses a capture artifact from another scenario")
        if phase_digests & used_phase_digests:
            raise EvidenceError(f"{label} reuses a phase output from another capture")
        if visual_digest in used_visual_digests:
            raise EvidenceError(f"{label} reuses a retained visual image")
        used_deterministic_paths.update(paths)
        used_phase_digests.update(phase_digests)
        used_visual_digests.add(visual_digest)
        visual_paths.update(scenario_visuals)
        interaction_paths.update(scenario_interactions)
    if "host_evidence" in data:
        host_visual_paths, host_interaction_paths, host_pairs, _ = _validate_host_evidence(
            root,
            data["host_evidence"],
            set(discovered),
            forbidden_paths=used_deterministic_paths,
        )
    else:
        host_visual_paths, host_interaction_paths, host_pairs = set(), set(), set()
    visual_paths.update(host_visual_paths)
    interaction_paths.update(host_interaction_paths)
    return discovered, visual_paths, interaction_paths, host_pairs


def _manifest_file(root: Path, requested: str | None) -> Path:
    """Resolve a repository-owned manifest without following a symlink."""
    root = root.resolve(strict=True)
    candidate = Path(requested) if requested is not None else Path(DEFAULT_MANIFEST)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        candidate.resolve(strict=True).relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError("manifest must be a readable file beneath the project root") from exc
    try:
        relative = candidate.relative_to(root).as_posix()
    except ValueError as exc:
        raise EvidenceError("manifest must be a readable file beneath the project root") from exc
    return _regular_project_file(root, relative, "manifest")


def validate_manifest(root: Path, requested: str | None = None) -> tuple[int, int]:
    """Validate the manifest and return its claim and subagent counts."""
    try:
        root = root.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError("project root must be a readable directory") from exc
    if not root.is_dir():
        raise EvidenceError("project root must be a directory")
    manifest = _manifest_file(root, requested)
    try:
        raw_manifest = manifest.read_bytes()
    except OSError as exc:
        raise EvidenceError(f"cannot read manifest: {exc}") from exc
    if len(raw_manifest) > MAX_MANIFEST_BYTES:
        raise EvidenceError(f"manifest exceeds the {MAX_MANIFEST_BYTES}-byte size limit")
    try:
        data = json.loads(raw_manifest, object_pairs_hook=_reject_duplicates)
    except UnicodeError as exc:
        raise EvidenceError("manifest must be UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"manifest is not valid JSON: {exc}") from exc
    except RecursionError as exc:
        raise EvidenceError("manifest nesting is too deep") from exc
    data = _object(data, "manifest")
    _reject_unknown(
        data,
        {"version", "claims", "subagent_policy", "subagent_evidence", "ui_acceptance"},
        "manifest",
    )
    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version not in SUPPORTED_VERSIONS:
        raise EvidenceError(
            "manifest.version must be the current machine-generated contract version 3"
        )
    source_paths, visual_paths, interaction_paths, host_pairs = _validate_ui_acceptance(
        root,
        data.get("ui_acceptance"),
    )

    claims = data.get("claims")
    if not isinstance(claims, list):
        raise EvidenceError("manifest.claims must be a list")
    if not claims:
        raise EvidenceError("manifest.claims must not be empty")
    if len(claims) > MAX_CLAIMS:
        raise EvidenceError(f"manifest.claims must contain at most {MAX_CLAIMS} items")
    claim_ids: set[str] = set()
    has_evidenced_completion = False
    for index, claim in enumerate(claims):
        claim_data = _object(claim, f"claims[{index}]")
        claim_id = _string(claim_data.get("id"), f"claims[{index}].id")
        if claim_id in claim_ids:
            raise EvidenceError(f"duplicate claim id: {claim_id}")
        claim_ids.add(claim_id)
        _validate_claim(
            root,
            claim_data,
            index,
            source_paths=source_paths,
            visual_paths=visual_paths,
            interaction_paths=interaction_paths,
            host_pairs=host_pairs,
        )
        evidence = claim_data.get("evidence", {})
        if claim_data.get("status") in {"complete", "limited"} and isinstance(
            evidence, dict
        ) and any(evidence.values()):
            has_evidenced_completion = True
    if not has_evidenced_completion:
        raise EvidenceError("manifest.claims must include an evidenced complete or limited claim")

    allowed_agents, allowed_models, max_concurrency = _validate_subagent_policy(
        data.get("subagent_policy")
    )
    subagent_evidence = data.get("subagent_evidence")
    _validate_subagent_evidence(
        root,
        subagent_evidence,
        allowed_agents,
        allowed_models,
        max_concurrency,
        source_paths=source_paths,
    )
    return len(claims), len(subagent_evidence)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments for the read-only validator."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="project root (default: current directory)")
    parser.add_argument(
        "--manifest",
        default=None,
        help=f"manifest relative to root (default: {DEFAULT_MANIFEST})",
    )
    return parser.parse_args(list(argv) if argv is not None else None)


def main(argv: Iterable[str] | None = None) -> int:
    """Run the validator and print concise evidence counts."""
    args = parse_args(argv)
    try:
        claims, subagents = validate_manifest(Path(args.root), args.manifest)
    except (EvidenceError, OSError) as exc:
        print(f"ERROR: acceptance evidence failed: {exc}", file=sys.stderr)
        return 1
    print(
        f"OK: acceptance evidence manifest valid ({claims} claims; "
        f"{subagents} background subagents)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
