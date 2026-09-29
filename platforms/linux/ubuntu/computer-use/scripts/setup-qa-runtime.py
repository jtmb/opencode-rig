#!/usr/bin/env python3
"""Verify or install the checksum-pinned checkout-local repository QA runtime."""

from __future__ import annotations

import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from dataclasses import dataclass
import urllib.error
import urllib.parse
import urllib.request


sys.dont_write_bytecode = True

ARCHIVE_URL = "https://nodejs.org/dist/v26.4.0/node-v26.4.0-linux-x64.tar.xz"
ARCHIVE_SHA256 = "5c4286dcd5bbd5acb1ccc7eb0e088bd5eb1e3affad671ee9364004f8f6a4a431"
NODE_SHA256 = "4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94"
NPM_CLI_SHA256 = "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7"
ARCHIVE_ROOT = "node-v26.4.0-linux-x64"
NODE_PATH = "bin/node"
NPM_LAUNCHER_PATH = "bin/npm"
NPM_CLI_PATH = "lib/node_modules/npm/bin/npm-cli.js"
NPM_PACKAGE_PATH = "lib/node_modules/npm/package.json"
NPM_LAUNCHER_BYTES = (
    b'#!/bin/sh\n'
    b'exec "${0%/*}/node" "${0%/*}/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n'
)
MANIFEST_NAME = ".open-rig-qa-runtime.json"
QA_CONFIG_PATH = ".opencode/rig-gates.json"
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 10_000
MAX_UNPACKED_BYTES = 512 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 2 * 1024 * 1024


class ProvisionError(RuntimeError):
    """A fail-closed runtime verification or installation error."""


class _DuplicateKey(ProvisionError):
    pass


def _reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _parse_json(raw: bytes, label: str) -> object:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicates)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ProvisionError(f"{label} must be valid UTF-8 JSON") from exc


def _safe_parts(value: object, label: str) -> tuple[str, ...]:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise ProvisionError(f"{label} must be a safe relative POSIX path")
    path = PurePosixPath(value)
    if path.is_absolute() or path.drive or any(part in {"", ".", ".."} for part in path.parts):
        raise ProvisionError(f"{label} escapes its expected root")
    if path.as_posix() != value:
        raise ProvisionError(f"{label} is not canonical")
    return path.parts


def _lstat_beneath(root: Path, relative: str, label: str) -> os.stat_result:
    parts = _safe_parts(relative, label)
    current = root
    for part in parts:
        current = current / part
        try:
            info = current.lstat()
        except OSError as exc:
            raise ProvisionError(f"{label} is missing or unreadable: {relative}") from exc
        if stat.S_ISLNK(info.st_mode):
            raise ProvisionError(f"{label} rejects symlink path: {relative}")
    return info


def _sha256(path: Path) -> str:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ProvisionError(f"cannot safely open file: {path.name}") from exc
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ProvisionError(f"file must be regular and have one link: {path.name}")
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise ProvisionError(f"file changed while hashing: {path.name}")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def _read_regular(root: Path, relative: str, label: str, maximum: int) -> bytes:
    info = _lstat_beneath(root, relative, label)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ProvisionError(f"{label} must be a regular file with one link: {relative}")
    if info.st_size > maximum:
        raise ProvisionError(f"{label} exceeds its {maximum}-byte limit")
    path = root.joinpath(*_safe_parts(relative, label))
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ProvisionError(f"cannot read {label}: {relative}") from exc
    if len(raw) != info.st_size:
        raise ProvisionError(f"{label} changed while reading: {relative}")
    return raw


def _expected_qa_runtime(pins: object) -> dict[str, object]:
    return {
        "name": "node",
        "version": pins.version,
        "executable": f"toolchains/node/{NODE_PATH}",
        "sha256": pins.node_sha256,
        "packageManager": {
            "name": "npm",
            "executable": f"toolchains/node/{NPM_CLI_PATH}",
            "sha256": pins.npm_cli_sha256,
        },
    }


def verify_gate_config(root: Path, pins: object) -> None:
    raw = _read_regular(root, QA_CONFIG_PATH, "QA gate configuration", MAX_CONFIG_BYTES)
    parsed = _parse_json(raw, "QA gate configuration")
    if not isinstance(parsed, dict) or parsed.get("qaRuntime") != _expected_qa_runtime(pins):
        raise ProvisionError(
            "qaRuntime in .opencode/rig-gates.json does not match the approved Node/npm pins"
        )


