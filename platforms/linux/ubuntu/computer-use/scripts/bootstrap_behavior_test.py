#!/usr/bin/env python3
"""Exercise bootstrap.sh against disposable fake profile delegates."""

from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from typing import Iterator


ROOT = Path(__file__).resolve().parents[5]
BOOTSTRAP = ROOT / "bootstrap.sh"
TEST_ROOT = Path(os.environ.get("OPEN_RIG_BOOTSTRAP_TEST_ROOT", "/tmp/opencode"))
NATIVE_DELEGATES = (
    "setup-computer-assistant.sh",
    "deploy-plugins.sh",
    "verify-opencode-v2.sh",
    "setup-git-hooks.sh",
)
JOURNAL_PATTERN = re.compile(r"Journal: (?P<path>[^\n]+)")


def _link_or_stub(directory: Path, name: str) -> None:
    target = shutil.which(name)
    path = directory / name
    if target is not None:
        path.symlink_to(target)
        return
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)


def _write_platform_cat(directory: Path) -> None:
    real_cat = shutil.which("cat")
    if real_cat is None:
        raise AssertionError("cat is required to construct the fixture")
    (directory / "cat").write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "if [ \"${1:-}\" = /proc/sys/kernel/osrelease ]; then\n"
        "  printf '%s\\n' \"${BOOTSTRAP_TEST_KERNEL-6.8.0-fixture-native}\"\n"
        "else\n"
        f"  exec {real_cat} \"$@\"\n"
        "fi\n",
        encoding="utf-8",
    )
    (directory / "cat").chmod(0o755)


def _write_ubuntu_grep(directory: Path) -> None:
    real_grep = shutil.which("grep")
    if real_grep is None:
        raise AssertionError("grep is required to construct the fixture")
    (directory / "grep").write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "for argument in \"$@\"; do\n"
        "  if [ \"$argument\" = /etc/os-release ]; then\n"
        "    case \"$*\" in\n"
        "      *ubuntu*) exit 0 ;;\n"
        "    esac\n"
        "  fi\n"
        "done\n"
        f"exec {real_grep} \"$@\"\n",
        encoding="utf-8",
    )
    (directory / "grep").chmod(0o755)


