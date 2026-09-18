#!/usr/bin/env python3
"""Negative tests for the mandatory progress-tracking gate.

Builds temporary fixture trees, runs the real `check-progress-tracking.py`
CLI against them, and proves it rejects a missing or gutted rule surface while
accepting a compliant one.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

AGENTS = """# AGENTS.md fixture

## Progress Tracking

- Track work with the todo tool: keep exactly one item in_progress and mark an
  item completed only after its verification passes.
"""

AGENTS_WITHOUT_MARKER = AGENTS.replace("in_progress", "running")

RESUME = """Resume steps.

6. Track the resumed work with the todo tool.
"""

HANDOFF = """Prompt.

- Track multi-step work with the todo tool.
"""


def build(root: Path, agents: str = AGENTS, resume: str = RESUME, handoff: str = HANDOFF) -> None:
    (root / "AGENTS.md").write_text(agents, encoding="utf-8")
    (root / "HANDOFF.md").write_text(handoff, encoding="utf-8")
    commands = root / "platforms/linux/ubuntu/computer-use/commands"
    commands.mkdir(parents=True, exist_ok=True)
    (commands / "resume.md").write_text(resume, encoding="utf-8")


def run(checker: Path, root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(checker), "--root", str(root)],
        capture_output=True,
        text=True,
        check=False,
    )


def main() -> int:
    checker = Path(__file__).resolve().parent / "check-progress-tracking.py"
    cases = [
        ("compliant fixture", {}, 0),
        ("missing AGENTS section", {"agents": "# AGENTS.md fixture\n"}, 1),
        ("AGENTS section without in_progress", {"agents": AGENTS_WITHOUT_MARKER}, 1),
        ("resume without todo", {"resume": "Resume steps.\n"}, 1),
        ("handoff without todo", {"handoff": "Prompt.\n"}, 1),
    ]

    with tempfile.TemporaryDirectory(prefix="progress-gate-") as tmp:
        base = Path(tmp)
        for index, (name, mutation, expected) in enumerate(cases, start=1):
            case_root = base / f"case-{index}"
            case_root.mkdir()
            build(case_root, **mutation)
            result = run(checker, case_root)
            if result.returncode != expected:
                print(
                    f"ERROR: {name}: expected exit {expected}, got {result.returncode}",
                    file=sys.stderr,
                )
                sys.stderr.write(result.stderr or result.stdout)
                return 1

    print(f"OK: progress-tracking gate rejects {len(cases) - 1} invalid fixtures and accepts the compliant one")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
