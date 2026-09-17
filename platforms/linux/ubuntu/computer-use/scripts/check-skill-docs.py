#!/usr/bin/env python3
"""Validate canonical skill metadata and user-facing documentation.

This is a read-only repository consistency check. It does not deploy skills,
modify files, or inspect live application state.
"""

from __future__ import annotations

import re
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SKILLS_DIR = SCRIPT_DIR.parent / "skills"
CATALOG = SKILLS_DIR / "README.md"
CATEGORIES = {
    "applications",
    "automation",
    "browser",
    "desktop",
    "editor",
    "files",
    "maintenance",
    "memory",
    "skills",
    "troubleshooting",
}
NAME_PATTERN = re.compile(r"^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$")
TAG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK_PATTERN = re.compile(r"\[[^\]]+\]\(([^)\s]+)\)")
GENERATED_DIRS = {
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "node_modules",
}
GENERATED_FILES = {".DS_Store", "Thumbs.db"}
GENERATED_SUFFIXES = {".pyc", ".pyo"}
REQUIRED_SECTIONS = (
    "## Purpose and when to use it",
    "## Prerequisites and setup verification",
    "## How to request it",
    "## Worked workflow and expected result",
    "## Verification and known limitations",
    "## Troubleshooting",
    "## Safety, confirmation, and elevation",
    "## Related skills and documents",
)


def fail(message: str) -> None:
    raise SystemExit(f"check-skill-docs: {message}")


def read_frontmatter(path: Path) -> tuple[dict[str, str], dict[str, str]]:
    text = path.read_text(encoding="utf-8")
    parts = text.split("---", 2)
    if len(parts) != 3 or parts[0].strip():
        fail(f"invalid frontmatter envelope: {path}")
    fields: dict[str, str] = {}
    metadata: dict[str, str] = {}
    in_metadata = False
    for line in parts[1].splitlines():
        if not line.strip():
            continue
        if line == "metadata:":
            in_metadata = True
            fields["metadata"] = ""
            continue
        if line.startswith("  ") and in_metadata:
            key, separator, value = line.strip().partition(":")
            raw_value = value.strip()
            if not separator or not key or not raw_value:
                fail(f"invalid metadata entry in {path}: {line!r}")
            if key in metadata:
                fail(f"duplicate metadata key in {path}: {key!r}")
            if (
                len(raw_value) < 2
                or raw_value[0] not in "\"'"
                or raw_value[-1] != raw_value[0]
            ):
                fail(f"metadata values must be quoted strings in {path}: {line!r}")
            metadata[key] = raw_value[1:-1]
        elif line.startswith((" ", "\t")):
            fail(f"unexpected indentation in {path}: {line!r}")
        else:
            key, separator, value = line.partition(":")
            if not separator or key in fields:
                fail(f"invalid frontmatter entry in {path}: {line!r}")
            fields[key.strip()] = value.strip()
            in_metadata = False
    return fields, metadata


def check_links(path: Path) -> None:
    base = path.parent
    for target in LINK_PATTERN.findall(path.read_text(encoding="utf-8")):
        target, _, _ = target.partition("#")
        if not target or "://" in target or target.startswith(("#", "/", "~")):
            continue
        resolved = (base / target).resolve()
        try:
            resolved.relative_to(SKILLS_DIR.resolve())
        except ValueError:
            fail(f"link escapes deployed skill set in {path}: {target}")
        if not resolved.exists():
            fail(f"unresolved link in {path}: {target}")


def check_bundle_files(skill: Path) -> None:
    if skill.is_symlink():
        fail(f"skill directory is a symbolic link: {skill}")
    for path in skill.rglob("*"):
        relative = path.relative_to(skill)
        if path.is_symlink():
            fail(f"skill bundle contains a symbolic link: {path}")
        if (
            any(part in GENERATED_DIRS for part in relative.parts)
            or path.name in GENERATED_FILES
            or path.suffix in GENERATED_SUFFIXES
        ):
            fail(f"skill bundle contains generated artifact: {path}")
        if path.is_file() and path.stat().st_mode & 0o002:
            fail(f"skill bundle file is world writable: {path}")


