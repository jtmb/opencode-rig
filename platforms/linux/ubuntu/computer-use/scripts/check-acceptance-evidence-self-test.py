#!/usr/bin/env python3
"""Exercise a copied acceptance-evidence validator in a consumer repository."""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import zlib
from pathlib import Path
from types import ModuleType


MODULE_PATH = Path(__file__).with_name("check-acceptance-evidence.py")
sys.dont_write_bytecode = True
EXECUTION_CACHE: dict[tuple[str, str, str], tuple[dict[str, object], bytes]] = {}


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    """Encode one deterministic PNG chunk for the native cell visualization."""
    return (
        len(payload).to_bytes(4, "big")
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def native_visual_bytes(spans: dict[str, object], columns: int, rows: int, cell_width: int = 6, cell_height: int = 8) -> bytes:
    """Recreate the validator's retained native OpenTUI cell visualization."""
    width = columns * cell_width
    height = rows * cell_height
    stride = width * 4 + 1
    pixels = bytearray(stride * height)

    def fill_pixel(x: int, y: int, color: list[int]) -> None:
        if x < 0 or y < 0 or x >= width or y >= height:
            return
        offset = y * stride + 1 + x * 4
        pixels[offset : offset + 4] = bytes(color)

    for raw_line in spans["lines"]:
        line = raw_line
        row = int(line["y"])
        for raw_span in line["spans"]:
            span = raw_span
            attributes = int(span["attributes"])
            foreground = list(span["fg"])
            background = list(span["bg"])
            if attributes & 32:
                foreground, background = background, foreground
            if attributes & 2:
                foreground = [(value * 65 + 50) // 100 for value in foreground[:3]] + [foreground[3]]
            for column in range(int(span["x"]), int(span["x"]) + int(span["width"])):
                cell_x = column * cell_width
                for pixel_y in range(row * cell_height, (row + 1) * cell_height):
                    for pixel_x in range(cell_x, (column + 1) * cell_width):
                        fill_pixel(pixel_x, pixel_y, background)
                if str(span["text"]).strip() and not attributes & 64:
                    glyph_width = cell_width - (1 if attributes & 1 else 2)
                    text = str(span["text"])
                    character = ord(text[min(column - int(span["x"]), max(0, len(text) - 1))]) if text else 32
                    for pixel_y in range(row * cell_height + 1, (row + 1) * cell_height - 1):
                        for pixel_x in range(cell_x + 1, cell_x + 1 + glyph_width):
                            stripe = (character + pixel_x - cell_x + (pixel_y - row * cell_height) * 3) % 5
                            fill_pixel(pixel_x, pixel_y, background if stripe == 0 else foreground)
                if attributes & 8:
                    for pixel_x in range(cell_x, (column + 1) * cell_width):
                        fill_pixel(pixel_x, (row + 1) * cell_height - 1, foreground)
                if attributes & 128:
                    for pixel_x in range(cell_x, (column + 1) * cell_width):
                        fill_pixel(pixel_x, row * cell_height + cell_height // 2, foreground)
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(bytes(pixels), 9))
        + png_chunk(b"IEND", b"")
    )


def canonical_digest(value: object) -> str:
    """Digest the same sorted JSON semantics as the copied validator."""
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def native_snapshot(snapshot_id: str, frame: str, visible: bool, color: list[int]) -> dict[str, object]:
    """Build one bounded native frame/span/state snapshot."""
    lines = frame.splitlines()
    spans = {
        "version": 1,
        "cols": 80,
        "rows": 20,
        "cursor": [0, 0],
        "lines": [
            {
                "y": row,
                "spans": [
                    {
                        "x": 0,
                        "y": row,
                        "text": line,
                        "width": 80,
                        "fg": color if line.strip() else [255, 255, 255, 255],
                        "bg": [0, 0, 0, 255],
                        "attributes": 1 if line.strip() else 0,
                    }
                ],
            }
            for row, line in enumerate(lines)
        ],
    }
    state = {"visible": visible}
    return {
        "id": snapshot_id,
        "frame": frame,
        "spans": spans,
        "state": state,
        "frame_sha256": hashlib.sha256(frame.encode("utf-8")).hexdigest(),
        "spans_sha256": canonical_digest(spans),
        "state_sha256": canonical_digest(state),
    }


def transition_event(
    capture_id: str,
    phase: str,
    action: dict[str, object],
    dispatch: dict[str, object],
    before: dict[str, object],
    after: dict[str, object],
    run_id: str,
) -> dict[str, object]:
    """Build one observed native event with recomputed transition facts."""
    result = {
        "status": "passed",
        "target": action["target"],
        "observed": {
            "visibility_before": before["state"]["visible"],
            "visibility_after": after["state"]["visible"],
            "frame_changed": before["frame_sha256"] != after["frame_sha256"],
            "spans_changed": before["spans_sha256"] != after["spans_sha256"],
            "state_changed": before["state_sha256"] != after["state_sha256"],
        },
    }
    core = {
        "version": 3,
        "phase": phase,
        "event_id": f"{capture_id}-{phase}-001",
        "action": action,
        "dispatch": dispatch,
        "provenance": {
            "scope": "native-test-renderer",
            "run_id": run_id,
            "dispatch_id": f"{capture_id}-{phase}-dispatch-001",
            "transition_id": f"{capture_id}-{phase}-transition-001",
            "dispatch_monotonic_ns": str((1, 3, 5)[("test-setup", "test-dispatch", "test-teardown").index(phase)]),
            "transition_monotonic_ns": str((2, 4, 6)[("test-setup", "test-dispatch", "test-teardown").index(phase)]),
        },
        "before": {
            "snapshot_id": before["id"],
            "frame_sha256": before["frame_sha256"],
            "spans_sha256": before["spans_sha256"],
            "state_sha256": before["state_sha256"],
        },
        "after": {
            "snapshot_id": after["id"],
            "frame_sha256": after["frame_sha256"],
            "spans_sha256": after["spans_sha256"],
            "state_sha256": after["state_sha256"],
        },
        "result": result,
    }
    return {**core, "native_event_sha256": canonical_digest(core)}


def png_bytes(width: int, height: int, red: int) -> bytes:
    """Retain the old helper name for callers outside the valid native fixture."""
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    rows = b"".join(
        b"\x00" + bytes((red, 32, 64)) * width for _ in range(height)
    )
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def rgba_png_bytes(
    width: int,
    height: int,
    *,
    compressed_pixels: bytes | None = None,
) -> bytes:
    """Build bounded RGBA PNG fixtures with optionally malformed pixel streams."""
    rows = b"".join(b"\x00" + b"\x00\x00\x00\xff" * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(rows) if compressed_pixels is None else compressed_pixels
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", compressed)
        + png_chunk(b"IEND", b"")
    )


def load_checker(path: Path) -> ModuleType:
    """Load a copied validator without spawning a child process."""
    spec = importlib.util.spec_from_file_location("consumer_acceptance_evidence", path)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load copied acceptance-evidence validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path: Path) -> str:
    """Return a fixture file's SHA-256 digest."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    """Write deterministic JSON fixture bytes."""
    path.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")


def reset_fixture_extras(root: Path) -> None:
    """Remove adversarial paths from the disposable consumer repository."""
    for path in (
        root / "ui" / "render-helper.ts",
        root / "evidence" / "linked.txt",
        root / "evidence" / "linked-directory",
        root / "evidence" / "directory",
        root / "outside.txt",
        root / "evidence" / "host-rendered.json",
        root / "evidence" / "host-interaction.json",
        root / "evidence" / "host-rendered.png",
        root / "evidence" / "host-interaction.png",
        root / "evidence" / "host-linked.png",
        root / "outside-host.png",
    ):
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    outside_directory = root / "outside-directory"
    if outside_directory.is_dir():
        shutil.rmtree(outside_directory)


def source_set_digest(root: Path, sources: list[str]) -> str:
    """Match the validator's deterministic multi-source binding."""
    payload = [
        {"path": source, "sha256": digest(root / source)} for source in sorted(sources)
    ]
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def write_execution_bundle(
    root: Path,
    *,
    prefix: str,
    source_path: str,
    behavioral_test: str,
    render_test: str,
) -> None:
    """Run each focused fixture test and retain its exact invocation receipt."""
    for kind, test_name in (("behavioral", behavioral_test), ("render", render_test)):
        output_path = f"evidence/{prefix}{kind}-output.txt"
        test_path = f"tests/{test_name}"
        source_digest = digest(root / source_path)
        test_digest = digest(root / test_path)
        cache_key = (root.as_posix(), test_path, source_digest)
        cached = EXECUTION_CACHE.get(cache_key)
        if cached is None:
            runner_code = (
                "from pathlib import Path; import sys; "
                "def_test = None\n"
                "def test(name, callback):\n"
                "    assert callable(callback), name\n"
                "    callback()\n"
                "    print('executed:' + name)\n"
                "namespace = {'test': test}\n"
                "source = Path(sys.argv[1]).read_text(encoding='utf-8')\n"
                "exec(compile(source, sys.argv[1], 'exec'), namespace)\n"
            )
            argv = [sys.executable, "-c", runner_code, test_path]
            started_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
            started_monotonic_ns = str(time.monotonic_ns())
            result = subprocess.run(
                argv,
                cwd=root,
                capture_output=True,
                check=False,
                timeout=10,
            )
            finished_monotonic_ns = str(time.monotonic_ns())
            finished_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
            if result.returncode != 0:
                raise AssertionError(
                    f"focused fixture invocation failed for {test_path}: "
                    f"{result.stdout.decode('utf-8', errors='replace')}"
                    f"{result.stderr.decode('utf-8', errors='replace')}"
                )
            if digest(root / source_path) != source_digest or digest(root / test_path) != test_digest:
                raise AssertionError("focused source or test changed during its fixture run")
            output = result.stdout + result.stderr
            report = {
                "version": 2,
                "kind": kind,
                "test": test_path,
                "test_sha256": test_digest,
                "source_sha256": source_digest,
                "result": "passed",
                "exit_code": result.returncode,
                "runner": "python-self-test-test-runner",
                "command": json.dumps(argv, ensure_ascii=False, separators=(",", ":")),
                "observed_at": finished_at,
                "max_age_days": 0,
                "output": output_path,
                "output_sha256": hashlib.sha256(output).hexdigest(),
                "invocation": {
                    "run_id": str(uuid.uuid4()),
                    "argv": argv,
                    "cwd": ".",
                    "started_at": started_at,
                    "finished_at": finished_at,
                    "started_monotonic_ns": started_monotonic_ns,
                    "finished_monotonic_ns": finished_monotonic_ns,
                    "exit_code": result.returncode,
                    "source_sha256_before": source_digest,
                    "source_sha256_after": digest(root / source_path),
                    "test_sha256_before": test_digest,
                    "test_sha256_after": digest(root / test_path),
                },
            }
            cached = (report, output)
            EXECUTION_CACHE[cache_key] = cached
        report, output = cached
        (root / output_path).write_bytes(output)
        report = {**report, "output": output_path, "output_sha256": digest(root / output_path)}
        write_json(root / "evidence" / f"{prefix}{kind}-execution.json", report)


