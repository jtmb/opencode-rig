#!/usr/bin/env python3
"""Validate WSL ownership while allowing intentional canonical delegation."""

from __future__ import annotations

import os
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
CANONICAL_ROOT = (ROOT.parents[3] / "linux" / "ubuntu" / "computer-use").resolve()
CHECK_SUFFIXES = {".json", ".jsonc", ".ts", ".tsx", ".js", ".py", ".sh", ".ps1", ".psm1"}
SHARED_MARKER = "platforms/linux/ubuntu/computer-use"
SHARED_NAMES = {
    "basic-memory-mcp.sh",
    "playwright-mcp.sh",
    "mcp-versions.json",
}
DEVELOPER_HOME = re.compile(r"/(?:home|Users)/[^/\s'\"]+(?:/[^\s'\"`),;\]]*)*")


def scan(root: Path = ROOT, canonical_root: Path = CANONICAL_ROOT) -> list[str]:
    """Return ownership-boundary violations without following any symlink."""
    failures: list[str] = []
    root = root.resolve()
    canonical_root = canonical_root.resolve()
    for directory, names, files in os.walk(root, followlinks=False):
        current = Path(directory)
        names[:] = [name for name in names if name not in {"node_modules", "__pycache__"}]
        retained: list[str] = []
        for name in names:
            path = current / name
            if path.is_symlink():
                failures.append(f"symlink is not allowed: {path.relative_to(root)}")
            else:
                retained.append(name)
        names[:] = retained
        for name in files:
            path = current / name
            if path.is_symlink():
                failures.append(f"symlink is not allowed: {path.relative_to(root)}")
                continue
            if path.name in SHARED_NAMES:
                failures.append(f"generic MCP implementation is duplicated in WSL: {path.relative_to(root)}")
            if path.suffix not in CHECK_SUFFIXES:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as error:
                failures.append(f"cannot read {path.relative_to(root)}: {error}")
                continue
            for match in DEVELOPER_HOME.finditer(text):
                value = match.group(0).rstrip("'\" )],;.")
                if not _is_canonical_reference(value, canonical_root):
                    failures.append(f"developer-specific absolute path {value!r}: {path.relative_to(root)}")
    return failures


def _is_canonical_reference(value: str, canonical_root: Path) -> bool:
    """Permit only an absolute path that remains below the canonical root."""
    try:
        candidate = Path(value.rstrip("/ "))
        return candidate == canonical_root or canonical_root in candidate.parents
    except (OSError, RuntimeError):
        return False


def main() -> int:
    failures = scan()
    if failures:
        print("\n".join(f"ERROR: {failure}" for failure in failures), file=sys.stderr)
        return 1
    print("OK: WSL ownership boundary permits only canonical Ubuntu delegation and WSL-specific code")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
