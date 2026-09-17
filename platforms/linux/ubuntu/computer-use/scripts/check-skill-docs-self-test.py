#!/usr/bin/env python3
"""Isolated negative tests for the skill documentation validator."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-skill-docs.py"
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


def load_validator():
    spec = importlib.util.spec_from_file_location("check_skill_docs", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_skill(root: Path, name: str, category: str, tags: str) -> Path:
    skill = root / name
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\n"
        f"name: {name}\n"
        "description: Fixture skill used only for validator testing.\n"
        "metadata:\n"
        '  schema-version: "1"\n'
        f'  category: "{category}"\n'
        f'  tags: "{tags}"\n'
        "---\n\n# Fixture\n\n[README](./README.md)\n",
        encoding="utf-8",
    )
    (skill / "README.md").write_text(
        "# Fixture Usage\n\n"
        f"Category: `{category}`\n\nTags: `{tags}`\n\n"
        + "".join(f"{section}\n\nBody.\n\n" for section in REQUIRED_SECTIONS)
        + "[SKILL](./SKILL.md)\n",
        encoding="utf-8",
    )
    return skill


def write_catalog(root: Path, rows: list[tuple[str, str, str]]) -> Path:
    catalog = root / "README.md"
    text = "# Skills\n\n| Skill | Guide | Category | Tags |\n"
    text += "".join(
        f"| [`{name}`](./{name}/SKILL.md) | "
        f"[`README`](./{name}/README.md) | `{category}` | `{tags}` |\n"
        for name, category, tags in rows
    )
    text += "".join(f"\n### {name}\n" for name, _, _ in rows)
    catalog.write_text(text, encoding="utf-8")
    return catalog


def expect_failure(module, skills: Path, catalog: Path, label: str) -> None:
    old_skills, old_catalog = module.SKILLS_DIR, module.CATALOG
    module.SKILLS_DIR, module.CATALOG = skills, catalog
    try:
        try:
            module.main()
        except SystemExit:
            return
        raise AssertionError(f"validator unexpectedly passed: {label}")
    finally:
        module.SKILLS_DIR, module.CATALOG = old_skills, old_catalog


def main() -> int:
    module = load_validator()
    with tempfile.TemporaryDirectory(prefix="skill-docs-self-test-") as tmp:
        base = Path(tmp)

        valid_skills = base / "valid" / "skills"
        valid_skills.mkdir(parents=True)
        write_skill(valid_skills, "example-skill", "desktop", "one,two,three")
        valid_catalog = write_catalog(
            valid_skills, [("example-skill", "desktop", "one,two,three")]
        )
        module.SKILLS_DIR, module.CATALOG = valid_skills, valid_catalog
        assert module.main() == 0

        cases = []

        case = base / "duplicate-metadata" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        entry = (skill / "SKILL.md").read_text(encoding="utf-8")
        (skill / "SKILL.md").write_text(
            entry.replace(
                '  category: "desktop"\n',
                '  category: "desktop"\n  category: "browser"\n',
            ),
            encoding="utf-8",
        )
        cases.append(("duplicate metadata", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        case = base / "unquoted-metadata" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        entry = (skill / "SKILL.md").read_text(encoding="utf-8")
        (skill / "SKILL.md").write_text(
            entry.replace('  schema-version: "1"\n', "  schema-version: 1\n"),
            encoding="utf-8",
        )
        cases.append(("unquoted metadata", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        long_name = "a" * 65
        case = base / "long-name" / "skills"
        case.mkdir(parents=True)
        write_skill(case, long_name, "desktop", "one,two,three")
        cases.append(("overlong name", case, write_catalog(
            case, [(long_name, "desktop", "one,two,three")]
        )))

        case = base / "empty-tag" / "skills"
        case.mkdir(parents=True)
        write_skill(case, "example-skill", "desktop", "one,,two")
        cases.append(("empty tag", case, write_catalog(
            case, [("example-skill", "desktop", "one,,two")]
        )))

        case = base / "catalog-mismatch" / "skills"
        case.mkdir(parents=True)
        write_skill(case, "example-skill", "desktop", "one,two,three")
        cases.append(("catalog mismatch", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,other")],
        )))

        case = base / "missing-section" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        guide = (skill / "README.md").read_text(encoding="utf-8")
        (skill / "README.md").write_text(
            guide.replace("## Troubleshooting\n\nBody.\n\n", ""),
            encoding="utf-8",
        )
        cases.append(("missing section", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        case = base / "unresolved-link" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        guide = (skill / "README.md").read_text(encoding="utf-8")
        (skill / "README.md").write_text(
            guide + "\n[Missing](./missing.md)\n", encoding="utf-8"
        )
        cases.append(("unresolved link", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        case = base / "extra-catalog-row" / "skills"
        case.mkdir(parents=True)
        write_skill(case, "example-skill", "desktop", "one,two,three")
        cases.append(("extra catalog row", case, write_catalog(
            case,
            [
                ("example-skill", "desktop", "one,two,three"),
                ("retired-skill", "desktop", "one,two,three"),
            ],
        )))

        case = base / "generated-artifact" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        cache = skill / "__pycache__"
        cache.mkdir()
        (cache / "helper.pyc").write_bytes(b"generated")
        cases.append(("generated artifact", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        case = base / "escaping-link" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        outside = case.parent / "outside.md"
        outside.write_text("outside\n", encoding="utf-8")
        guide = (skill / "README.md").read_text(encoding="utf-8")
        (skill / "README.md").write_text(
            guide + "\n[Outside](../../outside.md)\n", encoding="utf-8"
        )
        cases.append(("escaping link", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        case = base / "symbolic-link" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        (skill / "linked-readme.md").symlink_to(skill / "README.md")
        cases.append(("symbolic link", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        case = base / "world-writable" / "skills"
        case.mkdir(parents=True)
        skill = write_skill(case, "example-skill", "desktop", "one,two,three")
        entry = skill / "SKILL.md"
        entry.chmod(entry.stat().st_mode | 0o002)
        cases.append(("world writable", case, write_catalog(
            case,
            [("example-skill", "desktop", "one,two,three")],
        )))

        for label, skills, catalog in cases:
            expect_failure(module, skills, catalog, label)

    print(f"OK: validator negative coverage passed for {len(cases)} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
