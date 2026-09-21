#!/usr/bin/env python3
"""Exercise the bounded-command queue and safe non-systemd fallback."""

from __future__ import annotations

import os
import fcntl
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def run(command: list[str], environment: dict[str, str], timeout: float = 15, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, env=environment, cwd=cwd, capture_output=True, text=True, check=False, timeout=timeout)


def make_path(directory: Path, tools: list[str], name: str = "path") -> Path:
    path = directory / name
    path.mkdir()
    for tool in tools:
        target = shutil.which(tool, path=os.defpath)
        if target is None:
            raise RuntimeError(f"required test tool is missing: {tool}")
        (path / tool).symlink_to(target)
    return path


def wait_for_lock(runtime: Path, timeout: float = 5) -> bool:
    lock = runtime / "opencode-rig-bounded-command.lock"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with lock.open("a+") as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(handle, fcntl.LOCK_UN)
                except BlockingIOError:
                    return True
        except FileNotFoundError:
            pass
        time.sleep(0.02)
    return False


def wait_pid_file_gone(path: Path, timeout: float = 5) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            try:
                pid = int(path.read_text(encoding="utf-8").strip())
            except (OSError, ValueError):
                time.sleep(0.05)
                continue
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
        time.sleep(0.05)
    return False


def main() -> int:
    root = Path(__file__).resolve().parents[5]
    wrapper = root / "platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh"
    node = shutil.which("node")
    if node is None:
        print("ERROR: node is required for the startup test", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="bounded-command-test-") as directory:
        base = Path(directory)
        runtime = base / "runtime"
        runtime.mkdir(mode=0o700)
        runtime.chmod(0o700)
        environment = {**os.environ, "XDG_RUNTIME_DIR": str(runtime)}
        fallback_path = make_path(base, ["bash", "timeout", "flock", "setsid", "prlimit", "sleep", "stat", "id", "readlink", "mkdir"])
        fallback_env = {**environment, "PATH": str(fallback_path)}

        # Force the systemd branch with harmless stand-ins. The fake runner
        # records only its argv (which must contain no caller environment) and
        # executes the command after `--`, preserving the inherited environment
        # exactly as a user scope does.
        systemd_path = make_path(base, ["bash", "timeout", "flock", "stat", "id", "readlink", "mkdir", "sleep"], "systemd-path")
        systemd_log = base / "systemd-run.argv"
        fake_systemd_run = systemd_path / "systemd-run"
        fake_systemd_run.write_text(
            "#!/bin/bash\n"
            f"printf '%q\\n' \"$@\" > '{systemd_log}'\n"
            "while [ \"$#\" -gt 0 ] && [ \"$1\" != -- ]; do shift; done\n"
            "[ \"$#\" -gt 0 ] || exit 125\n"
            "shift\nexec \"$@\"\n",
            encoding="utf-8",
        )
        fake_systemd_run.chmod(0o755)
        fake_systemctl = systemd_path / "systemctl"
        fake_systemctl.write_text("#!/bin/bash\n[ \"$1\" = --user ] && [ \"$2\" = show-environment ]\n", encoding="utf-8")
        fake_systemctl.chmod(0o755)
        systemd_env = {
            **environment,
            "PATH": str(systemd_path),
            "FOO_OPEN_RIG_SENTINEL": "spaces 'quotes' = equals Ω",
            "EMPTY_OPEN_RIG_SENTINEL": "",
            "npm_config_offline": "true",
            "PYTHONDONTWRITEBYTECODE": "1",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "RIG_PARSERS_DIR": str(base / "parser assets"),
            "NODE_OPTIONS": "--max-old-space-size=999",
        }
        systemd_probe = base / "systemd-env-probe"
        systemd_probe.write_text(
            "#!/bin/bash\n"
            "[ \"$FOO_OPEN_RIG_SENTINEL\" = \"spaces 'quotes' = equals Ω\" ] || exit 11\n"
            "[ -z \"$EMPTY_OPEN_RIG_SENTINEL\" ] || exit 12\n"
            "[ \"$npm_config_offline\" = true ] || exit 13\n"
            "[ \"$PYTHONDONTWRITEBYTECODE\" = 1 ] || exit 14\n"
            "[ \"$LANG\" = C.UTF-8 ] || exit 15\n"
            "[ \"$LC_ALL\" = C.UTF-8 ] || exit 16\n"
            "[ \"$RIG_PARSERS_DIR\" = \"" + str(base / "parser assets") + "\" ] || exit 17\n"
            "case \"$NODE_OPTIONS\" in --max-old-space-size=*) ;; *) exit 18 ;; esac\n"
            "[ \"$NODE_OPTIONS\" != \"--max-old-space-size=999\" ] || exit 19\n",
            encoding="utf-8",
        )
        systemd_probe.chmod(0o755)
        systemd_ok = run([str(wrapper), "--", str(systemd_probe)], systemd_env)
        if systemd_ok.returncode != 0:
            print("ERROR: forced systemd environment propagation failed", file=sys.stderr)
            print(systemd_ok.stderr, file=sys.stderr, end="")
            return 1
        argv_text = systemd_log.read_text(encoding="utf-8")
        for secret in (systemd_env["FOO_OPEN_RIG_SENTINEL"], systemd_env["RIG_PARSERS_DIR"]):
            if secret in argv_text:
                print("ERROR: caller environment value leaked into systemd-run argv", file=sys.stderr)
                return 1
        if "--setenv" in argv_text or "--wait" in argv_text or "--collect" in argv_text:
            print("ERROR: incompatible or environment-serializing systemd option used", file=sys.stderr)
            return 1
        if "--foreground" in argv_text or "TasksMax=256" not in argv_text or "CPUQuota=200%" not in argv_text:
            print("ERROR: systemd scope is missing aggregate process/CPU limits or uses foreground-only timeout", file=sys.stderr)
            return 1
        nonzero = run([str(wrapper), "--", "/bin/sh", "-c", "exit 37"], systemd_env)
        if nonzero.returncode != 37:
            print("ERROR: systemd command status was not propagated", file=sys.stderr)
            return 1
        systemd_timeout = run([str(wrapper), "--timeout", "1s", "--", "/bin/sh", "-c", "sleep 5"], systemd_env)
        if systemd_timeout.returncode != 124:
            print("ERROR: systemd timeout status was not propagated", file=sys.stderr)
            print(systemd_timeout.stderr, file=sys.stderr, end="")
            return 1
        systemd_child = base / "systemd-timeout-child.pid"
        timeout_tree = run(
            [
                str(wrapper),
                "--timeout",
                "1s",
                "--",
                "/bin/sh",
                "-c",
                f"sleep 10 & echo $! > {systemd_child}; wait",
            ],
            systemd_env,
        )
        if timeout_tree.returncode != 124 or not wait_pid_file_gone(systemd_child):
            print("ERROR: systemd timeout left a descendant alive", file=sys.stderr)
            print(timeout_tree.stderr, file=sys.stderr, end="")
            return 1

        required = run([str(wrapper), "--require-cgroup", "--", "/bin/true"], fallback_env)
        if required.returncode != 2 or "systemd user cgroup is required" not in required.stderr:
            print("ERROR: --require-cgroup did not fail closed on the fallback path", file=sys.stderr)
            return 1

        # Run the real pinned file-manager installer and verifier through the
        # forced fallback. Assets are already installed in node_modules; no
        # network or package-manager operation is involved.
        file_manager = root / "platforms/linux/ubuntu/computer-use/plugins-v2/file-manager"
        parser_target = base / "parser-target"
        install = run(
            [str(wrapper), "--timeout", "20s", "--", node, "scripts/install-parsers.mjs", "--target", str(parser_target)],
            fallback_env, cwd=file_manager,
        )
        verify = run(
            [str(wrapper), "--timeout", "20s", "--", node, "scripts/install-parsers.mjs", "--verify-only", "--target", str(parser_target)],
            fallback_env, cwd=file_manager,
        )
        if install.returncode != 0 or verify.returncode != 0 or "verified" not in verify.stdout:
            print("ERROR: bounded file-manager parser install/verify failed under RSS fallback", file=sys.stderr)
            sys.stderr.write(install.stderr)
            sys.stderr.write(verify.stderr)
            return 1

        holder = subprocess.Popen(
            [str(wrapper), "--", "/bin/sleep", "5"],
            env=fallback_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if not wait_for_lock(runtime):
            print("ERROR: first contention holder did not acquire its lock", file=sys.stderr)
            holder.kill()
            holder.wait(timeout=5)
            return 1
        queued = run([str(wrapper), "--lock-timeout", "10", "--", "/bin/sh", "-c", "sleep 1"], environment)
        _, holder_stderr = holder.communicate(timeout=10)
        if queued.returncode != 0 or "waiting up to 10s" not in queued.stderr:
            print("ERROR: contending check did not queue and complete", file=sys.stderr)
            print(queued.stderr, file=sys.stderr, end="")
            print(holder_stderr, file=sys.stderr, end="")
            return 1

        # Descendants remain in the monitored process tree during normal work.
        descendants = run([str(wrapper), "--timeout", "10s", "--", "/bin/sh", "-c", "sleep 3 & wait"], fallback_env)
        if descendants.returncode != 0:
            print("ERROR: fallback descendant command failed", file=sys.stderr)
            sys.stderr.write(descendants.stderr)
            return 1

        timeout_holder = subprocess.Popen(
            [str(wrapper), "--timeout", "10s", "--", "/bin/sleep", "5"],
            env=fallback_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        if not wait_for_lock(runtime):
            print("ERROR: timeout contention holder did not acquire its lock", file=sys.stderr)
            timeout_holder.kill()
            timeout_holder.wait(timeout=5)
            return 1
        expired = run([str(wrapper), "--lock-timeout", "1", "--", "/bin/true"], fallback_env)
        _, timeout_holder_stderr = timeout_holder.communicate(timeout=10)
        # The queued invocation times out on the lock while the fallback child
        # is still running; this preserves the separate queueing guarantee.
        if expired.returncode == 0 or "timed out after 1s" not in expired.stderr:
            print("ERROR: lock timeout did not fail with a clear diagnostic", file=sys.stderr)
            print(expired.stderr, file=sys.stderr, end="")
            print(timeout_holder_stderr, file=sys.stderr, end="")
            return 1

        pid_root = base / "timeout-root.pid"
        pid_child = base / "timeout-child.pid"
        pid_script = base / "timeout-pid-tree.sh"
        pid_script.write_text(
            "#!/bin/bash\n"
            f"echo $$ > '{pid_root}'\n"
            f"(echo $BASHPID > '{pid_child}'; sleep 10) &\n"
            "child=$!\nwait \"$child\"\n",
            encoding="utf-8",
        )
        pid_script.chmod(0o755)
        command_timeout = run([str(wrapper), "--timeout", "1s", "--", "/bin/bash", str(pid_script)], fallback_env)
        if command_timeout.returncode != 124 or "exceeded timeout" not in command_timeout.stderr:
            print("ERROR: fallback command timeout did not terminate its group", file=sys.stderr)
            print(command_timeout.stderr, file=sys.stderr, end="")
            return 1
        if not wait_pid_file_gone(pid_root) or not wait_pid_file_gone(pid_child):
            print("ERROR: timeout cleanup left a monitored PID alive", file=sys.stderr)
            return 1

        cleanup = run([str(wrapper), "--lock-timeout", "1", "--", "/bin/sh", "-c", "sleep 1"], fallback_env)
        if cleanup.returncode != 0:
            print("ERROR: lock was not released after fallback timeout", file=sys.stderr)
            print(cleanup.stderr, file=sys.stderr, end="")
            return 1

        # Fake only the monitor's /proc view to deterministically exercise the
        # RSS-exceeded path without allocating a large resident buffer.
        fake_proc = base / "fake-proc"
        fake_proc.mkdir()
        (fake_proc / "meminfo").write_text("MemAvailable: 1048576 kB\nSwapFree: 1048576 kB\n", encoding="utf-8")
        (fake_proc / "self").mkdir()
        (fake_proc / "self" / "cgroup").write_text("", encoding="utf-8")
        stub = base / "prlimit-stub"
        stub.write_text(
            "#!/bin/bash\n"
            "/bin/mkdir -p \"$BOUNDED_COMMAND_PROC_ROOT/$$\"\n"
            "/bin/mkdir -p \"$BOUNDED_COMMAND_PROC_ROOT/$$/task/$$\"\n"
            "mode=\"${BOUNDED_COMMAND_SYNTHETIC_MODE:-rss}\"\n"
            "rss=1\n[ \"$mode\" = rss ] && rss=999999999\n"
            "pgrp=$$\n[ \"$mode\" = wrong-pgrp ] && pgrp=999999\n"
            "printf 'Name: stub\\nPPid: 1\\nVmRSS: %s kB\\n' \"$rss\" > \"$BOUNDED_COMMAND_PROC_ROOT/$$/status\"\n"
            "printf '%s\\n' \"$$ (stub) S 1 $pgrp 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345\" > \"$BOUNDED_COMMAND_PROC_ROOT/$$/stat\"\n"
            "children=\"\"\n"
            "case \"$mode\" in\n"
            "  malformed-child) child=424242; children=\"$child\"; /bin/mkdir -p \"$BOUNDED_COMMAND_PROC_ROOT/$child/task/$child\"; : > \"$BOUNDED_COMMAND_PROC_ROOT/$child/task/$child/children\"; printf 'Name: malformed-child\\n' > \"$BOUNDED_COMMAND_PROC_ROOT/$child/status\"; printf '%s\\n' \"$child (bad child) S $$ 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345\" > \"$BOUNDED_COMMAND_PROC_ROOT/$child/stat\" ;;\n"
            "  disappearing-child) children=\"424243\" ;;\n"
            "  overbound) for ((i=0; i<513; i++)); do children=\"$children $((420000+i))\"; done ;;\n"
            "  reuse) child=424244; children=\"$child\"; /bin/mkdir -p \"$BOUNDED_COMMAND_PROC_ROOT/$child/task/$child\"; : > \"$BOUNDED_COMMAND_PROC_ROOT/$child/task/$child/children\"; printf 'Name: reuse\\nPPid: $$\\nVmRSS: 1 kB\\n' > \"$BOUNDED_COMMAND_PROC_ROOT/$child/status\"; printf '%s\\n' \"$child (reuse) S $$ 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 11111\" > \"$BOUNDED_COMMAND_PROC_ROOT/$child/stat\"; (sleep 1; printf '%s\\n' \"$child (reuse) S $$ 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 22222\" > \"$BOUNDED_COMMAND_PROC_ROOT/$child/stat\") & ;;\n"
            "esac\n"
            "printf '%s\\n' \"$children\" > \"$BOUNDED_COMMAND_PROC_ROOT/$$/task/$$/children\"\n"
            f"exec {shutil.which('prlimit')} \"$@\"\n",
            encoding="utf-8",
        )
        stub.chmod(0o755)
        (fallback_path / "prlimit").unlink()
        (fallback_path / "prlimit").symlink_to(stub)
        pid_root = base / "root.pid"
        pid_child = base / "child.pid"
        pid_script = base / "pid-tree.sh"
        pid_script.write_text(
            "#!/bin/bash\n"
            f"echo $$ > '{pid_root}'\n"
            f"(echo $BASHPID > '{pid_child}'; sleep 10) &\n"
            "child=$!\n"
            "wait \"$child\"\n",
            encoding="utf-8",
        )
        pid_script.chmod(0o755)
        (fallback_path / "prlimit").unlink()
        (fallback_path / "prlimit").symlink_to(shutil.which("prlimit", path=os.defpath))
        exceeded = run(
            [str(wrapper), "--timeout", "5s", "--", "/bin/bash", str(pid_script)],
            {**fallback_env, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_TEST_RSS_BYTES": "999999999999"},
        )
        if exceeded.returncode != 137 or "RSS exceeded" not in exceeded.stderr:
            print("ERROR: RSS exceed did not terminate safely", file=sys.stderr)
            print(exceeded.stderr, file=sys.stderr, end="")
            return 1
        if not wait_pid_file_gone(pid_root) or not wait_pid_file_gone(pid_child):
            print("ERROR: RSS cleanup left a monitored PID alive", file=sys.stderr)
            return 1
        (fallback_path / "prlimit").unlink()
        (fallback_path / "prlimit").symlink_to(stub)

        # A listed child with a live but malformed identity/RSS must fail
        # closed; a listed PID with no files is the permitted disappearance
        # race. The synthetic tree also tests the hard process bound.
        for mode, expected, label in (
            ("malformed-child", 125, "malformed child"),
            ("disappearing-child", 0, "disappearing child"),
            ("overbound", 125, "over-bound tree"),
            ("reuse", 125, "PID reuse"),
            ("wrong-pgrp", 124, "wrong process group"),
        ):
            command = [str(wrapper), "--timeout", "1s" if mode == "wrong-pgrp" else "5s", "--", "/bin/sh", "-c", "sleep 3"]
            synthetic = run(
                command,
                {**fallback_env, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(fake_proc), "BOUNDED_COMMAND_SYNTHETIC_MODE": mode},
            )
            if synthetic.returncode != expected:
                print(f"ERROR: {label} synthetic tree returned {synthetic.returncode}", file=sys.stderr)
                print(synthetic.stderr, file=sys.stderr, end="")
                return 1

        (fallback_path / "prlimit").unlink()
        (fallback_path / "prlimit").symlink_to(shutil.which("prlimit", path=os.defpath))

        # Numeric cgroup exhaustion must not fall back to host MemAvailable;
        # finite swap headroom must also constrain the advertised budget.
        cgroup_proc = base / "cgroup-proc"
        cgroup_root = base / "cgroup-root"
        (cgroup_proc / "self").mkdir(parents=True)
        (cgroup_proc / "self" / "cgroup").write_text("0::/test\n", encoding="utf-8")
        (cgroup_proc / "meminfo").write_text("MemAvailable: 1048576 kB\nSwapFree: 1048576 kB\n", encoding="utf-8")
        cg = cgroup_root / "test"
        cg.mkdir(parents=True)
        (cg / "memory.max").write_text("1024\n", encoding="utf-8")
        (cg / "memory.current").write_text("1024\n", encoding="utf-8")
        (cg / "memory.swap.max").write_text("1048576\n", encoding="utf-8")
        (cg / "memory.swap.current").write_text("1048576\n", encoding="utf-8")
        exhausted = run(
            [str(wrapper), "--print-budget"],
            {**environment, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(cgroup_proc), "BOUNDED_COMMAND_CGROUP_ROOT": str(cgroup_root)},
        )
        if exhausted.returncode == 0 or "only 0 bytes" not in exhausted.stderr:
            print("ERROR: exhausted numeric cgroup did not fail closed", file=sys.stderr)
            return 1
        (cg / "memory.max").write_text("2147483648\n", encoding="utf-8")
        (cg / "memory.current").write_text("0\n", encoding="utf-8")
        (cg / "memory.swap.max").write_text("10485760\n", encoding="utf-8")
        (cg / "memory.swap.current").write_text("8388608\n", encoding="utf-8")
        swap_budget = run(
            [str(wrapper), "--print-budget"],
            {**environment, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(cgroup_proc), "BOUNDED_COMMAND_CGROUP_ROOT": str(cgroup_root)},
        )
        if swap_budget.returncode != 0 or "swap_budget_bytes=524288" not in swap_budget.stdout:
            print("ERROR: finite cgroup swap headroom was not honored", file=sys.stderr)
            return 1
        runner_cgroup_proc = base / "runner-cgroup-proc"
        runner_cgroup_root = base / "runner-cgroup-root"
        (runner_cgroup_proc / "self").mkdir(parents=True)
        (runner_cgroup_proc / "self" / "cgroup").write_text("0::/parent/child/grandparent\n", encoding="utf-8")
        (runner_cgroup_proc / "meminfo").write_text("MemAvailable: 1048576 kB\nSwapFree: 1048576 kB\n", encoding="utf-8")
        for relative in ("parent/child/grandparent", "parent/child", "parent", ""):
            directory = runner_cgroup_root / relative
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "memory.max").write_text("max\n", encoding="utf-8")
            (directory / "memory.current").write_text("0\n", encoding="utf-8")
            (directory / "memory.swap.max").write_text("max\n", encoding="utf-8")
            (directory / "memory.swap.current").write_text("0\n", encoding="utf-8")
        (runner_cgroup_root / "parent" / "memory.max").write_text("1048576\n", encoding="utf-8")
        bounded_parent = run(
            [str(wrapper), "--print-budget"],
            {**environment, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(runner_cgroup_proc), "BOUNDED_COMMAND_CGROUP_ROOT": str(runner_cgroup_root)},
        )
        if bounded_parent.returncode == 0 or "only 1048576 bytes" not in bounded_parent.stderr:
            print("ERROR: runner ignored finite ancestor cgroup headroom", file=sys.stderr)
            return 1
        (runner_cgroup_root / "parent" / "memory.current").write_text("1048576\n", encoding="utf-8")
        exhausted_parent = run(
            [str(wrapper), "--print-budget"],
            {**environment, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(runner_cgroup_proc), "BOUNDED_COMMAND_CGROUP_ROOT": str(runner_cgroup_root)},
        )
        if exhausted_parent.returncode == 0 or "only 0 bytes" not in exhausted_parent.stderr:
            print("ERROR: runner ignored exhausted ancestor cgroup", file=sys.stderr)
            return 1
        (runner_cgroup_root / "parent" / "memory.current").write_text("bad\n", encoding="utf-8")
        malformed_parent = run(
            [str(wrapper), "--print-budget"],
            {**environment, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(runner_cgroup_proc), "BOUNDED_COMMAND_CGROUP_ROOT": str(runner_cgroup_root)},
        )
        if malformed_parent.returncode == 0 or "malformed" not in malformed_parent.stderr:
            print("ERROR: runner ignored malformed ancestor cgroup current", file=sys.stderr)
            return 1
        (runner_cgroup_root / "parent" / "memory.max").write_text("2147483648\n", encoding="utf-8")
        (runner_cgroup_root / "parent" / "memory.current").write_text("0\n", encoding="utf-8")
        (runner_cgroup_root / "parent" / "memory.swap.max").write_text("10485760\n", encoding="utf-8")
        (runner_cgroup_root / "parent" / "memory.swap.current").write_text("8388608\n", encoding="utf-8")
        runner_swap = run(
            [str(wrapper), "--print-budget"],
            {**environment, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(runner_cgroup_proc), "BOUNDED_COMMAND_CGROUP_ROOT": str(runner_cgroup_root)},
        )
        if runner_swap.returncode != 0 or "swap_budget_bytes=524288" not in runner_swap.stdout:
            print("ERROR: runner ignored finite ancestor cgroup swap headroom", file=sys.stderr)
            return 1

        # Runtime and lock paths reject symlinks/unsafe permissions and create
        # a private fallback runtime when XDG_RUNTIME_DIR is absent.
        hostile_target = base / "hostile-target"
        hostile_target.mkdir(mode=0o700)
        hostile_link = base / "hostile-link"
        hostile_link.symlink_to(hostile_target, target_is_directory=True)
        hostile = run([str(wrapper), "--", "/bin/true"], {**fallback_env, "XDG_RUNTIME_DIR": str(hostile_link)})
        if hostile.returncode == 0 or "must be a real directory" not in hostile.stderr:
            print("ERROR: symlink runtime directory was accepted", file=sys.stderr)
            return 1
        unsafe = base / "unsafe-runtime"
        unsafe.mkdir(mode=0o755)
        unsafe.chmod(0o755)
        unsafe_run = run([str(wrapper), "--", "/bin/true"], {**fallback_env, "XDG_RUNTIME_DIR": str(unsafe)})
        if unsafe_run.returncode == 0 or "not private" not in unsafe_run.stderr:
            print("ERROR: unsafe runtime mode was accepted", file=sys.stderr)
            return 1
        home = base / "home"
        home.mkdir(mode=0o700)
        home.chmod(0o700)
        unset_runtime_env = {**fallback_env, "HOME": str(home)}
        unset_runtime_env.pop("XDG_RUNTIME_DIR", None)
        created = run([str(wrapper), "--", "/bin/sleep", "3"], unset_runtime_env)
        created_runtime = home / ".cache/opencode-rig/runtime"
        if created.returncode != 0 or not created_runtime.is_dir() or (created_runtime.stat().st_mode & 0o77):
            print("ERROR: private fallback runtime was not safely created", file=sys.stderr)
            print(created.stderr, file=sys.stderr, end="")
            return 1
        shared_home = base / "shared-home"
        (shared_home / ".cache").mkdir(parents=True, mode=0o755)
        shared_home.chmod(0o750)
        (shared_home / ".cache").chmod(0o755)
        shared_env = {**fallback_env, "HOME": str(shared_home)}
        shared_env.pop("XDG_RUNTIME_DIR", None)
        shared = run([str(wrapper), "--", "/bin/sleep", "3"], shared_env)
        if shared.returncode != 0 or not (shared_home / ".cache/opencode-rig/runtime").is_dir():
            print("ERROR: safe readable parent runtime was rejected", file=sys.stderr)
            return 1
        writable_home = base / "writable-home"
        (writable_home / ".cache").mkdir(parents=True, mode=0o775)
        writable_home.chmod(0o750)
        (writable_home / ".cache").chmod(0o775)
        writable_env = {**fallback_env, "HOME": str(writable_home)}
        writable_env.pop("XDG_RUNTIME_DIR", None)
        writable = run([str(wrapper), "--", "/bin/true"], writable_env)
        if writable.returncode == 0 or "group/world writable" not in writable.stderr:
            print("ERROR: writable parent runtime was accepted", file=sys.stderr)
            return 1
        lock_target = base / "lock-target"
        lock_target.write_text("", encoding="utf-8")
        (runtime / "opencode-rig-bounded-command.lock").unlink()
        (runtime / "opencode-rig-bounded-command.lock").symlink_to(lock_target)
        hostile_lock = run([str(wrapper), "--", "/bin/true"], environment)
        if hostile_lock.returncode == 0 or "must not be a symlink" not in hostile_lock.stderr:
            print("ERROR: symlink lock file was accepted", file=sys.stderr)
            return 1
        (runtime / "opencode-rig-bounded-command.lock").unlink()

        # A malformed root status must fail closed rather than trust an
        # incomplete memory reading.
        (fallback_path / "prlimit").unlink()
        (fallback_path / "prlimit").symlink_to(stub)
        stub.write_text(
            "#!/bin/bash\n"
            "/bin/mkdir -p \"$BOUNDED_COMMAND_PROC_ROOT/$$\"\n"
            "/bin/mkdir -p \"$BOUNDED_COMMAND_PROC_ROOT/$$/task/$$\"\n"
            ": > \"$BOUNDED_COMMAND_PROC_ROOT/$$/task/$$/children\"\n"
            "printf 'Name: malformed\\n' > \"$BOUNDED_COMMAND_PROC_ROOT/$$/status\"\n"
            "printf '%s\\n' \"$$ (stub) S 1 $$ 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345\" > \"$BOUNDED_COMMAND_PROC_ROOT/$$/stat\"\n"
            f"exec {shutil.which('prlimit')} \"$@\"\n",
            encoding="utf-8",
        )
        malformed = run(
            [str(wrapper), "--timeout", "5s", "--", "/bin/sh", "-c", "sleep 5"],
            {**fallback_env, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_PROC_ROOT": str(fake_proc)},
        )
        if malformed.returncode != 125 or "malformed or unreadable" not in malformed.stderr:
            print("ERROR: malformed /proc did not fail closed", file=sys.stderr)
            print(malformed.stderr, file=sys.stderr, end="")
            return 1
        (fallback_path / "prlimit").unlink()
        (fallback_path / "prlimit").symlink_to(shutil.which("prlimit", path=os.defpath))
        malformed_pid = run(
            [str(wrapper), "--timeout", "5s", "--", "/bin/bash", str(pid_script)],
            {**fallback_env, "BOUNDED_COMMAND_TESTING": "1", "BOUNDED_COMMAND_TEST_MALFORM_PID_FILE": str(pid_child)},
        )
        if malformed_pid.returncode != 125 or not wait_pid_file_gone(pid_root) or not wait_pid_file_gone(pid_child):
            print("ERROR: malformed live child cleanup left a monitored PID alive", file=sys.stderr)
            print(malformed_pid.stderr, file=sys.stderr, end="")
            return 1

        # No prlimit means no safe fallback; it must not silently execute.
        missing = make_path(base, ["bash", "timeout", "flock", "sleep", "stat", "id", "readlink", "mkdir"], "missing-path")
        unavailable = run([str(wrapper), "--", "/bin/true"], {**environment, "PATH": str(missing)})
        if unavailable.returncode == 0 or "refusing to run unbounded" not in unavailable.stderr:
            print("ERROR: missing fallback limiter did not fail closed", file=sys.stderr)
            return 1

        missing_setsid = make_path(base, ["bash", "timeout", "flock", "prlimit", "sleep", "stat", "id", "readlink", "mkdir"], "missing-setsid-path")
        missing_dependency = run([str(wrapper), "--", "/bin/true"], {**environment, "PATH": str(missing_setsid)})
        if missing_dependency.returncode == 0 or "setsid is required" not in missing_dependency.stderr:
            print("ERROR: missing RSS fallback dependency did not fail closed", file=sys.stderr)
            return 1

    print("OK: Node startup, descendants, RSS exceed, timeout, queueing, cleanup, and fail-closed cases passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