def read_catalog_rows(catalog_text: str) -> dict[str, tuple[str, list[str]]]:
    rows: dict[str, tuple[str, list[str]]] = {}
    for line in catalog_text.splitlines():
        if not line.startswith("| [`"):
            continue
        columns = [column.strip() for column in line.strip().strip("|").split("|")]
        if len(columns) < 4:
            fail(f"invalid category index row: {line!r}")
        match = re.search(r"\[`([^`]+)`\]", columns[0])
        if match is None:
            fail(f"invalid category index row: {line!r}")
        name = match.group(1)
        if name in rows:
            fail(f"duplicate category index row: {name}")
        category = columns[2].strip().strip("`").strip()
        tags = [
            tag.strip().strip("`")
            for tag in columns[3].replace("`", "").split(",")
            if tag.strip().strip("`")
        ]
        rows[name] = (category, tags)
    return rows


def main() -> int:
    if not SKILLS_DIR.is_dir():
        fail(f"missing skills directory: {SKILLS_DIR}")
    if not CATALOG.is_file():
        fail(f"missing skills catalog: {CATALOG}")
    catalog = CATALOG.read_text(encoding="utf-8")
    skills = sorted(p for p in SKILLS_DIR.iterdir() if p.is_dir())
    catalog_rows = read_catalog_rows(catalog)
    if set(catalog_rows) != {skill.name for skill in skills}:
        fail("category index does not match canonical skill directories")

    for skill in skills:
        check_bundle_files(skill)
        entry = skill / "SKILL.md"
        guide = skill / "README.md"
        if not entry.is_file():
            fail(f"missing SKILL.md: {skill}")
        if not guide.is_file():
            fail(f"missing usage README.md: {skill}")

        fields, metadata = read_frontmatter(entry)
        if set(fields) - {"name", "description", "license", "compatibility", "metadata"}:
            fail(f"unrecognized frontmatter field: {entry}")
        if fields.get("name") != skill.name or not NAME_PATTERN.fullmatch(skill.name):
            fail(f"invalid skill name: {entry}")
        description = fields.get("description", "")
        if not 1 <= len(description) <= 1024:
            fail(f"invalid description length: {entry}")
        if metadata.get("schema-version") != "1":
            fail(f"invalid metadata schema-version: {entry}")
        if metadata.get("category") not in CATEGORIES:
            fail(f"invalid metadata category: {entry}")
        raw_tags = metadata.get("tags", "").split(",")
        tags = [tag.strip() for tag in raw_tags]
        if (
            any(not tag for tag in tags)
            or len(tags) != len(set(tags))
            or not 3 <= len(tags) <= 8
            or any(not TAG_PATTERN.fullmatch(tag) for tag in tags)
        ):
            fail(f"invalid metadata tags: {entry}")

        guide_text = guide.read_text(encoding="utf-8")
        title = guide_text.splitlines()[0] if guide_text else ""
        if not title.startswith("# ") or not title.endswith(" Usage"):
            fail(f"invalid usage-guide title: {guide}")
        for section in REQUIRED_SECTIONS:
            if section not in guide_text:
                fail(f"missing {section!r}: {guide}")
        category_match = re.search(r"^Category: `([^`]+)`$", guide_text, re.MULTILINE)
        tags_match = re.search(r"^Tags: (.+)$", guide_text, re.MULTILINE)
        guide_tags = (
            [
                tag.strip().strip("`")
                for tag in tags_match.group(1).replace("`", "").split(",")
                if tag.strip().strip("`")
            ]
            if tags_match
            else []
        )
        if (
            category_match is None
            or category_match.group(1).strip() != metadata["category"]
            or guide_tags != tags
        ):
            fail(f"usage guide does not match {entry}: {guide}")

        if f"### {skill.name}" not in catalog:
            fail(f"missing catalog entry: {skill.name}")
        if catalog_rows[skill.name] != (metadata["category"], tags):
            fail(f"catalog category/tags do not match {entry}")
        entry_text = entry.read_text(encoding="utf-8")
        if "./README.md" not in entry_text:
            fail(f"missing usage-guide link: {entry}")
        if "./SKILL.md" not in guide_text:
            fail(f"missing skill link: {guide}")

        for document in sorted(skill.rglob("*.md")):
            check_links(document)

    check_links(CATALOG)
    print(f"OK: skill metadata and documentation valid for {len(skills)} skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
