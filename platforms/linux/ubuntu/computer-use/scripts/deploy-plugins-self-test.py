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
SERVER_NAMES = ["orchestration-policy", "git-tool", "integrated-browser", "repo-learning", "rig-tools", "rig-todo", "codex-fallback"]
CLI_NAMES = ["rig-tools", "rig-todo", "repo-learning", "source-control", "codex-usage", "file-manager", "integrated-browser", "resource-monitor"]
PACKAGE_ROLES = {
    "orchestration-policy": {"server"},
    "git-tool": {"server"},
    "integrated-browser": {"server", "cli"},
    "repo-learning": {"server", "cli"},
    "rig-tools": {"server", "cli"},
    "rig-todo": {"server", "cli"},
    "codex-fallback": {"server"},
    "source-control": {"cli"},
    "codex-usage": {"cli"},
    "file-manager": {"cli"},
    "resource-monitor": {"cli"},
}


def run(*arguments: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(SCRIPT), *arguments],
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
    data = load_jsonc(path)
    return {Path(entry["package"]).name for entry in data.get("plugins", [])}


def load_jsonc(path: Path) -> object:
    text = path.read_text(encoding="utf-8")
    cleaned = []
    i = 0
    quoted = False
    escaped = False
    while i < len(text):
        char = text[i]
        if quoted:
            cleaned.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            i += 1
        elif char == '"':
            quoted = True; cleaned.append(char); i += 1
        elif text.startswith("//", i):
            end = text.find("\n", i + 2); i = len(text) if end < 0 else end
        elif text.startswith("/*", i):
            end = text.find("*/", i + 2)
            if end < 0: raise ValueError("unterminated comment")
            i = end + 2
        else:
            cleaned.append(char); i += 1
    compact = "".join(cleaned)
    compact = compact.replace(",\n}", "\n}").replace(",\n]", "\n]")
    return json.loads(compact)


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
        if load_jsonc(all_dir / "cli.json")["session"]["permissions"] != "prompt":
            raise AssertionError("rig-tools deployment did not enable prompt permissions")
        orchestration = next(
            entry for entry in load_jsonc(all_dir / "opencode.jsonc")["plugins"]
            if Path(entry["package"]).name == "orchestration-policy"
        )
        if orchestration["options"].get("maxConcurrent") != 3 or orchestration["options"].get("backgroundOnly") is not True:
            raise AssertionError("orchestration policy defaults were not deployed")
        server_dir = tmp / "server"
        run("--config-dir", str(server_dir), "--plugins", "server", "--apply")
        assert_selection(server_dir, set(SERVER_NAMES), set())

        cli_dir = tmp / "cli"
        run("--config-dir", str(cli_dir), "--plugins", "cli", "--apply")
        assert_selection(cli_dir, set(), set(CLI_NAMES))

        split_dir = tmp / "split"
        split_cli = tmp / "split-xdg" / "opencode" / "cli.json"
        run(
            "--config-dir", str(split_dir),
            "--cli-config", str(split_cli),
            "--plugins", "rig-tools",
            "--apply",
        )
        if read_names(split_dir, "opencode.jsonc") != {"rig-tools"}:
            raise AssertionError("split deployment omitted the rig-tools server role")
        split_cli_data = load_jsonc(split_cli)
        if {Path(entry["package"]).name for entry in split_cli_data["plugins"]} != {"rig-tools"}:
            raise AssertionError("split deployment omitted the rig-tools CLI role")
        if split_cli_data.get("session", {}).get("permissions") != "prompt":
            raise AssertionError("split deployment omitted CLI prompt permissions")
        if (split_dir / "cli.json").exists():
            raise AssertionError("split deployment wrote a duplicate CLI config")

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
        jsonc_dir.mkdir()
        (jsonc_dir / "opencode.jsonc").write_text(
            '{\n  "description": "https://example.test/* not a comment // nor this",\n'
            '  /* keep semantic settings */\n  "plugins": [],\n}\n',
            encoding="utf-8",
        )
        original = (jsonc_dir / "opencode.jsonc").read_bytes()
        run(
            "--config-dir",
            str(jsonc_dir),
            "--plugins",
            "rig-tools",
            "--verify-only",
            expected=1,
        )
        if (jsonc_dir / "opencode.jsonc").read_bytes() != original:
            raise AssertionError("verify-only rewrote JSONC")
        os.chmod(jsonc_dir / "opencode.jsonc", 0o600)
        run("--config-dir", str(jsonc_dir), "--plugins", "rig-tools", "--apply")
        if (jsonc_dir / "opencode.jsonc").stat().st_mode & 0o777 != 0o600:
            raise AssertionError("config mode was not preserved")
        if load_jsonc(jsonc_dir / "opencode.jsonc")["description"] != "https://example.test/* not a comment // nor this":
            raise AssertionError("string comment markers were corrupted")
        if list(jsonc_dir.glob(".deploy.*")):
            raise AssertionError("temporary deployment file leaked")

        malformed_dir = tmp / "malformed-jsonc"
        malformed_dir.mkdir()
        (malformed_dir / "opencode.jsonc").write_text('{"plugins": [}', encoding="utf-8")
        malformed = run("--config-dir", str(malformed_dir), "--plugins", "rig-tools", "--apply", expected=1)
        if "could not be updated" not in malformed.stderr:
            raise AssertionError("malformed JSONC was not rejected")

        duplicate_key_dir = tmp / "duplicate-key"
        duplicate_key_dir.mkdir()
        (duplicate_key_dir / "opencode.jsonc").write_text(
            '{"plugins": [], "plugins": []}', encoding="utf-8"
        )
        duplicate_key = run("--config-dir", str(duplicate_key_dir), "--plugins", "rig-tools", "--apply", expected=1)
        if "could not be updated" not in duplicate_key.stderr:
            raise AssertionError("duplicate JSONC key was not rejected")

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
