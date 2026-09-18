#!/usr/bin/env python3
"""Exercise v2 plugin deployment against disposable config directories."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("deploy-plugins.sh")
CATALOG_TOOL = Path(__file__).resolve().with_name("v2-plugin-catalog.py")
COMPUTER_USE_ROOT = SCRIPT.parent.parent
PLUGIN_ROOT = COMPUTER_USE_ROOT / "plugins-v2"
SERVER_NAMES = ["rig-tools", "rig-todo", "codex-fallback"]
CLI_NAMES = ["rig-todo", "source-control", "codex-usage", "file-manager"]
PACKAGE_ROLES = {
    "rig-tools": {"server"},
    "rig-todo": {"server", "cli"},
    "codex-fallback": {"server"},
    "source-control": {"cli"},
    "codex-usage": {"cli"},
    "file-manager": {"cli"},
}


def run(*arguments: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(SCRIPT), "--v2", *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != expected:
        raise AssertionError(
            f"expected {expected} for {arguments}, got {result.returncode}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def read_names(config_dir: Path, filename: str) -> set[str]:
    path = config_dir / filename
    if not path.exists():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return {Path(entry["package"]).name for entry in data.get("plugins", [])}


def assert_selection(config_dir: Path, server: set[str], cli: set[str]) -> None:
    if read_names(config_dir, "opencode.jsonc") != server:
        raise AssertionError(f"unexpected server selection in {config_dir}")
    if read_names(config_dir, "cli.json") != cli:
        raise AssertionError(f"unexpected cli selection in {config_dir}")


def write_config(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data) + "\n", encoding="utf-8")


def test_catalog_rejects_duplicate_package(tmp: Path) -> None:
    catalog = tmp / "duplicate-catalog.json"
    item = {
        "name": "rig-tools",
        "path": "plugins-v2/rig-tools",
        "roles": {"server": {"entrypoint": "server.ts", "config": "opencode.jsonc"}},
    }
    catalog.write_text(
        json.dumps({"version": 1, "plugins": [item, item]}) + "\n", encoding="utf-8"
    )
    result = subprocess.run(
        [
            "python3",
            str(CATALOG_TOOL),
            "--catalog",
            str(catalog),
            "--root",
            str(COMPUTER_USE_ROOT),
            "--json",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0 or "duplicate" not in result.stderr:
        raise AssertionError("catalog validator accepted a duplicate package")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="opencode-v2-deploy-") as directory:
        tmp = Path(directory)

        all_dir = tmp / "all"
        run("--config-dir", str(all_dir), "--plugins", "all", "--apply")
        assert_selection(all_dir, set(SERVER_NAMES), set(CLI_NAMES))
        before = {path.name: path.read_bytes() for path in all_dir.iterdir()}
        run("--config-dir", str(all_dir), "--plugins", "all", "--apply")
        after = {path.name: path.read_bytes() for path in all_dir.iterdir()}
        if before != after:
            raise AssertionError("idempotent deployment rewrote a config")
        run("--config-dir", str(all_dir), "--plugins", "all", "--verify-only")

        server_dir = tmp / "server"
        run("--config-dir", str(server_dir), "--plugins", "server", "--apply")
        assert_selection(server_dir, set(SERVER_NAMES), set())

        cli_dir = tmp / "cli"
        run("--config-dir", str(cli_dir), "--plugins", "cli", "--apply")
        assert_selection(cli_dir, set(), set(CLI_NAMES))

        both_dir = tmp / "both"
        run("--config-dir", str(both_dir), "--plugins", "both", "--apply")
        assert_selection(both_dir, {"codex-fallback"}, {"codex-usage"})

        for name, roles in PACKAGE_ROLES.items():
            single_dir = tmp / f"single-{name}"
            run("--config-dir", str(single_dir), "--plugins", name, "--apply")
            assert_selection(
                single_dir,
                {name} if "server" in roles else set(),
                {name} if "cli" in roles else set(),
            )

        duplicate_dir = tmp / "duplicate"
        duplicate_entry = {"package": str((PLUGIN_ROOT / "rig-tools").resolve()), "options": {}}
        write_config(
            duplicate_dir / "opencode.jsonc",
            {"plugins": [duplicate_entry, duplicate_entry]},
        )
        duplicate = run(
            "--config-dir",
            str(duplicate_dir),
            "--plugins",
            "rig-tools",
            "--verify-only",
            expected=1,
        )
        if "more than once" not in duplicate.stderr:
            raise AssertionError("duplicate v2 package was not reported")

        malformed_dir = tmp / "malformed"
        write_config(malformed_dir / "opencode.jsonc", {"plugins": [{}]})
        malformed = run(
            "--config-dir",
            str(malformed_dir),
            "--plugins",
            "rig-tools",
            "--verify-only",
            expected=1,
        )
        if "malformed" not in malformed.stderr:
            raise AssertionError("malformed v2 package entry was not reported")

        noncanonical_dir = tmp / "noncanonical"
        noncanonical_package = f"{PLUGIN_ROOT}/./rig-tools"
        write_config(
            noncanonical_dir / "opencode.jsonc",
            {"plugins": [{"package": noncanonical_package, "options": {}}]},
        )
        noncanonical = run(
            "--config-dir",
            str(noncanonical_dir),
            "--plugins",
            "rig-tools",
            "--verify-only",
            expected=1,
        )
        if "canonical" not in noncanonical.stderr:
            raise AssertionError("non-canonical v2 package path was not reported")

        wrong_role_dir = tmp / "wrong-role"
        write_config(
            wrong_role_dir / "opencode.jsonc",
            {
                "plugins": [
                    {"package": str((PLUGIN_ROOT / "source-control").resolve()), "options": {}}
                ]
            },
        )
        wrong_role = run(
            "--config-dir",
            str(wrong_role_dir),
            "--plugins",
            "source-control",
            "--verify-only",
            expected=1,
        )
        if "config not found" not in wrong_role.stderr:
            raise AssertionError("wrong-role v2 entry was not rejected")

        jsonc_dir = tmp / "jsonc"
        write_config(jsonc_dir / "opencode.jsonc", {"plugins": []})
        (jsonc_dir / "opencode.jsonc").write_text(
            '{\n  // comments are intentionally unsupported by deployment\n  "plugins": []\n}\n',
            encoding="utf-8",
        )
        jsonc = run(
            "--config-dir",
            str(jsonc_dir),
            "--plugins",
            "rig-tools",
            "--apply",
            expected=1,
        )
        if "not editable JSON" not in jsonc.stderr:
            raise AssertionError("JSONC deployment was not rejected safely")

        unknown = run(
            "--config-dir",
            str(tmp / "unknown"),
            "--plugins",
            "not-in-catalog",
            "--verify-only",
            expected=2,
        )
        if "role catalog" not in unknown.stderr:
            raise AssertionError("unknown catalog package was not rejected")

        test_catalog_rejects_duplicate_package(tmp)

    print("OK: v2 deployment self-tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
