#!/usr/bin/env python3
"""Validate a repository-owned acceptance-evidence manifest."""

from __future__ import annotations

import argparse
import json
import stat
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable


DEFAULT_MANIFEST = "acceptance-evidence.json"
EVIDENCE_KINDS = {"automated", "interaction", "rendered_visual"}
MAX_MANIFEST_BYTES = 1024 * 1024
MAX_CLAIMS = 256
MAX_EVIDENCE_PATHS = 256
MAX_ALLOWLIST_ENTRIES = 64
MAX_CONCURRENCY = 64
MAX_PATH_LENGTH = 4096


class EvidenceError(ValueError):
    """Raised when an acceptance-evidence manifest is unsafe or invalid."""


def _reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject duplicate JSON object keys instead of silently choosing one."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _object(value: object, label: str) -> dict[str, object]:
    """Return a JSON object or raise a manifest-specific error."""
    if not isinstance(value, dict):
        raise EvidenceError(f"{label} must be an object")
    return value


def _reject_unknown(data: dict[str, object], allowed: set[str], label: str) -> None:
    """Reject fields outside the versioned manifest schema."""
    unknown = set(data) - allowed
    if unknown:
        raise EvidenceError(
            f"{label} has unsupported field(s): " + ", ".join(sorted(unknown))
        )


def _string(value: object, label: str) -> str:
    """Return a non-empty JSON string or raise a manifest-specific error."""
    if not isinstance(value, str) or not value:
        raise EvidenceError(f"{label} must be a non-empty string")
    return value


def _string_list(
    value: object,
    label: str,
    *,
    non_empty: bool = False,
    max_items: int | None = None,
) -> list[str]:
    """Return a list of non-empty strings with optional non-empty enforcement."""
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise EvidenceError(f"{label} must be a list of non-empty strings")
    if non_empty and not value:
        raise EvidenceError(f"{label} must not be empty")
    if max_items is not None and len(value) > max_items:
        raise EvidenceError(f"{label} must contain at most {max_items} items")
    if len(set(value)) != len(value):
        raise EvidenceError(f"{label} must not contain duplicates")
    return value


def _relative_parts(raw_path: str, label: str) -> tuple[str, ...]:
    """Return safe portable path components for a manifest evidence path."""
    if len(raw_path) > MAX_PATH_LENGTH:
        raise EvidenceError(f"{label} exceeds the {MAX_PATH_LENGTH}-character path limit")
    if "\x00" in raw_path or "\\" in raw_path:
        raise EvidenceError(f"{label} must use relative forward-slash paths")
    posix = PurePosixPath(raw_path)
    windows = PureWindowsPath(raw_path)
    if posix.is_absolute() or windows.is_absolute() or windows.drive:
        raise EvidenceError(f"{label} must be relative to the project root")
    parts = posix.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise EvidenceError(f"{label} must stay beneath the project root")
    return parts


def _regular_project_file(root: Path, raw_path: object, label: str) -> Path:
    """Validate one relative, non-symlink regular file below ``root``."""
    path_text = _string(raw_path, label)
    parts = _relative_parts(path_text, label)
    candidate = root.joinpath(*parts)
    current = root
    for part in parts:
        current /= part
        if current.is_symlink():
            raise EvidenceError(f"{label} rejects symlink path: {path_text}")
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
        mode = candidate.stat().st_mode
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError(f"{label} is not a readable project file: {path_text}") from exc
    if not stat.S_ISREG(mode):
        raise EvidenceError(f"{label} must name a regular file: {path_text}")
    return candidate


def _validate_path_list(root: Path, value: object, label: str, *, non_empty: bool) -> int:
    """Validate all paths in one evidence list and return its item count."""
    paths = _string_list(
        value,
        label,
        non_empty=non_empty,
        max_items=MAX_EVIDENCE_PATHS,
    )
    for index, path in enumerate(paths):
        _regular_project_file(root, path, f"{label}[{index}]")
    return len(paths)


