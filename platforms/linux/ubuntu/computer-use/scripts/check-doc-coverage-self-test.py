#!/usr/bin/env python3
"""Isolated tests for the documentation coverage gate.

Runs the real checker CLI against temporary fixture trees and maps, proving that
missing documentation, undocumented changes, and new artifacts are rejected, and
that compliant changes and the explicit exemption are accepted.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

CHECKER = Path(__file__).resolve().parent / "check-doc-coverage.py"
BR = "platforms/linux/ubuntu/computer-use"

FIXTURE_MAP = {
    "version": 1,
    "rules": [
        {
            "name": "scripts-exceptions",
            "match": [f"{BR}/scripts/alpha-self-test.py"],
            "docs": ["docs/scripts/alpha-shared.md"],
        },
        {
            "name": "scripts",
            "match": [f"{BR}/scripts/*.sh", f"{BR}/scripts/*.py"],
            "docs": ["docs/scripts/{stem}.md"],
            "onAdd": ["docs/scripts/README.md"],
        },
        {
            "name": "plugins",
            "match": [f"{BR}/plugins/*/**"],
            "docs": [f"docs/plugins/{{plugin}}.md", f"{BR}/plugins/{{plugin}}/README.md"],
            "onAdd": ["docs/plugins/README.md"],
        },
        {
            "name": "skills",
            "match": [f"{BR}/skills/*/**"],
            "docs": [f"{BR}/skills/{{skill}}/README.md", f"{BR}/skills/README.md"],
        },
    ],
    "additional": [
        {
            "name": "handoff",
            "match": [f"{BR}/scripts/alpha.sh"],
            "docs": ["HANDOFF.md"],
        }
    ],
}

FILES = [
    f"{BR}/scripts/alpha.sh",
    f"{BR}/scripts/alpha-self-test.py",
    "docs/scripts/alpha.md",
    "docs/scripts/alpha-shared.md",
    "docs/scripts/README.md",
    f"{BR}/plugins/widget/src/index.ts",
    f"{BR}/plugins/widget/README.md",
    "docs/plugins/widget.md",
    "docs/plugins/README.md",
    f"{BR}/skills/demo/SKILL.md",
    f"{BR}/skills/demo/README.md",
    f"{BR}/skills/README.md",
    "docs/README.md",
    "HANDOFF.md",
]


def write(root: Path, relative: str, text: str = "x\n") -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run(root: Path, map_path: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CHECKER), "--root", str(root), "--map", str(map_path), *args],
        capture_output=True,
        text=True,
    )


def expect(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(f"unexpected result: {label}")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="doc-coverage-self-test-") as tmp:
        root = Path(tmp)
        for relative in FILES:
            write(root, relative)
        map_path = root / "documentation-map.json"
        map_path.write_text(json.dumps(FIXTURE_MAP), encoding="utf-8")

        cases = 0

        result = run(root, map_path)
        expect(result.returncode == 0, f"baseline completeness should pass: {result.stderr}")
        cases += 1

        alpha_doc = root / "docs/scripts/alpha.md"
        alpha_text = alpha_doc.read_text(encoding="utf-8")
        alpha_doc.unlink()
        result = run(root, map_path)
        expect(result.returncode == 1 and "missing documentation" in result.stderr,
               "missing mapped documentation must fail")
        cases += 1
        alpha_doc.write_text(alpha_text, encoding="utf-8")

        result = run(root, map_path, "--changed-file", f"{BR}/scripts/alpha.sh")
        expect(result.returncode == 1, "changed source without a doc change must fail")
        cases += 1

        result = run(
            root, map_path,
            "--changed-file", f"{BR}/scripts/alpha.sh",
            "--changed-file", "docs/scripts/alpha.md",
        )
        expect(result.returncode == 1 and "handoff" in result.stderr,
               "an additional rule must also be satisfied")
        cases += 1

        result = run(
            root, map_path,
            "--changed-file", f"{BR}/scripts/alpha.sh",
            "--changed-file", "docs/scripts/alpha.md",
            "--changed-file", "HANDOFF.md",
        )
        expect(result.returncode == 0, "changed source with its doc and handoff change must pass")
        cases += 1

        result = run(root, map_path, "--changed-file", f"{BR}/scripts/alpha.sh", "--exempt")
        expect(result.returncode == 0 and "exempted" in result.stderr,
               "--exempt must bypass the change-aware check")
        cases += 1

        result = run(root, map_path, "--changed-file", f"{BR}/skills/demo/SKILL.md")
        expect(result.returncode == 1, "skill source change without a doc change must fail")
        cases += 1

        result = run(
            root, map_path,
            "--changed-file", f"{BR}/skills/demo/SKILL.md",
            "--changed-file", f"{BR}/skills/demo/README.md",
        )
        expect(result.returncode == 0, "skill change with its README change must pass")
        cases += 1

        result = run(root, map_path, "--changed-file", f"{BR}/plugins/widget/src/index.ts")
        expect(result.returncode == 1, "plugin source change without a doc change must fail")
        cases += 1

        result = run(
            root, map_path,
            "--changed-file", f"{BR}/plugins/widget/src/index.ts",
            "--changed-file", "docs/plugins/widget.md",
        )
        expect(result.returncode == 0, "plugin change with its doc change must pass")
        cases += 1

        write(root, f"{BR}/scripts/beta.sh")
        write(root, "docs/scripts/beta.md")
        result = run(
            root, map_path,
            "--added-file", f"{BR}/scripts/beta.sh",
            "--added-file", "docs/scripts/beta.md",
        )
        expect(result.returncode == 1 and "new entry" in result.stderr,
               "a new script must also update the script index")
        cases += 1

        result = run(
            root, map_path,
            "--added-file", f"{BR}/scripts/beta.sh",
            "--added-file", "docs/scripts/beta.md",
            "--changed-file", "docs/scripts/README.md",
        )
        expect(result.returncode == 0, "a new script with its doc and index update must pass")
        cases += 1

        write(root, f"{BR}/scripts/gamma.sh")
        result = run(root, map_path)
        expect(result.returncode == 1 and "gamma.md" in result.stderr,
               "a new script without any documentation must fail completeness")
        cases += 1
        (root / f"{BR}/scripts/gamma.sh").unlink()

        result = run(root, map_path, "--json")
        expect(result.returncode == 0 and json.loads(result.stdout)["ok"] is True,
               "--json output should report success")
        cases += 1

    print(f"OK: documentation coverage gate negative coverage passed for {cases} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
