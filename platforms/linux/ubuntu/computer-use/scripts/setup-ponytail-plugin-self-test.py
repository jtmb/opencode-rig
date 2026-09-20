#!/usr/bin/env python3
"""Exercise Ponytail activation and rollback without touching the live install."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("setup-ponytail-plugin.sh")
ADAPTER = SCRIPT.parent.parent / "plugins-v2" / "ponytail-adapter"


def executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def package(root: Path, version: str) -> None:
    directory = root / "versions" / version / "node_modules" / "@dietrichgebert" / "ponytail"
    directory.mkdir(parents=True)
    (directory / "package.json").write_text(
        json.dumps({"name": "@dietrichgebert/ponytail", "version": version}) + "\n",
        encoding="utf-8",
    )


def exercise(*, registered: bool, activation_succeeds: bool, enable_timer: bool = False, quota: str = "2s") -> None:
    with tempfile.TemporaryDirectory(prefix="ponytail-self-test-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        install = root / "install"
        config = root / "config"
        runtime = root / "runtime"
        config.mkdir()
        runtime.mkdir()
        runtime.chmod(0o700)
        package(install, "9.9.8")
        package(install, "9.9.9")
        (install / "current").symlink_to("versions/9.9.8")

        plugins = []
        if registered:
            plugins.append({
                "package": str(ADAPTER),
                "options": {"packageRoot": str(install / "current" / "node_modules" / "@dietrichgebert" / "ponytail")},
            })
        original = (json.dumps({"custom": {"keep": True}, "plugins": plugins}, separators=(",", ":")) + "\n").encode()
        config_path = config / "opencode.jsonc"
        config_path.write_bytes(original)
        config_path.chmod(0o600)

        npm = root / "npm"
        executable(npm, "#!/bin/sh\n[ \"$1\" = view ] && { echo 9.9.9; exit 0; }\nexit 97\n")
        opencode = root / "opencode"
        listing = "ponytail local /tmp/adapter" if activation_succeeds else "other local /tmp/other"
        executable(
            opencode,
            "#!/bin/sh\n"
            "[ \"$1 $2\" = \"service restart\" ] && exit 0\n"
            f"[ \"$1 $2\" = \"plugin list\" ] && {{ echo '{listing}'; exit 0; }}\n"
            "exit 98\n",
        )
        systemctl = root / "systemctl"
        executable(
            systemctl,
            "#!/bin/sh\n"
            f"[ \"$2\" = show ] && {{ echo '{quota}'; exit 0; }}\n"
            "exit 0\n",
        )

        command = [
            str(SCRIPT),
            "--apply",
            "--config-dir",
            str(config),
            "--install-root",
            str(install),
        ]
        if not enable_timer:
            command.append("--no-timer")
        result = subprocess.run(
            command,
            env={
                **os.environ,
                "OPENCODE_V2_BIN": str(opencode),
                "OPENCODE_V2_PILOT_DIR": str(root / "pilot"),
                "PONYTAIL_NPM_BIN": str(npm),
                "PONYTAIL_SYSTEMCTL_BIN": str(systemctl),
                "XDG_CONFIG_HOME": str(root / "config-home"),
                "XDG_RUNTIME_DIR": str(runtime),
            },
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if enable_timer and quota != "2s":
            if result.returncode == 0 or "prior units were restored" not in result.stderr:
                raise AssertionError(f"ineffective CPU quota was accepted\n{result.stdout}\n{result.stderr}")
            if (install / "current").readlink() != Path("versions/9.9.8") or config_path.read_bytes() != original:
                raise AssertionError("timer failure changed the active package or config")
            return

        if activation_succeeds:
            if result.returncode != 0:
                raise AssertionError(f"activation unexpectedly failed\n{result.stdout}\n{result.stderr}")
            data = json.loads(config_path.read_text(encoding="utf-8"))
            entry = next(item for item in data["plugins"] if item["package"] == str(ADAPTER))
            expected = str(install / "current" / "node_modules" / "@dietrichgebert" / "ponytail")
            if entry.get("options", {}).get("packageRoot") != expected:
                raise AssertionError("custom install root was not registered for the adapter")
            if enable_timer:
                service = root / "config-home/systemd/user/opencode-ponytail-update.service"
                if "CPUQuota=200%\n" not in service.read_text(encoding="utf-8"):
                    raise AssertionError("Ponytail updater CPU quota is missing or malformed")
            return

        if result.returncode == 0 or "prior package/config were restored" not in result.stderr:
            raise AssertionError(f"activation failure did not report rollback\n{result.stdout}\n{result.stderr}")
        if (install / "current").readlink() != Path("versions/9.9.8"):
            raise AssertionError("activation failure did not restore the previous package link")
        if config_path.read_bytes() != original or config_path.stat().st_mode & 0o777 != 0o600:
            raise AssertionError("activation failure did not restore the exact prior config")
        if list(install.glob(".rollback.*")) or list(install.glob(".current.*")):
            raise AssertionError("activation rollback leaked a temporary symlink")


def main() -> int:
    exercise(registered=False, activation_succeeds=False)
    exercise(registered=True, activation_succeeds=False)
    exercise(registered=False, activation_succeeds=True, enable_timer=True)
    exercise(registered=False, activation_succeeds=True, enable_timer=True, quota="infinity")
    print("OK: Ponytail activation, custom-root registration, timer limits, and rollback self-tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