def write_capture_bundle(
    root: Path,
    *,
    prefix: str,
    source_sha256: str,
    source_inputs: list[str],
    render_test: str,
    runtime: dict[str, object],
    renderer: dict[str, object],
    red: int,
) -> str:
    """Write one test-renderer fixture with explicit test-only provenance."""
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    generator_path = "tests/capture-generator.py"
    native_test_path = "tests/native-capture-fixture.ts"
    render_test_path = f"tests/{render_test}"
    character_path = f"evidence/{prefix}character.txt"
    visual_path = f"evidence/{prefix}visual.png"
    native_output_path = f"evidence/{prefix}native-output.json"
    capture_path = f"evidence/{prefix}capture.json"
    viewport = {"columns": 80, "rows": 20}
    color = [red, 120, 220, 255]
    capture_id = (prefix or "panel-").rstrip("-")
    capture_prefix = f"{capture_id}-"
    run_id = str(uuid.uuid4())

    def frame(*lines: str) -> str:
        visible = [line[: viewport["columns"]].ljust(viewport["columns"]) for line in lines]
        return "\n".join(visible + [" " * viewport["columns"]] * (viewport["rows"] - len(visible))) + "\n"

    frames = {
        "test-setup-before": frame(),
        "test-setup-after": frame("- Todo 1/2", "- Source Control 3 changes", "FOOTER_SENTINEL"),
        "test-dispatch-before": frame("- Todo 1/2", "- Source Control 3 changes", "FOOTER_SENTINEL"),
        "test-dispatch-after": frame("- Todo 1/2", "- Source Control 4 changes", "FOOTER_SENTINEL"),
        "test-teardown-after": frame(),
    }
    snapshots = {
        f"{capture_prefix}{snapshot_id}": native_snapshot(
            f"{capture_prefix}{snapshot_id}",
            snapshot_frame,
            not snapshot_id.endswith(("test-setup-before", "test-teardown-after")),
            color,
        )
        for snapshot_id, snapshot_frame in frames.items()
    }
    event_actions = {
        "test-setup": {"type": "setup", "target": "capture-surface"},
        "test-dispatch": {"type": "click", "target": "source-control-row", "input": {"x": 2, "y": 1}},
        "test-teardown": {"type": "teardown", "target": "capture-surface"},
    }
    event_dispatches = {
        "test-setup": {"device": "lifecycle", "method": "mount", "target": "capture-surface"},
        "test-dispatch": {"device": "mouse", "method": "click", "target": "source-control-row", "input": {"x": 2, "y": 1}},
        "test-teardown": {"device": "lifecycle", "method": "unmount", "target": "capture-surface"},
    }
    transitions = {
        "test-setup": transition_event(capture_id, "test-setup", event_actions["test-setup"], event_dispatches["test-setup"], snapshots[f"{capture_prefix}test-setup-before"], snapshots[f"{capture_prefix}test-setup-after"], run_id),
        "test-dispatch": transition_event(capture_id, "test-dispatch", event_actions["test-dispatch"], event_dispatches["test-dispatch"], snapshots[f"{capture_prefix}test-dispatch-before"], snapshots[f"{capture_prefix}test-dispatch-after"], run_id),
        "test-teardown": transition_event(capture_id, "test-teardown", event_actions["test-teardown"], event_dispatches["test-teardown"], snapshots[f"{capture_prefix}test-dispatch-after"], snapshots[f"{capture_prefix}test-teardown-after"], run_id),
    }
    native_output = {
        "version": 1,
        "id": capture_id,
        "run_id": run_id,
        "viewport": viewport,
        "snapshots": snapshots,
        "final_snapshot_id": f"{capture_prefix}test-dispatch-after",
        "reachable_targets": ["Todo", "Source Control", "FOOTER_SENTINEL"],
        "events": list(transitions.values()),
    }
    write_json(root / native_output_path, native_output)
    final_snapshot = snapshots[native_output["final_snapshot_id"]]
    (root / character_path).write_text(final_snapshot["frame"], encoding="utf-8")
    (root / visual_path).write_bytes(native_visual_bytes(final_snapshot["spans"], 80, 20))
    snapshot_bindings: dict[str, dict[str, object]] = {}
    for snapshot_id, snapshot in snapshots.items():
        snapshot_directory = root / "evidence" / f"{prefix}snapshots" / snapshot_id
        snapshot_directory.mkdir(parents=True, exist_ok=True)
        frame_file = snapshot_directory / "frame.txt"
        spans_file = snapshot_directory / "spans.json"
        state_file = snapshot_directory / "state.json"
        frame_file.write_text(snapshot["frame"], encoding="utf-8")
        write_json(spans_file, snapshot["spans"])
        write_json(state_file, snapshot["state"])
        snapshot_bindings[snapshot_id] = {
            "id": snapshot_id,
            "frame": {"path": f"evidence/{prefix}snapshots/{snapshot_id}/frame.txt", "sha256": digest(frame_file), "encoding": "utf-8"},
            "semantic_spans": {"path": f"evidence/{prefix}snapshots/{snapshot_id}/spans.json", "sha256": digest(spans_file), "semantic_sha256": snapshot["spans_sha256"], "encoding": "utf-8", "format": "opentui-captureSpans-v1"},
            "state": {"path": f"evidence/{prefix}snapshots/{snapshot_id}/state.json", "sha256": digest(state_file), "semantic_sha256": snapshot["state_sha256"], "encoding": "utf-8", "format": "native-state-v1"},
        }
    event_refs = []
    for phase in ("test-setup", "test-dispatch", "test-teardown"):
        native_event = transitions[phase]
        record_path = f"evidence/{prefix}{phase}.json"
        output_path = f"evidence/{prefix}{phase}-output.json"
        event_id = native_event["event_id"]
        output = {
            **native_event,
            "capture_id": native_output["id"],
            "native_capture_output_sha256": digest(root / native_output_path),
        }
        write_json(root / output_path, output)
        record = {
            "version": 3,
            "phase": phase,
            "event_id": event_id,
            "capture_id": native_output["id"],
            "source_sha256": source_sha256,
            "capture_generator_sha256": digest(root / generator_path),
            "render_test_sha256": digest(root / render_test_path),
            "native_capture_test_sha256": digest(root / native_test_path),
            "native_capture_output_sha256": digest(root / native_output_path),
            "runtime_id": runtime["id"],
            "renderer_id": renderer["id"],
            "viewport": viewport,
            "action": native_event["action"],
            "dispatch": native_event["dispatch"],
            "provenance": native_event["provenance"],
            "before": native_event["before"],
            "after": native_event["after"],
            "result": native_event["result"],
            "native_event_sha256": native_event["native_event_sha256"],
            "output": output_path,
            "output_sha256": digest(root / output_path),
            "observed_at": today,
        }
        write_json(root / record_path, record)
        event_refs.append(
            {
                "phase": phase,
                "event_id": event_id,
                "record": record_path,
                "record_sha256": digest(root / record_path),
            }
        )
    capture = {
        "version": 3,
        "source_sha256": source_sha256,
        "capture_generator": {
            "path": generator_path,
            "sha256": digest(root / generator_path),
        },
        "render_test": {
            "path": render_test_path,
            "sha256": digest(root / render_test_path),
        },
        "native_capture_test": {
            "path": native_test_path,
            "sha256": digest(root / native_test_path),
        },
        "native_capture_run": {
            "scope": "native-test-renderer",
            "run_id": run_id,
            "argv": ["/bin/bash", "scripts/run-bounded-command.sh", "--", "node", "--test", "tests/native-capture-fixture.ts"],
            "cwd": ".",
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            "started_monotonic_ns": "100",
            "finished_monotonic_ns": "200",
            "exit_code": 0,
            "inputs": [
                {"path": path_text, "sha256": digest(root / path_text)}
                for path_text in sorted(
                    set(source_inputs + [generator_path, render_test_path, native_test_path])
                )
            ],
        },
        "native_capture_output": {
            "path": native_output_path,
            "sha256": digest(root / native_output_path),
            "encoding": "utf-8",
            "format": "native-opentui-capture-v1",
        },
        "runtime": runtime,
        "renderer": renderer,
        "observed_at": today,
        "max_age_days": 0,
        "viewport": viewport,
        "native_snapshots": list(snapshot_bindings.values()),
        "native_frame": {
            "snapshot_id": native_output["final_snapshot_id"],
            "character_output": {
                "path": character_path,
                "sha256": digest(root / character_path),
                "encoding": "utf-8",
            },
            "semantic_spans": snapshot_bindings[native_output["final_snapshot_id"]]["semantic_spans"],
            "frame_sha256": final_snapshot["frame_sha256"],
            "spans_sha256": final_snapshot["spans_sha256"],
        },
        "character_output": {
            "path": character_path,
            "sha256": digest(root / character_path),
            "encoding": "utf-8",
        },
        "span_visualization": {
            "path": visual_path,
            "sha256": digest(root / visual_path),
            "mime": "image/png",
            "width": 480,
            "height": 160,
            "derived_from": {
                "snapshot_id": native_output["final_snapshot_id"],
                "frame_sha256": final_snapshot["frame_sha256"],
                "spans_sha256": final_snapshot["spans_sha256"],
                "renderer": "opentui-semantic-span-diagnostic-v1",
                "cell_width": 6,
                "cell_height": 8,
            },
        },
        "layout_assertions": [
            {"id": "visible_rows", "operator": "<=", "limit": 20},
            {"id": "max_line_columns", "operator": "<=", "limit": 80},
            {
                "id": "reachable_sections",
                "operator": "==",
                "limit": 3,
                "targets": ["Todo", "Source Control", "FOOTER_SENTINEL"],
            },
        ],
        "events": event_refs,
    }
    write_json(root / capture_path, capture)
    return capture_path


