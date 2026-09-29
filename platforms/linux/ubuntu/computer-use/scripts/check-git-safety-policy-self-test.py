#!/usr/bin/env python3
"""Negative self-test for the repository commit/push policy drift check."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import json
from pathlib import Path


MEMORY_ACTIONS = (
    "basic-memory_read_content",
    "basic-memory_view_note",
    "basic-memory_move_note",
    "basic-memory_create_memory_project",
    "basic-memory_delete_project",
    "basic-memory_list_workspaces",
    "basic-memory_schema_validate",
    "basic-memory_schema_infer",
    "basic-memory_schema_diff",
    "basic-memory_search",
    "basic-memory_fetch",
)
MEMORY_PROJECT_LISTING = "basic-memory_list_memory_projects"

AGENTS = """# AGENTS.md

- [Agent policy](docs/agent-policy.md)
- [Commit and push gates](docs/scripts/git-safety-gates.md)
"""
DOC = """# Gates

## Commit gate
Show exact staged scope and ask for explicit approval.

## Push gate
Commit approval never implies push approval.
git ls-remote
Without approval, do not run `git push`.
"""


def run(checker: Path, root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(checker), "--root", str(root)],
        capture_output=True,
        text=True,
        check=False,
    )


def main() -> int:
    checker = Path(__file__).resolve().parent / "check-git-safety-policy.py"
    with tempfile.TemporaryDirectory(prefix="git-safety-gate-") as tmp:
        root = Path(tmp)
        def agent_config(*, include_listing: bool = False) -> dict:
            gates = [{"action": action, "resource": "*", "effect": "deny"} for action in ("repo_commit", "repo_push")]
            memory_actions = MEMORY_ACTIONS + (
                (MEMORY_PROJECT_LISTING,) if include_listing else ()
            )
            memory = [
                {"action": action, "resource": "*", "effect": "deny"}
                for action in memory_actions
            ]
            permissions = [
                {"action": "repo_commit", "resource": "*", "effect": "ask"},
                {"action": "repo_push", "resource": "*", "effect": "ask"},
                {"action": "shell", "resource": "git commit *", "effect": "deny"},
                {"action": "shell", "resource": "git push *", "effect": "deny"},
                {"action": "shell", "resource": "git -C * commit *", "effect": "deny"},
                {"action": "shell", "resource": "git -C * push *", "effect": "deny"},
                *memory,
            ]
            return {"permissions": permissions, "agents": {
                "build": {"permissions": [
                    {"action": "*", "resource": "*", "effect": "allow"},
                    {"action": "repo_commit", "resource": "*", "effect": "ask"},
                    {"action": "repo_push", "resource": "*", "effect": "ask"},
                    {"action": "shell", "resource": "git commit *", "effect": "deny"},
                    {"action": "shell", "resource": "git push *", "effect": "deny"},
                    {"action": "shell", "resource": "git -C * commit *", "effect": "deny"},
                    {"action": "shell", "resource": "git -C * push *", "effect": "deny"},
                    *memory,
                ]},
                "plan": {"permissions": [{"action": "subagent", "resource": "*", "effect": "deny"}, {"action": "subagent", "resource": "explore", "effect": "allow"}, *gates]},
                "explore": {"permissions": list(gates)},
                "general": {"permissions": list(gates)},
            }}
        (root / "docs/scripts").mkdir(parents=True)
        config = root / "platforms/linux/ubuntu/computer-use/config"
        config.mkdir(parents=True)
        (config / "v2-cli.example.json").write_text(json.dumps({"session": {"permissions": "prompt"}}), encoding="utf-8")
        project_config = agent_config()
        (root / "opencode.json").write_text(json.dumps(project_config), encoding="utf-8")
        example = root / "platforms/linux/ubuntu/computer-use/config/v2-opencode.example.jsonc"
        example.parent.mkdir(parents=True, exist_ok=True)
        example_config = agent_config(include_listing=True)
        example.write_text(json.dumps(example_config), encoding="utf-8")
        (root / "AGENTS.md").write_text(AGENTS, encoding="utf-8")
        doc = root / "docs/scripts/git-safety-gates.md"
        doc.write_text(DOC, encoding="utf-8")
        good = run(checker, root)
        if good.returncode != 0:
            print("ERROR: compliant fixture was rejected", file=sys.stderr)
            sys.stderr.write(good.stderr or good.stdout)
            return 1
        doc.write_text(DOC.replace("git ls-remote", "remote inspection"), encoding="utf-8")
        bad = run(checker, root)
        if bad.returncode != 1:
            print("ERROR: missing push-verification marker was accepted", file=sys.stderr)
            sys.stderr.write(bad.stderr or bad.stdout)
            return 1
        doc.write_text(DOC, encoding="utf-8")
        (root / "platforms/linux/ubuntu/computer-use/config/v2-cli.example.json").write_text(json.dumps({"session": {"permissions": "autoaccept"}}), encoding="utf-8")
        autoaccept = run(checker, root)
        if autoaccept.returncode != 1 or "prompt" not in autoaccept.stderr:
            print("ERROR: autoaccept CLI mode was accepted", file=sys.stderr)
            sys.stderr.write(autoaccept.stderr or autoaccept.stdout)
            return 1
        (root / "platforms/linux/ubuntu/computer-use/config/v2-cli.example.json").write_text(json.dumps({"session": {"permissions": "prompt"}}), encoding="utf-8")
        unsafe_auto_allow = json.loads(json.dumps(project_config))
        unsafe_auto_allow["permissions"].insert(0, {"action": "*", "resource": "*", "effect": "allow"})
        (root / "opencode.json").write_text(json.dumps(unsafe_auto_allow), encoding="utf-8")
        unsafe = run(checker, root)
        if unsafe.returncode != 1 or "Plan/Explore" not in unsafe.stderr:
            print("ERROR: global allow override of Plan/Explore safety was accepted", file=sys.stderr)
            sys.stderr.write(unsafe.stderr or unsafe.stdout)
            return 1
        for label, action, resource, expected in (
            ("commit ask", "repo_commit", "*", "ask"),
            ("raw Git deny", "shell", "git -C * push *", "deny"),
        ):
            drifted = json.loads(json.dumps(project_config))
            drifted["permissions"] = [
                rule
                for rule in drifted["permissions"]
                if not (
                    rule.get("action") == action
                    and rule.get("resource") == resource
                    and rule.get("effect") == expected
                )
            ]
            (root / "opencode.json").write_text(json.dumps(drifted), encoding="utf-8")
            rejected = run(checker, root)
            if rejected.returncode != 1 or action not in rejected.stderr:
                print(f"ERROR: missing {label} rule was accepted", file=sys.stderr)
                sys.stderr.write(rejected.stderr or rejected.stdout)
                return 1
        (root / "opencode.json").write_text(json.dumps(project_config), encoding="utf-8")
        top_only = json.loads(json.dumps(project_config))
        top_only["agents"]["build"]["permissions"] = [
            rule
            for rule in top_only["agents"]["build"]["permissions"]
            if rule.get("action") not in MEMORY_ACTIONS
        ]
        (root / "opencode.json").write_text(json.dumps(top_only), encoding="utf-8")
        top_only_result = run(checker, root)
        if top_only_result.returncode != 1 or "agents.build" not in top_only_result.stderr:
            print("ERROR: top-level-only memory denies were accepted for Build", file=sys.stderr)
            sys.stderr.write(top_only_result.stderr or top_only_result.stdout)
            return 1
        misplaced = json.loads(json.dumps(project_config))
        build_rules = misplaced["agents"]["build"]["permissions"]
        memory_rules = [rule for rule in build_rules if rule.get("action") in MEMORY_ACTIONS]
        other_rules = [rule for rule in build_rules if rule.get("action") not in MEMORY_ACTIONS]
        misplaced["agents"]["build"]["permissions"] = [*memory_rules, *other_rules]
        (root / "opencode.json").write_text(json.dumps(misplaced), encoding="utf-8")
        misplaced_result = run(checker, root)
        if misplaced_result.returncode != 1 or "must follow its allow */*" not in misplaced_result.stderr:
            print("ERROR: Build memory denies before allow */* were accepted", file=sys.stderr)
            sys.stderr.write(misplaced_result.stderr or misplaced_result.stdout)
            return 1
        listing_denied = json.loads(json.dumps(project_config))
        listing_denied["permissions"].append(
            {"action": "basic-memory_list_memory_projects", "resource": "*", "effect": "deny"}
        )
        (root / "opencode.json").write_text(json.dumps(listing_denied), encoding="utf-8")
        listing_result = run(checker, root)
        if listing_result.returncode != 1 or "list_memory_projects" not in listing_result.stderr:
            print("ERROR: denied opt-in project listing was accepted", file=sys.stderr)
            sys.stderr.write(listing_result.stderr or listing_result.stdout)
            return 1
        (root / "opencode.json").write_text(json.dumps(project_config), encoding="utf-8")
        example_top_only = agent_config(include_listing=True)
        example_top_only["agents"]["build"]["permissions"] = [
            rule
            for rule in example_top_only["agents"]["build"]["permissions"]
            if not str(rule.get("action", "")).startswith("basic-memory_")
        ]
        example.write_text(json.dumps(example_top_only), encoding="utf-8")
        example_top_result = run(checker, root)
        if example_top_result.returncode != 1 or "v2-opencode.example.jsonc agents.build" not in example_top_result.stderr:
            print("ERROR: top-level-only memory denies were accepted for example Build", file=sys.stderr)
            sys.stderr.write(example_top_result.stderr or example_top_result.stdout)
            return 1
        example_misplaced = agent_config(include_listing=True)
        example_build_rules = example_misplaced["agents"]["build"]["permissions"]
        example_memory_rules = [
            rule
            for rule in example_build_rules
            if str(rule.get("action", "")).startswith("basic-memory_")
        ]
        example_other_rules = [
            rule
            for rule in example_build_rules
            if not str(rule.get("action", "")).startswith("basic-memory_")
        ]
        example_misplaced["agents"]["build"]["permissions"] = [
            *example_memory_rules,
            *example_other_rules,
        ]
        example.write_text(json.dumps(example_misplaced), encoding="utf-8")
        example_misplaced_result = run(checker, root)
        if example_misplaced_result.returncode != 1 or "must follow its allow */*" not in example_misplaced_result.stderr:
            print("ERROR: example Build memory denies before allow */* were accepted", file=sys.stderr)
            sys.stderr.write(example_misplaced_result.stderr or example_misplaced_result.stdout)
            return 1
        example.write_text(json.dumps(example_config), encoding="utf-8")
        example.write_text(json.dumps({"agents": {name: {"permissions": []} for name in ("plan", "explore", "general")}}), encoding="utf-8")
        bad_example = run(checker, root)
        if bad_example.returncode != 1 or "v2-opencode.example.jsonc" not in bad_example.stderr:
            print("ERROR: v2 example gate drift was accepted", file=sys.stderr)
            sys.stderr.write(bad_example.stderr or bad_example.stdout)
            return 1
    print("OK: git safety policy self-test rejects auto-approval, ask-gate, raw-Git, CLI, agent, and documentation drift")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