def _normalized_archive_name(member: tarfile.TarInfo, pins: object) -> str:
    name = member.name
    if member.isdir() and name.endswith("/"):
        name = name[:-1]
    parts = _safe_parts(name, "archive member path")
    if parts[0] != pins.archive_root or (len(parts) > 1 and parts[1] == ""):
        raise ProvisionError(f"archive member is outside {pins.archive_root}: {name}")
    if len(name.encode("utf-8")) > 4096:
        raise ProvisionError("archive member path exceeds 4096 bytes")
    return name


def _archive_members(archive: tarfile.TarFile, pins: object) -> list[tuple[str, tarfile.TarInfo]]:
    members = archive.getmembers()
    if not members or len(members) > MAX_ARCHIVE_MEMBERS:
        raise ProvisionError("archive member count is empty or exceeds its limit")

    by_name: dict[str, tuple[str, tarfile.TarInfo]] = {}
    archive_bytes = 0
    expected_aliases = {
        f"{pins.archive_root}/bin/npm": "../lib/node_modules/npm/bin/npm-cli.js",
        f"{pins.archive_root}/bin/npx": "../lib/node_modules/npm/bin/npx-cli.js",
    }
    aliases: set[str] = set()
    for member in members:
        if member.pax_headers or getattr(member, "sparse", None):
            raise ProvisionError(f"archive metadata extensions are unsupported: {member.name}")
        name = _normalized_archive_name(member, pins)
        if name in by_name:
            raise ProvisionError(f"duplicate archive member: {name}")
        if member.mode & ~0o777:
            raise ProvisionError(f"archive member has special permission bits: {name}")
        if member.isdir():
            kind = "directory"
        elif member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
            kind = "file"
            if member.size < 0 or member.size > MAX_ARCHIVE_BYTES:
                raise ProvisionError(f"archive member size is invalid: {name}")
            archive_bytes += member.size
            if archive_bytes > MAX_UNPACKED_BYTES:
                raise ProvisionError("archive uncompressed contents exceed the configured limit")
        elif member.issym():
            kind = "symlink"
            if expected_aliases.get(name) != member.linkname:
                raise ProvisionError(f"archive symlink is not an approved npm alias: {name}")
            aliases.add(name)
        else:
            raise ProvisionError(f"archive member type is not a regular file or directory: {name}")
        by_name[name] = (kind, member)

    if aliases != set(expected_aliases):
        raise ProvisionError("archive does not contain exactly the two known npm alias records")

    for name, (kind, _member) in by_name.items():
        parent = PurePosixPath(name).parent
        while str(parent) not in {".", ""}:
            parent_name = parent.as_posix()
            parent_record = by_name.get(parent_name)
            if parent_record is not None and parent_record[0] != "directory":
                raise ProvisionError(f"archive member has a non-directory ancestor: {name}")
            parent = parent.parent

    required = {
        pins.archive_root: "directory",
        f"{pins.archive_root}/bin": "directory",
        f"{pins.archive_root}/lib": "directory",
        f"{pins.archive_root}/lib/node_modules": "directory",
        f"{pins.archive_root}/lib/node_modules/npm": "directory",
        f"{pins.archive_root}/bin/node": "file",
        f"{pins.archive_root}/{NPM_CLI_PATH}": "file",
        f"{pins.archive_root}/{NPM_PACKAGE_PATH}": "file",
    }
    for name, expected_kind in required.items():
        found = by_name.get(name)
        if found is None or found[0] != expected_kind:
            raise ProvisionError(f"archive is missing its required {expected_kind}: {name}")

    for name, (kind, member) in by_name.items():
        if name == pins.archive_root or name.startswith(f"{pins.archive_root}/"):
            if kind == "symlink" and name not in expected_aliases:
                raise ProvisionError(f"archive symlink is not allowed: {name}")
            if kind == "file" and name.startswith(f"{pins.archive_root}/lib/node_modules/npm/"):
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE):
                    raise ProvisionError(f"npm subtree contains an unsupported file: {name}")

    return [(name, member) for name, (_kind, member) in by_name.items()]


