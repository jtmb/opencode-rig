"""Record a bounded, metadata-only snapshot of Hermes observer hook activity."""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import math
import os
import re
import stat
import tempfile
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

LOGGER = logging.getLogger("open-rig-hermes-hooks")
MAX_EVENTS = 128
MAX_SNAPSHOT_BYTES = 128 * 1024
MAX_LABEL_LENGTH = 64
MAX_REFERENCE_LENGTH = 256
MAX_DURATION_MS = 3_600_000
SNAPSHOT_FILENAME = "open-rig-hooks.snapshot.json"
HOOK_NAMES = (
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
    "pre_llm_call",
    "post_llm_call",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "pre_auxiliary_call",
    "post_auxiliary_call",
    "pre_tool_call",
    "post_tool_call",
    "subagent_start",
    "subagent_stop",
)
START_HOOKS = frozenset(
    {
        "on_session_start",
        "pre_llm_call",
        "pre_api_request",
        "pre_auxiliary_call",
        "pre_tool_call",
        "subagent_start",
    }
)
STATUS_VALUES = frozenset(
    {
        "started",
        "ok",
        "error",
        "blocked",
        "cancelled",
        "completed",
        "interrupted",
        "unknown",
    }
)
LABEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,63}\Z")
REFERENCE_PATTERN = re.compile(r"[a-f0-9]{12}\Z")


class HookContext(Protocol):
    """Expose the hook registration method used by Hermes plugins."""

    def register_hook(self, name: str, callback: Callable[..., None]) -> None:
        """Register a callback for one Hermes lifecycle hook."""


def _snapshot_path() -> Path:
    """Resolve the shared snapshot path from the active Hermes profile."""
    configured = os.environ.get("OPEN_RIG_HERMES_TELEMETRY_FILE", "").strip()
    if configured:
        path = Path(configured).expanduser()
        if not path.is_absolute():
            raise ValueError("telemetry path must be absolute")
        return path

    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    root = Path(hermes_home).expanduser() if hermes_home else Path.home() / ".hermes"
    if not root.is_absolute():
        raise ValueError("Hermes home must be absolute")
    return root / "logs" / SNAPSHOT_FILENAME


def _safe_label(value: object) -> str | None:
    """Return a compact identifier-like value without arbitrary payload text."""
    if not isinstance(value, str):
        return None
    candidate = value.strip()[:MAX_LABEL_LENGTH]
    return candidate if LABEL_PATTERN.fullmatch(candidate) else None


def _reference(value: object) -> str | None:
    """Hash an opaque Hermes ID so events can be joined without storing it."""
    if not isinstance(value, str) or not value or len(value) > MAX_REFERENCE_LENGTH:
        return None
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:12]


