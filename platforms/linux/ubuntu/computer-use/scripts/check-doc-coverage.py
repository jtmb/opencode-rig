#!/usr/bin/env python3
"""Enforce that documentation is updated or created alongside source changes.

The gate has two checks driven by `documentation-map.json`:

- completeness: every tracked file matched by a rule has its mapped
  documentation file(s) present, so a new script, plugin, or skill cannot land
  without documentation.
- change-aware: when a git range or explicit changed files are given, every
  matched changed file must have at least one of its mapped documentation files
  changed in the same set.

The map has two sections: `rules` (first match wins, so exceptions can shadow
general rules) and `additional` (every matching rule applies, used for
cross-cutting requirements such as keeping HANDOFF.md current).

A `Doc-Gate: exempt` trailer on any commit in the range, `--exempt`, or
`DOC_GATE_EXEMPT=1` bypasses only the change-aware check. Completeness still
runs, so an undocumented new artifact is never allowed through.

Read-only: this script never writes to the repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

PLUGIN_MARKER = "platforms/linux/ubuntu/computer-use/plugins/"
SKILL_MARKER = "platforms/linux/ubuntu/computer-use/skills/"
SKIP_DIRS = {".git", "node_modules", "browsers", "__pycache__", ".opencode"}
EXEMPT_PATTERN = re.compile(r"(?im)^[ \t]*doc-gate[ \t]*:[ \t]*exempt\b")


class ConfigError(Exception):
    """Raised for an unusable map or an uncomputable change set."""


def compile_glob(pattern: str) -> re.Pattern:
    """Compile a glob supporting `*` (no slash), `**` (any), and `?`."""
    parts = ["^"]
    index = 0
    length = len(pattern)
    while index < length:
        char = pattern[index]
        if char == "*":
            if index + 1 < length and pattern[index + 1] == "*":
                index += 2
                if index < length and pattern[index] == "/":
                    index += 1
                    parts.append("(?:.*/)?")
                else:
                    parts.append(".*")
                continue
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        else:
            parts.append(re.escape(char))
        index += 1
    parts.append("$")
    return re.compile("".join(parts))


def segment_after(path: str, marker: str) -> str | None:
    index = path.find(marker)
    if index < 0:
        return None
    remainder = path[index + len(marker):]
    if not remainder:
        return None
    segment = remainder.split("/", 1)[0]
    return segment or None


def resolve_doc(spec: str, path: str) -> str:
    result = spec.replace("{stem}", os.path.splitext(os.path.basename(path))[0])
    if "{plugin}" in result:
        plugin = segment_after(path, PLUGIN_MARKER)
        if plugin is None:
            raise ConfigError(f"cannot resolve {{plugin}} for {path}")
        result = result.replace("{plugin}", plugin)
    if "{skill}" in result:
        skill = segment_after(path, SKILL_MARKER)
        if skill is None:
            raise ConfigError(f"cannot resolve {{skill}} for {path}")
        result = result.replace("{skill}", skill)
    if "{" in result or "}" in result:
        raise ConfigError(f"unresolved placeholder in documentation spec: {spec}")
    return result


def compile_rules(entries: list, path: str, allow_on_add: bool) -> list[dict]:
    rules: list[dict] = []
    names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ConfigError(f"invalid rule in {path}: {entry!r}")
        name = entry.get("name")
        match = entry.get("match")
        docs = entry.get("docs")
        on_add = entry.get("onAdd", [])
        if not isinstance(name, str) or not name:
            raise ConfigError(f"rule without a name in {path}")
        if name in names:
            raise ConfigError(f"duplicate rule name in {path}: {name}")
        names.add(name)
        if not isinstance(match, list) or not match or not all(isinstance(m, str) for m in match):
            raise ConfigError(f"rule {name} must list match patterns")
        if not isinstance(docs, list) or not docs or not all(isinstance(d, str) for d in docs):
            raise ConfigError(f"rule {name} must list documentation paths")
        if not isinstance(on_add, list) or not all(isinstance(d, str) for d in on_add):
            raise ConfigError(f"rule {name} onAdd must be a list of paths")
        if on_add and not allow_on_add:
            raise ConfigError(f"rule {name} may not use onAdd in the additional section")
        rules.append({
            "name": name,
            "match": [compile_glob(m) for m in match],
            "docs": docs,
            "onAdd": on_add,
        })
    return rules


def load_map(path: str) -> tuple[list[dict], list[dict]]:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise ConfigError(f"documentation map not found: {path}") from exc
    except (OSError, ValueError) as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ConfigError(f"{path} must be an object with version 1")
    entries = data.get("rules")
    if not isinstance(entries, list) or not entries:
        raise ConfigError(f"{path} must define a non-empty rules list")
    additional_entries = data.get("additional", [])
    if not isinstance(additional_entries, list):
        raise ConfigError(f"{path} additional must be a list")
    rules = compile_rules(entries, path, allow_on_add=True)
    additional = compile_rules(additional_entries, path, allow_on_add=False) if additional_entries else []
    return rules, additional


def matches(rule: dict, path: str) -> bool:
    return any(pattern.match(path) for pattern in rule["match"])


def first_match(rules: list[dict], path: str) -> dict | None:
    for rule in rules:
        if matches(rule, path):
            return rule
    return None


def rule_docs(rule: dict, path: str) -> list[str]:
    return [resolve_doc(spec, path) for spec in rule["docs"]]


def list_files(root: str) -> list[str]:
    try:
        proc = subprocess.run(
            ["git", "-C", root, "ls-files", "-z"],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            return [item for item in proc.stdout.split("\0") if item]
    except OSError:
        pass
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            relative = os.path.relpath(os.path.join(dirpath, name), root)
            files.append(relative.replace(os.sep, "/"))
    return files


def normalize(path: str) -> str:
    cleaned = path.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned


def git_changed(root: str, base: str, head: str) -> dict[str, str]:
    proc = subprocess.run(
        [
            "git", "-C", root, "diff", "--name-status", "-z", "-M",
            "--diff-filter=ACMRD", f"{base}...{head}",
        ],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise ConfigError(f"git diff {base}...{head} failed: {proc.stderr.strip()}")
    tokens = proc.stdout.split("\0")
    changed: dict[str, str] = {}
    index = 0
    while index < len(tokens):
        status = tokens[index]
        if not status:
            index += 1
            continue
        code = status[0]
        if code in ("R", "C"):
            if index + 2 >= len(tokens):
                break
            old, new = tokens[index + 1], tokens[index + 2]
            index += 3
            if code == "R":
                changed[normalize(old)] = "D"
                changed[normalize(new)] = "R"
            else:
                changed[normalize(new)] = "A"
        else:
            if index + 1 >= len(tokens):
                break
            path = tokens[index + 1]
            index += 2
            changed[normalize(path)] = code
    return changed


def git_exempt(root: str, base: str, head: str) -> bool:
    proc = subprocess.run(
        ["git", "-C", root, "log", "--format=%B", f"{base}..{head}"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return False
    return bool(EXEMPT_PATTERN.search(proc.stdout))


def check_completeness(
    root: str, rules: list[dict], additional: list[dict], files: list[str]
) -> tuple[list[tuple[str, str]], int]:
    violations: list[tuple[str, str]] = []
    checked = 0
    for path in files:
        rule = first_match(rules, path)
        if rule is not None:
            checked += 1
            for doc in rule_docs(rule, path):
                if not os.path.exists(os.path.join(root, doc)):
                    violations.append((path, f"missing documentation {doc}"))
        for extra in additional:
            if not matches(extra, path):
                continue
            for doc in rule_docs(extra, path):
                if not os.path.exists(os.path.join(root, doc)):
                    violations.append((path, f"missing documentation {doc} ({extra['name']})"))
    return violations, checked


def check_changes(
    root: str, rules: list[dict], additional: list[dict], changed: dict[str, str]
) -> list[tuple[str, str]]:
    violations: list[tuple[str, str]] = []
    changed_paths = set(changed)
    added: dict[str, set[str]] = {}
    for path in sorted(changed):
        rule = first_match(rules, path)
        if rule is not None:
            docs = rule_docs(rule, path)
            if not any(doc in changed_paths for doc in docs):
                violations.append((path, "requires an update to one of: " + ", ".join(docs)))
            if changed[path] == "A":
                added.setdefault(rule["name"], set()).add(path)
        for extra in additional:
            if not matches(extra, path):
                continue
            docs = rule_docs(extra, path)
            if not any(doc in changed_paths for doc in docs):
                violations.append(
                    (path, f"requires an update to one of: {', '.join(docs)} ({extra['name']})")
                )
    for name, paths in added.items():
        rule = next(rule for rule in rules if rule["name"] == name)
        if not rule["onAdd"]:
            continue
        satisfied = any(
            resolve_doc(spec, path) in changed_paths
            for path in paths
            for spec in rule["onAdd"]
        )
        if not satisfied:
            specs = ", ".join(rule["onAdd"])
            violations.append((f"new entry under rule '{name}'", f"requires an update to one of: {specs}"))
    return violations


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Enforce that mapped documentation is updated or created with source changes.",
    )
    parser.add_argument("--root", help="repository root (default: git toplevel of cwd)")
    parser.add_argument("--map", help="documentation map (default: <root>/documentation-map.json)")
    parser.add_argument("--base", help="git base ref for the change-aware check")
    parser.add_argument("--head", default="HEAD", help="git head ref (default: HEAD)")
    parser.add_argument("--changed-file", action="append", default=[], help="treat this path as modified")
    parser.add_argument("--added-file", action="append", default=[], help="treat this path as added")
    parser.add_argument("--exempt", action="store_true", help="skip the change-aware check")
    parser.add_argument("--json", action="store_true", help="emit a JSON summary")
    parser.add_argument("--quiet", action="store_true", help="suppress the OK line")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.root:
        root = os.path.abspath(os.path.expanduser(args.root))
    else:
        root = os.getcwd()
        try:
            proc = subprocess.run(
                ["git", "-C", root, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                root = proc.stdout.strip()
        except OSError:
            pass

    map_path = args.map or os.path.join(root, "documentation-map.json")
    try:
        rules, additional = load_map(map_path)
        changed: dict[str, str] = {}
        if args.changed_file or args.added_file:
            for path in args.changed_file:
                changed[normalize(path)] = "M"
            for path in args.added_file:
                changed[normalize(path)] = "A"
        elif args.base:
            changed = git_changed(root, args.base, args.head)

        exempt = (
            args.exempt
            or os.environ.get("DOC_GATE_EXEMPT", "").strip().lower() in {"1", "true", "yes", "on"}
        )
        if not exempt and args.base and changed:
            exempt = git_exempt(root, args.base, args.head)

        files = list_files(root)
        completeness, checked = check_completeness(root, rules, additional, files)
        changes = [] if (exempt or not changed) else check_changes(root, rules, additional, changed)
    except ConfigError as exc:
        print(f"check-doc-coverage: {exc}", file=sys.stderr)
        return 2

    violations = completeness + changes
    if args.json:
        payload = {
            "ok": not violations,
            "checked": checked,
            "changed": len(changed),
            "exempt": exempt and bool(changed),
            "violations": [{"path": path, "message": message} for path, message in violations],
        }
        print(json.dumps(payload, indent=2))
    else:
        for path, message in violations:
            print(f"MISSING/STALE: {path}: {message}", file=sys.stderr)
        if exempt and changed:
            print("NOTICE: change-aware documentation check exempted (Doc-Gate: exempt).", file=sys.stderr)
        if not violations and not args.quiet:
            suffix = f", {len(changed)} changed" if changed else ""
            print(f"OK: documentation coverage valid ({checked} mapped files checked{suffix})")
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