def validate_archive_structure(path: Path, pins: object) -> None:
    try:
        with tarfile.open(path, mode="r:xz") as archive:
            members = _archive_members(archive, pins)
            by_name = {name: member for name, member in members}
            package_member = by_name[f"{pins.archive_root}/{NPM_PACKAGE_PATH}"]
            package_file = archive.extractfile(package_member)
            if package_file is None:
                raise ProvisionError("npm package metadata is not a regular file")
            package = _parse_json(package_file.read(MAX_CONFIG_BYTES + 1), "archive npm package metadata")
            if not isinstance(package, dict) or package.get("version") != pins.npm_version:
                raise ProvisionError("archive npm package version does not match the approved pin")
    except (OSError, tarfile.TarError, EOFError) as exc:
        if isinstance(exc, ProvisionError):
            raise
        raise ProvisionError("official Node archive is unreadable or malformed") from exc


def verify_archive_digest(path: Path, pins: object) -> None:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ProvisionError("downloaded Node archive is missing") from exc
    if size <= 0 or size > MAX_ARCHIVE_BYTES:
        raise ProvisionError("downloaded Node archive is empty or exceeds its size limit")
    actual = _sha256(path)
    if actual != pins.archive_sha256:
        raise ProvisionError("Node archive SHA-256 does not match the approved official archive")


