#!/usr/bin/env python3
"""Exercise the resource guard without risking the parent process."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def main() -> int:
    root = Path(__file__).resolve().parents[5]
    wrapper = root / "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh"
    checker = root / "platforms/linux/ubuntu/computer-use/scripts/check-plugin-resource-guards.py"

    metadata = run([sys.executable, str(checker)])
    if metadata.returncode != 0:
        sys.stderr.write(metadata.stderr or metadata.stdout)
        return 1

    budget = run([str(wrapper), "--print-budget"])
    if budget.returncode != 0:
        if "refusing an unsafe check" in budget.stderr:
            print("OK: guard fails closed when the adaptive budget is too small")
            return 0
        sys.stderr.write(budget.stderr or budget.stdout)
        return 1
    if "memory_budget_bytes=" not in budget.stdout:
        print("ERROR: --print-budget did not report a memory budget", file=sys.stderr)
        return 1

    started = time.monotonic()
    child = run(
        [
            str(wrapper),
            "--timeout",
            "1s",
            "--",
            sys.executable,
            "-c",
            "import time; time.sleep(5)",
        ]
    )
    elapsed = time.monotonic() - started
    if child.returncode == 0 or elapsed > 10:
        print("ERROR: bounded timeout child did not terminate safely", file=sys.stderr)
        sys.stderr.write(child.stderr)
        return 1

    print(f"OK: bounded child terminated without killing its parent (exit={child.returncode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
