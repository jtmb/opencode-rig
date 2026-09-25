#!/usr/bin/env python3
"""Exercise lockout recovery against disposable checkout-shaped fixtures only."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SOURCE_SCRIPT = Path(__file__).resolve().with_name("recover-orchestration-lockout.py")
SCRIPT_RELATIVE = Path("platforms/linux/ubuntu/computer-use/scripts/recover-orchestration-lockout.py")
AGENTS = "AGENTS.md"
AGENT_POLICY = "docs/agent-policy.md"


def write_text(root: Path, relative: str, text: str) -> Path:
    """Create a fixture file with UTF-8 text and return its path."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def create_fixture(parent: Path, name: str) -> tuple[Path, Path]:
    """Create a disposable checkout layout and copy in the real maintenance CLI."""
    root = parent / name
    script = root / SCRIPT_RELATIVE
    script.parent.mkdir(parents=True)
    shutil.copyfile(SOURCE_SCRIPT, script)
    write_text(root, AGENTS, "fixture policy marker\nsecond line\n")
    write_text(root, AGENT_POLICY, "fixture enforcement marker\n")
    write_text(
        root,
        "platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/policy.ts",
        "export const fixture = true\n",
    )
    write_text(
        root,
        "platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/index.ts",
        "export const fixtureIndex = true\n",
    )
    return root, script


def write_spec(parent: Path, name: str, document: object) -> Path:
    """Serialize a test spec outside the disposable repository tree."""
    path = parent / f"{name}.json"
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