def _safe_timestamp(value: object) -> str | None:
    """Keep a valid ISO timestamp with a strict length ceiling."""
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def _safe_duration(value: object) -> int | None:
    """Clamp a finite duration to the maximum representable operation time."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        return None
    if value < 0 or value > MAX_DURATION_MS:
        return None
    return int(value)


def _status(hook_name: str, payload: Mapping[str, object]) -> str:
    """Map event outcome metadata to the fixed public status vocabulary."""
    if hook_name in START_HOOKS:
        return "started"
    if payload.get("interrupted") is True:
        return "interrupted"
    if (
        payload.get("failed") is True
        or hook_name == "api_request_error"
        or payload.get("error") is not None
    ):
        return "error"
    if payload.get("completed") is True:
        return "completed"

    value = payload.get("status", payload.get("child_status"))
    if isinstance(value, str):
        normalized = value.strip().lower()
        aliases = {
            "success": "ok",
            "succeeded": "ok",
            "failed": "error",
            "complete": "completed",
        }
        normalized = aliases.get(normalized, normalized)
        if normalized in STATUS_VALUES:
            return normalized

    if hook_name in {"post_api_request", "post_auxiliary_call"}:
        return "ok"
    if hook_name in {"post_llm_call", "on_session_finalize", "on_session_reset"}:
        return "completed"
    return "unknown"


def _event(hook_name: str, payload: Mapping[str, object]) -> dict[str, object]:
    """Project a raw Hermes callback into the metadata-only wire contract."""
    timestamp = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    event: dict[str, object] = {
        "at": timestamp,
        "hook": hook_name,
        "status": _status(hook_name, payload),
    }

    session_id = payload.get("session_id")
    if hook_name.startswith("subagent_"):
        session_id = payload.get("child_session_id", session_id)
    if session_id is None:
        session_id = payload.get("parent_session_id")

    references = {
        "sessionRef": session_id,
        "turnRef": payload.get("turn_id", payload.get("parent_turn_id")),
        "requestRef": payload.get("api_request_id"),
        "toolRef": payload.get("tool_call_id"),
    }
    for field, value in references.items():
        reference = _reference(value)
        if reference is not None:
            event[field] = reference

    labels = {
        "model": payload.get("model"),
        "provider": payload.get("provider"),
        "tool": payload.get("tool_name"),
        "auxTask": payload.get("aux_task"),
        "surface": payload.get("surface", payload.get("platform")),
    }
    for field, value in labels.items():
        label = _safe_label(value)
        if label is not None:
            event[field] = label

    duration = _safe_duration(payload.get("duration_ms", payload.get("api_duration")))
    if duration is not None:
        event["durationMs"] = duration
    return event


def _normalize_event(value: object) -> dict[str, object] | None:
    """Validate and rebuild a stored event without preserving unknown fields."""
    if not isinstance(value, dict):
        return None
    hook_name = value.get("hook")
    timestamp = _safe_timestamp(value.get("at"))
    status = value.get("status")
    if hook_name not in HOOK_NAMES or timestamp is None or status not in STATUS_VALUES:
        return None

    event: dict[str, object] = {"at": timestamp, "hook": hook_name, "status": status}
    for field in ("model", "provider", "tool", "auxTask", "surface"):
        label = _safe_label(value.get(field))
        if label is not None:
            event[field] = label
    for field in ("sessionRef", "turnRef", "requestRef", "toolRef"):
        reference = value.get(field)
        if isinstance(reference, str) and REFERENCE_PATTERN.fullmatch(reference):
            event[field] = reference
    duration = _safe_duration(value.get("durationMs"))
    if duration is not None:
        event["durationMs"] = duration
    return event


def _read_snapshot(path: Path) -> list[dict[str, object]]:
    """Read only the plugin-owned regular snapshot file under a hard byte cap."""
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return []

    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_SNAPSHOT_BYTES:
            raise ValueError("snapshot is not a bounded regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            raw = source.read(MAX_SNAPSHOT_BYTES + 1)
        if len(raw) > MAX_SNAPSHOT_BYTES:
            raise ValueError("snapshot exceeds the byte limit")
        document = json.loads(raw.decode("utf-8"))
        if not isinstance(document, dict) or document.get("schemaVersion") != 1:
            raise ValueError("snapshot schema is unsupported")
        events = document.get("events")
        if not isinstance(events, list):
            raise ValueError("snapshot events are invalid")
        return [
            event
            for item in events[-MAX_EVENTS:]
            if (event := _normalize_event(item)) is not None
        ]
    finally:
        os.close(descriptor)


def _write_snapshot(
    path: Path, events: list[dict[str, object]], updated_at: str
) -> None:
    """Atomically replace the private telemetry snapshot after validation."""
    document = {
        "schemaVersion": 1,
        "updatedAt": updated_at,
        "events": events[-MAX_EVENTS:],
    }
    encoded = json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode(
        "utf-8"
    )
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot exceeds the byte limit")

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".open-rig-hooks-", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(encoded)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary_path, path)
        directory_descriptor = os.open(
            path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        temporary_path.unlink(missing_ok=True)


def _store(event: dict[str, object]) -> None:
    """Append one safe event under a cross-process lock and retain a ring buffer."""
    path = _snapshot_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    descriptor = os.open(
        lock_path,
        os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("lock path is not a regular file")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        events = _read_snapshot(path)
        events.append(event)
        _write_snapshot(path, events[-MAX_EVENTS:], str(event["at"]))
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _callback(hook_name: str) -> Callable[..., None]:
    """Create a fail-open callback that never retains raw hook payloads."""

    def capture(**payload: object) -> None:
        try:
            _store(_event(hook_name, payload))
        except (OSError, TypeError, ValueError) as error:
            LOGGER.warning(
                "Hermes telemetry snapshot skipped (%s)", type(error).__name__
            )

    return capture


def register(ctx: HookContext) -> None:
    """Register the observer hooks consumed by the Open Rig live pipeline."""
    for hook_name in HOOK_NAMES:
        ctx.register_hook(hook_name, _callback(hook_name))