def _validate_claim(root: Path, claim: object, index: int) -> None:
    """Validate one completion claim and its evidence requirements."""
    data = _object(claim, f"claims[{index}]")
    _reject_unknown(
        data,
        {"id", "status", "user_visible", "runtime", "evidence"},
        f"claims[{index}]",
    )
    claim_id = _string(data.get("id"), f"claims[{index}].id")
    status = _string(data.get("status"), f"claims[{index}].status")
    if status not in {"complete", "limited", "planned"}:
        raise EvidenceError(f"claims[{index}] {claim_id}: unsupported status {status!r}")
    user_visible = data.get("user_visible")
    if not isinstance(user_visible, bool):
        raise EvidenceError(f"claims[{index}] {claim_id}: user_visible must be boolean")
    if not isinstance(data.get("runtime", True), bool):
        raise EvidenceError(f"claims[{index}] {claim_id}: runtime must be boolean")

    evidence = data.get("evidence", {})
    evidence_data = _object(evidence, f"claims[{index}].evidence")
    unknown = set(evidence_data) - EVIDENCE_KINDS
    if unknown:
        raise EvidenceError(
            f"claims[{index}] {claim_id}: unsupported evidence kind(s): "
            + ", ".join(sorted(unknown))
        )
    for kind, paths in evidence_data.items():
        _validate_path_list(root, paths, f"claims[{index}].evidence.{kind}", non_empty=False)

    if status in {"complete", "limited"} and not any(evidence_data.values()):
        raise EvidenceError(
            f"claims[{index}] {claim_id}: {status} claims require evidence"
        )

    if status in {"complete", "limited"} and user_visible:
        for kind in ("rendered_visual", "interaction"):
            if not evidence_data.get(kind):
                raise EvidenceError(
                    f"claims[{index}] {claim_id}: user-visible completion claims "
                    f"require {kind} evidence"
                )


def _validate_subagent_policy(policy: object) -> tuple[set[str], set[str], int]:
    """Validate and return the configured subagent policy."""
    data = _object(policy, "subagent_policy")
    _reject_unknown(data, {"allowed_agents", "allowed_models", "max_concurrency"}, "subagent_policy")
    agents = set(
        _string_list(
            data.get("allowed_agents"),
            "subagent_policy.allowed_agents",
            non_empty=True,
            max_items=MAX_ALLOWLIST_ENTRIES,
        )
    )
    models = set(
        _string_list(
            data.get("allowed_models"),
            "subagent_policy.allowed_models",
            non_empty=True,
            max_items=MAX_ALLOWLIST_ENTRIES,
        )
    )
    maximum = data.get("max_concurrency")
    if isinstance(maximum, bool) or not isinstance(maximum, int) or maximum < 1:
        raise EvidenceError("subagent_policy.max_concurrency must be a positive integer")
    if maximum > MAX_CONCURRENCY:
        raise EvidenceError(
            f"subagent_policy.max_concurrency must be at most {MAX_CONCURRENCY}"
        )
    return agents, models, maximum


def _validate_subagent_evidence(
    root: Path,
    entries: object,
    allowed_agents: set[str],
    allowed_models: set[str],
    max_concurrency: int,
) -> None:
    """Validate a bounded batch of background-subagent evidence records."""
    if not isinstance(entries, list) or not entries:
        raise EvidenceError("subagent_evidence must be a non-empty list")
    if len(entries) > max_concurrency:
        raise EvidenceError(
            f"subagent_evidence has {len(entries)} records, above max_concurrency "
            f"{max_concurrency}"
        )
    identifiers: set[str] = set()
    for index, entry in enumerate(entries):
        data = _object(entry, f"subagent_evidence[{index}]")
        _reject_unknown(
            data,
            {"id", "agent", "model", "background", "evidence"},
            f"subagent_evidence[{index}]",
        )
        entry_id = _string(data.get("id"), f"subagent_evidence[{index}].id")
        if entry_id in identifiers:
            raise EvidenceError(f"duplicate subagent evidence id: {entry_id}")
        identifiers.add(entry_id)
        agent = _string(data.get("agent"), f"subagent_evidence[{index}].agent")
        if agent not in allowed_agents:
            raise EvidenceError(f"subagent_evidence[{index}] uses disallowed agent: {agent}")
        model = _string(data.get("model"), f"subagent_evidence[{index}].model")
        if model not in allowed_models:
            raise EvidenceError(f"subagent_evidence[{index}] uses disallowed model: {model}")
        if data.get("background") is not True:
            raise EvidenceError(f"subagent_evidence[{index}] must set background to true")
        _validate_path_list(
            root,
            data.get("evidence"),
            f"subagent_evidence[{index}].evidence",
            non_empty=True,
        )