def download_archive(destination: Path, pins: object) -> None:
    request = urllib.request.Request(
        pins.archive_url,
        headers={"User-Agent": "Open-Rig-QA-runtime-provisioner"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            final = urllib.parse.urlparse(response.geturl())
            if final.scheme != "https" or final.hostname != "nodejs.org":
                raise ProvisionError("Node archive redirected outside the official HTTPS host")
            content_length = response.headers.get("Content-Length")
            if content_length is not None and int(content_length) > MAX_ARCHIVE_BYTES:
                raise ProvisionError("official Node archive exceeds its size limit")
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            total = 0
            try:
                with os.fdopen(descriptor, "wb") as output:
                    while chunk := response.read(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_ARCHIVE_BYTES:
                            raise ProvisionError("official Node archive exceeds its size limit")
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            except BaseException:
                try:
                    destination.unlink()
                except OSError:
                    pass
                raise
    except (OSError, ValueError, urllib.error.URLError) as exc:
        if isinstance(exc, ProvisionError):
            raise
        raise ProvisionError("cannot download the official Node archive") from exc


def _safe_directory(root: Path, relative: str, mode: int = 0o755) -> Path:
    parts = _safe_parts(relative, "runtime directory")
    current = root
    for part in parts:
        current = current / part
        try:
            current.mkdir(mode=0o755)
        except FileExistsError:
            pass
        except OSError as exc:
            raise ProvisionError(f"cannot create runtime directory: {relative}") from exc
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ProvisionError(f"runtime path is not a real directory: {relative}")
        os.chmod(current, 0o755)
    os.chmod(current, mode)
    return current


def _is_selected(name: str, archive_root: str) -> bool:
    npm_root = f"{archive_root}/lib/node_modules/npm"
    return name in {
        f"{archive_root}/bin",
        f"{archive_root}/lib",
        f"{archive_root}/lib/node_modules",
        npm_root,
        f"{archive_root}/bin/node",
    } or name.startswith(f"{npm_root}/")


def extract_archive(path: Path, destination: Path, pins: object) -> None:
    try:
        with tarfile.open(path, mode="r:xz") as archive:
            members = _archive_members(archive, pins)
            directories: dict[str, int] = {}
            files: dict[str, dict[str, object]] = {}
            aliases = {
                f"{pins.archive_root}/bin/npm",
                f"{pins.archive_root}/bin/npx",
            }

            for name, member in members:
                if name == pins.archive_root or name in aliases or not _is_selected(name, pins.archive_root):
                    continue
                relative = name[len(pins.archive_root) + 1 :]
                parts = _safe_parts(relative, "selected archive path")
                if member.isdir():
                    mode = 0o755
                    directory = _safe_directory(destination, relative, mode)
                    directories[relative] = stat.S_IMODE(directory.stat().st_mode)
                    continue

                parent = PurePosixPath(relative).parent
                if str(parent) != ".":
                    _safe_directory(destination, parent.as_posix())
                    for index in range(1, len(parent.parts) + 1):
                        ancestor = PurePosixPath(*parent.parts[:index]).as_posix()
                        directories.setdefault(ancestor, 0o755)
                target = destination.joinpath(*parts)
                mode = 0o755 if member.mode & 0o111 else 0o644
                descriptor = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                source = archive.extractfile(member)
                if source is None:
                    os.close(descriptor)
                    raise ProvisionError(f"archive member is not readable: {name}")
                written = 0
                with source, os.fdopen(descriptor, "wb") as output:
                    while chunk := source.read(1024 * 1024):
                        written += len(chunk)
                        if written > member.size:
                            raise ProvisionError(f"archive member expanded beyond its declared size: {name}")
                        output.write(chunk)
                    if written != member.size:
                        raise ProvisionError(f"archive member size did not match its header: {name}")
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(target, mode)
                files[relative] = {"sha256": _sha256(target), "mode": mode}

            for required in (NODE_PATH, NPM_CLI_PATH, NPM_PACKAGE_PATH):
                if required not in files:
                    raise ProvisionError(f"archive extraction omitted required runtime file: {required}")
            if files[NODE_PATH]["sha256"] != pins.node_sha256:
                raise ProvisionError("extracted Node executable SHA-256 does not match the approved pin")
            if files[NPM_CLI_PATH]["sha256"] != pins.npm_cli_sha256:
                raise ProvisionError("extracted npm CLI SHA-256 does not match the approved pin")

            launcher = destination / NPM_LAUNCHER_PATH
            descriptor = os.open(
                launcher,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o755,
            )
            with os.fdopen(descriptor, "wb") as output:
                output.write(NPM_LAUNCHER_BYTES)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(launcher, 0o755)
            files[NPM_LAUNCHER_PATH] = {
                "sha256": hashlib.sha256(NPM_LAUNCHER_BYTES).hexdigest(),
                "mode": 0o755,
            }

            package = _parse_json((destination / NPM_PACKAGE_PATH).read_bytes(), "extracted npm package metadata")
            if not isinstance(package, dict) or package.get("version") != pins.npm_version:
                raise ProvisionError("extracted npm package version does not match the approved pin")

            manifest = {
                "schemaVersion": 1,
                "archiveSha256": pins.archive_sha256,
                "nodeVersion": pins.version,
                "npmVersion": pins.npm_version,
                "files": dict(sorted(files.items())),
                "directories": dict(sorted(directories.items())),
            }
            manifest_path = destination / MANIFEST_NAME
            manifest_bytes = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
            descriptor = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            with os.fdopen(descriptor, "wb") as output:
                output.write(manifest_bytes)
                output.flush()
                os.fsync(output.fileno())
    except (OSError, tarfile.TarError, EOFError) as exc:
        if isinstance(exc, ProvisionError):
            raise
        raise ProvisionError("official Node archive could not be safely extracted") from exc


def verify_runtime_tree(directory: Path, pins: object) -> None:
    try:
        root_info = directory.lstat()
    except OSError as exc:
        raise ProvisionError("checkout-local Node runtime is not installed") from exc
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise ProvisionError("checkout-local Node runtime must be a real directory")
    if stat.S_IMODE(root_info.st_mode) & 0o022:
        raise ProvisionError("checkout-local Node runtime directory is group/world writable")

    manifest_raw = _read_regular(directory, MANIFEST_NAME, "runtime manifest", MAX_MANIFEST_BYTES)
    manifest = _parse_json(manifest_raw, "runtime manifest")
    if not isinstance(manifest, dict) or set(manifest) != {
        "schemaVersion", "archiveSha256", "nodeVersion", "npmVersion", "files", "directories"
    }:
        raise ProvisionError("runtime manifest has an unsupported shape")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("archiveSha256") != pins.archive_sha256
        or manifest.get("nodeVersion") != pins.version
        or manifest.get("npmVersion") != pins.npm_version
    ):
        raise ProvisionError("runtime manifest does not match the approved distribution")

    files = manifest.get("files")
    directories = manifest.get("directories")
    if not isinstance(files, dict) or not isinstance(directories, dict):
        raise ProvisionError("runtime manifest file/directory lists must be objects")
    node_entry = files.get(NODE_PATH)
    npm_launcher_entry = files.get(NPM_LAUNCHER_PATH)
    npm_entry = files.get(NPM_CLI_PATH)
    if not isinstance(node_entry, dict) or not isinstance(npm_launcher_entry, dict) or not isinstance(npm_entry, dict):
        raise ProvisionError("runtime manifest omits a pinned Node or npm executable")
    if npm_launcher_entry.get("mode") != 0o755:
        raise ProvisionError("runtime manifest npm launcher mode does not match the approved wrapper")
    if node_entry.get("sha256") != pins.node_sha256:
        raise ProvisionError("runtime manifest Node digest does not match the approved pin")
    if npm_entry.get("sha256") != pins.npm_cli_sha256:
        raise ProvisionError("runtime manifest npm CLI digest does not match the approved pin")
    if npm_launcher_entry.get("sha256") != hashlib.sha256(NPM_LAUNCHER_BYTES).hexdigest():
        raise ProvisionError("runtime manifest npm launcher digest does not match the approved wrapper")
    if (
        not node_entry.get("mode", 0) & 0o111
        or not npm_launcher_entry.get("mode", 0) & 0o111
        or not npm_entry.get("mode", 0) & 0o111
    ):
        raise ProvisionError("runtime manifest Node/npm entries must be executable")

    actual_files: set[str] = set()
    actual_directories: set[str] = set()
    for current_name, directory_names, filenames in os.walk(directory, topdown=True, followlinks=False):
        current = Path(current_name)
        kept_directories: list[str] = []
        for name in directory_names:
            entry = current / name
            info = entry.lstat()
            relative = entry.relative_to(directory).as_posix()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ProvisionError(f"runtime contains a non-directory or symlink: {relative}")
            actual_directories.add(relative)
            kept_directories.append(name)
        directory_names[:] = kept_directories
        for name in filenames:
            entry = current / name
            relative = entry.relative_to(directory).as_posix()
            info = entry.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
                raise ProvisionError(f"runtime contains a non-regular or linked file: {relative}")
            actual_files.add(relative)

    if actual_files != set(files) | {MANIFEST_NAME}:
        raise ProvisionError("runtime files are incomplete or contain unexpected entries")
    if actual_directories != set(directories):
        raise ProvisionError("runtime directories are incomplete or contain unexpected entries")

    for relative, expected in files.items():
        _safe_parts(relative, "runtime manifest file path")
        if not isinstance(expected, dict) or set(expected) != {"sha256", "mode"}:
            raise ProvisionError(f"runtime manifest entry is malformed: {relative}")
        if not isinstance(expected["sha256"], str) or re.fullmatch(r"[0-9a-f]{64}", expected["sha256"]) is None:
            raise ProvisionError(f"runtime manifest digest is malformed: {relative}")
        if not isinstance(expected["mode"], int) or isinstance(expected["mode"], bool):
            raise ProvisionError(f"runtime manifest mode is malformed: {relative}")
        info = _lstat_beneath(directory, relative, "runtime file")
        path = directory.joinpath(*_safe_parts(relative, "runtime file"))
        if stat.S_IMODE(info.st_mode) != expected["mode"]:
            raise ProvisionError(f"runtime file mode changed: {relative}")
        if _sha256(path) != expected["sha256"]:
            raise ProvisionError(f"runtime file SHA-256 changed: {relative}")
    for relative, mode in directories.items():
        _safe_parts(relative, "runtime manifest directory path")
        if not isinstance(mode, int) or isinstance(mode, bool) or mode != 0o755:
            raise ProvisionError(f"runtime manifest directory mode is malformed: {relative}")
        info = _lstat_beneath(directory, relative, "runtime directory")
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != mode:
            raise ProvisionError(f"runtime directory mode changed: {relative}")

    package = _parse_json((directory / NPM_PACKAGE_PATH).read_bytes(), "installed npm package metadata")
    if not isinstance(package, dict) or package.get("version") != pins.npm_version:
        raise ProvisionError("installed npm package version does not match the approved pin")


def verify_installed_runtime(root: Path, pins: object) -> None:
    verify_gate_config(root, pins)
    toolchains = root / "toolchains"
    try:
        info = toolchains.lstat()
    except OSError as exc:
        raise ProvisionError("checkout-local toolchains directory is missing") from exc
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ProvisionError("checkout-local toolchains path must be a real directory")
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise ProvisionError("checkout-local toolchains directory is group/world writable")
    verify_runtime_tree(toolchains / "node", pins)


def _rename_noreplace(source: Path, destination: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise ProvisionError("atomic no-replace installation requires Linux renameat2 support")
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        -100,
        os.fsencode(source),
        -100,
        os.fsencode(destination),
        1,
    )
    if result == 0:
        return
    error = ctypes.get_errno()
    if error == errno.EEXIST:
        raise ProvisionError("checkout-local Node runtime already exists; refusing to replace it")
    if error in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP}:
        raise ProvisionError("atomic no-replace installation is unavailable on this filesystem")
    raise ProvisionError(f"atomic no-replace installation failed: {os.strerror(error)}")


def install_from_archive(root: Path, archive_path: Path, pins: object) -> None:
    verify_gate_config(root, pins)
    target = root / "toolchains" / "node"
    if target.exists() or target.is_symlink():
        verify_runtime_tree(target, pins)
        return

    verify_archive_digest(archive_path, pins)
    validate_archive_structure(archive_path, pins)
    toolchains = root / "toolchains"
    try:
        toolchains.mkdir(mode=0o755)
    except FileExistsError:
        pass
    except OSError as exc:
        raise ProvisionError("cannot create checkout-local toolchains directory") from exc
    info = toolchains.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ProvisionError("checkout-local toolchains path must be a real directory")
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise ProvisionError("checkout-local toolchains directory is group/world writable")

    stage = Path(tempfile.mkdtemp(prefix=".node-qa-stage-", dir=toolchains))
    os.chmod(stage, 0o755)
    try:
        extract_archive(archive_path, stage, pins)
        verify_runtime_tree(stage, pins)
        verify_archive_digest(archive_path, pins)
        _rename_noreplace(stage, target)
        descriptor = os.open(toolchains, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        verify_runtime_tree(target, pins)
    finally:
        if stage.exists() and not stage.is_symlink():
            shutil.rmtree(stage)


def apply_runtime(root: Path, pins: object, downloader=download_archive) -> None:
    verify_gate_config(root, pins)
    target = root / "toolchains" / "node"
    if target.exists() or target.is_symlink():
        verify_installed_runtime(root, pins)
        return
    with tempfile.TemporaryDirectory(prefix="open-rig-qa-runtime-") as temporary:
        archive = Path(temporary) / "node.tar.xz"
        downloader(archive, pins)
        verify_archive_digest(archive, pins)
        validate_archive_structure(archive, pins)
        install_from_archive(root, archive, pins)


def repository_root() -> Path:
    return Path(__file__).resolve().parents[5]


def main(argv: list[str] | None = None, *, root: Path | None = None, pins: object | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--verify-only", action="store_true", help="verify the installed runtime without writing (default)")
    actions.add_argument("--apply", action="store_true", help="download, verify, and atomically install the pinned runtime")
    args = parser.parse_args(argv)
    selected_root = (root or repository_root()).resolve(strict=True)
    selected_pins = pins or DEFAULT_PINS
    try:
        if args.apply:
            apply_runtime(selected_root, selected_pins)
            print(f"OK: Node {selected_pins.version} and npm {selected_pins.npm_version} installed and verified")
        else:
            verify_installed_runtime(selected_root, selected_pins)
            print(f"OK: Node {selected_pins.version} and npm {selected_pins.npm_version} verified")
    except ProvisionError as exc:
        print(f"MISSING/FAILED: {exc}", file=sys.stderr)
        return 4 if args.apply else 1
    return 0


@dataclass(frozen=True)
class RuntimePins:
    version: str
    npm_version: str
    archive_root: str
    archive_url: str
    archive_sha256: str
    node_sha256: str
    npm_cli_sha256: str


DEFAULT_PINS = RuntimePins(
    version="26.4.0",
    npm_version="11.17.0",
    archive_root=ARCHIVE_ROOT,
    archive_url=ARCHIVE_URL,
    archive_sha256=ARCHIVE_SHA256,
    node_sha256=NODE_SHA256,
    npm_cli_sha256=NPM_CLI_SHA256,
)


if __name__ == "__main__":
    raise SystemExit(main())