def prepare_fixture_files(root: Path) -> None:
    """Create machine-generated-looking files for one consumer repository."""
    reset_fixture_extras(root)
    for directory in (root / "evidence", root / "ui", root / "tests"):
        directory.mkdir(exist_ok=True)
    (root / "ui" / "panel.tsx").write_text("export const panel = true\n", encoding="utf-8")
    (root / "ui" / "secondary.tsx").write_text(
        "export const secondary = true\n", encoding="utf-8"
    )
    (root / "tests" / "capture-generator.py").write_text(
        "def visualizeNativeSpans(spans):\n"
        "    return spans\n\n"
        "captureSpans = True\n"
        "OpenTUI.testRender.captureCharFrame+captureSpans\n",
        encoding="utf-8",
    )
    (root / "tests" / "native-capture-fixture.ts").write_text(
        "import { testRender } from '@opentui/solid'\n"
        "testRender(() => jsx('text', { children: 'Native capture' }))\n"
        "setup.captureCharFrame()\n"
        "setup.captureSpans()\n"
        "setup.mockMouse.click(2, 1)\n"
        "setup.mockInput.pressArrow('down')\n",
        encoding="utf-8",
    )
    test_names = (
        "behavioral.test.ts",
        "render.test.ts",
        "secondary-behavioral.test.ts",
        "secondary-render.test.ts",
    )
    for name in test_names:
        fixture_name = "secondary" if name.startswith("secondary-") else "panel"
        (root / "tests" / name).write_text(
            f"def run_{fixture_name}():\n"
            f"    assert {fixture_name!r} in open('ui/{fixture_name}.tsx', encoding='utf-8').read()\n\n"
            f"test({name!r}, run_{fixture_name})\n",
            encoding="utf-8",
        )
    runtime_directory = root.parent / f"{root.name}-external-runtime"
    runtime_directory.mkdir(exist_ok=True)
    node = runtime_directory / "node"
    npm = runtime_directory / "npm"
    for executable in (node, npm):
        if executable.is_symlink():
            executable.unlink()
    node.write_bytes(b"fixture node runtime 26.4.0\n")
    npm.write_bytes(b"fixture npm runtime 10.8.2\n")
    node.chmod(0o755)
    npm.chmod(0o755)
    runtime = {
        "id": "node-26.4.0-npm-10.8.2",
        "name": "node",
        "version": "26.4.0",
        "identity": "node@26.4.0",
        "provisioning": "external-checksum",
        "executable": node.as_posix(),
        "executable_sha256": digest(node),
        "package_manager": "npm",
        "package_manager_version": "10.8.2",
        "package_manager_identity": "npm@10.8.2",
        "package_manager_executable": npm.as_posix(),
        "package_manager_executable_sha256": digest(npm),
    }
    renderer = {
        "id": "fixture-renderer-1",
        "name": "fixture-renderer",
        "version": "1.0.0",
        "identity": "fixture-renderer@1.0.0",
    }
    write_execution_bundle(
        root,
        prefix="",
        source_path="ui/panel.tsx",
        behavioral_test="behavioral.test.ts",
        render_test="render.test.ts",
    )
    write_execution_bundle(
        root,
        prefix="secondary-",
        source_path="ui/secondary.tsx",
        behavioral_test="secondary-behavioral.test.ts",
        render_test="secondary-render.test.ts",
    )
    write_capture_bundle(
        root,
        prefix="",
        source_sha256=digest(root / "ui/panel.tsx"),
        source_inputs=["ui/panel.tsx"],
        render_test="render.test.ts",
        runtime=runtime,
        renderer=renderer,
        red=64,
    )
    write_capture_bundle(
        root,
        prefix="secondary-",
        source_sha256=digest(root / "ui/secondary.tsx"),
        source_inputs=["ui/secondary.tsx"],
        render_test="secondary-render.test.ts",
        runtime=runtime,
        renderer=renderer,
        red=96,
    )
    write_capture_bundle(
        root,
        prefix="integrated-",
        source_sha256=source_set_digest(root, ["ui/panel.tsx", "ui/secondary.tsx"]),
        source_inputs=["ui/panel.tsx", "ui/secondary.tsx"],
        render_test="render.test.ts",
        runtime=runtime,
        renderer=renderer,
        red=128,
    )
    (root / "evidence" / "subagent.txt").write_text("subagent", encoding="utf-8")


def write_manifest(root: Path, manifest: dict[str, object]) -> None:
    """Write one manifest after resetting ordinary fixture files."""
    prepare_fixture_files(root)
    write_json(root / "acceptance-evidence.json", manifest)


