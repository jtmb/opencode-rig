#!/usr/bin/env python3
"""Apply a bounded, audited recovery patch to orchestration policy files."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
ALLOWLIST = frozenset(
    {
        "AGENTS.md",
        "docs/agent-policy.md",
        "platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/policy.ts",
        "platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/index.ts",
    }
)
MAX_EDITS = 16
MAX_EDIT_TEXT_BYTES = 64 * 1024
MAX_TOTAL_EDIT_BYTES = 256 * 1024
MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_REASON_BYTES = 4096
MAX_TARGET_BYTES = 16 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
NONBLOCK = getattr(os, "O_NONBLOCK", 0)


class MaintenanceError(Exception):
    """Raised when a request fails a recovery safety or input check."""


class ApplyFailure(MaintenanceError):
    """Raised when an applying operation fails after validation."""


class VerificationFailure(MaintenanceError):
    """Raised when an available optional syntax check rejects the proposed text."""


@dataclass(frozen=True)
class Edit:
    """One exact-text replacement requested by the operator."""

    file: str
    old: str
    new: str
    old_bytes: int
    new_bytes: int


@dataclass
class PlannedFile:
    """Validated content and an open, no-follow parent directory handle."""

    relative: str
    name: str
    parent_fd: int
    original: bytes
    updated: bytes
    mode: int
    original_stat: os.stat_result
    edits: list[Edit]


def sha256(data: bytes) -> str:
    """Return the SHA-256 hex digest of bytes."""
    return hashlib.sha256(data).hexdigest()


def encoded_size(value: str, label: str) -> int:
    """Return a string's UTF-8 byte length or reject unpaired surrogates."""
    try:
        return len(value.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise MaintenanceError(f"{label} is not valid Unicode text") from exc


def duplicate_free_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Build a JSON object and refuse duplicate keys."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise MaintenanceError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_spec_bytes(spec_path: str) -> bytes:
    """Read a bounded regular spec file, or bounded JSON from standard input."""
    if spec_path == "-":
        data = sys.stdin.buffer.read(MAX_SPEC_BYTES + 1)
    else:
        path = Path(spec_path).expanduser()
        try:
            descriptor = os.open(path, os.O_RDONLY | NOFOLLOW | NONBLOCK | getattr(os, "O_CLOEXEC", 0))
        except OSError as exc:
            raise MaintenanceError(f"cannot open spec file {path}: {exc}") from exc
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise MaintenanceError("spec path must be a regular, non-symlink file")
            chunks: list[bytes] = []
            remaining = MAX_SPEC_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(READ_CHUNK_BYTES, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
        finally:
            os.close(descriptor)
    if len(data) > MAX_SPEC_BYTES:
        raise MaintenanceError(f"JSON spec exceeds the {MAX_SPEC_BYTES}-byte input limit")
    return data


def parse_spec(spec_path: str, reason_override: str | None) -> tuple[str, list[Edit]]:
    """Parse and validate the bounded JSON edit specification."""
    raw = read_spec_bytes(spec_path)
    try:
        document = json.loads(raw.decode("utf-8"), object_pairs_hook=duplicate_free_object)
    except MaintenanceError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MaintenanceError(f"spec must be valid UTF-8 JSON: {exc}") from exc
    if not isinstance(document, dict) or set(document) != {"reason", "edits"}:
        raise MaintenanceError('spec must contain exactly the keys "reason" and "edits"')

    spec_reason = document["reason"]
    if not isinstance(spec_reason, str) or not spec_reason.strip():
        raise MaintenanceError('spec "reason" must be non-empty text')
    reason = reason_override if reason_override is not None else spec_reason
    if not isinstance(reason, str) or not reason.strip():
        raise MaintenanceError("reason must be non-empty text")
    reason_bytes = encoded_size(reason, "reason")
    if reason_bytes > MAX_REASON_BYTES:
        raise MaintenanceError(f"reason exceeds the {MAX_REASON_BYTES}-byte limit")

    entries = document["edits"]
    if not isinstance(entries, list) or not entries:
        raise MaintenanceError('spec "edits" must be a non-empty array')
    if len(entries) > MAX_EDITS:
        raise MaintenanceError(f"spec contains more than {MAX_EDITS} edits")

    edits: list[Edit] = []
    total_bytes = 0
    for index, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict) or set(entry) != {"file", "old", "new"}:
            raise MaintenanceError(f"edit {index} must contain exactly file, old, and new")
        file_name = entry["file"]
        old = entry["old"]
        new = entry["new"]
        if not isinstance(file_name, str) or not file_name.strip():
            raise MaintenanceError(f"edit {index} file must be non-empty text")
        if not isinstance(old, str) or not old:
            raise MaintenanceError(f"edit {index} old text must be non-empty text")
        if not isinstance(new, str) or not new:
            raise MaintenanceError(f"edit {index} new text must be non-empty text")
        old_size = encoded_size(old, f"edit {index} old text")
        new_size = encoded_size(new, f"edit {index} new text")
        if old_size > MAX_EDIT_TEXT_BYTES or new_size > MAX_EDIT_TEXT_BYTES:
            raise MaintenanceError(
                f"edit {index} old/new text exceeds the {MAX_EDIT_TEXT_BYTES}-byte per-text limit"
            )
        total_bytes += old_size + new_size
        if total_bytes > MAX_TOTAL_EDIT_BYTES:
            raise MaintenanceError(
                f"total old/new edit text exceeds the {MAX_TOTAL_EDIT_BYTES}-byte limit"
            )
        edits.append(Edit(file_name, old, new, old_size, new_size))
    return reason, edits


def normalize_allowlisted_path(value: str) -> str:
    """Resolve a relative or absolute input to one exact allowlisted path."""
    portable = value.replace("\\", "/")
    if "\0" in portable or any(part == ".." for part in portable.split("/")):
        raise MaintenanceError(f"refusing path containing traversal: {value!r}")
    candidate = Path(portable)
    if candidate.is_absolute():
        try:
            relative = candidate.relative_to(REPOSITORY_ROOT)
        except ValueError as exc:
            raise MaintenanceError(f"refusing path outside the repository: {value!r}") from exc
    else:
        relative = candidate
    normalized = relative.as_posix()
    if normalized not in ALLOWLIST:
        raise MaintenanceError(f"refusing non-allowlisted path: {value!r}")
    return normalized


def open_repository_root() -> int:
    """Open the checkout root as a no-follow directory descriptor."""
    try:
        descriptor = os.open(REPOSITORY_ROOT, DIRECTORY_FLAGS | NOFOLLOW)
    except OSError as exc:
        raise MaintenanceError(f"cannot safely open repository root: {exc}") from exc
    if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise MaintenanceError("repository root is not a directory")
    return descriptor


def open_child_directory(parent_fd: int, name: str) -> int:
    """Open one child directory after explicitly rejecting symlinks."""
    try:
        info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as exc:
        raise MaintenanceError(f"cannot inspect directory component {name!r}: {exc}") from exc
    if stat.S_ISLNK(info.st_mode):
        raise MaintenanceError(f"refusing symlink directory component: {name}")
    if not stat.S_ISDIR(info.st_mode):
        raise MaintenanceError(f"refusing non-directory path component: {name}")
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS | NOFOLLOW, dir_fd=parent_fd)
    except OSError as exc:
        raise MaintenanceError(f"cannot safely open directory component {name!r}: {exc}") from exc
    return descriptor


