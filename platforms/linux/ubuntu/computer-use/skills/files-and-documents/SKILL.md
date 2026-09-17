---
name: files-and-documents
description: Find, inspect, organize, rename, summarize, and export local files and documents while preserving originals. Use when the user asks to find a file, organize Downloads, summarize a PDF, rename files, create notes, or prepare a document/export.
metadata:
  schema-version: "1"
  category: "files"
  tags: "files,documents,organization,pdf"
---

# Files and Documents

Inspect first, preserve originals, and save only in approved locations.

## Locations

- Project code and checkouts: `~/repos/<project>`.
- Standalone runnable utilities: `~/scripts/`.
- Notes, reports, exports, and final documents: `~/Documents/`.
- Temporary downloads only: `~/Downloads/`.
- Session scratch: `/tmp/opencode/`.

Never create output in the home root, Desktop, dot-directories, XDG media
folders, or other locations without explicit approval.

## Workflow

1. Use Glob/Grep and targeted Read calls before proposing organization.
2. For PDFs and images, use the Read tool directly. Extract only information
needed for the request.
3. Preview batch renames/moves/deletions as an old-to-new manifest.
4. Copy or move only after the user approves destructive/bulk changes.
5. Verify counts, names, sizes, and readability at the destination.

## Rules

- Never overwrite a distinct file silently. Use atomic writes and backups
for irreplaceable documents.
- Do not upload documents or quote unrelated private content.
- Preserve metadata when it matters and explain format conversion losses.
- Deletion, deduplication, and cleanup default to dry-run.
- Emptying trash is a separate, explicit action.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