def valid_manifest(root: Path) -> dict[str, object]:
    """Return the smallest compliant manifest for the disposable consumer."""
    prepare_fixture_files(root)
    runtime = json.loads(
        (root / "evidence/capture.json").read_text(encoding="utf-8")
    )["runtime"]
    renderer = json.loads(
        (root / "evidence/capture.json").read_text(encoding="utf-8")
    )["renderer"]
    source_digest = digest(root / "ui/panel.tsx")
    secondary_digest = digest(root / "ui/secondary.tsx")
    return {
        "version": 3,
        "claims": [
            {
                "id": "visible-runtime",
                "status": "planned",
                "user_visible": True,
                "runtime": True,
                "evidence": {},
            },
            {
                "id": "native-render-tests",
                "status": "limited",
                "user_visible": False,
                "runtime": False,
                "evidence": {"automated": ["evidence/capture.json"]},
            }
        ],
        "ui_acceptance": {
            "version": 3,
            "source_roots": ["ui"],
            "source_extensions": [".tsx"],
            "supported_runtimes": [runtime],
            "supported_renderers": [renderer],
            "mappings": [
                {
                    "source": "ui/panel.tsx",
                    "source_sha256": source_digest,
                    "focused_tests": {
                        "behavioral": [
                            {
                                "path": "tests/behavioral.test.ts",
                                "execution_evidence": "evidence/behavioral-execution.json",
                            }
                        ],
                        "render": [
                            {
                                "path": "tests/render.test.ts",
                                "execution_evidence": "evidence/render-execution.json",
                            }
                        ],
                    },
                    "capture_artifact": "evidence/capture.json",
                },
                {
                    "source": "ui/secondary.tsx",
                    "source_sha256": secondary_digest,
                    "focused_tests": {
                        "behavioral": [
                            {
                                "path": "tests/secondary-behavioral.test.ts",
                                "execution_evidence": "evidence/secondary-behavioral-execution.json",
                            }
                        ],
                        "render": [
                            {
                                "path": "tests/secondary-render.test.ts",
                                "execution_evidence": "evidence/secondary-render-execution.json",
                            }
                        ],
                    },
                    "capture_artifact": "evidence/secondary-capture.json",
                },
            ],
            "integrated_scenarios": [
                {
                    "id": "combined-sidebar",
                    "sources": ["ui/panel.tsx", "ui/secondary.tsx"],
                    "capture_artifact": "evidence/integrated-capture.json",
                }
            ],
        },
        "subagent_policy": {
            "allowed_agents": ["general"],
            "allowed_models": ["portable/model"],
            "max_concurrency": 1,
        },
        "subagent_evidence": [
            {
                "id": "one-background-child",
                "agent": "general",
                "model": "portable/model",
                "background": True,
                "evidence": ["evidence/subagent.txt"],
            }
        ],
    }


def expect_failure(
    checker: ModuleType,
    root: Path,
    label: str,
    expected: str,
    requested: str | None = None,
) -> None:
    """Assert that the copied validator rejects a fixture with a useful diagnostic."""
    try:
        checker.validate_manifest(root, requested)
    except Exception as exc:  # noqa: BLE001 - the fixture must reject any validator error.
        if expected not in str(exc):
            raise AssertionError(f"{label}: missing {expected!r}: {exc}") from exc
        return
    raise AssertionError(f"{label}: invalid manifest was accepted")


def capture_data(root: Path) -> dict[str, object]:
    """Read the disposable capture artifact as a mutable fixture object."""
    return json.loads((root / "evidence/capture.json").read_text(encoding="utf-8"))


def save_capture(root: Path, capture: dict[str, object]) -> None:
    """Rewrite the disposable capture artifact."""
    write_json(root / "evidence/capture.json", capture)


def ready_host_fixture(
    root: Path,
    manifest: dict[str, object],
    action_tool_id: str = "screen_terminal",
    exact_window: bool = False,
) -> dict[str, object]:
    """Build an isolated ready manifest with distinct declared host PNG captures."""
    candidate = json.loads(json.dumps(manifest))
    write_manifest(root, candidate)
    run_id = str(uuid.uuid4())
    captured = dt.datetime.now(dt.timezone.utc)
    bounds = {"x": 100, "y": 50, "width": 2, "height": 2}
    window = {
        "identity_sha256": "a" * 64,
        "process": "opencode",
        "bounds": bounds,
    }
    exact_window_binding: dict[str, object] | None = None
    if exact_window:
        core = {
            "pid": 4242,
            "hwnd": "0x0000000000012ab4",
            "title": "OpenCode operator console",
            "wm_class": "CASCADIA_HOSTING_WINDOW_CLASS",
            "bounds": dict(bounds),
        }
        exact_window_binding = {**core, "window_sha256": canonical_digest(core)}
    references: dict[str, dict[str, str]] = {}
    for kind, name, image_bytes, monotonic_ns, timestamp in (
        ("rendered_visual", "host-rendered", png_bytes(2, 2, 64), 100, captured - dt.timedelta(seconds=1)),
        ("interaction", "host-interaction", png_bytes(2, 2, 96), 200, captured),
    ):
        image_path = f"evidence/{name}.png"
        image_file = root / image_path
        image_file.write_bytes(image_bytes)
        image = {
            "path": image_path,
            "sha256": digest(image_file),
            "width": 2,
            "height": 2,
        }
        record: dict[str, object] = {
            "version": 1,
            "kind": kind,
            "tool_id": "rig-tools.vision_capture",
            "capture_method": "wsl-interop.windows.screenshot",
            "run_id": run_id,
            "captured_at": timestamp.isoformat().replace("+00:00", "Z"),
            "monotonic_ns": str(monotonic_ns),
            "window": window,
        }
        if kind == "rendered_visual":
            record["image"] = image
            if exact_window_binding is not None:
                record["exact_window"] = exact_window_binding
        else:
            record["action"] = {"tool_id": action_tool_id, "event": "escape"}
            if exact_window_binding is not None:
                receipt_core = {
                    "version": 1,
                    "action_tool_id": action_tool_id,
                    "target_window_sha256": exact_window_binding["window_sha256"],
                    "target_selector": "operator-console:goal-settings",
                    "action_monotonic_ns": "150",
                }
                record["action"]["receipt"] = {
                    **receipt_core,
                    "receipt_sha256": canonical_digest(receipt_core),
                }
            record["result"] = {
                "image": image,
                "rendered_visual_sha256": references["rendered_visual"]["sha256"],
            }
        record_path = f"evidence/{name}.json"
        record_file = root / record_path
        write_json(record_file, record)
        references[kind] = {"path": record_path, "sha256": digest(record_file)}

    ui_acceptance = candidate["ui_acceptance"]
    claims = candidate["claims"]
    assert isinstance(ui_acceptance, dict) and isinstance(claims, list)
    ui_acceptance["host_evidence"] = [
        {
            "rendered_visual": references["rendered_visual"],
            "interaction": references["interaction"],
        }
    ]
    claim = claims[0]
    assert isinstance(claim, dict)
    claim["status"] = "complete"
    claim["evidence"] = {
        "rendered_visual": [references["rendered_visual"]["path"]],
        "interaction": [references["interaction"]["path"]],
    }
    write_json(root / "acceptance-evidence.json", candidate)
    return candidate


def host_record_reference(
    manifest: dict[str, object], kind: str
) -> dict[str, str]:
    """Return one record reference from the disposable manifest."""
    ui_acceptance = manifest["ui_acceptance"]
    assert isinstance(ui_acceptance, dict)
    host_evidence = ui_acceptance["host_evidence"]
    assert isinstance(host_evidence, list) and isinstance(host_evidence[0], dict)
    reference = host_evidence[0][kind]
    assert isinstance(reference, dict)
    return reference


