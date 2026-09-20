#!/usr/bin/env python3
"""Check that the repository's commit/push approval policy is documented.

This is deliberately a read-only drift check. It validates the operating
surfaces that describe the protocol; it does not create hooks or perform Git
mutations.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path



def load_jsonc(path: str):
    parser_path = Path(__file__).with_name("setup-opencode-jsonc.py")
    spec = importlib.util.spec_from_file_location("policy_jsonc_parser", parser_path)
    if spec is None or spec.loader is None:
        raise ValueError("JSONC parser is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.load_jsonc(path)


AGENTS_MARKERS = (
    "(docs/agent-policy.md)",
    "(docs/scripts/git-safety-gates.md)",
)
DOC_MARKERS = (
    "## Commit gate",
    "## Push gate",
    "Commit approval never implies push approval.",
    "git ls-remote",
    "Without approval, do not run `git push`.",
)


def missing(path: Path, root: Path, text: str, markers: tuple[str, ...]) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).lower()
    return [
        f"{path.relative_to(root)} must mention '{marker}'"
        for marker in markers
        if re.sub(r"\s+", " ", marker).lower() not in normalized
    ]


def permission_rules(config: dict, agent: str) -> list[dict]:
    value = config.get("agents", {}).get(agent, {}).get("permissions", [])
    return value if isinstance(value, list) else []


def check_primary_permissions(
    config: dict, label: str, *, protect_builtin_agents: bool
) -> list[str]:
    failures: list[str] = []
    rules = config.get("permissions", [])
    if not isinstance(rules, list) or any(not isinstance(rule, dict) for rule in rules):
        return [f"{label} permissions must be a list of rule objects"]

    def matching(action: str, resource: str, effect: str) -> list[int]:
        return [
            index
            for index, rule in enumerate(rules)
            if rule.get("action") == action
            and rule.get("resource") == resource
            and rule.get("effect") == effect
        ]

    auto_allow = matching("*", "*", "allow")
    if protect_builtin_agents and auto_allow:
        failures.append(
            f"{label} must not override built-in Plan/Explore safety with allow */*"
        )

    protected: list[tuple[str, str, str]] = [
        ("repo_commit", "*", "ask"),
        ("repo_push", "*", "ask"),
        ("shell", "git commit *", "deny"),
        ("shell", "git push *", "deny"),
        ("shell", "git -C * commit *", "deny"),
        ("shell", "git -C * push *", "deny"),
    ]
    protected_indexes: list[int] = []
    for action, resource, effect in protected:
        indexes = matching(action, resource, effect)
        if not indexes:
            failures.append(
                f"{label} must set {action}/{resource} to {effect}"
            )
        else:
            protected_indexes.extend(indexes)
    return failures


def check_agent_gate_permissions(config: dict, label: str) -> list[str]:
    failures: list[str] = []
    build_rules = permission_rules(config, "build")
    build_expected = [
        ("*", "*", "allow"),
        ("repo_commit", "*", "ask"),
        ("repo_push", "*", "ask"),
        ("shell", "git commit *", "deny"),
        ("shell", "git push *", "deny"),
        ("shell", "git -C * commit *", "deny"),
        ("shell", "git -C * push *", "deny"),
    ]
    build_indexes: list[int] = []
    for action, resource, effect in build_expected:
        indexes = [
            index for index, rule in enumerate(build_rules)
            if rule.get("action") == action
            and rule.get("resource") == resource
            and rule.get("effect") == effect
        ]
        if not indexes:
            failures.append(f"{label} agents.build must set {action}/{resource} to {effect}")
        else:
            build_indexes.append(indexes[-1])
    if len(build_indexes) == len(build_expected) and build_indexes[0] >= min(build_indexes[1:]):
        failures.append(f"{label} agents.build allow */* must precede commit/push protections")
    for agent in ("plan", "explore", "general"):
        rules = permission_rules(config, agent)
        for action in ("repo_commit", "repo_push"):
            if not any(rule.get("action") == action and rule.get("resource") == "*" and rule.get("effect") == "deny" for rule in rules):
                failures.append(f"{label} agents.{agent} must deny {action}/*")
    plan_rules = permission_rules(config, "plan")
    if not any(rule.get("action") == "subagent" and rule.get("resource") == "*" and rule.get("effect") == "deny" for rule in plan_rules):
        failures.append(f"{label} agents.plan must deny subagent/*")
    allowed = {rule.get("resource") for rule in plan_rules if rule.get("action") == "subagent" and rule.get("effect") == "allow"}
    if allowed != {"explore"}:
        failures.append(f"{label} agents.plan must allow only the explore subagent")
    return failures


def check_root(root: Path) -> list[str]:
    failures: list[str] = []
    agents = root / "AGENTS.md"
    doc = root / "docs/scripts/git-safety-gates.md"
    try:
        agents_text = agents.read_text(encoding="utf-8")
    except OSError as exc:
        return [f"AGENTS.md: cannot read ({exc})"]
    failures.extend(missing(agents, root, agents_text, AGENTS_MARKERS))
    try:
        doc_text = doc.read_text(encoding="utf-8")
    except OSError as exc:
        failures.append(f"{doc.relative_to(root)}: cannot read ({exc})")
    else:
        failures.extend(missing(doc, root, doc_text, DOC_MARKERS))
    cli = root / "platforms/linux/ubuntu/computer-use/config/v2-cli.example.json"
    try:
        cli_data = json.loads(cli.read_text(encoding="utf-8"))
        if cli_data.get("session", {}).get("permissions") != "prompt":
            failures.append(f"{cli.relative_to(root)} must set session.permissions to 'prompt' when gate tools are enabled")
    except (OSError, json.JSONDecodeError, AttributeError) as exc:
        failures.append(f"{cli.relative_to(root)} must be readable JSON with session.permissions='prompt' ({exc})")
    config = root / "opencode.json"
    try:
        config_data = json.loads(config.read_text(encoding="utf-8"))
        failures.extend(
            check_primary_permissions(
                config_data, "opencode.json", protect_builtin_agents=True
            )
        )
        failures.extend(check_agent_gate_permissions(config_data, "opencode.json"))
    except (OSError, json.JSONDecodeError, AttributeError) as exc:
        failures.append(f"opencode.json must configure agent gate denies ({exc})")
    example = root / "platforms/linux/ubuntu/computer-use/config/v2-opencode.example.jsonc"
    try:
        example_data = load_jsonc(str(example))
        if not isinstance(example_data, dict):
            failures.append(f"{example.relative_to(root)} must contain a JSON object")
        else:
            failures.extend(
                check_primary_permissions(
                    example_data,
                    str(example.relative_to(root)),
                    protect_builtin_agents=False,
                )
            )
            failures.extend(check_agent_gate_permissions(example_data, str(example.relative_to(root))))
    except (OSError, ValueError, json.JSONDecodeError, AttributeError) as exc:
        failures.append(f"{example.relative_to(root)} must be valid JSONC with agent gate denies ({exc})")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=None, help="repository root")
    args = parser.parse_args()
    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parents[5]
    failures = check_root(root)
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1
    print(
        "OK: Build auto-approval, separate commit/push asks, raw Git denials, "
        "and subagent restrictions are documented and configured"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
