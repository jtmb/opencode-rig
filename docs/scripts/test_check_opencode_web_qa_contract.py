"""Tests for the portable OpenCode Web QA documentation-contract check."""

from __future__ import annotations

import unittest
from pathlib import Path

import check_opencode_web_qa_contract as contract

SCRIPT_DIRECTORY = Path(__file__).resolve().parent


class WebQaContractTests(unittest.TestCase):
    """Verify required prose is present and meaningful omissions are detected."""

    def test_repository_documents_satisfy_contract(self) -> None:
        """The current guide, QA instructions, and roadmap cover Web QA."""
        root = SCRIPT_DIRECTORY.parents[1]
        documents = contract.read_documents(root)
        self.assertEqual([], contract.check_documents(documents))

    def test_missing_accessibility_requirement_is_reported(self) -> None:
        """Removing the accessible snapshot requirement fails the static check."""
        root = SCRIPT_DIRECTORY.parents[1]
        documents = contract.read_documents(root)
        guide_path = "docs/scripts/opencode-web-qa.md"
        documents[guide_path] = documents[guide_path].replace(
            "accessible/ARIA snapshot", "removed accessibility evidence"
        )

        issues = contract.check_documents(documents)

        self.assertTrue(
            any("accessible/aria snapshot" in issue.casefold() for issue in issues),
            "the missing accessibility requirement must be reported",
        )


if __name__ == "__main__":
    unittest.main()