def read_host_record(
    root: Path, manifest: dict[str, object], kind: str
) -> dict[str, object]:
    """Read one mutable host record fixture."""
    reference = host_record_reference(manifest, kind)
    value = json.loads((root / reference["path"]).read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


def save_host_record(
    root: Path,
    manifest: dict[str, object],
    kind: str,
    record: dict[str, object],
) -> None:
    """Rewrite one host record and refresh only its declared fixture digest."""
    reference = host_record_reference(manifest, kind)
    record_path = root / reference["path"]
    write_json(record_path, record)
    reference["sha256"] = digest(record_path)
    write_json(root / "acceptance-evidence.json", manifest)


def host_image(record: dict[str, object], kind: str) -> dict[str, object]:
    """Return the screenshot metadata from a rendered or interaction record."""
    image = record.get("image")
    if kind == "interaction":
        result = record.get("result")
        assert isinstance(result, dict)
        image = result.get("image")
    assert isinstance(image, dict)
    return image


def reseal_receipt(receipt: dict[str, object]) -> None:
    """Recompute a fixture action receipt digest after an intentional mutation."""
    core = {
        key: receipt[key]
        for key in (
            "version",
            "action_tool_id",
            "target_window_sha256",
            "target_selector",
            "action_monotonic_ns",
        )
    }
    receipt["receipt_sha256"] = canonical_digest(core)


def reseal_exact_window(exact_window: dict[str, object]) -> None:
    """Recompute a fixture exact-window digest after an intentional mutation."""
    core = {
        key: exact_window[key]
        for key in ("pid", "hwnd", "title", "wm_class", "bounds")
    }
    exact_window["window_sha256"] = canonical_digest(core)


def action_receipt(record: dict[str, object]) -> dict[str, object]:
    """Return the mutable action receipt from an interaction record."""
    action = record.get("action")
    assert isinstance(action, dict)
    receipt = action.get("receipt")
    assert isinstance(receipt, dict)
    return receipt


def exact_window_binding(record: dict[str, object]) -> dict[str, object]:
    """Return the mutable exact-window binding from a rendered-visual record."""
    binding = record.get("exact_window")
    assert isinstance(binding, dict)
    return binding


def main() -> int:
    """Run valid and adversarial checks against a copied consumer validator."""
    with tempfile.TemporaryDirectory(prefix="acceptance-evidence-consumer-") as directory:
        base = Path(directory)
        consumer = base / "consumer-repository"
        consumer.mkdir()
        copied_validator = consumer / "tools" / "check-acceptance-evidence.py"
        copied_validator.parent.mkdir()
        shutil.copy2(MODULE_PATH, copied_validator)
        copied_source = copied_validator.read_text(encoding="utf-8")
        if str(MODULE_PATH.parent) in copied_source:
            raise AssertionError("copied validator contains an Open Rig absolute path")
        checker = load_checker(copied_validator)
        if hasattr(checker, "subprocess"):
            raise AssertionError("manifest validator must not import subprocess")
        vp8 = (
            b"RIFF"
            + (22).to_bytes(4, "little")
            + b"WEBPVP8 "
            + (10).to_bytes(4, "little")
            + b"\x00\x00\x00\x9d\x01\x2a"
            + (160).to_bytes(2, "little")
            + (60).to_bytes(2, "little")
        )
        assert checker._validate_image(vp8, "image/webp", "vp8") == (160, 60)
        vp8l_bits = (159 | (59 << 14)).to_bytes(4, "little")
        vp8l = (
            b"RIFF"
            + (17).to_bytes(4, "little")
            + b"WEBPVP8L"
            + (5).to_bytes(4, "little")
            + b"\x2f"
            + vp8l_bits
        )
        assert checker._validate_image(vp8l, "image/webp", "vp8l") == (160, 60)
        assert checker._png_rgba_scanlines(rgba_png_bytes(2, 2), "valid PNG") == (
            2,
            2,
            b"\x00\x00\x00\x00\xff\x00\x00\x00\xff"
            b"\x00\x00\x00\x00\xff\x00\x00\x00\xff",
        )
        compressed_rows = zlib.compress(
            b"".join(b"\x00" + b"\x00\x00\x00\xff" * 2 for _ in range(2))
        )
        for label, image, expected in (
            ("zero-width PNG", rgba_png_bytes(0, 2), "positive PNG dimensions"),
            ("zero-height PNG", rgba_png_bytes(2, 0), "positive PNG dimensions"),
            (
                "truncated PNG zlib stream",
                rgba_png_bytes(2, 2, compressed_pixels=compressed_rows[:-1]),
                "trailing or incomplete compressed pixels",
            ),
            (
                "trailing PNG zlib stream",
                rgba_png_bytes(2, 2, compressed_pixels=compressed_rows + b"trailing"),
                "trailing or incomplete compressed pixels",
            ),
        ):
            try:
                checker._png_rgba_scanlines(image, label)
            except checker.EvidenceError as exc:
                assert expected in str(exc), f"{label}: {exc}"
            else:
                raise AssertionError(f"{label}: malformed PNG was accepted")

        oversized_pixels = zlib.compress(b"\x00" + b"\x00" * 1_048_576)
        oversized_png = rgba_png_bytes(1, 1, compressed_pixels=oversized_pixels)
        decompression_limits: list[int] = []
        original_decompressobj = checker.zlib.decompressobj

        class DecompressorProbe:
            """Record the maximum decoded length requested by the PNG validator."""

            def __init__(self) -> None:
                self.inner = original_decompressobj()

            def decompress(self, data: bytes, max_length: int = 0) -> bytes:
                decompression_limits.append(max_length)
                return self.inner.decompress(data, max_length)

            def __getattr__(self, name: str) -> object:
                return getattr(self.inner, name)

        checker.zlib.decompressobj = DecompressorProbe
        try:
            try:
                checker._png_rgba_scanlines(oversized_png, "oversized PNG")
            except checker.EvidenceError as exc:
                assert "expands beyond its declared scanline size" in str(exc)
            else:
                raise AssertionError("oversized PNG expansion was accepted")
        finally:
            checker.zlib.decompressobj = original_decompressobj
        assert decompression_limits == [6], (
            f"PNG decode should cap output at expected scanline bytes + 1: {decompression_limits}"
        )
        checker._validate_layout_assertions(
            [
                {"id": "visible_rows", "operator": "<=", "limit": 3},
                {"id": "max_line_columns", "operator": "<=", "limit": 20},
                {
                    "id": "reachable_sections",
                    "operator": "==",
                    "limit": 3,
                    "targets": ["Todo", "Source Control", "FOOTER_SENTINEL"],
                },
            ],
            {"columns": 20, "rows": 3},
            "\x1b]0;sidebar\x07\x1b[36mTodo\x1b[0m\nSource Control\nFOOTER_SENTINEL\n",
            "ansi-layout",
        )

        manifest = valid_manifest(consumer)
        write_manifest(consumer, manifest)
        assert checker.validate_manifest(consumer) == (2, 1)

        ready_host_fixture(consumer, manifest)
        assert checker.validate_manifest(consumer) == (2, 1)

        for action_tool_id in (
            "screen_terminal",
            "subagent",
            "subagent_cancel",
            "task_declare",
            "todowrite",
        ):
            ready_host_fixture(consumer, manifest, action_tool_id)
            assert checker.validate_manifest(consumer) == (2, 1)

        powershell_capture = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, powershell_capture, "rendered_visual")
        record["tool_id"] = "powershell_raw"
        record["capture_method"] = "bounded-script"
        save_host_record(consumer, powershell_capture, "rendered_visual", record)
        record = read_host_record(consumer, powershell_capture, "interaction")
        record["tool_id"] = "powershell_raw"
        record["capture_method"] = "bounded-script"
        result = record["result"]
        assert isinstance(result, dict)
        result["rendered_visual_sha256"] = host_record_reference(
            powershell_capture, "rendered_visual"
        )["sha256"]
        save_host_record(consumer, powershell_capture, "interaction", record)
        assert checker.validate_manifest(consumer) == (2, 1)

        # Exact-window rendered-visual binding plus a digest-bound causal action
        # receipt. The old validator rejected exact_window/receipt as unsupported
        # fields, so this positive case failed before the schema extension.
        ready_host_fixture(consumer, manifest, exact_window=True)
        assert checker.validate_manifest(consumer) == (2, 1)

        for action_tool_id in (
            "screen_terminal",
            "subagent",
            "subagent_cancel",
            "task_declare",
            "todowrite",
        ):
            ready_host_fixture(consumer, manifest, action_tool_id, exact_window=True)
            assert checker.validate_manifest(consumer) == (2, 1)

        mismatched_receipt_target = ready_host_fixture(
            consumer, manifest, exact_window=True
        )
        record = read_host_record(consumer, mismatched_receipt_target, "interaction")
        receipt = action_receipt(record)
        receipt["target_window_sha256"] = "b" * 64
        reseal_receipt(receipt)
        save_host_record(consumer, mismatched_receipt_target, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "mismatched action receipt target",
            "target does not match the rendered_visual exact window",
        )

        missing_receipt = ready_host_fixture(consumer, manifest, exact_window=True)
        record = read_host_record(consumer, missing_receipt, "interaction")
        action = record["action"]
        assert isinstance(action, dict)
        del action["receipt"]
        save_host_record(consumer, missing_receipt, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "missing action receipt",
            "must be declared together",
        )

        missing_exact_window = ready_host_fixture(consumer, manifest, exact_window=True)
        record = read_host_record(consumer, missing_exact_window, "rendered_visual")
        del record["exact_window"]
        save_host_record(consumer, missing_exact_window, "rendered_visual", record)
        rebound_visual_digest = host_record_reference(
            missing_exact_window, "rendered_visual"
        )["sha256"]
        interaction_record = read_host_record(
            consumer, missing_exact_window, "interaction"
        )
        rebound_result = interaction_record["result"]
        assert isinstance(rebound_result, dict)
        rebound_result["rendered_visual_sha256"] = rebound_visual_digest
        save_host_record(
            consumer, missing_exact_window, "interaction", interaction_record
        )
        expect_failure(
            checker,
            consumer,
            "missing exact window binding",
            "must be declared together",
        )

        fabricated_receipt = ready_host_fixture(consumer, manifest, exact_window=True)
        record = read_host_record(consumer, fabricated_receipt, "interaction")
        receipt = action_receipt(record)
        receipt["target_selector"] = "operator-console:forged"
        save_host_record(consumer, fabricated_receipt, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "fabricated receipt selector",
            "receipt_sha256 does not match its causal action receipt",
        )

        fabricated_window = ready_host_fixture(consumer, manifest, exact_window=True)
        record = read_host_record(consumer, fabricated_window, "rendered_visual")
        exact_window_binding(record)["pid"] = 9999
        save_host_record(consumer, fabricated_window, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "fabricated exact window identity",
            "does not match its exact window identity",
        )

        unordered_receipt = ready_host_fixture(consumer, manifest, exact_window=True)
        record = read_host_record(consumer, unordered_receipt, "interaction")
        receipt = action_receipt(record)
        receipt["action_monotonic_ns"] = "250"
        reseal_receipt(receipt)
        save_host_record(consumer, unordered_receipt, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "action receipt outside render/interaction order",
            "not ordered between render and interaction",
        )

        mismatched_receipt_tool = ready_host_fixture(
            consumer, manifest, "screen_terminal", exact_window=True
        )
        record = read_host_record(consumer, mismatched_receipt_tool, "interaction")
        receipt = action_receipt(record)
        receipt["action_tool_id"] = "subagent"
        reseal_receipt(receipt)
        save_host_record(consumer, mismatched_receipt_tool, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "action receipt tool mismatch",
            "tool does not match the declared interaction action",
        )

        unknown_receipt_tool = ready_host_fixture(consumer, manifest, exact_window=True)
        record = read_host_record(consumer, unknown_receipt_tool, "interaction")
        receipt = action_receipt(record)
        receipt["action_tool_id"] = "windows_capture"
        reseal_receipt(receipt)
        save_host_record(consumer, unknown_receipt_tool, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "unallowlisted receipt action tool",
            "action_tool_id is unsupported",
        )

        missing_receipt_target = ready_host_fixture(
            consumer, manifest, exact_window=True
        )
        record = read_host_record(consumer, missing_receipt_target, "interaction")
        receipt = action_receipt(record)
        del receipt["target_window_sha256"]
        save_host_record(consumer, missing_receipt_target, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "missing receipt target identity",
            "must be a non-empty string",
        )

        float_host_version = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, float_host_version, "interaction")
        record["version"] = 1.0
        save_host_record(consumer, float_host_version, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "float host record version",
            "version must be the integer 1",
        )

        future_host_capture = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, future_host_capture, "rendered_visual")
        record["captured_at"] = "2026-01-01T12:00:01Z"
        save_host_record(consumer, future_host_capture, "rendered_visual", record)
        ui_acceptance = future_host_capture["ui_acceptance"]
        assert isinstance(ui_acceptance, dict)
        fixed_now = dt.datetime(2026, 1, 1, 12, 0, 0, tzinfo=dt.timezone.utc)
        try:
            checker._validate_host_evidence(
                consumer,
                ui_acceptance["host_evidence"],
                set(),
                validation_time=fixed_now,
            )
        except checker.EvidenceError as exc:
            assert "cannot be in the future" in str(exc), str(exc)
        else:
            raise AssertionError("same-day future host timestamp was accepted")

        missing_host_png = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, missing_host_png, "rendered_visual")
        image = host_image(record, "rendered_visual")
        image["path"] = "evidence/missing-host.png"
        save_host_record(consumer, missing_host_png, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "missing host PNG",
            "not a readable project file",
        )

        oversized_host_record = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, oversized_host_record, "rendered_visual")
        record["padding"] = "x" * checker.MAX_HOST_RECORD_BYTES
        save_host_record(consumer, oversized_host_record, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "oversized host record",
            "exceeds the",
        )

        oversized_host_png = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, oversized_host_png, "rendered_visual")
        image = host_image(record, "rendered_visual")
        image_file = consumer / image["path"]
        image_file.write_bytes(b"x" * (checker.MAX_HOST_IMAGE_BYTES + 1))
        image["sha256"] = digest(image_file)
        save_host_record(consumer, oversized_host_png, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "oversized host PNG",
            "exceeds the",
        )

        non_png_host_image = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, non_png_host_image, "rendered_visual")
        image = host_image(record, "rendered_visual")
        image_file = consumer / image["path"]
        image_file.write_bytes(b"not a PNG")
        image["sha256"] = digest(image_file)
        save_host_record(consumer, non_png_host_image, "rendered_visual", record)
        expect_failure(checker, consumer, "non-PNG host image", "is not a PNG")

        mismatched_host_dimensions = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, mismatched_host_dimensions, "rendered_visual")
        image = host_image(record, "rendered_visual")
        image["width"] = 3
        save_host_record(consumer, mismatched_host_dimensions, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "mismatched host PNG dimensions",
            "dimensions contradict the retained PNG",
        )

        duplicate_host_key = ready_host_fixture(consumer, manifest)
        reference = host_record_reference(duplicate_host_key, "rendered_visual")
        record_path = consumer / reference["path"]
        duplicate_bytes = b'{"version":1,"version":1}'
        record_path.write_bytes(duplicate_bytes)
        reference["sha256"] = hashlib.sha256(duplicate_bytes).hexdigest()
        write_json(consumer / "acceptance-evidence.json", duplicate_host_key)
        expect_failure(
            checker,
            consumer,
            "duplicate host JSON key",
            "duplicate JSON object key",
        )

        traversal_host_png = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, traversal_host_png, "rendered_visual")
        image = host_image(record, "rendered_visual")
        image["path"] = "../outside-host.png"
        save_host_record(consumer, traversal_host_png, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "traversal host PNG",
            "stay beneath the project root",
        )

        symlink_host_png = ready_host_fixture(consumer, manifest)
        outside_host_image = consumer / "outside-host.png"
        outside_host_image.write_bytes(png_bytes(2, 2, 128))
        linked_host_image = consumer / "evidence/host-linked.png"
        linked_host_image.symlink_to(outside_host_image)
        record = read_host_record(consumer, symlink_host_png, "rendered_visual")
        image = host_image(record, "rendered_visual")
        image["path"] = "evidence/host-linked.png"
        image["sha256"] = digest(outside_host_image)
        save_host_record(consumer, symlink_host_png, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "symlink host PNG",
            "rejects symlink path",
        )

        stale_host_png_digest = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, stale_host_png_digest, "rendered_visual")
        image = host_image(record, "rendered_visual")
        (consumer / image["path"]).write_bytes(png_bytes(2, 2, 128))
        save_host_record(consumer, stale_host_png_digest, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "stale host PNG digest",
            "digest mismatch",
        )

        stale_host_record_digest = ready_host_fixture(consumer, manifest)
        reference = host_record_reference(stale_host_record_digest, "rendered_visual")
        record_path = consumer / reference["path"]
        record_path.write_text(
            record_path.read_text(encoding="utf-8").replace("opencode", "OpenCode"),
            encoding="utf-8",
        )
        expect_failure(
            checker,
            consumer,
            "stale host record digest",
            "digest mismatch",
        )

        unknown_host_field = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, unknown_host_field, "rendered_visual")
        record["origin_proof"] = "unverifiable"
        save_host_record(consumer, unknown_host_field, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "unknown host field",
            "unsupported field(s)",
        )

        missing_interaction_result = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, missing_interaction_result, "interaction")
        del record["result"]
        save_host_record(consumer, missing_interaction_result, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "interaction without result binding",
            "result must be an object",
        )

        mismatched_interaction_result = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, mismatched_interaction_result, "interaction")
        result = record["result"]
        assert isinstance(result, dict)
        result["rendered_visual_sha256"] = "0" * 64
        save_host_record(consumer, mismatched_interaction_result, "interaction", record)
        expect_failure(
            checker,
            consumer,
            "interaction result without visual binding",
            "does not bind its rendered_visual record",
        )

        ready_host_fixture(consumer, manifest, "unknown_tool")
        expect_failure(
            checker,
            consumer,
            "unknown interaction action tool",
            "action.tool_id is unsupported",
        )

        rejected_browser_tool = ready_host_fixture(consumer, manifest)
        record = read_host_record(consumer, rejected_browser_tool, "rendered_visual")
        record["tool_id"] = "integrated_browser.screenshot"
        save_host_record(consumer, rejected_browser_tool, "rendered_visual", record)
        expect_failure(
            checker,
            consumer,
            "rejected browser screenshot identity",
            "unsupported host capture tool",
        )

        pending_ui = json.loads(json.dumps(manifest))
        pending_ui["ui_acceptance"] = {
            "version": 3,
            "status": "pending",
            "reason": "current UI captures have no live screenshot or host-dispatch proof",
            "source_roots": ["ui"],
            "source_extensions": [".tsx"],
            "source_files": [],
        }
        pending_ui["claims"][1] = {
            "id": "independent-fixture",
            "status": "limited",
            "user_visible": False,
            "runtime": False,
            "evidence": {"automated": ["evidence/subagent.txt"]},
        }
        write_manifest(consumer, pending_ui)
        assert checker.validate_manifest(consumer) == (2, 1)

        pending_host_evidence = json.loads(json.dumps(pending_ui))
        pending_host_evidence["ui_acceptance"]["host_evidence"] = []
        write_manifest(consumer, pending_host_evidence)
        expect_failure(
            checker,
            consumer,
            "pending inventory host evidence",
            "unsupported field(s): host_evidence",
        )

        span_image_claim = json.loads(json.dumps(manifest))
        span_image_claim["claims"][0]["status"] = "limited"
        span_image_claim["claims"][0]["evidence"] = {
            "rendered_visual": ["evidence/visual.png"]
        }
        write_manifest(consumer, span_image_claim)
        expect_failure(
            checker,
            consumer,
            "span visualization promoted to screenshot",
            "native span visualizations are test-only",
        )

        renderer_dispatch_claim = json.loads(json.dumps(manifest))
        renderer_dispatch_claim["claims"][1]["evidence"] = {
            "interaction": ["evidence/test-dispatch.json"]
        }
        write_manifest(consumer, renderer_dispatch_claim)
        expect_failure(
            checker,
            consumer,
            "renderer dispatch promoted to host interaction",
            "native test-renderer events are test-only",
        )

        legacy = json.loads(json.dumps(manifest))
        legacy["version"] = 2
        del legacy["ui_acceptance"]
        write_manifest(consumer, legacy)
        expect_failure(
            checker,
            consumer,
            "legacy manifest",
            "current machine-generated contract version 3",
        )
        write_manifest(consumer, manifest)

        old_live_review = json.loads(json.dumps(manifest))
        old_live_review["version"] = 2
        old_live_review["ui_acceptance"]["version"] = 1
        old_live_review["ui_acceptance"]["mappings"][0]["live_review"] = {
            "mode": "ephemeral_live_review",
            "review": "text",
            "open": ["evidence/open.txt"],
            "interact": ["evidence/interact.txt"],
            "close": ["evidence/close.txt"],
        }
        del old_live_review["ui_acceptance"]["mappings"][0]["capture_artifact"]
        write_manifest(consumer, old_live_review)
        expect_failure(
            checker,
            consumer,
            "old ephemeral live review",
            "current machine-generated contract version 3",
        )
        write_manifest(consumer, manifest)

        old_ui_contract = json.loads(json.dumps(manifest))
        old_ui_contract["ui_acceptance"]["version"] = 2
        write_manifest(consumer, old_ui_contract)
        expect_failure(
            checker,
            consumer,
            "old UI acceptance contract",
            "ui_acceptance.version must be 3",
        )

        empty_claims = json.loads(json.dumps(manifest))
        empty_claims["claims"] = []
        write_manifest(consumer, empty_claims)
        expect_failure(checker, consumer, "empty claims", "claims must not be empty")

        boolean_version = json.loads(json.dumps(manifest))
        boolean_version["version"] = True
        write_manifest(consumer, boolean_version)
        expect_failure(checker, consumer, "boolean version", "contract version 3")

        manual_status = json.loads(json.dumps(manifest))
        manual_status["ui_acceptance"]["mappings"][0]["focused_tests"]["render"][0][
            "status"
        ] = "passed"
        write_manifest(consumer, manual_status)
        expect_failure(checker, consumer, "manual focused-test status", "unsupported field")

        manual_boolean = json.loads(json.dumps(manifest))
        write_manifest(consumer, manual_boolean)
        capture = capture_data(consumer)
        capture["layout_assertions"][0]["passed"] = True
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "manual layout pass boolean",
            "unsupported field",
        )

        authored_observed = json.loads(json.dumps(manifest))
        write_manifest(consumer, authored_observed)
        capture = capture_data(consumer)
        capture["layout_assertions"][0]["observed"] = 1
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "authored layout measurement",
            "unsupported field",
        )

        stale_source = json.loads(json.dumps(manifest))
        stale_source["ui_acceptance"]["mappings"][0]["source_sha256"] = "0" * 64
        write_manifest(consumer, stale_source)
        expect_failure(checker, consumer, "stale source digest", "stale UI source digest")

        unexecuted_report = json.loads(json.dumps(manifest))
        write_manifest(consumer, unexecuted_report)
        report_path = consumer / "evidence/render-execution.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        del report["invocation"]
        write_json(report_path, report)
        expect_failure(
            checker,
            consumer,
            "unexecuted focused report",
            "execution_evidence.invocation must be an object",
        )

        wrong_invocation = json.loads(json.dumps(manifest))
        write_manifest(consumer, wrong_invocation)
        report_path = consumer / "evidence/render-execution.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        report["invocation"]["argv"] = [sys.executable, "-c", "pass"]
        report["command"] = json.dumps(
            report["invocation"]["argv"], ensure_ascii=False, separators=(",", ":")
        )
        write_json(report_path, report)
        expect_failure(
            checker,
            consumer,
            "focused report command mismatch",
            "does not invoke focused test",
        )

        contradictory = json.loads(json.dumps(manifest))
        write_manifest(consumer, contradictory)
        capture = capture_data(consumer)
        capture["source_sha256"] = "0" * 64
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "contradictory capture source digest",
            "does not match the mapped UI source",
        )

        synthetic_native = json.loads(json.dumps(manifest))
        write_manifest(consumer, synthetic_native)
        capture = capture_data(consumer)
        native_test_path = consumer / capture["native_capture_test"]["path"]
        native_test_path.write_text("TAP version 13\n", encoding="utf-8")
        native_test_digest = digest(native_test_path)
        capture["native_capture_test"]["sha256"] = native_test_digest
        for event_ref in capture["events"]:
            record_path = consumer / event_ref["record"]
            record = json.loads(record_path.read_text(encoding="utf-8"))
            record["native_capture_test_sha256"] = native_test_digest
            write_json(record_path, record)
            event_ref["record_sha256"] = digest(record_path)
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "synthetic native fixture",
            "forbidden synthetic evidence marker",
        )

        null_render = json.loads(json.dumps(manifest))
        write_manifest(consumer, null_render)
        capture = capture_data(consumer)
        native_test_path = consumer / capture["native_capture_test"]["path"]
        native_test_path.write_text(
            "import { testRender } from '@opentui/solid'\n"
            "testRender(() => null)\n"
            "setup.captureCharFrame()\n"
            "setup.captureSpans()\n"
            "setup.mockMouse.click(2, 1)\n"
            "setup.mockInput.pressArrow('down')\n",
            encoding="utf-8",
        )
        capture["native_capture_test"]["sha256"] = digest(native_test_path)
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "empty native test render",
            "testRender callback returns no native frame",
        )

        missing_dispatch_receipt = json.loads(json.dumps(manifest))
        write_manifest(consumer, missing_dispatch_receipt)
        capture = capture_data(consumer)
        native_output_path = consumer / capture["native_capture_output"]["path"]
        native_output = json.loads(native_output_path.read_text(encoding="utf-8"))
        event = native_output["events"][1]
        del event["provenance"]
        event["native_event_sha256"] = canonical_digest(
            {key: value for key, value in event.items() if key != "native_event_sha256"}
        )
        write_json(native_output_path, native_output)
        capture["native_capture_output"]["sha256"] = digest(native_output_path)
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "missing native dispatch receipt",
            "native_capture_output.events[1].provenance must be an object",
        )

        missing_native_spans = json.loads(json.dumps(manifest))
        write_manifest(consumer, missing_native_spans)
        capture = capture_data(consumer)
        native_output_path = consumer / capture["native_capture_output"]["path"]
        native_output = json.loads(native_output_path.read_text(encoding="utf-8"))
        first_snapshot = next(iter(native_output["snapshots"].values()))
        del first_snapshot["spans"]
        write_json(native_output_path, native_output)
        native_output_digest = digest(native_output_path)
        capture["native_capture_output"]["sha256"] = native_output_digest
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "missing native semantic spans",
            "spans",
        )

        mismatched_native_frame = json.loads(json.dumps(manifest))
        write_manifest(consumer, mismatched_native_frame)
        capture = capture_data(consumer)
        capture["native_frame"]["frame_sha256"] = "0" * 64
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "mismatched native frame binding",
            "native_frame.frame_sha256 contradicts the final snapshot",
        )

        mismatched_native_event = json.loads(json.dumps(manifest))
        write_manifest(consumer, mismatched_native_event)
        capture = capture_data(consumer)
        interact_record = json.loads(
            (consumer / "evidence/test-dispatch.json").read_text(encoding="utf-8")
        )
        interact_record["after"]["spans_sha256"] = "0" * 64
        write_json(consumer / "evidence/test-dispatch.json", interact_record)
        capture["events"][1]["record_sha256"] = digest(consumer / "evidence/test-dispatch.json")
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "mismatched native event snapshot",
            "record.after.spans_sha256 contradicts",
        )

        unsupported_runtime = json.loads(json.dumps(manifest))
        write_manifest(consumer, unsupported_runtime)
        capture = capture_data(consumer)
        capture["runtime"]["id"] = "python-3.13"
        save_capture(consumer, capture)
        expect_failure(checker, consumer, "unsupported runtime", "unsupported runtime")

        contradictory_interaction = json.loads(json.dumps(manifest))
        write_manifest(consumer, contradictory_interaction)
        capture = capture_data(consumer)
        interact_record = json.loads(
            (consumer / "evidence/test-dispatch.json").read_text(encoding="utf-8")
        )
        interact_record["result"]["observed"]["frame_changed"] = False
        write_json(consumer / "evidence/test-dispatch.json", interact_record)
        capture["events"][1]["record_sha256"] = digest(
            consumer / "evidence/test-dispatch.json"
        )
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "contradictory interaction result",
            "observed contradicts the retained native snapshots",
        )

        markdown_phase = json.loads(json.dumps(manifest))
        write_manifest(consumer, markdown_phase)
        (consumer / "evidence/narrative.md").write_text("prose", encoding="utf-8")
        capture = capture_data(consumer)
        for event in capture["events"]:
            event["record"] = "evidence/narrative.md"
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "one Markdown narrative across phases",
            "Markdown narrative",
        )

        missing_screenshot = json.loads(json.dumps(manifest))
        write_manifest(consumer, missing_screenshot)
        (consumer / "evidence/visual.png").write_bytes(b"")
        capture = capture_data(consumer)
        capture["span_visualization"]["sha256"] = hashlib.sha256(b"").hexdigest()
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "missing screenshot bytes",
            "must contain bytes",
        )

        wrong_dimensions = json.loads(json.dumps(manifest))
        write_manifest(consumer, wrong_dimensions)
        capture = capture_data(consumer)
        capture["span_visualization"]["width"] = 159
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "contradictory screenshot dimensions",
            "width contradicts the retained image",
        )

        stale_capture = json.loads(json.dumps(manifest))
        write_manifest(consumer, stale_capture)
        capture = capture_data(consumer)
        yesterday = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
        capture["observed_at"] = yesterday.isoformat()
        save_capture(consumer, capture)
        expect_failure(checker, consumer, "stale capture", "is stale")

        density_overflow = json.loads(json.dumps(manifest))
        write_manifest(consumer, density_overflow)
        capture = capture_data(consumer)
        (consumer / "evidence/character.txt").write_text(
            "\n".join(f"visible row {index}" for index in range(21)) + "\n",
            encoding="utf-8",
        )
        capture["character_output"]["sha256"] = digest(
            consumer / "evidence/character.txt"
        )
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "unbounded density",
            "exactly the native viewport rows",
        )

        tab_width_overflow = json.loads(json.dumps(manifest))
        write_manifest(consumer, tab_width_overflow)
        capture = capture_data(consumer)
        (consumer / "evidence/character.txt").write_text(
            "\t" * 11 + "\nTodo\nSource Control\nFOOTER_SENTINEL\n",
            encoding="utf-8",
        )
        capture["character_output"]["sha256"] = digest(
            consumer / "evidence/character.txt"
        )
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "tab-expanded width overflow",
            "exactly the native viewport rows",
        )

        missing_reachability = json.loads(json.dumps(manifest))
        write_manifest(consumer, missing_reachability)
        capture = capture_data(consumer)
        capture["layout_assertions"] = capture["layout_assertions"][:2]
        save_capture(consumer, capture)
        expect_failure(
            checker,
            consumer,
            "missing reachability assertions",
            "missing required assertion",
        )

        missing_integrated = json.loads(json.dumps(manifest))
        del missing_integrated["ui_acceptance"]["integrated_scenarios"]
        write_manifest(consumer, missing_integrated)
        expect_failure(
            checker,
            consumer,
            "missing integrated scenario",
            "must contain a multi-source capture",
        )

        stale_external_runtime = json.loads(json.dumps(manifest))
        write_manifest(consumer, stale_external_runtime)
        runtime_path = Path(
            stale_external_runtime["ui_acceptance"]["supported_runtimes"][0][
                "executable"
            ]
        )
        runtime_path.write_bytes(b"tampered external runtime\n")
        expect_failure(
            checker,
            consumer,
            "tampered external runtime",
            "digest mismatch",
        )

        symlinked_external_runtime = json.loads(json.dumps(manifest))
        write_manifest(consumer, symlinked_external_runtime)
        npm_path = Path(
            symlinked_external_runtime["ui_acceptance"]["supported_runtimes"][0][
                "package_manager_executable"
            ]
        )
        node_path = Path(
            symlinked_external_runtime["ui_acceptance"]["supported_runtimes"][0][
                "executable"
            ]
        )
        npm_path.unlink()
        npm_path.symlink_to(node_path)
        expect_failure(
            checker,
            consumer,
            "symlinked external runtime",
            "rejects symlink paths",
        )

        skipped_render = json.loads(json.dumps(manifest))
        write_manifest(consumer, skipped_render)
        (consumer / "tests/render.test.ts").write_text(
            'import test from "node:test"\n\ntest.skip("not acceptance", () => {})\n',
            encoding="utf-8",
        )
        expect_failure(checker, consumer, "skipped render execution", "contains a skipped")

        wrong_path = json.loads(json.dumps(manifest))
        write_manifest(consumer, wrong_path)
        wrong_path["claims"][0]["evidence"]["rendered_visual"] = [
            "evidence/does-not-exist.png"
        ]
        write_manifest(consumer, wrong_path)
        expect_failure(checker, consumer, "absent visual claim", "not a readable project file")

        absolute_path = json.loads(json.dumps(manifest))
        write_manifest(consumer, absolute_path)
        absolute_path["claims"][0]["evidence"]["interaction"] = [
            str(consumer / "evidence/open.json")
        ]
        write_manifest(consumer, absolute_path)
        expect_failure(checker, consumer, "absolute evidence path", "relative")

        symlink = json.loads(json.dumps(manifest))
        write_manifest(consumer, symlink)
        outside = consumer / "outside.txt"
        outside.write_text("outside", encoding="utf-8")
        (consumer / "evidence/linked.txt").symlink_to(outside)
        symlink["claims"][0]["evidence"]["interaction"] = ["evidence/linked.txt"]
        write_manifest(consumer, symlink)
        (consumer / "evidence/linked.txt").symlink_to(outside)
        expect_failure(checker, consumer, "symlink evidence path", "symlink")

        print(
            "OK: copied consumer validator covers v3 migration, native OpenTUI frame/span/state "
            "bindings, concrete transitions, source/test/capture/runtime digests, checksum-bound "
            "external Node/npm, structured actions/results, measured layout including tabs, retained "
            "PNG/WebP dimensions, bounded PNG expansion and malformed-stream rejection, multi-source "
            "integration, declared host TUI captures and allowlisted action tools, "
            "exact-window/causal-action-receipt bindings and their fabrication/ordering rejections, "
            "same-day future "
            "rejection, float versions, "
            "missing/oversized/non-PNG/duplicate-key/traversal/symlink/stale-digest evidence, "
            "unknown fields, missing interaction-result bindings, skipped render execution, "
            "manual/Markdown evidence, safe paths, and no subprocess"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
