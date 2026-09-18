#!/usr/bin/env python3
"""Verify that local plugin and custom-tool checks use the adaptive resource guard."""

from __future__ import annotations

import json
import sys
from pathlib import Path


GUARD = "run-bounded-command.sh"
REQUIRED_SCRIPTS = ("typecheck", "test")


def package_paths(root: Path) -> list[Path]:
    computer_use = root / "platforms/linux/ubuntu/computer-use"
    plugin_root = computer_use / "plugins"
    v2_root = computer_use / "plugins-v2"
    tools_package = computer_use / "tools/package.json"
    return (
        sorted(plugin_root.glob("*/package.json"))
        + sorted(v2_root.glob("*/package.json"))
        + [tools_package]
    )


def main() -> int:
    root = Path(__file__).resolve().parents[5]
    failures: list[str] = []
    checked = 0

    for package_path in package_paths(root):
        checked += 1
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            failures.append(f"{package_path}: missing package metadata")
            continue
        except (OSError, ValueError) as exc:
            failures.append(f"{package_path}: cannot read JSON ({exc})")
            continue
        scripts = package.get("scripts")
        if not isinstance(scripts, dict):
            failures.append(f"{package_path}: missing scripts object")
            continue
        for script_name in REQUIRED_SCRIPTS:
            command = scripts.get(script_name)
            if not isinstance(command, str) or GUARD not in command:
                failures.append(f"{package_path}: {script_name} must use {GUARD}")

    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    print(f"OK: resource guards present in {checked} local packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
