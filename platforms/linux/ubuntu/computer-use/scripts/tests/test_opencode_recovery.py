#!/usr/bin/env python3
"""Focused tests for target-bound, marker-aware OpenCode recovery."""

from __future__ import annotations

import importlib.util
import hashlib
import inspect
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock
from typing import Any


SCRIPT = Path(__file__).resolve().parents[1] / "opencode-recovery.py"
SPEC = importlib.util.spec_from_file_location("opencode_recovery", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load recovery module")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


CLONE_DIRECTORY = Path("/srv/open-rig-clone").resolve()


class FakeClock:
    """Advance a monotonic test clock only through bounded waits."""

    def __init__(self, value: float = 0.0) -> None:
        self.value = value

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class FakeApi:
    """Provide location-scoped MCP responses without starting any process."""

    def __init__(self, statuses: list[Any], *, location: Path = CLONE_DIRECTORY, server: str = "basic-memory") -> None:
        self.statuses = list(statuses)
        self.directory = location
        self.location_value: object = {
            "data": {"directory": str(location), "project": {"id": "clone-project"}},
        }
        self.server = server
        self.location_calls = 0
        self.connect_calls = 0
        self.status_calls = 0
        self.connect_timeouts = 0
        self.plugin_calls = 0
        self.plugin_value: object = {"data": []}
        self.server_identities: list[Any] = [MODULE.ServerIdentity("2.0.7", 1234)]
        self.bound_server_identity: MODULE.ServerIdentity | None = None

    def bind_server_identity(self, identity: MODULE.ServerIdentity) -> None:
        """Bind mutating test calls to the expected server process."""
        self.bound_server_identity = identity

    def assert_server_identity(self, timeout_seconds: float) -> None:
        """Reject test mutations after deterministic identity drift."""
        if self.bound_server_identity is None:
            return
        if timeout_seconds <= 0:
            raise MODULE.RecoveryTimeout("selected service identity")
        if self.server_info(timeout_seconds) != self.bound_server_identity:
            raise MODULE.RecoveryError("selected OpenCode service identity changed before mutation")

    def server_info(self, timeout_seconds: float) -> MODULE.ServerIdentity:
        """Return the selected service identity, including deterministic drift fixtures."""
        identity = self.server_identities.pop(0) if len(self.server_identities) > 1 else self.server_identities[0]
        if isinstance(identity, BaseException):
            raise identity
        return identity

    def location(self, timeout_seconds: float) -> object:
        self.location_calls += 1
        return self.location_value

    def connect_basic_memory(self, timeout_seconds: float) -> None:
        self.assert_server_identity(timeout_seconds)
        self.connect_calls += 1
        if self.connect_timeouts:
            self.connect_timeouts -= 1
            clock = getattr(self, "clock", None)
            if clock is not None:
                clock.value += 5.0
            raise MODULE.RecoveryTimeout("connect delayed")
        self.assert_server_identity(timeout_seconds)

    def list_mcp(self, timeout_seconds: float) -> object:
        self.status_calls += 1
        status = self.statuses.pop(0) if self.statuses else "pending"
        if isinstance(status, BaseException):
            raise status
        return {"data": [{"name": self.server, "status": {"status": status}}]}

    def list_plugins(self, timeout_seconds: float) -> object:
        self.plugin_calls += 1
        if isinstance(self.plugin_value, BaseException):
            raise self.plugin_value
        return self.plugin_value


class FakeRuntime:
    """Record marker verification/preview/apply sequencing."""

    def __init__(self, verify_results: list[bool]) -> None:
        self.verify_results = list(verify_results)
        self.verify_calls = 0
        self.preview_calls = 0
        self.apply_calls: list[tuple[Any, bool, float]] = []

    def verify_native(self, timeout_seconds: float) -> bool:
        self.verify_calls += 1
        return self.verify_results.pop(0) if self.verify_results else False

    def preview_native(self, timeout_seconds: float | None = None) -> Any:
        self.preview_calls += 1
        return MODULE.NativeRuntimePreview(
            "canonical-mcp-runtime-marker",
            "native",
            "a" * 64,
            "b" * 64,
        )

    def apply_native(self, preview: Any, approval: bool, timeout_seconds: float) -> str:
        self.apply_calls.append((preview, approval, timeout_seconds))
        return "applied"


def connected() -> dict[str, object]:
    """Return a correctly identified connected Basic Memory response."""
    return {"data": [{"name": "basic-memory", "status": {"status": "connected"}}]}


def policy(**changes: Any) -> Any:
    """Build a startup-aware deterministic policy."""
    values = {
        "max_rechecks": 64,
        "retry_delay_seconds": 2.0,
        "deadline_seconds": 90.0,
        "runtime_timeout_seconds": 60.0,
        "api_timeout_seconds": 5.0,
    }
    values.update(changes)
    return MODULE.RecoveryPolicy(**values)


def output_script(directory: Path, stream: str) -> Path:
    """Create a fixture child that exceeds one bounded output stream."""
    script = directory / f"overflow-{stream}.py"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        f"sys.{stream}.write('x' * 200000)\n"
        f"sys.{stream}.flush()\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


class RecoveryTests(unittest.TestCase):
    """Cover marker flow, target binding, delayed readiness, and proof gating."""

    def test_stale_marker_offers_preview_without_connect_or_apply(self) -> None:
        """Verify-only failure returns a digest preview before any mutation or reconnect."""
        api = FakeApi([])
        runtime = FakeRuntime([False])
        result = MODULE.recover_basic_memory(api, "safe/health", "computer-assistant", policy(), runtime=runtime)
        self.assertEqual(result.status, "marker-repair-required")
        self.assertIsNotNone(result.preview)
        self.assertEqual(runtime.preview_calls, 1)
        self.assertEqual(runtime.apply_calls, [])
        self.assertEqual(api.connect_calls, 0)

    def test_apply_requires_explicit_apply_approval_and_fresh_postcheck(self) -> None:
        """Fresh verification precedes the exact canonical apply and postcheck."""
        commands: list[list[str]] = []
        verify_results = iter([False, False, True])

        def runner(arguments: list[str], timeout_seconds: float) -> bool:
            commands.append(arguments)
            return next(verify_results, True)

        fingerprints = lambda: ("a" * 64, "b" * 64)
        runtime = MODULE.CanonicalNativeRuntime(runner=runner, fingerprints=fingerprints)
        preview = runtime.preview_native()
        api = FakeApi(["pending", connected()["data"][0]["status"]["status"]])
        result = MODULE.recover_basic_memory(
            api,
            "safe/health",
            "computer-assistant",
            policy(),
            runtime=runtime,
            marker_action="apply",
            preview=preview,
            approval=True,
        )
        self.assertEqual(result.status, MODULE.READINESS_STATUS)
        self.assertEqual(commands, [
            ["mcp-runtime", "--profile", "native", "--quiet"],
            ["mcp-runtime", "--profile", "native", "--quiet"],
            ["mcp-runtime", "--profile", "native", "--apply", "--quiet"],
            ["mcp-runtime", "--profile", "native", "--quiet"],
        ])
        self.assertEqual(api.connect_calls, 1)

    def test_stale_preview_state_rejects_apply_without_canonical_write(self) -> None:
        """A changed policy/marker digest rejects apply before the canonical command."""
        commands: list[list[str]] = []
        runtime = MODULE.CanonicalNativeRuntime(
            runner=lambda arguments, timeout: commands.append(arguments) or False,
            fingerprints=lambda: ("a" * 64, "changed".ljust(64, "0")),
        )
        preview = MODULE.NativeRuntimePreview("canonical-mcp-runtime-marker", "native", "a" * 64, "b" * 64)
        api = FakeApi([])
        result = MODULE.recover_basic_memory(
            api,
            "safe/health",
            "computer-assistant",
            policy(),
            runtime=runtime,
            marker_action="apply",
            preview=preview,
            approval=True,
        )
        self.assertEqual(result.status, "marker-repair-rejected")
        self.assertEqual(commands, [["mcp-runtime", "--profile", "native", "--quiet"]])

    def test_native_apply_shares_one_deadline_between_verify_and_apply(self) -> None:
        """Fresh verify and canonical apply consume one bounded operation budget."""
        clock = FakeClock(1000.0)
        commands: list[tuple[list[str], float]] = []

        def runner(arguments: list[str], timeout_seconds: float) -> bool:
            commands.append((arguments, timeout_seconds))
            if "--apply" in arguments:
                clock.value += 5.0
                return True
            clock.value += 4.0
            return False

        runtime = MODULE.CanonicalNativeRuntime(
            runner=runner,
            fingerprints=lambda: ("a" * 64, "b" * 64),
            clock=clock.now,
        )
        preview = runtime.preview_native()
        result = runtime.apply_native(preview, True, 10.0)
        self.assertEqual(result, "applied")
        self.assertEqual(len(commands), 2)
        self.assertAlmostEqual(commands[0][1], 10.0)
        self.assertAlmostEqual(commands[1][1], 6.0)
        self.assertEqual(clock.value, 1009.0)

    def test_native_apply_rechecks_bound_identity_after_fresh_verify(self) -> None:
        """Service drift during fresh verification stops immediately before marker apply."""
        api = FakeApi(["pending"])
        api.bind_server_identity(MODULE.ServerIdentity("2.0.7", 1234))
        api.server_identities = [MODULE.ServerIdentity("2.0.8", 1234)]
        commands: list[list[str]] = []
        runtime = MODULE.CanonicalNativeRuntime(
            runner=lambda arguments, timeout: commands.append(arguments) or False,
            fingerprints=lambda: ("a" * 64, "b" * 64),
            before_apply=api.assert_server_identity,
        )
        result = runtime.apply_native(runtime.preview_native(), True, 10.0)
        self.assertEqual(result, "rejected")
        self.assertEqual(commands, [["mcp-runtime", "--profile", "native", "--quiet"]])

    def test_native_apply_refuses_after_verify_exhausts_shared_deadline(self) -> None:
        """A verify that consumes the apply budget cannot launch the apply subprocess."""
        clock = FakeClock(1000.0)
        commands: list[list[str]] = []

        def runner(arguments: list[str], timeout_seconds: float) -> bool:
            commands.append(arguments)
            clock.value += timeout_seconds
            return False

        runtime = MODULE.CanonicalNativeRuntime(
            runner=runner,
            fingerprints=lambda: ("a" * 64, "b" * 64),
            clock=clock.now,
        )
        result = runtime.apply_native(runtime.preview_native(), True, 10.0)
        self.assertEqual(result, "rejected")
        self.assertEqual(commands, [["mcp-runtime", "--profile", "native", "--quiet"]])
        self.assertEqual(clock.value, 1010.0)

    def test_recovery_does_not_return_readiness_after_delayed_marker_apply(self) -> None:
        """The overall recovery deadline also bounds marker apply plus postcheck."""
        clock = FakeClock(1000.0)

        class DelayedRuntime(FakeRuntime):
            def apply_native(self, preview: Any, approval: bool, timeout_seconds: float) -> str:
                self.apply_calls.append((preview, approval, timeout_seconds))
                clock.value += timeout_seconds
                return "applied"

        runtime = DelayedRuntime([False])
        preview = runtime.preview_native()
        api = FakeApi(["connected"])
        result = MODULE.recover_basic_memory(
            api,
            "safe/health",
            "computer-assistant",
            policy(deadline_seconds=30.0, max_rechecks=16),
            runtime=runtime,
            marker_action="apply",
            preview=preview,
            approval=True,
            clock=clock.now,
            sleep=clock.sleep,
        )
        self.assertFalse(result.recovered)
        self.assertEqual(result.status, "marker-repair-failed")
        self.assertEqual(api.connect_calls, 0)
        self.assertEqual(clock.value, 1030.0)

    def test_delayed_connect_timeout_polls_until_ready_without_second_connect(self) -> None:
        """A five-second connect timeout can settle after 34 seconds within the deadline."""
        clock = FakeClock()
        api = FakeApi(["pending"] + ["pending"] * 14 + ["connected"])
        api.clock = clock
        api.connect_timeouts = 1
        result = MODULE.recover_basic_memory(
            api,
            "safe/health",
            "computer-assistant",
            policy(),
            runtime=FakeRuntime([True]),
            clock=clock.now,
            sleep=clock.sleep,
        )
        self.assertEqual(result.status, MODULE.READINESS_STATUS)
        self.assertEqual(api.connect_calls, 1)
        self.assertGreater(clock.value, 12.0)
        self.assertLess(clock.value, 90.0)

    def test_absolute_deadline_with_nonzero_monotonic_origin(self) -> None:
        """A nonzero monotonic origin preserves the full budget and absolute deadline."""
        clock = FakeClock(1000.0)
        self.assertEqual(MODULE._remaining(1090.0, clock.now), 90.0)
        api = FakeApi(["pending"] + ["pending"] * 14 + ["connected"])
        api.clock = clock
        api.connect_timeouts = 1
        result = MODULE.recover_basic_memory(
            api,
            "safe/health",
            "computer-assistant",
            policy(),
            runtime=FakeRuntime([True]),
            clock=clock.now,
            sleep=clock.sleep,
        )
        self.assertEqual(result.status, MODULE.READINESS_STATUS)
        self.assertGreater(clock.value - 1000.0, 12.0)
        self.assertLess(clock.value, 1090.0)

        timeout_clock = FakeClock(1000.0)
        timeout_api = FakeApi(["pending"] * 64)
        timeout_api.clock = timeout_clock
        timeout_api.connect_timeouts = 1
        timeout_result = MODULE.recover_basic_memory(
            timeout_api,
            "safe/health",
            "computer-assistant",
            policy(deadline_seconds=30.0, max_rechecks=16),
            runtime=FakeRuntime([True]),
            clock=timeout_clock.now,
            sleep=timeout_clock.sleep,
        )
        self.assertEqual(timeout_result.status, "pending")
        self.assertEqual(timeout_clock.value, 1030.0)
        self.assertLessEqual(timeout_clock.value, 1000.0 + 30.0)

    def test_polling_stops_at_deadline_without_reconnect_retry(self) -> None:
        """Never-connected status reaches the monotonic deadline with one connect."""
        clock = FakeClock()
        api = FakeApi(["pending"] * 40)
        api.clock = clock
        api.connect_timeouts = 1
        result = MODULE.recover_basic_memory(
            api,
            "safe/health",
            "computer-assistant",
            policy(max_rechecks=16, deadline_seconds=30.0),
            runtime=FakeRuntime([True]),
            clock=clock.now,
            sleep=clock.sleep,
        )
        self.assertFalse(result.recovered)
        self.assertEqual(api.connect_calls, 1)
        self.assertLessEqual(clock.value, 30.0)
        self.assertEqual(result.read_note_proof, "not-verified")

    def test_location_mismatch_and_wrong_server_stop_before_connect(self) -> None:
        """Primary-vs-clone location or server identity cannot trigger reconnect."""
        primary = FakeApi(["pending"], location=Path("/srv/primary"))
        primary.location_value = {"data": {"directory": str(CLONE_DIRECTORY), "project": {"id": "clone-project"}}}
        mismatch = MODULE.recover_basic_memory(primary, "safe/health", "computer-assistant", policy(), runtime=FakeRuntime([True]))
        self.assertEqual(mismatch.status, "target-location-mismatch")
        self.assertEqual(primary.connect_calls, 0)
        self.assertEqual(primary.status_calls, 0)

        wrong_server = FakeApi(["pending"], server="other-server")
        wrong = MODULE.recover_basic_memory(wrong_server, "safe/health", "computer-assistant", policy(), runtime=FakeRuntime([True]))
        self.assertEqual(wrong.status, "missing")
        self.assertEqual(wrong_server.connect_calls, 0)

    def test_initial_connected_status_skips_supported_reconnect(self) -> None:
        """A healthy location is reported as awaiting read_note without a connect call."""
        api = FakeApi(["connected"])
        result = MODULE.recover_basic_memory(api, "safe/health", "computer-assistant", policy(), runtime=FakeRuntime([True]))
        self.assertEqual(result.status, MODULE.READINESS_STATUS)
        self.assertFalse(result.recovered)
        self.assertEqual(api.connect_calls, 0)

    def test_fingerprint_rejects_symlink_and_oversized_inputs_before_open(self) -> None:
        """Approved fingerprints no-follow regular files and bound reads before content access."""
        with tempfile.TemporaryDirectory(prefix="rig-recovery-") as root:
            target = Path(root) / "target.json"
            link = Path(root) / "config.json"
            target.write_text("{}", encoding="utf-8")
            link.symlink_to(target)
            with self.assertRaises(MODULE.FingerprintError):
                MODULE._hash_path(
                    link,
                    hashlib.sha256(),
                    [MODULE.MAX_FINGERPRINT_BYTES],
                    "config",
                    deadline=100.0,
                    clock=FakeClock().now,
                )

            oversized = Path(root) / "oversized.json"
            oversized.write_bytes(b"x" * (MODULE.MAX_FINGERPRINT_BYTES + 1))
            with mock.patch.object(MODULE.os, "open", side_effect=AssertionError("content open must not run")):
                with self.assertRaises(MODULE.FingerprintError):
                    MODULE._hash_path(
                        oversized,
                        hashlib.sha256(),
                        [MODULE.MAX_FINGERPRINT_BYTES],
                        "config",
                        deadline=100.0,
                        clock=FakeClock().now,
                    )

    def test_fingerprint_deadline_stops_reads_and_prevents_canonical_apply(self) -> None:
        """Fingerprint I/O and stale-state apply stop when the shared monotonic budget expires."""
        with tempfile.TemporaryDirectory(prefix="rig-recovery-") as root:
            target = Path(root) / "config.json"
            target.write_text('{"projects":{}}', encoding="utf-8")
            clock = FakeClock()
            original_read = MODULE.os.read

            def delayed_read(descriptor: int, size: int) -> bytes:
                content = original_read(descriptor, size)
                clock.value = 1.0
                return content

            with mock.patch.object(MODULE.os, "read", side_effect=delayed_read):
                with self.assertRaises(MODULE.FingerprintTimeout):
                    MODULE._hash_path(
                        target,
                        hashlib.sha256(),
                        [MODULE.MAX_FINGERPRINT_BYTES],
                        "config",
                        deadline=1.0,
                        clock=clock.now,
                    )

        clock = FakeClock()
        commands: list[list[str]] = []

        def delayed_fingerprints() -> tuple[str, str]:
            clock.value += 1.1
            return "a" * 64, "b" * 64

        runtime = MODULE.CanonicalNativeRuntime(
            runner=lambda arguments, timeout: commands.append(arguments) or True,
            fingerprints=delayed_fingerprints,
            clock=clock.now,
        )
        preview = MODULE.NativeRuntimePreview(
            "canonical-mcp-runtime-marker", "native", "a" * 64, "b" * 64
        )
        self.assertEqual(runtime.apply_native(preview, True, 1.0), "rejected")
        self.assertEqual(commands, [])

    def test_fingerprint_excludes_database_logs_and_wal(self) -> None:
        """Only marker and exact config.json state participate in native repair digests."""
        with tempfile.TemporaryDirectory(prefix="rig-recovery-") as root:
            root_path = Path(root)
            config = root_path / "basic-memory" / "config"
            config.mkdir(parents=True)
            (root_path / "provisioned.json").write_text("marker", encoding="utf-8")
            (config / "config.json").write_text('{"projects":{}}', encoding="utf-8")
            previous = os.environ.get("OPENCODE_MCP_NATIVE_ROOT")
            os.environ["OPENCODE_MCP_NATIVE_ROOT"] = root
            try:
                before = MODULE._native_state_fingerprints()
                for name in ("memory.db", "config.log", "config.json-wal"):
                    (config / name).write_text("private", encoding="utf-8")
                self.assertEqual(MODULE._native_state_fingerprints(), before)
            finally:
                if previous is None:
                    os.environ.pop("OPENCODE_MCP_NATIVE_ROOT", None)
                else:
                    os.environ["OPENCODE_MCP_NATIVE_ROOT"] = previous

    def test_bounded_cli_api_rejects_oversized_stdout_and_stderr_before_apply(self) -> None:
        """Location/API output overflow fails closed before marker verification or apply."""
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream), tempfile.TemporaryDirectory(prefix="rig-recovery-") as root:
                script = output_script(Path(root), stream)
                api = MODULE.OpenCodeCliApi(str(script), Path.cwd(), "https://service.invalid")
                with self.assertRaises(MODULE.RecoveryOutputOverflow):
                    api.location(2.0)
                runtime = FakeRuntime([True])
                result = MODULE.recover_basic_memory(
                    api,
                    "safe/health",
                    "computer-assistant",
                    policy(),
                    runtime=runtime,
                    marker_action="apply",
                    preview=MODULE.NativeRuntimePreview(
                        "canonical-mcp-runtime-marker", "native", "a" * 64, "b" * 64
                    ),
                    approval=True,
                )
                self.assertEqual(result.status, "target-location-unavailable")
                self.assertEqual(runtime.verify_calls, 0)
                self.assertEqual(runtime.apply_calls, [])

    def test_bounded_canonical_helper_output_never_claims_readiness(self) -> None:
        """Canonical helper overflow fails closed for both probe and apply paths."""
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream), tempfile.TemporaryDirectory(prefix="rig-recovery-") as root:
                script = output_script(Path(root), stream)
                runtime = MODULE.CanonicalNativeRuntime(
                    script=script,
                    fingerprints=lambda: ("a" * 64, "b" * 64),
                )
                with self.assertRaises(MODULE.RecoveryOutputOverflow):
                    runtime.verify_native(2.0)
                api = FakeApi(["connected"])
                preview = MODULE.NativeRuntimePreview(
                    "canonical-mcp-runtime-marker", "native", "a" * 64, "b" * 64
                )
                preview_result = MODULE.recover_basic_memory(
                    api,
                    "safe/health",
                    "computer-assistant",
                    policy(),
                    runtime=runtime,
                )
                self.assertEqual(preview_result.status, "marker-verification-output-overflow")
                self.assertEqual(api.connect_calls, 0)
                apply_result = MODULE.recover_basic_memory(
                    api,
                    "safe/health",
                    "computer-assistant",
                    policy(),
                    runtime=runtime,
                    marker_action="apply",
                    preview=preview,
                    approval=True,
                )
                self.assertEqual(apply_result.status, "marker-verification-output-overflow")
                self.assertFalse(apply_result.recovered)

    def test_cleanup_failure_uses_only_bounded_waits_and_refuses(self) -> None:
        """A child that survives terminate and kill raises without an unbounded wait."""
        clock = FakeClock()

        class NeverReaped:
            def __init__(self) -> None:
                self.wait_timeouts: list[float | None] = []
                self.terminated = 0
                self.killed = 0

            def poll(self) -> None:
                return None

            def terminate(self) -> None:
                self.terminated += 1

            def kill(self) -> None:
                self.killed += 1

            def wait(self, timeout: float | None = None) -> int:
                self.wait_timeouts.append(timeout)
                if timeout is None:
                    raise AssertionError("cleanup must never wait without a timeout")
                clock.value += timeout
                raise subprocess.TimeoutExpired(["fixture"], timeout)

        process = NeverReaped()
        with self.assertRaises(MODULE.RecoveryProcessCleanupError):
            MODULE._terminate_and_reap(process, clock=clock.now)  # type: ignore[arg-type]
        self.assertEqual(process.terminated, 1)
        self.assertEqual(process.killed, 1)
        self.assertEqual(len(process.wait_timeouts), 2)
        self.assertTrue(all(timeout is not None and timeout > 0 for timeout in process.wait_timeouts))
        self.assertLessEqual(clock.value, MODULE.SUBPROCESS_CLEANUP_DEADLINE_SECONDS)

    def test_main_requires_explicit_directory(self) -> None:
        """The CLI cannot select cwd implicitly for a recovery target."""
        with mock.patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                MODULE.main(["basic-memory"])
        self.assertEqual(raised.exception.code, 2)

    def test_main_requires_explicit_server(self) -> None:
        """The CLI cannot fall back to the shared default service."""
        with mock.patch.object(sys, "stderr", io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                MODULE.main(["basic-memory", "--directory", str(Path.cwd())])
        self.assertEqual(raised.exception.code, 2)

    def _run_main_with_fake_runtime(
        self,
        api: FakeApi,
        runtime: FakeRuntime,
        *extra_arguments: str,
        clock: FakeClock | None = None,
    ) -> tuple[int, dict[str, object]]:
        """Run the CLI with fake API/runtime boundaries and parse its safe report."""
        output = io.StringIO()
        arguments = [
            "basic-memory",
            "--directory",
            str(Path.cwd()),
            "--server",
            "https://service.invalid",
            *extra_arguments,
        ]
        original_defaults = MODULE.recover_basic_memory.__kwdefaults__
        try:
            if clock is not None:
                patched_defaults = dict(original_defaults or {})
                patched_defaults["clock"] = clock.now
                patched_defaults["sleep"] = clock.sleep
                MODULE.recover_basic_memory.__kwdefaults__ = patched_defaults
            with (
                mock.patch.object(MODULE, "OpenCodeCliApi", return_value=api),
                mock.patch.object(MODULE, "CanonicalNativeRuntime", return_value=runtime),
                redirect_stdout(output),
            ):
                exit_code = MODULE.main(arguments)
        finally:
            MODULE.recover_basic_memory.__kwdefaults__ = original_defaults
        return exit_code, json.loads(output.getvalue())

    def test_main_exit_zero_means_readiness_only(self) -> None:
        """Connected readiness exits zero while the report remains explicitly un-recovered."""
        api = FakeApi(["connected"], location=Path.cwd())
        exit_code, output = self._run_main_with_fake_runtime(api, FakeRuntime([True]))
        self.assertEqual(exit_code, 0)
        self.assertEqual(output["status"], MODULE.READINESS_STATUS)
        self.assertFalse(output["recovered"])
        self.assertEqual(output["read_note_proof"], "not-verified")
        self.assertEqual(output["server_identity"], {"version": "2.0.7", "pid": 1234})
        self.assertEqual(output["plugins"], {"status": "ok", "plugins": [], "truncated": False})

    def test_plugin_list_failure_is_reported_but_does_not_block_bound_recovery(self) -> None:
        """Plugin activation evidence is independent from exact-server Basic Memory recovery."""
        api = FakeApi(["connected"], location=Path.cwd())
        api.plugin_value = MODULE.RecoveryError("private plugin failure")
        runtime = FakeRuntime([True])
        exit_code, output = self._run_main_with_fake_runtime(api, runtime)
        self.assertEqual(exit_code, 0)
        self.assertEqual(output["status"], MODULE.READINESS_STATUS)
        self.assertFalse(output["recovered"])
        self.assertEqual(output["plugins"]["status"], "unavailable")
        self.assertEqual(output["plugins"]["reason"], "live-plugin-list-unavailable")
        self.assertEqual(runtime.verify_calls, 1)
        self.assertEqual(api.location_calls, 1)
        self.assertEqual(api.status_calls, 1)

    def test_diagnose_success_and_failure_have_independent_exit_semantics(self) -> None:
        """Diagnosis uses mcp/plugin availability, not the recovery readiness status."""
        for statuses, expected_code, expected_status in [
            (["connected"], 0, "ok"),
            ([MODULE.RecoveryError("mcp unavailable")], 1, "unavailable"),
        ]:
            with self.subTest(expected_status=expected_status):
                api = FakeApi(statuses, location=Path.cwd())
                output = io.StringIO()
                with (
                    mock.patch.object(MODULE, "OpenCodeCliApi", return_value=api),
                    redirect_stdout(output),
                ):
                    exit_code = MODULE.main(
                        ["diagnose", "--directory", str(Path.cwd()), "--server", "https://service.invalid"]
                    )
                report = json.loads(output.getvalue())
                self.assertEqual(exit_code, expected_code)
                self.assertEqual(report["status"], expected_status)

    def test_server_identity_drift_at_end_fails_closed_without_readiness_or_url_leak(self) -> None:
        """A changed version/PID pair is not the same service, even at one directory."""
        api = FakeApi(["connected"], location=Path.cwd())
        api.server_identities = [MODULE.ServerIdentity("2.0.7", 1234), MODULE.ServerIdentity("2.0.8", 1234)]
        runtime = FakeRuntime([True])
        exit_code, output = self._run_main_with_fake_runtime(api, runtime)
        encoded = json.dumps(output)
        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "server-identity-changed")
        self.assertFalse(output["recovered"])
        self.assertEqual(runtime.apply_calls, [])
        self.assertNotIn("https://service.invalid", encoded)
        self.assertNotIn("paths.tmp", encoded)

    def test_missing_start_identity_refuses_marker_work(self) -> None:
        """An unproven explicit service identity stops before native marker verification."""
        api = FakeApi(["connected"], location=Path.cwd())
        api.server_identities = [MODULE.RecoveryError("identity unavailable")]
        runtime = FakeRuntime([True])
        exit_code, output = self._run_main_with_fake_runtime(api, runtime)
        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "server-identity-unavailable")
        self.assertEqual(runtime.verify_calls, 0)

    def test_api_operations_bind_exact_server_and_location_without_cross_service_auth(self) -> None:
        """Calls use only the selected service and OpenAPI deepObject location parameter."""
        response = MODULE.BoundedSubprocessResult(
            returncode=0,
            stdout=b'{"version":"2.0.7","pid":1234,"security":[],"urls":["private"],"paths":{"tmp":"/private"}}',
            stderr=b"",
        )
        selected_server = "https://selected.service.invalid"
        other_server = "https://launcher.service.invalid"
        selected_directory = Path("/srv/open-rig-clone")
        with mock.patch.object(MODULE, "_run_bounded_subprocess", return_value=response) as run:
            api = MODULE.OpenCodeCliApi("opencode", selected_directory, selected_server)
            identity = api.server_info(1.0)
            api.bind_server_identity(identity)
            api.location(1.0)
            api.list_mcp(1.0)
            api.list_plugins(1.0)
            api.connect_basic_memory(1.0)
        self.assertEqual(identity, MODULE.ServerIdentity("2.0.7", 1234))
        self.assertEqual(run.call_count, 7)
        calls = [call.args[0] for call in run.call_args_list]
        for arguments in calls:
            self.assertEqual(arguments[arguments.index("--server") + 1], selected_server)
            self.assertNotIn(other_server, arguments)
            self.assertNotIn("--header", arguments)
            self.assertFalse(any(argument.lower().startswith("authorization:") for argument in arguments))
            if arguments[-1] == "server.info":
                self.assertNotIn(f"location[directory]={selected_directory}", arguments)
            else:
                self.assertIn(f"location[directory]={selected_directory}", arguments)
        connect = next(arguments for arguments in calls if arguments[-1] == "experimental.mcp.connect")
        self.assertIn("server=basic-memory", connect)
        self.assertNotIn("urls", identity.as_dict())
        self.assertNotIn("paths.tmp", json.dumps(identity.as_dict()))

    def test_targeted_connect_checks_bound_identity_before_and_after_mutation(self) -> None:
        """The exact-server reconnect is bracketed by service-process identity checks."""
        expected = MODULE.ServerIdentity("2.0.7", 1234)
        changed = MODULE.ServerIdentity("2.0.8", 1234)
        api = MODULE.OpenCodeCliApi("opencode", Path.cwd(), "https://service.invalid")
        api.bind_server_identity(expected)
        for identities, expected_calls in (([changed], 0), ([expected, changed], 1)):
            with self.subTest(expected_calls=expected_calls):
                with (
                    mock.patch.object(api, "server_info", side_effect=identities),
                    mock.patch.object(api, "_call") as operation,
                ):
                    with self.assertRaises(MODULE.RecoveryError):
                        api.connect_basic_memory(1.0)
                self.assertEqual(operation.call_count, expected_calls)

    def test_server_info_requires_nonempty_version_and_positive_pid(self) -> None:
        """OpenAPI identity fields are required and security metadata is not retained."""
        for payload in (
            {"pid": 1234},
            {"version": "", "pid": 1234},
            {"version": "2.0.7", "pid": 0},
            {"version": "2.0.7", "pid": "1234"},
            {"version": "1.9.0", "pid": 1234},
            {"version": "two.zero.seven", "pid": 1234},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(MODULE.RecoveryError):
                    MODULE._server_identity_from_response(payload)
        identity = MODULE._server_identity_from_response({"version": "2.0.7", "pid": 1234, "security": []})
        self.assertEqual(identity.as_dict(), {"version": "2.0.7", "pid": 1234})

    def test_unsupported_server_major_stops_before_marker_apply(self) -> None:
        """A V1 service at the selected endpoint cannot authorize native marker work."""
        api = FakeApi(["connected"], location=Path.cwd())
        api.server_identities = [MODULE.ServerIdentity("1.9.0", 1234)]
        runtime = FakeRuntime([False])
        exit_code, output = self._run_main_with_fake_runtime(
            api,
            runtime,
            "--apply",
            "--approval",
            "--expected-policy-digest",
            "a" * 64,
            "--expected-state-digest",
            "b" * 64,
        )
        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "server-identity-unavailable")
        self.assertEqual(runtime.verify_calls, 0)
        self.assertEqual(runtime.apply_calls, [])

    def test_main_nonzero_for_mismatch_probe_failure_and_startup_timeout(self) -> None:
        """Target, marker, and bounded startup failures never use the readiness exit code."""
        mismatch_api = FakeApi(["connected"], location=Path.cwd())
        mismatch_api.location_value = {"data": {"directory": "/not-the-requested-target", "project": {"id": "clone-project"}}}
        mismatch_code, mismatch_output = self._run_main_with_fake_runtime(mismatch_api, FakeRuntime([True]))
        self.assertEqual(mismatch_code, 1)
        self.assertEqual(mismatch_output["status"], "target-location-mismatch")

        probe_code, probe_output = self._run_main_with_fake_runtime(
            FakeApi(["connected"], location=Path.cwd()), FakeRuntime([False])
        )
        self.assertEqual(probe_code, 1)
        self.assertEqual(probe_output["status"], "marker-repair-required")

        clock = FakeClock()
        timeout_code, timeout_output = self._run_main_with_fake_runtime(
            FakeApi(["pending"] * 40, location=Path.cwd()),
            FakeRuntime([True]),
            "--deadline",
            "30",
            "--max-rechecks",
            "16",
            clock=clock,
        )
        self.assertEqual(timeout_code, 1)
        self.assertEqual(timeout_output["status"], "pending")
        self.assertFalse(timeout_output["recovered"])

    def test_server_identity_drift_before_marker_apply_prevents_mutation(self) -> None:
        """A stale service binding stops canonical marker apply before its side effect."""
        api = FakeApi(["connected"], location=Path.cwd())
        api.server_identities = [
            MODULE.ServerIdentity("2.0.7", 1234),
            MODULE.ServerIdentity("2.0.8", 1234),
        ]
        runtime = FakeRuntime([False])
        exit_code, output = self._run_main_with_fake_runtime(
            api,
            runtime,
            "--apply",
            "--approval",
            "--expected-policy-digest",
            "a" * 64,
            "--expected-state-digest",
            "b" * 64,
        )
        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "server-identity-changed")
        self.assertEqual(runtime.apply_calls, [])

    def test_server_identity_drift_before_reconnect_prevents_connect(self) -> None:
        """A restarted selected service is rejected before targeted MCP connect."""
        api = FakeApi(["pending"], location=Path.cwd())
        api.server_identities = [
            MODULE.ServerIdentity("2.0.7", 1234),
            MODULE.ServerIdentity("2.0.8", 1234),
        ]
        exit_code, output = self._run_main_with_fake_runtime(api, FakeRuntime([True]))
        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "server-identity-changed")
        self.assertEqual(api.connect_calls, 0)

    def test_server_pid_drift_at_end_fails_closed(self) -> None:
        """A restarted service at the same URL is not the bound service instance."""
        api = FakeApi(["connected"], location=Path.cwd())
        api.server_identities = [MODULE.ServerIdentity("2.0.7", 1234), MODULE.ServerIdentity("2.0.7", 5678)]
        exit_code, output = self._run_main_with_fake_runtime(api, FakeRuntime([True]))
        self.assertEqual(exit_code, 1)
        self.assertEqual(output["status"], "server-identity-changed")

    def test_main_oversized_api_output_cannot_exit_zero(self) -> None:
        """Real bounded CLI capture maps stdout and stderr overflow to a nonzero report."""
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream), tempfile.TemporaryDirectory(prefix="rig-recovery-") as root:
                script = output_script(Path(root), stream)
                output = io.StringIO()
                with redirect_stdout(output):
                    exit_code = MODULE.main(
                        [
                            "basic-memory",
                            "--directory",
                            str(Path.cwd()),
                            "--server",
                            "https://service.invalid",
                            "--opencode-bin",
                            str(script),
                        ]
                    )
                report = json.loads(output.getvalue())
                self.assertEqual(exit_code, 1)
                self.assertEqual(report["status"], "server-identity-unavailable")

    def test_target_report_is_sanitized_and_status_is_not_recovery(self) -> None:
        """Reports identify the clone by digest and never expose paths, bodies, or recovered=true."""
        api = FakeApi(["pending", "connected"])
        result = MODULE.recover_basic_memory(api, "safe/health", "computer-assistant", policy(), runtime=FakeRuntime([True]))
        encoded = json.dumps(result.as_dict())
        self.assertEqual(result.status, MODULE.READINESS_STATUS)
        self.assertFalse(result.recovered)
        self.assertNotIn(str(CLONE_DIRECTORY), encoded)
        self.assertEqual(result.target["server"], "basic-memory")
        self.assertEqual(result.target["profile"], "native")
        self.assertIn("location", result.target)

    def test_read_note_classifier_rejects_text_and_does_not_claim_provenance(self) -> None:
        """Only a structured identity-matched caller result is classifiable, never authenticated here."""
        self.assertEqual(MODULE.classify_caller_read_note_result("note body", "safe/health"), "malformed-or-unmatched")
        self.assertEqual(MODULE.classify_caller_read_note_result(True, "safe/health"), "malformed-or-unmatched")
        self.assertEqual(
            MODULE.classify_caller_read_note_result(
                {"content": [{"type": "text", "text": "caller result"}], "structuredContent": {"note": {"identifier": "safe/health", "content": "caller result"}}},
                "safe/health",
            ),
            "structured-identity-match-unproven",
        )

    def test_source_has_no_basic_memory_transport_or_spawn_path(self) -> None:
        """The recovery implementation cannot start a duplicate Basic Memory server."""
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("basic-memory-mcp.sh", source)
        self.assertNotIn("_StdioJsonRpc", source)
        self.assertNotIn("tools/call", source)
        self.assertNotIn("authenticated=True", source)
        self.assertNotIn("subprocess.run", source)
        self.assertNotIn("process.wait()", source)
        self.assertIn("_run_bounded_subprocess", source)
        self.assertNotIn("read_note =", inspect.getsource(MODULE.recover_basic_memory))

    def test_diagnostics_omit_plugin_errors_and_control_plane_repairs(self) -> None:
        """Diagnostics are bounded and point to protected tools instead of bypassing them."""
        api = FakeApi([])
        api.list_mcp = lambda timeout: {"data": [{"name": "basic-memory", "status": {"status": "failed", "error": "token-secret"}}]}
        api.list_plugins = lambda timeout: {"data": [{"id": "plugin", "state": {"status": "failed", "error": "private"}}]}
        output = MODULE.diagnose(api, 0.5)
        encoded = json.dumps(output)
        self.assertNotIn("token-secret", encoded)
        self.assertEqual(output["ownership"]["status"], "control-plane-only")
        self.assertFalse(output["qa"]["auto_approve"])


if __name__ == "__main__":
    unittest.main()