def _manifest_file(root: Path, requested: str | None) -> Path:
    """Resolve a repository-owned manifest without following a symlink."""
    root = root.resolve(strict=True)
    candidate = Path(requested) if requested is not None else Path(DEFAULT_MANIFEST)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        candidate.resolve(strict=True).relative_to(root)
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError("manifest must be a readable file beneath the project root") from exc
    try:
        relative = candidate.relative_to(root).as_posix()
    except ValueError as exc:
        raise EvidenceError("manifest must be a readable file beneath the project root") from exc
    return _regular_project_file(root, relative, "manifest")


def validate_manifest(root: Path, requested: str | None = None) -> tuple[int, int]:
    """Validate the manifest and return its claim and subagent counts."""
    try:
        root = root.resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as exc:
        raise EvidenceError("project root must be a readable directory") from exc
    if not root.is_dir():
        raise EvidenceError("project root must be a directory")
    manifest = _manifest_file(root, requested)
    try:
        with manifest.open("rb") as handle:
            raw_manifest = handle.read(MAX_MANIFEST_BYTES + 1)
    except OSError as exc:
        raise EvidenceError(f"cannot read manifest: {exc}") from exc
    if len(raw_manifest) > MAX_MANIFEST_BYTES:
        raise EvidenceError(
            f"manifest exceeds the {MAX_MANIFEST_BYTES}-byte size limit"
        )
    try:
        data = json.loads(raw_manifest, object_pairs_hook=_reject_duplicates)
    except UnicodeError as exc:
        raise EvidenceError("manifest must be UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"manifest is not valid JSON: {exc}") from exc
    except RecursionError as exc:
        raise EvidenceError("manifest nesting is too deep") from exc
    data = _object(data, "manifest")
    _reject_unknown(
        data,
        {"version", "claims", "subagent_policy", "subagent_evidence"},
        "manifest",
    )
    version = data.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version != 1:
        raise EvidenceError("manifest.version must be 1")

    claims = data.get("claims")
    if not isinstance(claims, list):
        raise EvidenceError("manifest.claims must be a list")
    if not claims:
        raise EvidenceError("manifest.claims must not be empty")
    if len(claims) > MAX_CLAIMS:
        raise EvidenceError(f"manifest.claims must contain at most {MAX_CLAIMS} items")
    claim_ids: set[str] = set()
    has_evidenced_completion = False
    for index, claim in enumerate(claims):
        claim_data = _object(claim, f"claims[{index}]")
        claim_id = _string(claim_data.get("id"), f"claims[{index}].id")
        if claim_id in claim_ids:
            raise EvidenceError(f"duplicate claim id: {claim_id}")
        claim_ids.add(claim_id)
        _validate_claim(root, claim_data, index)
        evidence = claim_data.get("evidence", {})
        if claim_data.get("status") in {"complete", "limited"} and isinstance(
            evidence, dict
        ) and any(evidence.values()):
            has_evidenced_completion = True
    if not has_evidenced_completion:
        raise EvidenceError(
            "manifest.claims must include an evidenced complete or limited claim"
        )

    allowed_agents, allowed_models, max_concurrency = _validate_subagent_policy(
        data.get("subagent_policy")
    )
    subagent_evidence = data.get("subagent_evidence")
    _validate_subagent_evidence(
        root,
        subagent_evidence,
        allowed_agents,
        allowed_models,
        max_concurrency,
    )
    return len(claims), len(subagent_evidence)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments for the read-only validator."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="project root (default: current directory)")
    parser.add_argument(
        "--manifest",
        default=None,
        help=f"manifest relative to root (default: {DEFAULT_MANIFEST})",
    )
    return parser.parse_args(list(argv) if argv is not None else None)


def main(argv: Iterable[str] | None = None) -> int:
    """Run the validator and print concise evidence counts."""
    args = parse_args(argv)
    try:
        claims, subagents = validate_manifest(Path(args.root), args.manifest)
    except (EvidenceError, OSError) as exc:
        print(f"ERROR: acceptance evidence failed: {exc}", file=sys.stderr)
        return 1
    print(f"OK: acceptance evidence manifest valid ({claims} claims; {subagents} background subagents)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