def open_repository_parent(relative: str) -> tuple[int, str]:
    """Open every allowlisted path ancestor without following symlinks."""
    parts = Path(relative).parts
    descriptor = open_repository_root()
    try:
        for component in parts[:-1]:
            next_descriptor = open_child_directory(descriptor, component)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor, parts[-1]
    except Exception:
        os.close(descriptor)
        raise


def fsync_directory(path: Path) -> None:
    """Persist directory-entry changes for backups, logs, and atomic replaces."""
    descriptor = os.open(path, DIRECTORY_FLAGS | NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_regular_file_at(parent_fd: int, name: str, label: str) -> tuple[bytes, os.stat_result]:
    """Read a bounded regular file through an already-open parent directory."""
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | NOFOLLOW | NONBLOCK | getattr(os, "O_CLOEXEC", 0),
            dir_fd=parent_fd,
        )
    except OSError as exc:
        raise MaintenanceError(f"cannot safely open {label}: {exc}") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise MaintenanceError(f"refusing non-regular file: {label}")
        if info.st_size > MAX_TARGET_BYTES:
            raise MaintenanceError(f"file exceeds the {MAX_TARGET_BYTES}-byte bound: {label}")
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_TARGET_BYTES:
            chunk = os.read(descriptor, min(READ_CHUNK_BYTES, MAX_TARGET_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > MAX_TARGET_BYTES:
            raise MaintenanceError(f"file exceeds the {MAX_TARGET_BYTES}-byte bound: {label}")
        return b"".join(chunks), info
    finally:
        os.close(descriptor)


def overlapping_positions(text: str, needle: str) -> list[int]:
    """Return all match positions, including overlapping matches."""
    positions: list[int] = []
    start = 0
    while True:
        found = text.find(needle, start)
        if found < 0:
            return positions
        positions.append(found)
        start = found + 1


def updated_text(original: str, edits: list[Edit], relative: str) -> str:
    """Validate exact, unique, non-overlapping edits and apply them in memory."""
    replacements: list[tuple[int, int, str]] = []
    for edit in edits:
        matches = overlapping_positions(original, edit.old)
        if len(matches) != 1:
            raise MaintenanceError(
                f"{relative}: old text for edit must occur exactly once; found {len(matches)} matches"
            )
        start = matches[0]
        replacements.append((start, start + len(edit.old), edit.new))
    ordered_by_start = sorted(replacements)
    for previous, current in zip(ordered_by_start, ordered_by_start[1:]):
        if current[0] < previous[1]:
            raise MaintenanceError(f"{relative}: edits overlap and cannot be applied atomically")
    result = original
    for start, end, replacement in sorted(replacements, reverse=True):
        result = result[:start] + replacement + result[end:]
    return result


def build_plan(edits: list[Edit]) -> list[PlannedFile]:
    """Validate every file and edit before returning a complete in-memory plan."""
    grouped: dict[str, list[Edit]] = {}
    for edit in edits:
        relative = normalize_allowlisted_path(edit.file)
        grouped.setdefault(relative, []).append(edit)

    planned: list[PlannedFile] = []
    try:
        for relative, file_edits in grouped.items():
            parent_fd, name = open_repository_parent(relative)
            try:
                original, info = read_regular_file_at(parent_fd, name, relative)
                try:
                    text = original.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise MaintenanceError(f"refusing invalid UTF-8 file: {relative}") from exc
                updated = updated_text(text, file_edits, relative).encode("utf-8")
                if len(updated) > MAX_TARGET_BYTES:
                    raise MaintenanceError(f"updated file exceeds the {MAX_TARGET_BYTES}-byte bound: {relative}")
                planned.append(
                    PlannedFile(
                        relative=relative,
                        name=name,
                        parent_fd=parent_fd,
                        original=original,
                        updated=updated,
                        mode=stat.S_IMODE(info.st_mode),
                        original_stat=info,
                        edits=file_edits,
                    )
                )
            except Exception:
                os.close(parent_fd)
                raise
    except Exception:
        close_plan(planned)
        raise
    return planned


def close_plan(plan: list[PlannedFile]) -> None:
    """Close the directory descriptors held by a planned change."""
    for item in plan:
        try:
            os.close(item.parent_fd)
        except OSError:
            pass


def print_plan(plan: list[PlannedFile], applying: bool) -> None:
    """Print byte counts and SHA-256 digests for each planned target file."""
    print("PLAN: apply requested" if applying else "DRY RUN: no files will be written")
    for item in plan:
        print(
            f"{item.relative}: before_bytes={len(item.original)} after_bytes={len(item.updated)} "
            f"before_sha256={sha256(item.original)} after_sha256={sha256(item.updated)}"
        )
        for index, edit in enumerate(item.edits, start=1):
            print(f"  edit {index}: old_bytes={edit.old_bytes} new_bytes={edit.new_bytes}")


def timestamp() -> str:
    """Return a sortable UTC timestamp with sub-second precision."""
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def path_is_within(candidate: Path, parent: Path) -> bool:
    """Return whether one absolute path is equal to or beneath another."""
    return candidate == parent or parent in candidate.parents


def protected_opencode_roots() -> set[Path]:
    """Return standard OpenCode config, data, storage, and binary roots to avoid."""
    roots: set[Path] = set()
    data_home = Path(os.environ.get("XDG_DATA_HOME") or "~/.local/share").expanduser()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or "~/.config").expanduser()
    if not data_home.is_absolute():
        data_home = Path.cwd() / data_home
    if not config_home.is_absolute():
        config_home = Path.cwd() / config_home
    roots.add((data_home / "opencode").resolve(strict=False))
    roots.add((config_home / "opencode").resolve(strict=False))
    roots.add((Path.home() / ".opencode").resolve(strict=False))
    for name in ("OPENCODE_STORAGE_DIR", "OPENCODE_DATA_DIR"):
        value = os.environ.get(name)
        if not value:
            continue
        configured = Path(value).expanduser()
        if not configured.is_absolute():
            configured = Path.cwd() / configured
        roots.add(configured.resolve(strict=False))
        if name == "OPENCODE_DATA_DIR":
            roots.add((configured / "storage").resolve(strict=False))
    binary = os.environ.get("OPENCODE_V2_BIN")
    if binary:
        binary_path = Path(binary).expanduser()
        if not binary_path.is_absolute():
            binary_path = Path.cwd() / binary_path
        roots.add(binary_path.parent.resolve(strict=False))
    return roots


def absolute_state_path(raw: str | None) -> Path:
    """Resolve the external maintenance state directory without following links."""
    if raw is None:
        state_home = Path(os.environ.get("XDG_STATE_HOME") or "~/.local/state").expanduser()
        if not state_home.is_absolute():
            raise MaintenanceError("XDG_STATE_HOME must be absolute")
        requested = state_home / "opencode-rig" / "policy-maintenance"
    else:
        requested = Path(raw).expanduser()
        if not requested.is_absolute():
            requested = Path.cwd() / requested
    absolute = Path(os.path.abspath(requested))
    resolved = absolute.resolve(strict=False)
    if ".git" in absolute.parts or ".git" in resolved.parts:
        raise MaintenanceError("state directory must not touch .git internals")
    if path_is_within(absolute, REPOSITORY_ROOT) or path_is_within(resolved, REPOSITORY_ROOT):
        raise MaintenanceError("state directory must be outside the repository")
    if any(
        path_is_within(absolute, protected) or path_is_within(resolved, protected)
        for protected in protected_opencode_roots()
    ):
        raise MaintenanceError("state directory must not be inside protected OpenCode paths")
    return absolute


def ensure_directories(path: Path) -> None:
    """Create a directory tree while refusing symlinks and non-directory parts."""
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current = current / component
        try:
            info = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
                fsync_directory(current.parent)
            except FileExistsError:
                pass
            try:
                info = current.lstat()
            except OSError as exc:
                raise MaintenanceError(f"cannot create state directory {current}: {exc}") from exc
        except OSError as exc:
            raise MaintenanceError(f"cannot inspect state directory {current}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode):
            raise MaintenanceError(f"refusing symlink in state directory: {current}")
        if not stat.S_ISDIR(info.st_mode):
            raise MaintenanceError(f"state path component is not a directory: {current}")


def ensure_new_directory(path: Path) -> None:
    """Create one private directory or verify an existing real directory."""
    try:
        path.mkdir(mode=0o700)
        fsync_directory(path.parent)
    except FileExistsError:
        try:
            info = path.lstat()
        except OSError as exc:
            raise MaintenanceError(f"cannot inspect directory {path}: {exc}") from exc
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise MaintenanceError(f"refusing symlink or non-directory path: {path}")


def write_new_file(path: Path, data: bytes, mode: int = 0o600) -> None:
    """Create a new file exclusively, flush it, and refuse symlink replacement."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(path, flags, mode)
    except OSError as exc:
        raise MaintenanceError(f"cannot create {path}: {exc}") from exc
    completed = False
    try:
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write while creating maintenance state")
            view = view[written:]
        os.fsync(descriptor)
        completed = True
    finally:
        os.close(descriptor)
    if completed:
        fsync_directory(path.parent)


def create_backup(plan: list[PlannedFile], reason: str, state_dir: Path) -> tuple[Path, dict[str, object]]:
    """Create pristine backup copies and a manifest before target writes."""
    ensure_directories(state_dir)
    backups_root = state_dir / "backups"
    ensure_new_directory(backups_root)
    backup_dir = backups_root / f"{timestamp()}-{os.getpid()}-{secrets.token_hex(4)}"
    ensure_new_directory(backup_dir)
    files_root = backup_dir / "files"
    ensure_new_directory(files_root)

    manifest_files: list[dict[str, object]] = []
    for item in plan:
        relative_path = Path(item.relative)
        destination_dir = files_root
        for component in relative_path.parts[:-1]:
            destination_dir = destination_dir / component
            ensure_new_directory(destination_dir)
        backup_relative = (Path("files") / relative_path).as_posix()
        write_new_file(destination_dir / relative_path.name, item.original)
        manifest_files.append(
            {
                "path": item.relative,
                "backup": backup_relative,
                "mode": item.mode,
                "beforeBytes": len(item.original),
                "beforeSha256": sha256(item.original),
                "afterBytes": len(item.updated),
                "afterSha256": sha256(item.updated),
                "edits": [
                    {"oldBytes": edit.old_bytes, "newBytes": edit.new_bytes}
                    for edit in item.edits
                ],
            }
        )
    manifest: dict[str, object] = {
        "formatVersion": 1,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "reason": reason,
        "files": manifest_files,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    write_new_file(backup_dir / "manifest.json", manifest_bytes)
    return backup_dir, manifest


def assert_unchanged(item: PlannedFile) -> None:
    """Refuse to replace a target changed since planning."""
    current, info = read_regular_file_at(item.parent_fd, item.name, item.relative)
    original = item.original_stat
    if (
        info.st_dev != original.st_dev
        or info.st_ino != original.st_ino
        or stat.S_IMODE(info.st_mode) != item.mode
        or current != item.original
    ):
        raise MaintenanceError(f"target changed after validation; refusing to overwrite: {item.relative}")


def read_backup_copy(backup_dir: Path, item: PlannedFile) -> bytes:
    """Read and verify one pristine backup before using it for rollback."""
    backup_path = backup_dir / "files" / Path(item.relative)
    try:
        descriptor = os.open(backup_path, os.O_RDONLY | NOFOLLOW | NONBLOCK | getattr(os, "O_CLOEXEC", 0))
    except OSError as exc:
        raise MaintenanceError(f"cannot safely read rollback backup for {item.relative}: {exc}") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_TARGET_BYTES:
            raise MaintenanceError(f"rollback backup is not a bounded regular file: {item.relative}")
        chunks: list[bytes] = []
        total = 0
        while total <= MAX_TARGET_BYTES:
            chunk = os.read(descriptor, min(READ_CHUNK_BYTES, MAX_TARGET_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        content = b"".join(chunks)
        if total > MAX_TARGET_BYTES or content != item.original:
            raise MaintenanceError(f"rollback backup failed its pristine-byte check: {item.relative}")
        return content
    finally:
        os.close(descriptor)


def atomic_replace(
    item: PlannedFile,
    content: bytes,
    mode: int,
    on_replace: Callable[[], None],
) -> None:
    """Write a same-directory temporary file and atomically replace the target."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    temporary_name = ""
    descriptor = -1
    for _attempt in range(10):
        temporary_name = f".{item.name}.policy-recovery-{secrets.token_hex(8)}"
        try:
            descriptor = os.open(temporary_name, flags, 0o600, dir_fd=item.parent_fd)
            break
        except FileExistsError:
            continue
    if descriptor < 0:
        raise OSError("could not allocate a unique same-directory temporary file")

    replaced = False
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        os.replace(
            temporary_name,
            item.name,
            src_dir_fd=item.parent_fd,
            dst_dir_fd=item.parent_fd,
        )
        replaced = True
        on_replace()
        os.fsync(item.parent_fd)
    except (Exception, KeyboardInterrupt):
        if not replaced:
            try:
                current, _info = read_regular_file_at(item.parent_fd, item.name, item.relative)
                if current == content:
                    on_replace()
            except (Exception, KeyboardInterrupt):
                pass
        try:
            os.unlink(temporary_name, dir_fd=item.parent_fd)
        except FileNotFoundError:
            pass
        raise


def append_audit(state_dir: Path, record: dict[str, object]) -> None:
    """Append one fsynced JSON object without truncating the audit log."""
    audit_path = state_dir / "audit.jsonl"
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | NOFOLLOW | NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(audit_path, flags, 0o600)
    except OSError as exc:
        raise MaintenanceError(f"cannot open append-only audit log {audit_path}: {exc}") from exc
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise MaintenanceError(f"audit log is not a regular file: {audit_path}")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        payload = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        view = memoryview(payload)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short write while appending audit record")
            view = view[written:]
        os.fsync(descriptor)
        fsync_directory(state_dir)
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def file_audit_summary(plan: list[PlannedFile]) -> list[dict[str, object]]:
    """Build bounded per-file digest summaries for the audit log."""
    return [
        {
            "path": item.relative,
            "beforeBytes": len(item.original),
            "afterBytes": len(item.updated),
            "beforeSha256": sha256(item.original),
            "afterSha256": sha256(item.updated),
        }
        for item in plan
    ]


def verify_node(plan: list[PlannedFile]) -> bool:
    """Optionally syntax-check proposed TypeScript using checkout-local Node."""
    typescript = [item for item in plan if item.relative.endswith(".ts")]
    if not typescript:
        print("VERIFY: no edited .ts files; syntax check not needed")
        return True
    try:
        config_parent, config_name = open_repository_parent(".opencode/rig-gates.json")
        try:
            config_bytes, _info = read_regular_file_at(config_parent, config_name, ".opencode/rig-gates.json")
        finally:
            os.close(config_parent)
        if len(config_bytes) > 64 * 1024:
            raise MaintenanceError("rig-gates config exceeds its optional read bound")
        config = json.loads(config_bytes.decode("utf-8"))
        runtime = config.get("qaRuntime") if isinstance(config, dict) else None
        if not isinstance(runtime, dict):
            raise MaintenanceError("rig-gates config has no qaRuntime object")
        executable = runtime.get("executable")
        if not isinstance(executable, str) or not executable:
            raise MaintenanceError("rig-gates config has no qaRuntime executable")
        node_relative = Path(executable.replace("\\", "/"))
        if node_relative.is_absolute() or any(part in {"", ".."} for part in node_relative.parts):
            raise MaintenanceError("rig-gates Node executable must be a safe relative path")
        node_path = REPOSITORY_ROOT / node_relative
        node_parent, node_name = open_repository_parent(node_relative.as_posix())
        try:
            _node_bytes, node_stat = read_regular_file_at(node_parent, node_name, executable)
        finally:
            os.close(node_parent)
        if not (stat.S_IMODE(node_stat.st_mode) & 0o111):
            raise MaintenanceError("checkout-local Node is not executable")
    except (MaintenanceError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"VERIFY: skipped (optional checkout-local Node unavailable: {exc})")
        return True

    try:
        version = subprocess.run(
            [str(node_path), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"VERIFY: skipped (optional checkout-local Node is not runnable: {exc})")
        return True
    if version.returncode != 0:
        print("VERIFY: skipped (optional checkout-local Node --version failed)")
        return True

    successful = True
    try:
        with tempfile.TemporaryDirectory(prefix="orchestration-policy-verify-", dir="/tmp") as temporary:
            for item in typescript:
                temporary_file = Path(temporary) / Path(item.relative).name
                temporary_file.write_bytes(item.updated)
                try:
                    result = subprocess.run(
                        [str(node_path), "--experimental-strip-types", "--check", str(temporary_file)],
                        capture_output=True,
                        timeout=30,
                        check=False,
                    )
                except (OSError, subprocess.TimeoutExpired) as exc:
                    print(f"VERIFY: FAIL {item.relative}: {exc}")
                    successful = False
                    continue
                if result.returncode == 0:
                    print(f"VERIFY: PASS {item.relative} ({version.stdout.strip()})")
                else:
                    detail = result.stderr.decode("utf-8", errors="replace").strip()
                    print(f"VERIFY: FAIL {item.relative}: {detail or 'syntax check failed'}")
                    successful = False
    except OSError as exc:
        print(f"VERIFY: FAIL could not create temporary syntax-check input: {exc}")
        return False
    return successful


def apply_plan(plan: list[PlannedFile], reason: str, requested_state_dir: Path) -> Path:
    """Back up all targets, atomically apply the plan, and audit the result."""
    replaced: list[PlannedFile] = []
    backup_dir: Path | None = None
    state_ready = False
    failure: BaseException | None = None
    rollback_errors: list[str] = []
    audit_errors: list[str] = []
    try:
        ensure_directories(requested_state_dir)
        state_ready = True
        for item in plan:
            assert_unchanged(item)
        backup_dir, _manifest = create_backup(plan, reason, requested_state_dir)
        for item in plan:
            assert_unchanged(item)
            atomic_replace(item, item.updated, item.mode, lambda target=item: replaced.append(target))
        record: dict[str, object] = {
            "recordedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "status": "applied",
            "reason": reason,
            "backupDirectory": str(backup_dir),
            "files": file_audit_summary(plan),
        }
        append_audit(requested_state_dir, record)
        print(f"APPLY: complete; backup={backup_dir}")
        print(f"AUDIT: {requested_state_dir / 'audit.jsonl'}")
        return backup_dir
    except (Exception, KeyboardInterrupt) as exc:
        failure = exc
        for item in reversed(replaced):
            try:
                if backup_dir is None:
                    raise MaintenanceError("no complete backup is available for rollback")
                pristine = read_backup_copy(backup_dir, item)
                atomic_replace(item, pristine, item.mode, lambda: None)
            except (Exception, KeyboardInterrupt) as rollback_exc:
                rollback_errors.append(f"{item.relative}: {rollback_exc}")
        if state_ready:
            record = {
                "recordedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "status": "failed_rollback_incomplete" if rollback_errors else "failed_rolled_back",
                "reason": reason,
                "backupDirectory": str(backup_dir) if backup_dir else None,
                "files": file_audit_summary(plan),
                "error": str(exc),
                "rollbackErrors": rollback_errors,
            }
            try:
                append_audit(requested_state_dir, record)
            except (Exception, KeyboardInterrupt) as audit_exc:
                audit_errors.append(str(audit_exc))
    rollback_status = "rollback complete" if not rollback_errors else "rollback incomplete: " + "; ".join(rollback_errors)
    audit_status = "; audit append failed: " + "; ".join(audit_errors) if audit_errors else ""
    backup_status = f"; pristine backup retained at {backup_dir}" if backup_dir else "; no complete backup directory was created"
    raise ApplyFailure(f"apply failed: {failure}; {rollback_status}{audit_status}{backup_status}") from failure


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the required spec and explicit mutation/verification options."""
    parser = argparse.ArgumentParser(description="Audited, allowlisted orchestration-policy lockout recovery.")
    parser.add_argument("--spec", required=True, help="JSON edit spec path, or - to read JSON from stdin")
    parser.add_argument("--apply", action="store_true", help="apply edits; default is a read-only dry-run")
    parser.add_argument("--reason", help="override the required reason in the JSON spec")
    parser.add_argument("--state-dir", help="external state directory (default: XDG_STATE_HOME or ~/.local/state)")
    parser.add_argument("--verify", action="store_true", help="optionally syntax-check edited TypeScript with checkout-local Node")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Run the dry-run or explicitly requested audited apply operation."""
    args = parse_args(argv)
    plan: list[PlannedFile] = []
    try:
        reason, edits = parse_spec(args.spec, args.reason)
        plan = build_plan(edits)
        print_plan(plan, args.apply)
        if args.verify and not verify_node(plan):
            raise VerificationFailure("optional TypeScript syntax verification failed")
        if args.apply:
            apply_plan(plan, reason, absolute_state_path(args.state_dir))
        else:
            print("DRY RUN: no changes made; pass --apply to write and audit")
        return 0
    except ApplyFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except VerificationFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    except MaintenanceError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        close_plan(plan)


if __name__ == "__main__":
    raise SystemExit(main())
