#!/usr/bin/env python3
"""Adversarial disposable tests for the checksum-pinned QA runtime installer."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import replace
from unittest.mock import patch


sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).with_name("setup-qa-runtime.py")
SPEC = importlib.util.spec_from_file_location("setup_qa_runtime", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise SystemExit("cannot import setup-qa-runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)


ROOT_NAME = runtime.ARCHIVE_ROOT
NODE_BYTES = b"#!/bin/sh\nexec \"$@\"\n"
NPM_CLI_BYTES = b"#!/bin/sh\nprintf 'fixture npm\\n'\n"
NPM_PACKAGE = json.dumps({"name": "npm", "version": "11.17.0"}).encode()
NPM_EXTRA = b"module.exports = 'complete npm subtree'\n"


def expect_failure(action, label: str, expected: str) -> None:
    try:
        action()
    except runtime.ProvisionError as error:
        if expected not in str(error):
            raise AssertionError(f"{label} failed with {error!r}, expected {expected!r}") from error
    else:
        raise AssertionError(f"{label} was accepted")


def fixture_entries() -> list[tuple[str, bytes | None, str, str | None]]:
    entries: list[tuple[str, bytes | None, str, str | None]] = [
        (f"{ROOT_NAME}/", None, "directory", None),
        (f"{ROOT_NAME}/bin/", None, "directory", None),
        (f"{ROOT_NAME}/bin/node", NODE_BYTES, "executable", None),
        (f"{ROOT_NAME}/bin/npm", None, "symlink", "../lib/node_modules/npm/bin/npm-cli.js"),
        (f"{ROOT_NAME}/bin/npx", None, "symlink", "../lib/node_modules/npm/bin/npx-cli.js"),
        (f"{ROOT_NAME}/lib/", None, "directory", None),
        (f"{ROOT_NAME}/lib/node_modules/", None, "directory", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/", None, "directory", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/bin/", None, "directory", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/bin/npm-cli.js", NPM_CLI_BYTES, "executable", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/package.json", NPM_PACKAGE, "file", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/node_modules/", None, "directory", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/node_modules/fixture/", None, "directory", None),
        (f"{ROOT_NAME}/lib/node_modules/npm/node_modules/fixture/index.js", NPM_EXTRA, "file", None),
    ]
    return entries


def write_archive(path: Path, entries: list[tuple[str, bytes | None, str, str | None]]) -> None:
    with tarfile.open(path, mode="w:xz") as archive:
        for name, data, kind, target in entries:
            info = tarfile.TarInfo(name)
            if kind == "directory":
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.mode = 0o777
                info.linkname = target or ""
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.mode = 0o644
                info.linkname = target or ""
            elif kind == "fifo":
                info.type = tarfile.FIFOTYPE
                info.mode = 0o644
            elif kind == "device":
                info.type = tarfile.CHRTYPE
                info.mode = 0o600
            else:
                info.type = tarfile.REGTYPE
                info.mode = 0o755 if kind == "executable" else 0o644
                info.size = len(data or b"")
            archive.addfile(info, io.BytesIO(data or b"") if kind in {"file", "executable"} else None)


def fixture_pins(archive: Path) -> runtime.RuntimePins:
    return replace(
        runtime.DEFAULT_PINS,
        archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        node_sha256=hashlib.sha256(NODE_BYTES).hexdigest(),
        npm_cli_sha256=hashlib.sha256(NPM_CLI_BYTES).hexdigest(),
    )


def qa_config(pins: runtime.RuntimePins) -> dict[str, object]:
    return {
        "qaRuntime": {
            "name": "node",
            "version": pins.version,
            "executable": "toolchains/node/bin/node",
            "sha256": pins.node_sha256,
            "packageManager": {
                "name": "npm",
                "executable": "toolchains/node/lib/node_modules/npm/bin/npm-cli.js",
                "sha256": pins.npm_cli_sha256,
            },
        }
    }


def write_config(root: Path, pins: runtime.RuntimePins) -> None:
    config = root / ".opencode" / "rig-gates.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps(qa_config(pins)) + "\n", encoding="utf-8")


def snapshot(directory: Path) -> dict[str, tuple[str, int]]:
    result: dict[str, tuple[str, int]] = {}
    if not directory.exists():
        return result
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        info = path.lstat()
        if stat.S_ISREG(info.st_mode):
            result[relative] = (hashlib.sha256(path.read_bytes()).hexdigest(), stat.S_IMODE(info.st_mode))
        elif stat.S_ISDIR(info.st_mode):
            result[relative] = ("directory", stat.S_IMODE(info.st_mode))
        elif stat.S_ISLNK(info.st_mode):
            result[relative] = (f"symlink:{os.readlink(path)}", stat.S_IMODE(info.st_mode))
        else:
            result[relative] = ("special", stat.S_IMODE(info.st_mode))
    return result


def test_official_pins_and_gate_config() -> None:
    pins = runtime.DEFAULT_PINS
    assert runtime.repository_root() == MODULE_PATH.resolve().parents[5]
    assert pins.archive_sha256 == "5c4286dcd5bbd5acb1ccc7eb0e088bd5eb1e3affad671ee9364004f8f6a4a431"
    assert pins.node_sha256 == "4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94"
    assert pins.npm_cli_sha256 == "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7"
    assert pins.archive_url.startswith("https://nodejs.org/dist/v26.4.0/")
    with tempfile.TemporaryDirectory(prefix="qa-runtime-config-") as temporary:
        root = Path(temporary)
        write_config(root, pins)
        runtime.verify_gate_config(root, pins)
        config = root / ".opencode/rig-gates.json"
        config.write_text(json.dumps(qa_config(pins) | {"qaRuntime": {"name": "node"}}), encoding="utf-8")
        expect_failure(lambda: runtime.verify_gate_config(root, pins), "unpinned gate config", "approved Node/npm pins")


def test_safe_archive_install_and_read_only_verification() -> None:
    with tempfile.TemporaryDirectory(prefix="qa-runtime-install-") as temporary:
        root = Path(temporary) / "checkout"
        root.mkdir()
        archive = Path(temporary) / "fixture.tar.xz"
        write_archive(archive, fixture_entries())
        pins = fixture_pins(archive)
        write_config(root, pins)
        runtime.verify_archive_digest(archive, pins)
        runtime.validate_archive_structure(archive, pins)

        runtime.install_from_archive(root, archive, pins)
        installed = root / "toolchains/node"
        runtime.verify_installed_runtime(root, pins)
        assert (installed / "bin/node").stat().st_mode & 0o111
        npm_entry = installed / "bin/npm"
        assert npm_entry.is_file() and not npm_entry.is_symlink()
        assert npm_entry.stat().st_mode & 0o111
        assert npm_entry.read_bytes() == runtime.NPM_LAUNCHER_BYTES
        assert (installed / "lib/node_modules/npm/bin/npm-cli.js").stat().st_mode & 0o111
        assert (installed / "lib/node_modules/npm/node_modules/fixture/index.js").read_bytes() == NPM_EXTRA
        assert not (installed / "bin/npx").exists()
        path_only = subprocess.run(
            ["npm", "--version"],
            check=False,
            capture_output=True,
            text=True,
            env={"PATH": str(installed / "bin")},
        )
        assert path_only.returncode == 0, path_only.stderr
        assert path_only.stdout == "fixture npm\n"
        assert len(list((installed / "lib/node_modules/npm").rglob("*"))) == 6
        before = snapshot(installed)
        output = io.StringIO()
        with redirect_stdout(output):
            assert runtime.main([], root=root, pins=pins) == 0
        assert "verified" in output.getvalue()
        assert snapshot(installed) == before

        def unexpected_download(_destination: Path, _pins: runtime.RuntimePins) -> None:
            raise AssertionError("an already verified runtime must not download again")

        runtime.apply_runtime(root, pins, downloader=unexpected_download)
        assert snapshot(installed) == before


def test_missing_verify_only_is_read_only_and_wsl_isolated() -> None:
    with tempfile.TemporaryDirectory(prefix="qa-runtime-isolation-") as temporary:
        root = Path(temporary) / "checkout"
        root.mkdir()
        write_config(root, runtime.DEFAULT_PINS)
        profile = Path(temporary) / "wsl-profile"
        before = snapshot(root)
        errors = io.StringIO()
        with redirect_stderr(errors):
            assert runtime.main([], root=root) == 1
        assert "toolchains directory is missing" in errors.getvalue()
        assert snapshot(root) == before

        archive = Path(temporary) / "fixture.tar.xz"
        write_archive(archive, fixture_entries())
        pins = fixture_pins(archive)
        write_config(root, pins)

        def fetch(destination: Path, _pins: runtime.RuntimePins) -> None:
            shutil.copyfile(archive, destination)

        with patch.dict(os.environ, {"OPENCODE_WSL2_PILOT_DIR": str(profile), "OPENCODE_WSL2_CONFIG_DIR": str(profile / "config")}):
            runtime.apply_runtime(root, pins, downloader=fetch)
        assert (root / "toolchains/node/bin/node").is_file()
        assert (root / "toolchains/node/bin/npm").is_file()
        assert not profile.exists()


def test_archive_hash_mismatch_and_extract_hashes_fail_closed() -> None:
    with tempfile.TemporaryDirectory(prefix="qa-runtime-digest-") as temporary:
        root = Path(temporary)
        archive = root / "fixture.tar.xz"
        write_archive(archive, fixture_entries())
        pins = fixture_pins(archive)
        archive.write_bytes(archive.read_bytes() + b"tamper")
        expect_failure(lambda: runtime.verify_archive_digest(archive, pins), "archive hash mismatch", "SHA-256")

        write_archive(archive, fixture_entries())
        pins = fixture_pins(archive)
        wrong_node_pin = replace(pins, node_sha256="0" * 64)
        destination = root / "extract"
        destination.mkdir()
        expect_failure(
            lambda: runtime.extract_archive(archive, destination, wrong_node_pin),
            "extracted node hash mismatch",
            "Node executable SHA-256",
        )


def test_archive_rejects_traversal_links_special_files_and_duplicates() -> None:
    with tempfile.TemporaryDirectory(prefix="qa-runtime-adversarial-") as temporary:
        root = Path(temporary)
        baseline = fixture_entries()

        def rejected(extra: tuple[str, bytes | None, str, str | None], expected: str, *, remove: tuple[str, ...] = ()) -> None:
            archive = root / "bad.tar.xz"
            entries = [entry for entry in baseline if entry[0] not in remove]
            entries.append(extra)
            write_archive(archive, entries)
            try:
                runtime.validate_archive_structure(archive, runtime.DEFAULT_PINS)
            except runtime.ProvisionError as error:
                if expected not in str(error):
                    raise AssertionError(f"unsafe archive failed as {error!r}, expected {expected!r}") from error
            else:
                raise AssertionError(f"unsafe archive was accepted: {extra[0]}")

        rejected((f"{ROOT_NAME}/../../escape", b"bad", "file", None), "escapes")
        rejected(("/absolute/path", b"bad", "file", None), "escapes")
        rejected((f"{ROOT_NAME}/bin/evil", None, "symlink", "../../escape"), "approved npm alias")
        rejected((f"{ROOT_NAME}/bin/npm", None, "symlink", "../../escape"), "approved npm alias", remove=(f"{ROOT_NAME}/bin/npm",))
        rejected((f"{ROOT_NAME}/lib/node_modules/npm/linked", None, "hardlink", f"{ROOT_NAME}/bin/node"), "member type")
        rejected((f"{ROOT_NAME}/lib/node_modules/npm/device", None, "device", None), "member type")
        rejected((f"{ROOT_NAME}/lib/node_modules/npm/pipe", None, "fifo", None), "member type")
        rejected((f"{ROOT_NAME}/bin/node", NODE_BYTES, "executable", None), "duplicate")


def test_atomic_install_never_replaces_an_existing_destination() -> None:
    with tempfile.TemporaryDirectory(prefix="qa-runtime-no-replace-") as temporary:
        root = Path(temporary)
        source = root / "stage"
        destination = root / "node"
        source.mkdir()
        destination.mkdir()
        (source / "owned").write_text("new", encoding="utf-8")
        (destination / "preserve").write_text("existing", encoding="utf-8")
        expect_failure(
            lambda: runtime._rename_noreplace(source, destination),
            "no-replace rename",
            "already exists",
        )
        assert (destination / "preserve").read_text(encoding="utf-8") == "existing"
        assert (source / "owned").read_text(encoding="utf-8") == "new"


def main() -> int:
    tests = (
        test_official_pins_and_gate_config,
        test_safe_archive_install_and_read_only_verification,
        test_missing_verify_only_is_read_only_and_wsl_isolated,
        test_archive_hash_mismatch_and_extract_hashes_fail_closed,
        test_archive_rejects_traversal_links_special_files_and_duplicates,
        test_atomic_install_never_replaces_an_existing_destination,
    )
    for test in tests:
        test()
    print("OK: QA runtime pins, read-only verification, WSL isolation, safe extraction, and no-replace install passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
