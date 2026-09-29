#!/usr/bin/env python3
"""Exercise the Hermes observer deployment script against disposable profiles.

The real CLI runs as a subprocess. The tests prove read-only verification,
idempotent install, stale repair, symlink/repository refusal, shared telemetry
path printing, and mode/hash fidelity. They never touch a real Hermes profile.
"""

from __future__ import annotations

import hashlib
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("deploy-hermes-plugin.py")
SOURCE = SCRIPT.parent.parent / "plugins-v2/rig-tools/hermes-plugin"
REPOSITORY_ROOT = SCRIPT.parent.parents[4]
PLUGIN_RELATIVE = Path("plugins/open-rig-hermes-hooks")
FILES = ("plugin.yaml", "__init__.py")

CHECKS = 0


def check(condition: bool, message: str) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(message)


def run(*arguments: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_digests() -> dict[str, str]:
    return {name: sha256(SOURCE / name) for name in FILES}


def test_missing_profile(tmp: Path) -> None:
    home = tmp / "missing"
    result = run("--hermes-home", str(home))
    check(result.returncode == 1, f"missing profile must verify non-zero, got {result.returncode}")
    check("MISSING/STALE" in result.stderr, "missing profile did not report stale state")
    check(f"OPEN_RIG_HERMES_TELEMETRY_FILE={home / 'logs' / 'open-rig-hooks.snapshot.json'}" in result.stdout,
          "shared telemetry path was not printed")
    check("hermes plugins enable open-rig-hermes-hooks" in result.stderr,
          "required enable command was not printed")
    check(not (home / "plugins").exists(), "verify-only created the target directory")


def test_apply_idempotent_verify(tmp: Path) -> None:
    home = tmp / "apply"
    expected = source_digests()
    first = run("--hermes-home", str(home), "--apply")
    check(first.returncode == 0, f"apply failed: {first.stderr}")
    target = home / PLUGIN_RELATIVE
    for name in FILES:
        installed = target / name
        check(installed.is_file(), f"{name} was not installed")
        check(sha256(installed) == expected[name], f"{name} does not match the source")
        check(stat.S_IMODE(installed.stat().st_mode) == 0o644, f"{name} mode is not 0644")
        check(not installed.is_symlink(), f"{name} is a symlink")
    check(stat.S_IMODE(target.stat().st_mode) == 0o700, "plugin directory mode is not 0700")

    before = {name: (target / name).stat().st_ino for name in FILES}
    second = run("--hermes-home", str(home), "--apply")
    check(second.returncode == 0, "second apply failed")
    check("already current" in second.stdout, "second apply was not idempotent")
    check(before == {name: (target / name).stat().st_ino for name in FILES},
          "idempotent apply rewrote an unchanged file")

    verify = run("--hermes-home", str(home), "--verify-only")
    check(verify.returncode == 0, f"verify after apply failed: {verify.stderr}")
    check(verify.stdout.count("OK:") >= len(FILES), "verify did not report each file")


def test_stale_repair(tmp: Path) -> None:
    home = tmp / "stale"
    run("--hermes-home", str(home), "--apply")
    target = home / PLUGIN_RELATIVE / "plugin.yaml"
    target.write_text("name: open-rig-hermes-hooks\nversion: \"9.9.9\"\n", encoding="utf-8")
    check(run("--hermes-home", str(home)).returncode == 1, "stale file verified clean")
    check(run("--hermes-home", str(home), "--apply").returncode == 0, "stale repair failed")
    check(sha256(target) == source_digests()["plugin.yaml"], "stale file was not repaired")


def test_symlink_refusal(tmp: Path) -> None:
    home = tmp / "symlink-file"
    run("--hermes-home", str(home), "--apply")
    target = home / PLUGIN_RELATIVE
    linked = target / "plugin.yaml"
    linked.unlink()
    linked.symlink_to(SOURCE / "plugin.yaml")
    check(run("--hermes-home", str(home)).returncode == 1, "symlinked file verified clean")
    check(run("--hermes-home", str(home), "--apply").returncode == 2, "symlinked file was replaced")
    check(linked.is_symlink(), "apply did not refuse the symlinked file")

    dir_home = tmp / "symlink-dir"
    plugin_dir = dir_home / PLUGIN_RELATIVE
    plugin_dir.parent.mkdir(parents=True)
    plugin_dir.symlink_to(SOURCE)
    check(run("--hermes-home", str(dir_home), "--apply").returncode == 2,
          "symlinked plugin directory was accepted")


def test_argument_refusals(tmp: Path) -> None:
    check(run("--hermes-home", "relative/profile").returncode == 2, "relative profile was accepted")
    check(run("--hermes-home", str(REPOSITORY_ROOT)).returncode == 2,
          "repository checkout was accepted as a profile root")
    fake_checkout = tmp / "fake-checkout"
    (fake_checkout / ".git").mkdir(parents=True)
    check(run("--hermes-home", str(fake_checkout / "profile"), "--apply").returncode == 2,
          "profile nested inside a git checkout was accepted")
    check(run("--hermes-home", str(tmp / "x"), "--telemetry-file", "logs/rel.json").returncode == 2,
          "relative telemetry override was accepted")
    override = tmp / "shared" / "snapshot.json"
    result = run("--hermes-home", str(tmp / "y"), "--telemetry-file", str(override))
    check(f"OPEN_RIG_HERMES_TELEMETRY_FILE={override}" in result.stdout,
          "absolute telemetry override was not printed")
    check(run("--apply", "--verify-only").returncode == 2, "conflicting modes were accepted")


def test_env_resolution(tmp: Path) -> None:
    home = tmp / "env-home"
    env = dict(os.environ, HERMES_HOME=str(home))
    result = run("--apply", env=env)
    check(result.returncode == 0, f"HERMES_HOME resolution failed: {result.stderr}")
    check((home / PLUGIN_RELATIVE / "__init__.py").is_file(), "HERMES_HOME target was not installed")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="deploy-hermes-plugin-") as directory:
        tmp = Path(directory)
        test_missing_profile(tmp)
        test_apply_idempotent_verify(tmp)
        test_stale_repair(tmp)
        test_symlink_refusal(tmp)
        test_argument_refusals(tmp)
        test_env_resolution(tmp)
    print(f"OK: {CHECKS} deploy-hermes-plugin self-tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
