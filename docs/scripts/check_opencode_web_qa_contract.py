"""Check that the written OpenCode Web QA contract remains complete."""

from __future__ import annotations

import argparse
import stat
import sys
from pathlib import Path, PurePosixPath

MAX_DOCUMENT_BYTES = 128 * 1024

REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "docs/scripts/opencode-web-qa.md": (
        "windows default browser",
        "ordinary authenticated browser session",
        "actual rendered browser",
        "accessible/aria snapshot",
        "meaningful browser interaction",
        "BrowserAttachments context must be used within a context provider",
        "capture time in utc",
        "sha-256",
        "2.0.10",
        "2.0.11",
        "service-owner coordination",
        "chrome for testing",
        "project playwright mcp",
        "installed opencode binary",
    ),
    "docs/scripts/check-repository-qa.md": (
        "opencode-web-qa.md",
        "authenticated windows default browser",
        "real rendered screenshot and accessible snapshot",
        "startup/browser errors",
        "not run by canonical repository qa",
        "do not use chrome for testing or a project playwright mcp",
        "check_opencode_web_qa_contract.py",
    ),
    "ROADMAP.md": (
        "OpenCode Web rendered QA",
        "Windows default browser",
        "2.0.10",
        "2.0.11",
        "authenticated access",
        "service-owner coordination",
        "Chrome for Testing",
        "project Playwright MCP",
    ),
}


def read_document(root: Path, relative_path: str) -> str:
    """Read one bounded, regular, non-symlink document beneath root.

    Args:
        root: Resolved repository root.
        relative_path: Forward-slash path selected by this checker.

    Returns:
        UTF-8 document contents.

    Raises:
        OSError: If the document is missing or cannot be read.
        ValueError: If the path or file violates the bounded input contract.
        UnicodeError: If the document is not valid UTF-8.
    """
    relative = PurePosixPath(relative_path)
    if relative.is_absolute() or any(
        part in ("", ".", "..") for part in relative.parts
    ):
        raise ValueError(f"unsafe contract path: {relative_path}")

    path = root.joinpath(*relative.parts)
    current = root
    for part in relative.parts:
        current = current / part
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"symlinked contract path: {relative_path}")

    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"contract input is not a regular file: {relative_path}")
    if metadata.st_size > MAX_DOCUMENT_BYTES:
        raise ValueError(f"contract input exceeds the size limit: {relative_path}")
    if root not in path.resolve(strict=True).parents:
        raise ValueError(f"contract path escapes repository root: {relative_path}")

    content = path.read_bytes()
    if len(content) > MAX_DOCUMENT_BYTES:
        raise ValueError(f"contract input exceeds the size limit: {relative_path}")
    return content.decode("utf-8")


def read_documents(root: Path) -> dict[str, str]:
    """Read all fixed documentation inputs for the Web QA contract.

    Args:
        root: Resolved repository root.

    Returns:
        A mapping from repository-relative path to document text.
    """
    return {path: read_document(root, path) for path in REQUIREMENTS}


def check_documents(documents: dict[str, str]) -> list[str]:
    """Return missing required phrases for the selected contract documents.

    Args:
        documents: Documentation contents keyed by repository-relative path.

    Returns:
        One diagnostic per missing required phrase or document.
    """
    issues: list[str] = []
    for path, phrases in REQUIREMENTS.items():
        content = documents.get(path)
        if content is None:
            issues.append(f"missing contract document: {path}")
            continue
        normalized = " ".join(content.split()).casefold()
        for phrase in phrases:
            if " ".join(phrase.split()).casefold() not in normalized:
                issues.append(f"{path}: missing required contract phrase {phrase!r}")
    return issues


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse the optional repository root argument.

    Args:
        argv: Optional argument list for callers and tests.

    Returns:
        Parsed command-line arguments.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help="repository root (default: inferred from this script)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """Run the read-only documentation contract check.

    Args:
        argv: Optional argument list for callers and tests.

    Returns:
        Zero when all documented requirements are present, otherwise one.
    """
    arguments = parse_arguments(argv)
    try:
        root = arguments.root.resolve(strict=True)
        if not root.is_dir():
            raise ValueError("repository root is not a directory")
        issues = check_documents(read_documents(root))
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Web QA contract check failed: {error}", file=sys.stderr)
        return 1

    if issues:
        for issue in issues:
            print(issue, file=sys.stderr)
        return 1

    print(
        f"OpenCode Web QA documentation contract present in {len(REQUIREMENTS)} files; "
        "live browser acceptance was not tested."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
