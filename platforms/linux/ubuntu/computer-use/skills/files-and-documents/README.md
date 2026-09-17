# Files and Documents Usage

This guide explains how to use the `files-and-documents` skill. The
agent-facing operating rules remain in [SKILL.md](./SKILL.md); OpenCode does
not automatically load this usage guide when the skill is loaded.

Category: `files`

Tags: `files`, `documents`, `organization`, `pdf`

## Purpose and when to use it

Use `files-and-documents` to find, inspect, organize, rename, summarize, and
export local files while preserving originals.

Appropriate requests include:

- "Find the invoice PDF I downloaded last week."
- "Organize Downloads without losing anything."
- "Summarize this PDF and save notes to Documents."
- "Rename these files consistently and show the result."
- "Prepare this document for export."

This skill consumes OpenCode file-search and reading tools. It does not
provide a separate repository file-management CLI.

## Prerequisites and setup verification

The agent should first understand:

- The file type and approximate location.
- Whether the request involves one file or bulk changes.
- Which output location is approved.
- Whether metadata, formatting, filenames, or document history must be
  preserved.
- Whether deletion, deduplication, cleanup, or trash handling is involved.

Approved destination classes are:

- `~/repos/<project>` for project code and checkouts.
- `~/scripts/` for standalone utilities.
- `~/Documents/` for notes, reports, exports, and final documents.
- `~/Downloads/` for temporary downloads.
- `/tmp/opencode/` for session scratch.

The agent should not create output in the home root, Desktop,
dot-directories, XDG media folders, or another location without explicit
approval.

## How to request it

Ask in ordinary language and identify the source, goal, and destination.

Example requests:

- "Find all PDFs with this invoice number and list their paths."
- "Preview a rename that adds this date prefix, then apply it."
- "Summarize only the payment terms in this scanned PDF."
- "Export this report to Documents without overwriting the prior version."

For bulk operations, the user should approve the previewed old-to-new
manifest before anything is moved, renamed, or deleted.

## Worked workflow and expected result

A representative agent workflow is:

1. Search with Glob/Grep and read the relevant files.
2. For PDFs or images, use direct reading and extract only the requested
   information.
3. Preview a batch operation as an old-to-new manifest, for example:

   | Current path | Proposed path | Action |
   |---|---|---|
   | `~/Downloads/invoice.pdf` | `~/Documents/invoice-2026-09-01.pdf` | Move |
   | `~/Downloads/receipt.png` | `~/Documents/receipt-2026-09-01.png` | Move |

4. Apply only the approved changes.
5. Verify file counts, names, sizes, readability, and destination paths.

Expected result: the requested files are found, preserved, organized, or
exported, and the destination contains exactly the intended result.

## Verification and known limitations

The agent should compare source and destination rather than infer success from
a command result. For documents, it should check that exported text remains
readable and formatting or metadata losses are explained.

Known limitations:

- Text extraction may be incomplete for scanned, encrypted, damaged, or
  unusually formatted documents.
- Filenames can collide across directories.
- Metadata or formatting may change during conversion.
- Trash deletion and permanent deletion are different operations.
- Large bulk operations can have consequences that are difficult to reverse.

## Troubleshooting

- File not found: broaden date, filename, directory, file-type, and content
  searches before concluding it is absent.
- Ambiguous filename: ask which file is intended rather than choosing the
  newest or most likely match.
- Existing destination file: do not overwrite silently; rename, back up, or
  obtain approval.
- Unreadable document: inspect permissions, file size, format support, and
  possible corruption.
- Excessive scope: break the request into smaller approved batches.

## Safety, confirmation, and elevation

The agent must:

- Preserve originals and use atomic writes or backups for irreplaceable
  documents.
- Preview destructive or bulk changes.
- Treat trash emptying as a separate explicit action.
- Never delete or deduplicate without approval and a manifest.
- Never upload documents or quote unrelated private content.
- Explain consequential metadata or format changes before applying them.

Normal file operations do not require administrator elevation. If ownership or
system permissions unexpectedly block access, diagnose the cause before
proposing any privileged operation.

## Related skills and documents

- [`routine-automation`](../routine-automation/README.md) converts a proven
  manual organization workflow into a reusable script.
- [`browser-assistant`](../browser-assistant/README.md) handles browser
  downloads before local organization.
- [`task-memory`](../task-memory/README.md) can retain an approved filing or
  naming convention.
- The canonical catalog entry is in `skills/README.md`.
