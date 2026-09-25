#!/usr/bin/env python3
"""Exercise the repository plugin dependency verifier in disposable profiles."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[5]
SCRIPT = ROOT / "platforms/linux/ubuntu/computer-use/scripts/setup-plugin-dependencies.sh"
RUNNER = ROOT / "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh"
WORKSPACE = ROOT / "platforms/linux/ubuntu/computer-use/plugins-v2"
ADAPTER = WORKSPACE / "ponytail-adapter"


def run(script: Path, *arguments: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(script), *arguments],
        cwd=script.parent,
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )


def copy_fixture(root: Path) -> Path:
    scripts = root / "platforms/linux/ubuntu/computer-use/scripts"
    plugins = root / "platforms/linux/ubuntu/computer-use/plugins-v2"
    adapter = plugins / "ponytail-adapter"
    scripts.mkdir(parents=True)
    adapter.mkdir(parents=True)
    (adapter / "scripts").mkdir()
    shutil.copy2(SCRIPT, scripts / SCRIPT.name)
    shutil.copy2(RUNNER, scripts / RUNNER.name)
    shutil.copy2(WORKSPACE / "package.json", plugins / "package.json")
    shutil.copy2(WORKSPACE / "package-lock.json", plugins / "package-lock.json")
    shutil.copy2(ADAPTER / "package.json", adapter / "package.json")
    shutil.copytree(ADAPTER / "src", adapter / "src")
    shutil.copy2(ADAPTER / "scripts/verify-package.mjs", adapter / "scripts/verify-package.mjs")
    return scripts / SCRIPT.name


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="open-rig-plugin-dependencies-") as temporary:
        root = Path(temporary)
        home = root / "home"
        home.mkdir()
        env = {**os.environ, "HOME": str(home)}

        verified = run(SCRIPT, "--verify-only", env=env)
        if verified.returncode != 0 or "six commands" not in verified.stdout:
            raise AssertionError(f"installed canonical dependency verification failed:\n{verified.stdout}\n{verified.stderr}")
        if str(home) in verified.stdout or ".local/opt/opencode-ponytail" in verified.stdout:
            raise AssertionError("canonical dependency verification used HOME-based Ponytail state")

        fixture_root = root / "missing"
        fixture_script = copy_fixture(fixture_root)
        missing_env = {**env, "PATH": os.environ["PATH"]}
        missing = run(fixture_script, "--verify-only", env=missing_env)
        if missing.returncode == 0 or "pinned official" not in missing.stderr:
            raise AssertionError(f"missing dependency did not fail closed:\n{missing.stdout}\n{missing.stderr}")

        fake_bin = root / "fake-bin"
        fake_bin.mkdir()
        invocation = root / "npm-invocation.txt"
        fake_npm = fake_bin / "npm"
        fake_npm.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            f"pathlib.Path({str(invocation)!r}).write_text(' '.join(sys.argv[1:]), encoding='utf-8')\n",
            encoding="utf-8",
        )
        fake_npm.chmod(0o755)
        applied = run(fixture_script, "--apply", env={**missing_env, "PATH": f"{fake_bin}:{os.environ['PATH']}"})
        if applied.returncode == 0 or not invocation.is_file():
            raise AssertionError("apply did not fail closed after the bounded fake install")
        command = invocation.read_text(encoding="utf-8")
        if command != "ci --ignore-scripts --no-audit --no-fund":
            raise AssertionError(f"unexpected dependency install command: {command!r}")

    print("OK: plugin dependency verification, missing-package failure, and bounded apply planning passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
