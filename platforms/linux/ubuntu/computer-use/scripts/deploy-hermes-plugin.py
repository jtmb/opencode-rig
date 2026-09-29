#!/usr/bin/env python3
"""Verify or install the opt-in Hermes observer plugin into a Hermes profile.

Verification is the default. `--apply` copies the two checked-in plugin files
(`plugin.yaml`, `__init__.py`) into `$HERMES_HOME/plugins/open-rig-hermes-hooks`,
then re-verifies. The script never runs `hermes`, never enables a plugin, never
restarts a service, and never writes inside a git checkout. It prints
the shared `OPEN_RIG_HERMES_TELEMETRY_FILE` that both the Hermes client and the
OpenCode server/CLI must export so the writer and reader resolve one snapshot.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
COMPUTER_USE_ROOT = SCRIPT_DIR.parent
SOURCE_DIR = COMPUTER_USE_ROOT / "plugins-v2/rig-tools/hermes-plugin"
PLUGIN_NAME = "open-rig-hermes-hooks"
PLUGIN_FILES = ("plugin.yaml", "__init__.py")
EXPECTED_YAML = f"name: {PLUGIN_NAME}\n"
SNAPSHOT_FILENAME = "open-rig-hooks.snapshot.json"


class DeployError(RuntimeError):
    """Raised for a fail-closed usage or filesystem contract violation."""


def digest(path: Path) -> str:
    """Return the SHA-256 of a regular, non-symlink file."""
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise DeployError(f"not a regular non-symlink file: {path}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resolve_home(raw: str | None) -> Path:
    value = (raw or os.environ.get("HERMES_HOME", "")).strip()
    home = Path(value).expanduser() if value else Path.home() / ".hermes"
    if not home.is_absolute():
        raise DeployError("Hermes profile root must be an absolute path")
    return home


def enclosing_checkout(path: Path) -> Path | None:
    """Return the nearest ancestor that is a git checkout, if any."""
    for candidate in (path, *path.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def check_source() -> dict[str, str]:
    """Validate the checked-in plugin source and return its file digests."""
    if not SOURCE_DIR.is_dir() or SOURCE_DIR.is_symlink():
        raise DeployError(f"plugin source directory is missing or unsafe: {SOURCE_DIR}")
    digests = {}
    for name in PLUGIN_FILES:
        digests[name] = digest(SOURCE_DIR / name)
    manifest = (SOURCE_DIR / "plugin.yaml").read_text(encoding="utf-8")
    if not manifest.startswith(EXPECTED_YAML):
        raise DeployError(f"plugin source is not {PLUGIN_NAME}: {SOURCE_DIR}")
    return digests


def check_target_root(home: Path) -> None:
    """Fail closed on a symlinked root or one inside any git checkout."""
    if os.path.islink(home):
        raise DeployError(f"refusing symlinked Hermes profile root: {home}")
    if home.exists() and not home.is_dir():
        raise DeployError(f"Hermes profile root is not a directory: {home}")
    checkout = enclosing_checkout(home.resolve())
    if checkout is not None:
        raise DeployError(
            f"refusing to write inside a repository checkout ({checkout}): {home}"
        )


def check_target_dir(target: Path) -> None:
    """Fail closed on a symlinked or non-directory plugin path."""
    if os.path.islink(target):
        raise DeployError(f"refusing symlinked plugin directory: {target}")
    if target.exists() and not target.is_dir():
        raise DeployError(f"plugin path is not a directory: {target}")


def file_state(target: Path, name: str, expected: str) -> str:
    path = target / name
    if os.path.islink(path):
        return "unsafe"
    if not path.exists():
        return "missing"
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode):
        return "unsafe"
    return "present" if digest(path) == expected else "stale"


def telemetry_path(home: Path, override: str | None) -> Path:
    value = (override or "").strip()
    path = Path(value).expanduser() if value else home / "logs" / SNAPSHOT_FILENAME
    if not path.is_absolute():
        raise DeployError("telemetry path must be absolute")
    return path


def write_atomic(path: Path, payload: bytes, mode: int) -> None:
    directory = path.parent
    descriptor, temporary = tempfile.mkstemp(prefix=".deploy-hermes-", dir=directory)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply_files(target: Path, source: Path) -> list[str]:
    """Install changed files atomically; return the names actually written."""
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    written = []
    for name in PLUGIN_FILES:
        destination = target / name
        origin = source / name
        if os.path.islink(destination):
            raise DeployError(f"refusing symlinked plugin file: {destination}")
        if destination.exists() and digest(destination) == digest(origin):
            continue
        write_atomic(destination, origin.read_bytes(), 0o644)
        written.append(name)
    return written


def report(target: Path, expected: dict[str, str], telemetry: Path) -> bool:
    """Print per-file status; return True only when every file is current."""
    healthy = True
    for name in PLUGIN_FILES:
        state = file_state(target, name, expected[name])
        if state == "present":
            print(f"OK: {name} is current at {target / name}")
        else:
            healthy = False
            print(f"MISSING/STALE: {name} is {state} at {target / name}", file=sys.stderr)
    if not healthy:
        print(
            "MISSING/STALE: run this script with --apply, then "
            f"`hermes plugins enable {PLUGIN_NAME}`",
            file=sys.stderr,
        )
    print(f"OPEN_RIG_HERMES_TELEMETRY_FILE={telemetry}")
    print(
        "  Export the path above as OPEN_RIG_HERMES_TELEMETRY_FILE in BOTH the "
        "Hermes profile environment"
    )
    print(
        "  and the OpenCode server/CLI environment, then start Hermes; the "
        f"snapshot is {telemetry}"
    )
    return healthy


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-home", help="Hermes profile root (default: $HERMES_HOME or ~/.hermes)")
    parser.add_argument("--telemetry-file", help="Shared snapshot path to print (default: ROOT/logs/<file>)")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Install or repair the two plugin files")
    mode.add_argument("--verify-only", action="store_true", help="Check only (default)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        home = resolve_home(args.hermes_home)
        check_target_root(home)
        telemetry = telemetry_path(home, args.telemetry_file)
        expected = check_source()
        target = home / "plugins" / PLUGIN_NAME
        check_target_dir(target)
        if args.apply:
            written = apply_files(target, SOURCE_DIR)
            if written:
                print(f"OK: installed {', '.join(written)} into {target}")
            else:
                print(f"OK: {PLUGIN_NAME} is already current in {target}")
        healthy = report(target, expected, telemetry)
    except DeployError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    return 0 if healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