def invoke(
    root: Path,
    script: Path,
    spec: Path,
    state_dir: Path,
    *arguments: str,
) -> subprocess.CompletedProcess[str]:
    """Run the copied CLI with fixture-local state and bounded output capture."""
    environment = os.environ.copy()
    environment["HOME"] = str(root.parent / "home")
    environment["XDG_DATA_HOME"] = str(root.parent / "home" / ".local" / "share")
    environment["XDG_CONFIG_HOME"] = str(root.parent / "home" / ".config")
    environment.pop("XDG_STATE_HOME", None)
    environment.pop("OPENCODE_STORAGE_DIR", None)
    environment.pop("OPENCODE_DATA_DIR", None)
    environment.pop("OPENCODE_V2_BIN", None)
    return subprocess.run(
        [
            sys.executable,
            str(script),
            "--spec",
            str(spec),
            "--state-dir",
            str(state_dir),
            *arguments,
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=15,
        env=environment,
        check=False,
    )


def require(condition: bool, message: str) -> None:
    """Fail the self-test with a concise case label."""
    if not condition:
        raise AssertionError(message)


def one_edit(file: str, old: str = "fixture policy marker", new: str = "recovered marker") -> dict[str, object]:
    """Return a small valid edit document for one fixture."""
    return {"file": file, "old": old, "new": new}


def main() -> int:
    """Run adversarial input, validation, dry-run, and isolated apply cases."""
    if not SOURCE_SCRIPT.is_file():
        print(f"ERROR: recovery script is missing: {SOURCE_SCRIPT}", file=sys.stderr)
        return 1

    cases = 0
    with tempfile.TemporaryDirectory(prefix="orchestration-lockout-self-test-") as temporary:
        sandbox = Path(temporary)

        root, script = create_fixture(sandbox, "allowlist")
        outside_file = write_text(sandbox, "outside.txt", "outside marker\n")
        package_file = write_text(root, "package.json", "{}\n")
        opencode_file = write_text(root, "opencode.json", "{}\n")
        refused_paths = [
            str(package_file.relative_to(root)),
            str(opencode_file.relative_to(root)),
            str(outside_file),
            "docs/../AGENTS.md",
        ]
        for index, forbidden in enumerate(refused_paths, start=1):
            spec = write_spec(
                sandbox,
                f"allowlist-{index}",
                {"reason": "allowlist refusal test", "edits": [one_edit(forbidden)]},
            )
            state_dir = sandbox / f"state-allowlist-{index}"
            result = invoke(root, script, spec, state_dir)
            require(
                result.returncode != 0 and "REFUSED:" in result.stderr,
                f"allowlist path should be refused: {forbidden}: {result.stdout}{result.stderr}",
            )
            require(not state_dir.exists(), "allowlist refusal must not create maintenance state")
            cases += 1

        root, script = create_fixture(sandbox, "missing-old")
        spec = write_spec(
            sandbox,
            "missing-old",
            {"reason": "missing old text test", "edits": [one_edit(AGENTS, "absent marker")]},
        )
        result = invoke(root, script, spec, sandbox / "state-missing-old")
        require(result.returncode != 0 and "found 0 matches" in result.stderr, "missing old text must fail")
        cases += 1

        root, script = create_fixture(sandbox, "duplicated-old")
        write_text(root, AGENTS, "repeat marker repeat marker\n")
        spec = write_spec(
            sandbox,
            "duplicated-old",
            {"reason": "duplicated old text test", "edits": [one_edit(AGENTS, "repeat marker")]},
        )
        result = invoke(root, script, spec, sandbox / "state-duplicated-old")
        require(result.returncode != 0 and "found 2 matches" in result.stderr, "duplicated old text must fail")
        cases += 1

        root, script = create_fixture(sandbox, "all-or-nothing")
        agents_path = root / AGENTS
        original_agents = agents_path.read_bytes()
        spec = write_spec(
            sandbox,
            "all-or-nothing",
            {
                "reason": "multi-file validation test",
                "edits": [
                    one_edit(AGENTS),
                    one_edit(AGENT_POLICY, "missing enforcement marker"),
                ],
            },
        )
        state_dir = sandbox / "state-all-or-nothing"
        result = invoke(root, script, spec, state_dir, "--apply")
        require(result.returncode != 0, "invalid edit in a later file must reject the full apply")
        require(agents_path.read_bytes() == original_agents, "earlier valid file must remain untouched")
        require(not state_dir.exists(), "validation failure must occur before backup or audit creation")
        cases += 1

        root, script = create_fixture(sandbox, "dry-run")
        agents_path = root / AGENTS
        original_agents = agents_path.read_bytes()
        spec = write_spec(
            sandbox,
            "dry-run",
            {"reason": "dry-run test", "edits": [one_edit(str(agents_path))]},
        )
        state_dir = sandbox / "state-dry-run"
        result = invoke(root, script, spec, state_dir)
        require(result.returncode == 0, f"valid dry-run should succeed: {result.stderr}")
        require(agents_path.read_bytes() == original_agents, "dry-run must not change policy content")
        require(not state_dir.exists(), "dry-run must not create backup or audit state")
        require("before_sha256=" in result.stdout and "after_sha256=" in result.stdout, "dry-run must report digests")
        cases += 1

        root, script = create_fixture(sandbox, "plugin-storage-state")
        agents_path = root / AGENTS
        original_agents = agents_path.read_bytes()
        spec = write_spec(
            sandbox,
            "plugin-storage-state",
            {"reason": "plugin storage protection test", "edits": [one_edit(AGENTS)]},
        )
        state_dir = sandbox / "home" / ".local" / "share" / "opencode" / "storage" / "policy-maintenance"
        result = invoke(root, script, spec, state_dir, "--apply")
        require(result.returncode != 0 and "protected OpenCode paths" in result.stderr, "plugin storage state path must be refused")
        require(agents_path.read_bytes() == original_agents and not state_dir.exists(), "plugin storage refusal must make no writes")
        cases += 1

        root, script = create_fixture(sandbox, "git-state")
        agents_path = root / AGENTS
        original_agents = agents_path.read_bytes()
        spec = write_spec(
            sandbox,
            "git-state",
            {"reason": "git internals protection test", "edits": [one_edit(AGENTS)]},
        )
        state_dir = sandbox / "other-checkout" / ".git" / "policy-maintenance"
        result = invoke(root, script, spec, state_dir, "--apply")
        require(result.returncode != 0 and ".git internals" in result.stderr, "state inside .git must be refused")
        require(agents_path.read_bytes() == original_agents and not state_dir.exists(), ".git refusal must make no writes")
        cases += 1

        root, script = create_fixture(sandbox, "apply")
        agents_path = root / AGENTS
        original_agents = agents_path.read_bytes()
        spec = write_spec(
            sandbox,
            "apply",
            {"reason": "fixture operator authorization", "edits": [one_edit(AGENTS)]},
        )
        state_dir = sandbox / "state-apply"
        result = invoke(root, script, spec, state_dir, "--apply", "--reason", "authorized fixture apply")
        require(result.returncode == 0, f"isolated apply should succeed: {result.stderr}")
        backups = list((state_dir / "backups").iterdir())
        require(len(backups) == 1 and backups[0].is_dir(), "apply must create one timestamped backup directory")
        backup_dir = backups[0]
        manifest = json.loads((backup_dir / "manifest.json").read_text(encoding="utf-8"))
        require(manifest["reason"] == "authorized fixture apply", "reason override must be recorded in the manifest")
        require((backup_dir / "files" / AGENTS).read_bytes() == original_agents, "backup must contain pristine bytes")
        require(agents_path.read_text(encoding="utf-8").startswith("recovered marker"), "apply must write the exact replacement")
        audit_lines = (state_dir / "audit.jsonl").read_text(encoding="utf-8").splitlines()
        require(len(audit_lines) == 1, "apply must append one audit record")
        audit = json.loads(audit_lines[0])
        require(audit["status"] == "applied" and audit["reason"] == "authorized fixture apply", "audit must record apply status and reason")
        cases += 1

        root, script = create_fixture(sandbox, "apply-rollback")
        agents_path = root / AGENTS
        original_agents = agents_path.read_bytes()
        spec = write_spec(
            sandbox,
            "apply-rollback",
            {"reason": "audit failure rollback test", "edits": [one_edit(AGENTS)]},
        )
        state_dir = sandbox / "state-apply-rollback"
        state_dir.mkdir()
        external_audit_target = write_text(sandbox, "protected-audit-target.txt", "must remain unchanged\n")
        (state_dir / "audit.jsonl").symlink_to(external_audit_target)
        result = invoke(root, script, spec, state_dir, "--apply")
        require(
            result.returncode != 0 and "rollback complete" in result.stderr,
            f"audit failure after write must trigger rollback: {result.stdout}{result.stderr}",
        )
        require(agents_path.read_bytes() == original_agents, "rollback must restore the pristine backup bytes")
        require(external_audit_target.read_text(encoding="utf-8") == "must remain unchanged\n", "audit symlink target must remain untouched")
        backups = list((state_dir / "backups").iterdir())
        require(len(backups) == 1 and (backups[0] / "files" / AGENTS).read_bytes() == original_agents, "rollback backup must be retained")
        cases += 1

        root, script = create_fixture(sandbox, "optional-verify")
        policy_ts = "platforms/linux/ubuntu/computer-use/plugins-v2/orchestration-policy/src/policy.ts"
        original_typescript = (root / policy_ts).read_bytes()
        write_text(
            root,
            ".opencode/rig-gates.json",
            json.dumps({"qaRuntime": {"executable": "toolchains/node/bin/node"}}),
        )
        spec = write_spec(
            sandbox,
            "optional-verify",
            {
                "reason": "missing optional Node test",
                "edits": [one_edit(policy_ts, "fixture = true", "fixture = false")],
            },
        )
        state_dir = sandbox / "state-optional-verify"
        result = invoke(root, script, spec, state_dir, "--verify")
        require(result.returncode == 0 and "VERIFY: skipped" in result.stdout, "missing optional Node must be reported without failure")
        require((root / policy_ts).read_bytes() == original_typescript, "optional verification dry-run must not write policy files")
        require(not state_dir.exists(), "optional verification dry-run must not create maintenance state")
        cases += 1

        root, script = create_fixture(sandbox, "malformed-json")
        malformed = sandbox / "malformed.json"
        malformed.write_text("{", encoding="utf-8")
        result = invoke(root, script, malformed, sandbox / "state-malformed")
        require(result.returncode != 0 and "REFUSED:" in result.stderr, "malformed JSON must fail")
        cases += 1

        root, script = create_fixture(sandbox, "oversized")
        oversized_edits = [
            {"file": AGENTS, "old": "a" * 40_000, "new": "b" * 40_000}
            for _ in range(4)
        ]
        spec = write_spec(sandbox, "oversized", {"reason": "size bound test", "edits": oversized_edits})
        result = invoke(root, script, spec, sandbox / "state-oversized")
        require(result.returncode != 0 and "total old/new edit text" in result.stderr, "oversized aggregate payload must fail")
        cases += 1

        oversized_text = "x" * (64 * 1024 + 1)
        spec = write_spec(
            sandbox,
            "oversized-single-edit",
            {"reason": "per-edit size bound test", "edits": [one_edit(AGENTS, oversized_text, "replacement")]},
        )
        result = invoke(root, script, spec, sandbox / "state-oversized-single-edit")
        require(result.returncode != 0 and "per-text limit" in result.stderr, "one oversized old/new text must fail")
        cases += 1

        too_many_edits = [one_edit(AGENTS, "x", "y") for _ in range(17)]
        spec = write_spec(
            sandbox,
            "too-many-edits",
            {"reason": "edit-count bound test", "edits": too_many_edits},
        )
        result = invoke(root, script, spec, sandbox / "state-too-many-edits")
        require(result.returncode != 0 and "more than 16 edits" in result.stderr, "more than 16 edits must fail")
        cases += 1

        root, script = create_fixture(sandbox, "non-utf8")
        (root / AGENTS).write_bytes(b"invalid \xff UTF-8\n")
        spec = write_spec(sandbox, "non-utf8", {"reason": "UTF-8 refusal test", "edits": [one_edit(AGENTS)]})
        result = invoke(root, script, spec, sandbox / "state-non-utf8")
        require(result.returncode != 0 and "invalid UTF-8" in result.stderr, "non-UTF-8 targets must be refused")
        cases += 1

        root, script = create_fixture(sandbox, "non-regular")
        (root / AGENTS).unlink()
        os.mkfifo(root / AGENTS)
        spec = write_spec(sandbox, "non-regular", {"reason": "non-regular refusal test", "edits": [one_edit(AGENTS)]})
        result = invoke(root, script, spec, sandbox / "state-non-regular")
        require(result.returncode != 0 and "non-regular file" in result.stderr, "non-regular policy targets must be refused")
        cases += 1

        root, script = create_fixture(sandbox, "symlink")
        outside_target = write_text(sandbox, "symlink-target.txt", "outside protected bytes\n")
        (root / AGENTS).unlink()
        (root / AGENTS).symlink_to(outside_target)
        spec = write_spec(sandbox, "symlink", {"reason": "symlink refusal test", "edits": [one_edit(AGENTS)]})
        result = invoke(root, script, spec, sandbox / "state-symlink")
        require(result.returncode != 0 and "REFUSED:" in result.stderr, "symlinked policy target must be refused")
        require(outside_target.read_text(encoding="utf-8") == "outside protected bytes\n", "symlink target must remain untouched")
        cases += 1

    print(f"OK: orchestration lockout recovery self-test passed ({cases} cases; disposable trees only)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
