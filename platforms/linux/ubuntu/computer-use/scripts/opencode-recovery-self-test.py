#!/usr/bin/env python3
"""Run the focused unittest suite for the OpenCode recovery CLI."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


def main() -> int:
    """Discover and run only the recovery CLI's fixture-backed tests."""
    test_directory = Path(__file__).resolve().parent / "tests"
    suite = unittest.defaultTestLoader.discover(
        str(test_directory), pattern="test_opencode_recovery.py"
    )
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
