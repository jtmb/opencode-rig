#!/usr/bin/env python3
"""Exercise passing and failing acceptance-evidence manifest cases."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path
from types import ModuleType


MODULE_PATH = Path(__file__).with_name("check-acceptance-evidence.py")
sys.dont_write_bytecode = True


def load_checker() -> ModuleType:
    """Load the validator without spawning a child process."""
    spec = importlib.util.spec_from_file_location("acceptance_evidence", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise AssertionError("could not load acceptance-evidence validator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_manifest(root: Path, manifest: dict[str, object]) -> None:
    """Write one temporary JSON manifest and its ordinary evidence files."""
    (root / "evidence").mkdir(exist_ok=True)
    for name in ("visual.png", "interaction.txt", "subagent.txt"):
        (root / "evidence" / name).write_text(name, encoding="utf-8")
    (root / "acceptance-evidence.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )


def valid_manifest() -> dict[str, object]:
    """Return the smallest compliant manifest fixture."""
    return {
        "version": 1,
        "claims": [
            {
                "id": "visible-runtime",
                "status": "complete",
                "user_visible": True,
                "runtime": True,
                "evidence": {
                    "rendered_visual": ["evidence/visual.png"],
                    "interaction": ["evidence/interaction.txt"],
                },
            }
        ],
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
    """Assert that the validator rejects a fixture with a useful diagnostic."""
    try:
        checker.validate_manifest(root, requested)
    except Exception as exc:  # noqa: BLE001 - the fixture must reject any validator error.
        if expected not in str(exc):
            raise AssertionError(f"{label}: missing {expected!r}: {exc}") from exc
        return
    raise AssertionError(f"{label}: invalid manifest was accepted")


def main() -> int:
    """Run isolated positive and negative manifest checks."""
    checker = load_checker()
    if hasattr(checker, "subprocess"):
        raise AssertionError("manifest validator must not import subprocess")
    with tempfile.TemporaryDirectory(prefix="acceptance-evidence-self-test-") as directory:
        root = Path(directory)
        manifest = valid_manifest()
        write_manifest(root, manifest)
        assert checker.validate_manifest(root) == (1, 1)

        empty_claims = json.loads(json.dumps(manifest))
        empty_claims["claims"] = []
        write_manifest(root, empty_claims)
        expect_failure(checker, root, "empty claims", "must not be empty")

        empty_subagents = json.loads(json.dumps(manifest))
        empty_subagents["subagent_evidence"] = []
        write_manifest(root, empty_subagents)
        expect_failure(checker, root, "empty subagent evidence", "non-empty list")

        boolean_version = json.loads(json.dumps(manifest))
        boolean_version["version"] = True
        write_manifest(root, boolean_version)
        expect_failure(checker, root, "boolean version", "manifest.version")

        float_version = json.loads(json.dumps(manifest))
        float_version["version"] = 1.0
        write_manifest(root, float_version)
        expect_failure(checker, root, "float version", "manifest.version")

        visible_without_runtime_evidence = json.loads(json.dumps(manifest))
        visible_without_runtime_evidence["claims"][0]["user_visible"] = True
        visible_without_runtime_evidence["claims"][0]["runtime"] = False
        del visible_without_runtime_evidence["claims"][0]["evidence"]["rendered_visual"]
        write_manifest(root, visible_without_runtime_evidence)
        expect_failure(
            checker,
            root,
            "visible non-runtime claim",
            "rendered_visual",
        )

        no_claim_evidence = json.loads(json.dumps(manifest))
        no_claim_evidence["claims"][0]["evidence"] = {}
        write_manifest(root, no_claim_evidence)
        expect_failure(checker, root, "complete claim without evidence", "require evidence")

        planned_only = json.loads(json.dumps(manifest))
        planned_only["claims"][0]["status"] = "planned"
        planned_only["claims"][0]["evidence"] = {}
        write_manifest(root, planned_only)
        expect_failure(
            checker,
            root,
            "planned-only manifest",
            "evidenced complete or limited claim",
        )

        missing_visual = json.loads(json.dumps(manifest))
        del missing_visual["claims"][0]["evidence"]["rendered_visual"]
        write_manifest(root, missing_visual)
        expect_failure(checker, root, "missing rendered visual", "rendered_visual")

        missing_interaction = json.loads(json.dumps(manifest))
        del missing_interaction["claims"][0]["evidence"]["interaction"]
        write_manifest(root, missing_interaction)
        expect_failure(checker, root, "missing interaction", "interaction")

        disallowed_agent = json.loads(json.dumps(manifest))
        disallowed_agent["subagent_evidence"][0]["agent"] = "explore"
        write_manifest(root, disallowed_agent)
        expect_failure(checker, root, "disallowed agent", "disallowed agent")

        disallowed_model = json.loads(json.dumps(manifest))
        disallowed_model["subagent_evidence"][0]["model"] = "other/model"
        write_manifest(root, disallowed_model)
        expect_failure(checker, root, "disallowed model", "disallowed model")

        foreground = json.loads(json.dumps(manifest))
        foreground["subagent_evidence"][0]["background"] = False
        write_manifest(root, foreground)
        expect_failure(checker, root, "foreground child", "background")

        nested = json.loads(json.dumps(manifest))
        nested["subagent_evidence"][0]["nested"] = True
        write_manifest(root, nested)
        expect_failure(checker, root, "nested child", "unsupported field")

        over_capacity = json.loads(json.dumps(manifest))
        over_capacity["subagent_policy"]["max_concurrency"] = 1
        over_capacity["subagent_evidence"].append(
            {
                "id": "second-child",
                "agent": "general",
                "model": "portable/model",
                "background": True,
                "evidence": ["evidence/subagent.txt"],
            }
        )
        write_manifest(root, over_capacity)
        expect_failure(checker, root, "concurrency cap", "max_concurrency")

        absolute_path = json.loads(json.dumps(manifest))
        absolute_path["claims"][0]["evidence"]["interaction"] = [
            str(root / "evidence" / "interaction.txt")
        ]
        write_manifest(root, absolute_path)
        expect_failure(checker, root, "absolute evidence path", "relative")

        traversal = json.loads(json.dumps(manifest))
        traversal["claims"][0]["evidence"]["interaction"] = ["../outside.txt"]
        write_manifest(root, traversal)
        expect_failure(checker, root, "escaping evidence path", "beneath")

        directory = json.loads(json.dumps(manifest))
        (root / "evidence" / "directory").mkdir(exist_ok=True)
        directory["claims"][0]["evidence"]["interaction"] = ["evidence/directory"]
        write_manifest(root, directory)
        expect_failure(checker, root, "directory evidence path", "regular file")

        symlink = json.loads(json.dumps(manifest))
        outside = root / "outside.txt"
        outside.write_text("outside", encoding="utf-8")
        (root / "evidence" / "linked.txt").symlink_to(outside)
        symlink["claims"][0]["evidence"]["interaction"] = ["evidence/linked.txt"]
        write_manifest(root, symlink)
        expect_failure(checker, root, "symlink evidence path", "symlink")

        ancestor_symlink = json.loads(json.dumps(manifest))
        outside_directory = root / "outside-directory"
        outside_directory.mkdir(exist_ok=True)
        (outside_directory / "interaction.txt").write_text("outside", encoding="utf-8")
        linked_directory = root / "evidence" / "linked-directory"
        linked_directory.symlink_to(outside_directory, target_is_directory=True)
        ancestor_symlink["claims"][0]["evidence"]["interaction"] = [
            "evidence/linked-directory/interaction.txt"
        ]
        write_manifest(root, ancestor_symlink)
        expect_failure(checker, root, "symlink ancestor evidence path", "symlink")

        write_manifest(root, manifest)
        manifest_link = root.parent / "manifest-root-link"
        manifest_link.symlink_to(root, target_is_directory=True)
        try:
            expect_failure(
                checker,
                root,
                "symlink manifest ancestor",
                "manifest must be a readable file",
                str(manifest_link / "acceptance-evidence.json"),
            )
        finally:
            manifest_link.unlink()

        too_many_claims = json.loads(json.dumps(manifest))
        too_many_claims["claims"] = [
            dict(too_many_claims["claims"][0], id=f"claim-{index}")
            for index in range(checker.MAX_CLAIMS + 1)
        ]
        write_manifest(root, too_many_claims)
        expect_failure(checker, root, "claim bound", "at most")

        excessive_concurrency = json.loads(json.dumps(manifest))
        excessive_concurrency["subagent_policy"]["max_concurrency"] = (
            checker.MAX_CONCURRENCY + 1
        )
        write_manifest(root, excessive_concurrency)
        expect_failure(checker, root, "concurrency bound", "at most")

        too_many_paths = json.loads(json.dumps(manifest))
        too_many_paths["claims"][0]["evidence"]["interaction"] = [
            "evidence/interaction.txt"
        ] * (checker.MAX_EVIDENCE_PATHS + 1)
        write_manifest(root, too_many_paths)
        expect_failure(checker, root, "evidence path bound", "at most")

        long_path = json.loads(json.dumps(manifest))
        long_path["claims"][0]["evidence"]["interaction"] = [
            "a" * (checker.MAX_PATH_LENGTH + 1)
        ]
        write_manifest(root, long_path)
        expect_failure(checker, root, "path length bound", "path limit")

        oversized = json.loads(json.dumps(manifest))
        oversized["padding"] = "x" * (checker.MAX_MANIFEST_BYTES + 1)
        write_manifest(root, oversized)
        expect_failure(checker, root, "manifest size bound", "size limit")

    print(
        "OK: acceptance-evidence self-test covers passing claims, empty/vacuous "
        "manifests, visible evidence, allowlists, background mode, bounds, "
        "regular files, absolute/traversal paths, symlink ancestors, and "
        "no-subprocess validation"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
