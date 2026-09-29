#!/usr/bin/env python3
"""Enforce that the indexed progress-tracking rule stays present and wired.

The repository requires multi-step work to be tracked with the todo tool.
That rule only works while the operating surfaces that define it stay
current, so this gate fails when any of them drops the requirement:

- the policy link in the root `AGENTS.md` index,
- the `## Work and progress` section in `docs/agent-policy.md`,
- the progress step in the `/resume` command,
- the operating expectation in the `HANDOFF.md` copy-paste prompt.

It checks for required markers, not exact sentences, so the rule text can be
reworded without breaking the gate. It proves the rule is present; it cannot
observe whether a session actually used the todo tool.

Read-only: this script never writes to the repository.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

AGENTS_POLICY_LINK = "(docs/agent-policy.md)"
POLICY_HEADING = "## Work and progress"
POLICY_MARKERS = ("todo tool", "in_progress", "completed", "roadmap.md")
RESUME_MARKERS = ("todo",)
HANDOFF_MARKERS = ("todo tool",)


def section_body(text: str, heading: str) -> str | None:
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == heading:
            start = index + 1
            break
    if start is None:
        return None
    body: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        body.append(line)
    return "\n".join(body)


def require_markers(path: Path, root: Path, markers: tuple[str, ...]) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"{path.relative_to(root)}: cannot read ({exc})"]
    lowered = text.lower()
    return [
        f"{path.relative_to(root)} must mention '{marker}'"
        for marker in markers
        if marker.lower() not in lowered
    ]


def check_root(root: Path) -> list[str]:
    failures: list[str] = []

    failures.extend(require_markers(root / "AGENTS.md", root, (AGENTS_POLICY_LINK,)))

    policy = root / "docs/agent-policy.md"
    try:
        policy_text = policy.read_text(encoding="utf-8")
    except OSError as exc:
        failures.append(f"{policy.relative_to(root)}: cannot read ({exc})")
    else:
        body = section_body(policy_text, POLICY_HEADING)
        if body is None:
            failures.append(f"{policy.relative_to(root)}: missing '{POLICY_HEADING}' section")
        else:
            lowered = body.lower()
            failures.extend(
                f"{policy.relative_to(root)}: progress section must mention '{marker}'"
                for marker in POLICY_MARKERS
                if marker.lower() not in lowered
            )

    failures.extend(
        require_markers(
            root / "platforms/linux/ubuntu/computer-use/commands/resume.md",
            root,
            RESUME_MARKERS,
        )
    )
    failures.extend(require_markers(root / "HANDOFF.md", root, HANDOFF_MARKERS))
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=None,
        help="repository root (default: this script's repository)",
    )
    args = parser.parse_args()
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[5]

    failures = check_root(root)
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    print("OK: progress tracking indexed in AGENTS.md and present in agent policy, /resume, and HANDOFF.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
