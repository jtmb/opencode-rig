"""Tests for bounded, metadata-only Hermes observer telemetry."""

from __future__ import annotations

import importlib.util
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType

import pytest

PLUGIN_PATH = Path(__file__).parents[1] / "__init__.py"


def load_plugin() -> ModuleType:
    """Load the Hermes directory-plugin module without requiring Hermes itself."""
    specification = importlib.util.spec_from_file_location(
        "open_rig_hermes_hooks_test", PLUGIN_PATH
    )
    assert specification is not None and specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class FakeContext:
    """Collect observer registrations for direct callback tests."""

    def __init__(self) -> None:
        self.hooks: dict[str, object] = {}

    def register_hook(self, name: str, callback: object) -> None:
        self.hooks[name] = callback


def test_register_captures_only_allowlisted_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Observer hooks persist safe labels and hashes without raw private payloads."""
    target = tmp_path / "open-rig-hooks.snapshot.json"
    monkeypatch.setenv("OPEN_RIG_HERMES_TELEMETRY_FILE", str(target))
    plugin = load_plugin()
    context = FakeContext()

    plugin.register(context)

    assert set(context.hooks) == set(plugin.HOOK_NAMES)
    context.hooks["pre_api_request"](
        session_id="session-private-01",
        turn_id="turn-private-02",
        api_request_id="request-private-03",
        model="gpt-6-luna",
        provider="openai",
        user_message="private prompt should never be stored",
        request={"authorization": "secret-token", "messages": "private transcript"},
    )
    context.hooks["post_api_request"](
        session_id="session-private-01",
        turn_id="turn-private-02",
        api_request_id="request-private-03",
        model="gpt-6-luna",
        provider="openai",
        api_duration=34.8,
        response={"secret": "private response"},
        assistant_message="private assistant content",
    )
    context.hooks["post_tool_call"](
        tool_name="read_file",
        args={"path": "/private/path"},
        result="private file contents",
        status="ok",
        duration_ms=25,
    )

    raw = target.read_text(encoding="utf-8")
    snapshot = json.loads(raw)
    assert [event["hook"] for event in snapshot["events"]] == [
        "pre_api_request",
        "post_api_request",
        "post_tool_call",
    ]
    assert snapshot["events"][0]["model"] == "gpt-6-luna"
    assert snapshot["events"][1]["status"] == "ok"
    assert snapshot["events"][1]["durationMs"] == 34
    assert snapshot["events"][0]["sessionRef"] == snapshot["events"][1]["sessionRef"]
    assert all(
        len(event.get("sessionRef", "")) in {0, 12} for event in snapshot["events"]
    )
    for private_value in (
        "session-private-01",
        "private prompt",
        "secret-token",
        "private transcript",
        "private response",
        "private assistant content",
        "/private/path",
        "private file contents",
    ):
        assert private_value not in raw
    assert target.stat().st_mode & 0o077 == 0


def test_request_failure_and_turn_completion_have_canonical_statuses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Error payloads close failed requests without persisting their contents."""
    target = tmp_path / "open-rig-hooks.snapshot.json"
    monkeypatch.setenv("OPEN_RIG_HERMES_TELEMETRY_FILE", str(target))
    plugin = load_plugin()
    context = FakeContext()

    plugin.register(context)
    context.hooks["api_request_error"](
        api_request_id="request-private-error",
        error={"type": "provider.timeout", "message": "private error detail"},
    )
    context.hooks["post_llm_call"](
        session_id="session-private-complete",
        turn_id="turn-private-complete",
        assistant_response="private assistant content",
    )

    raw = target.read_text(encoding="utf-8")
    events = json.loads(raw)["events"]
    assert [(event["hook"], event["status"]) for event in events] == [
        ("api_request_error", "error"),
        ("post_llm_call", "completed"),
    ]
    assert "private error detail" not in raw
    assert "private assistant content" not in raw


def test_snapshot_retains_only_the_newest_bounded_events(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The persistent snapshot remains a bounded newest-first-capable ring."""
    target = tmp_path / "open-rig-hooks.snapshot.json"
    monkeypatch.setenv("OPEN_RIG_HERMES_TELEMETRY_FILE", str(target))
    plugin = load_plugin()
    callback = plugin._callback("on_session_start")

    for index in range(plugin.MAX_EVENTS + 7):
        callback(session_id=f"session-{index}", model="gpt-6-luna")

    snapshot = json.loads(target.read_text(encoding="utf-8"))
    assert len(snapshot["events"]) == plugin.MAX_EVENTS
    assert snapshot["events"][0]["sessionRef"] == plugin._reference("session-7")
    assert snapshot["events"][-1]["sessionRef"] == plugin._reference(
        f"session-{plugin.MAX_EVENTS + 6}"
    )


def test_concurrent_observers_keep_a_valid_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Concurrent Hermes callback writers serialize snapshot replacement."""
    target = tmp_path / "open-rig-hooks.snapshot.json"
    monkeypatch.setenv("OPEN_RIG_HERMES_TELEMETRY_FILE", str(target))
    plugin = load_plugin()
    callback = plugin._callback("post_tool_call")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(
            pool.map(
                lambda index: callback(tool_name=f"tool_{index}", status="ok"),
                range(48),
            )
        )

    snapshot = json.loads(target.read_text(encoding="utf-8"))
    assert len(snapshot["events"]) == 48
    assert len({event["tool"] for event in snapshot["events"]}) == 48


def test_symlink_snapshot_is_not_followed_or_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A configured snapshot symlink cannot redirect telemetry writes."""
    target = tmp_path / "open-rig-hooks.snapshot.json"
    outside = tmp_path / "outside.json"
    outside.write_text('{"owner":"untouched"}', encoding="utf-8")
    target.symlink_to(outside)
    monkeypatch.setenv("OPEN_RIG_HERMES_TELEMETRY_FILE", str(target))
    plugin = load_plugin()

    plugin._callback("on_session_start")(session_id="session-1")

    assert target.is_symlink()
    assert outside.read_text(encoding="utf-8") == '{"owner":"untouched"}'


def test_relative_snapshot_override_fails_open_without_writing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A relative path override is rejected before any file can be created."""
    monkeypatch.setenv("OPEN_RIG_HERMES_TELEMETRY_FILE", "relative/snapshot.json")
    plugin = load_plugin()

    plugin._callback("on_session_start")(session_id="session-1")

    with pytest.raises(ValueError, match="absolute"):
        plugin._snapshot_path()