def _write_delegate(path: Path) -> None:
    name = path.name
    path.write_text(
        "#!/bin/sh\n"
        "set -eu\n"
        "printf '%s|%s\\n' "
        f"'{name}' \"$*\" >> \"$BOOTSTRAP_TEST_LOG\"\n"
        f"if [ \"${{BOOTSTRAP_TEST_FAIL_STAGE-}}\" = '{name}' ]; then\n"
        "  exit 7\n"
        "fi\n"
        "if [ \"${BOOTSTRAP_TEST_MUTATE-0}\" = 1 ]; then\n"
        "  case \" $* \" in\n"
        "    *' --apply '*) printf 'fixture delegate mutation\\n' >> \"$OPENCODE_V2_REPO/opencode.json\" ;;\n"
        "  esac\n"
        "fi\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_qa_runtime_delegate(path: Path) -> None:
    path.write_text(
        "#!/usr/bin/env python3\n"
        "import os\n"
        "import sys\n"
        "with open(os.environ['BOOTSTRAP_TEST_LOG'], 'a', encoding='utf-8') as log:\n"
        "    log.write('setup-qa-runtime.py|' + ' '.join(sys.argv[1:]) + '\\n')\n"
        "if os.environ.get('BOOTSTRAP_TEST_FAIL_STAGE') == 'setup-qa-runtime.py':\n"
        "    raise SystemExit(7)\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


class Fixture:
    """A copy of bootstrap.sh with harmless fake profile scripts."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.bootstrap = root / "bootstrap.sh"
        self.bin = root / "bin"
        self.bin.mkdir()
        self.home = root / "home"
        self.home.mkdir()
        self.state = root / "state"
        self.log = root / "delegate-calls.log"
        self.config = root / "opencode.json"
        self.config_bytes = b"{\n  \"fixture\": \"preserve\"\n}\r\n"
        self.config.write_bytes(self.config_bytes)
        shutil.copy2(BOOTSTRAP, self.bootstrap)
        self.bootstrap.chmod(0o755)

        for command in (
            "awk",
            "basename",
            "bash",
            "chmod",
            "date",
            "dirname",
            "env",
            "mkdir",
            "node",
            "npm",
            "git",
            "python3",
            "pwd",
            "sha256sum",
        ):
            _link_or_stub(self.bin, command)
        _write_platform_cat(self.bin)
        _write_ubuntu_grep(self.bin)

        native_scripts = self.root / "platforms/linux/ubuntu/computer-use/scripts"
        native_scripts.mkdir(parents=True)
        for name in NATIVE_DELEGATES:
            _write_delegate(native_scripts / name)
        _write_qa_runtime_delegate(native_scripts / "setup-qa-runtime.py")

        self.environment = os.environ.copy()
        self.environment.update(
            {
                "HOME": str(self.home),
                "PATH": str(self.bin),
                "XDG_STATE_HOME": str(self.state),
                "OPENCODE_V2_REPO": str(self.root),
                "BOOTSTRAP_TEST_KERNEL": "6.8.0-fixture-native",
                "BOOTSTRAP_TEST_LOG": str(self.log),
            }
        )
        for variable in (
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "OPEN_RIG_BOOTSTRAP_FORCE_PLATFORM",
            "OPENCODE_WSL2_CONFIG_DIR",
            "OPENCODE_WSL2_PILOT_DIR",
        ):
            self.environment.pop(variable, None)


@contextmanager
def fixtures() -> Iterator[Fixture]:
    TEST_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="open-rig-bootstrap-test-", dir=TEST_ROOT) as temporary:
        yield Fixture(Path(temporary))


def run_bootstrap(fixture: Fixture, *arguments: str, environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    env = fixture.environment.copy()
    if environment:
        env.update(environment)
    return subprocess.run(
        [str(fixture.bootstrap), *arguments],
        cwd=fixture.root,
        env=env,
        text=True,
        capture_output=True,
        check=False,
        timeout=20,
    )


def output(result: subprocess.CompletedProcess[str]) -> str:
    return f"{result.stdout}\n{result.stderr}"


def journal_path(result: subprocess.CompletedProcess[str]) -> Path:
    matches = JOURNAL_PATTERN.findall(output(result))
    if not matches:
        raise AssertionError(f"journal path missing from output:\n{output(result)}")
    return Path(matches[-1])


def assert_no_journals(fixture: Fixture) -> None:
    if fixture.state.exists() and any(fixture.state.rglob("*")):
        raise AssertionError(f"read-only bootstrap created state: {list(fixture.state.rglob('*'))}")


def assert_success(result: subprocess.CompletedProcess[str], context: str) -> None:
    if result.returncode != 0:
        raise AssertionError(f"{context} returned {result.returncode}:\n{output(result)}")


def test_help_default_verify_and_dry_run() -> None:
    with fixtures() as fixture:
        help_result = run_bootstrap(fixture, "--help")
        assert_success(help_result, "--help")
        assert "Usage: ./bootstrap.sh" in help_result.stdout
        assert not fixture.log.exists()
        assert_no_journals(fixture)

        default_result = run_bootstrap(fixture)
        assert_success(default_result, "default verify")
        calls = fixture.log.read_text(encoding="utf-8").splitlines()
        assert "setup-qa-runtime.py|--verify-only" in calls
        assert any(line == "setup-computer-assistant.sh|--verify-only" for line in calls)
        assert any(line == "deploy-plugins.sh|--plugins all --verify-only" for line in calls)
        assert all("--apply" not in line for line in calls)
        assert_no_journals(fixture)

        fixture.log.write_text("", encoding="utf-8")
        before = fixture.config.read_bytes()
        dry_run = run_bootstrap(fixture, "--apply", "--platform", "native", "--user-only", "--dry-run")
        assert_success(dry_run, "apply dry-run")
        assert "Dry run: platform=native mode=apply user-only=1" in dry_run.stdout
        assert "native-computer-assistant" in dry_run.stdout
        assert "checkout-local-qa-runtime" in dry_run.stdout
        assert "pinned Ponytail dependency" in dry_run.stdout
        assert "ponytail-adapter" in dry_run.stdout
        assert "--apply --user-only" in dry_run.stdout
        assert fixture.log.read_text(encoding="utf-8") == ""
        assert fixture.config.read_bytes() == before
        assert_no_journals(fixture)


def test_platform_selection_and_apply_safeguards() -> None:
    with fixtures() as fixture:
        mismatch = run_bootstrap(fixture, "--platform", "wsl2", "--verify-only")
        assert mismatch.returncode == 2
        assert "does not match detected platform native" in mismatch.stderr
        assert_no_journals(fixture)

        wsl_plan = run_bootstrap(fixture, "--platform", "wsl2", "--dry-run")
        assert_success(wsl_plan, "explicit WSL dry-run")
        assert "Dry run: platform=wsl2 mode=verify" in wsl_plan.stdout
        assert "checkout-local-qa-runtime" in wsl_plan.stdout
        assert "setup-qa-runtime.py --verify-only" in wsl_plan.stdout
        assert "canonical pinned Ponytail dependency" in wsl_plan.stdout
        assert "WSL plugin workspace dependencies" in wsl_plan.stdout
        assert "ponytail-adapter" in wsl_plan.stdout
        assert "differs from detected platform native" in wsl_plan.stdout
        assert_no_journals(fixture)

        auto_wsl = run_bootstrap(
            fixture,
            "--dry-run",
            environment={"BOOTSTRAP_TEST_KERNEL": "5.15.153.1-MICROSOFT-standard-WSL2"},
        )
        assert_success(auto_wsl, "auto WSL dry-run")
        assert "Dry run: platform=wsl2 mode=verify" in auto_wsl.stdout
        assert_no_journals(fixture)

        conflicting = run_bootstrap(fixture, "--verify-only", "--apply")
        assert conflicting.returncode == 2
        assert "mutually exclusive" in conflicting.stderr
        unknown = run_bootstrap(fixture, "--unknown-option")
        assert unknown.returncode == 2
        assert "unknown option" in unknown.stderr
        assert_no_journals(fixture)


def test_verify_failure_and_prerequisite_exit_codes() -> None:
    with fixtures() as fixture:
        failed_verify = run_bootstrap(
            fixture,
            "--platform",
            "native",
            "--verify-only",
            environment={"BOOTSTRAP_TEST_FAIL_STAGE": "deploy-plugins.sh"},
        )
        assert failed_verify.returncode == 1
        assert "MISSING/FAILED: stage native-plugin-registration" in failed_verify.stderr
        calls = fixture.log.read_text(encoding="utf-8").splitlines()
        assert any(line.startswith("verify-opencode-v2.sh|") for line in calls)
        assert any(line.startswith("setup-git-hooks.sh|") for line in calls)
        assert_no_journals(fixture)

        missing_node = fixture.bin / "node"
        missing_node.unlink()
        missing_prerequisite = run_bootstrap(
            fixture,
            "--platform",
            "native",
            "--apply",
            "--user-only",
        )
        assert missing_prerequisite.returncode == 3
        assert "required prerequisite missing at stage prerequisites" in missing_prerequisite.stderr
        failed_journal = journal_path(missing_prerequisite)
        assert failed_journal.exists()
        assert "FAIL stage=prerequisites status=3" in failed_journal.read_text(encoding="utf-8")


def test_apply_journal_and_config_preservation() -> None:
    with fixtures() as fixture:
        before = fixture.config.read_bytes()
        applied = run_bootstrap(fixture, "--platform", "native", "--apply", "--user-only")
        assert_success(applied, "fixture apply")
        assert fixture.config.read_bytes() == before
        assert "setup-qa-runtime.py|--apply" in fixture.log.read_text(encoding="utf-8").splitlines()

        journal = journal_path(applied)
        assert journal.is_file()
        assert journal.stat().st_mode & 0o777 == 0o600
        journal_text = journal.read_text(encoding="utf-8")
        assert "START platform=native mode=apply user_only=1" in journal_text
        assert "HASH_BEFORE sha256=" in journal_text
        assert "HASH_AFTER sha256=" in journal_text
        assert "PASS stage=portable-config-hash-after" in journal_text
        assert "COMPLETE platform=native mode=apply" in journal_text
        assert "fixture delegate mutation" not in journal_text


def test_apply_failures_and_hash_guard() -> None:
    with fixtures() as fixture:
        failed_runtime = run_bootstrap(
            fixture,
            "--platform",
            "native",
            "--apply",
            "--user-only",
            environment={"BOOTSTRAP_TEST_FAIL_STAGE": "setup-qa-runtime.py"},
        )
        assert failed_runtime.returncode == 4
        assert "apply stage failed: checkout-local-qa-runtime" in failed_runtime.stderr
        runtime_journal = journal_path(failed_runtime).read_text(encoding="utf-8")
        assert "FAIL stage=checkout-local-qa-runtime status=7" in runtime_journal

        failed_stage = run_bootstrap(
            fixture,
            "--platform",
            "native",
            "--apply",
            "--user-only",
            environment={"BOOTSTRAP_TEST_FAIL_STAGE": "deploy-plugins.sh"},
        )
        assert failed_stage.returncode == 4
        assert "apply stage failed: native-plugin-registration" in failed_stage.stderr
        failed_stage_journal = journal_path(failed_stage)
        failed_text = failed_stage_journal.read_text(encoding="utf-8")
        assert "FAIL stage=native-plugin-registration status=7" in failed_text
        assert "COMPLETE" not in failed_text
        assert "Suggested rerun: ./bootstrap.sh --platform native --apply --user-only" in failed_stage.stderr

        mutated = run_bootstrap(
            fixture,
            "--platform",
            "native",
            "--apply",
            "--user-only",
            environment={"BOOTSTRAP_TEST_MUTATE": "1"},
        )
        assert mutated.returncode == 4
        assert "portable project config changed during apply" in mutated.stderr
        mutated_journal = journal_path(mutated)
        mutated_text = mutated_journal.read_text(encoding="utf-8")
        assert "HASH_BEFORE sha256=" in mutated_text
        assert "HASH_AFTER sha256=" in mutated_text
        assert "FAIL stage=portable-config-hash-after status=1" in mutated_text
        assert fixture.config.read_bytes() != fixture.config_bytes


def main() -> int:
    tests = (
        test_help_default_verify_and_dry_run,
        test_platform_selection_and_apply_safeguards,
        test_verify_failure_and_prerequisite_exit_codes,
        test_apply_journal_and_config_preservation,
        test_apply_failures_and_hash_guard,
    )
    for test in tests:
        test()
    print("OK: bootstrap behavioral fixture tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
