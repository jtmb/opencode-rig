# Skills

Nine OpenCode skills. Sources live here in `../skills/<name>/SKILL.md` and are
deployed to `~/.config/opencode/skills/<name>/SKILL.md` by
`../scripts/setup-opencode.sh` (idempotent — only copies when content differs).

Restart OpenCode after deployment. Running sessions do not hot-reload skills.

## How they fit together

- `desktop-vision` gives the assistant eyes. `desktop-control` gives it hands.
  Every GUI mutation follows observe, act, verify with a fresh screenshot.
- `browser-assistant` handles web pages through Playwright so desktop clicking
  is not used for browser work.
- `task-memory` carries durable context across sessions so setup is not
  repeated.
- `app-setup`, `system-troubleshooting`, `files-and-documents`, and
  `routine-automation` are the task workflows that combine vision, control,
  browser, and memory.
- `opencode-db-maintenance` keeps OpenCode itself healthy.

## Catalog

### desktop-vision

Let the assistant see the user's GNOME desktop by triggering a trusted
screenshot shortcut when available, or asking the user to press PrintScreen.
View only the newly created PNG with the Read tool, then delete it.

Use when the user says see the screen, screenshot, look at my display, what's
on my screen, verify visually, or when GUI work needs eyes on the result.

Example requests:

- "Can you see what's on my screen right now?"
- "Verify visually that the installer window is closed."
- "Look at this dialog and tell me which button is focused."

Requires: GNOME screenshot shortcut, `ydotool` user service with its private
socket (agent-triggered path) or a user keypress (fallback). No permission
changes are made from this skill.

### desktop-control

Inspect and operate GNOME desktop applications through AT-SPI, using desktop
screenshots to verify each GUI action.

Use when the user asks to click, type, open, close, configure, or otherwise
interact with a desktop application or dialog. Do not use for browser pages
when Playwright tools are available.

Example requests:

- "Open Calculator, then close it."
- "Dismiss the unsaved-changes dialog without saving."
- "Type this address into the compose field."

Requires: `scripts/desktop-control.py`, `python3-pyatspi`, GNOME toolkit
accessibility, plus `desktop-vision` for verification. Mutations require
`--apply`. Password fields are refused. Ambiguous targets stop and list
candidates instead of guessing.

Observed limits: some GTK4 controls expose only a window frame; custom
canvases and sandboxed apps may expose little AT-SPI data; advertised dialog
actions do not always dismiss the dialog; `default.activate` may be accepted
without raising the window. Fall back to documented keyboard navigation and
verify with a fresh screenshot.

### browser-assistant

Research and interact with websites using the configured Playwright MCP
browser, including navigation, forms, downloads, and visible verification.

Use when the user asks to browse, click a website, fill a web form, download
from a site, or verify a web workflow. Prefer webfetch/websearch for
read-only research and Playwright for interaction.

Example requests:

- "Fill this web form as a draft and show me the result."
- "Download the release notes PDF from this page."
- "Verify the checkout flow up to (but not including) payment."

Requires: `playwright` MCP entry pointing at
`../scripts/playwright-mcp.sh`, pinned runtime in `../browser/`, isolated
Firefox binaries. The session is isolated and does not inherit normal Firefox
cookies or tabs. Never enter passwords, MFA, payment details, or CAPTCHAs.

### task-memory

Store and retrieve durable user preferences, verified computer facts,
workflow decisions, and pending tasks in a private local memory file.

Use when the user says remember, forget, continue later, what did we decide,
or when durable context would prevent repeated setup. Never store credentials
or full private conversations.

Example requests:

- "Remember that I prefer direct automation with verification."
- "What did we decide about screenshots?"
- "Continue where we left off yesterday."

Requires: `scripts/assistant-memory.py`, owner-only store at
`~/Documents/computer-assistant/memory.json` (dir `700`, file `600`).
Writes preview by default and require `--apply`.

### app-setup

Install, configure, update, verify, and safely remove desktop or CLI
applications on Ubuntu.

Use when the user asks to install, set up, update, configure, uninstall, or
make an application work. Treat acceptance tests, preserved settings, and
rollback as part of completion.

Example requests:

- "Install VLC and verify it plays this file."
- "Set up this printer and print a test page."
- "Remove this app without touching my settings."

Requires: APT simulation review for removals and downgrades, `desktop-control`
for configuration, and user handling of secrets and MFA.

### system-troubleshooting

Diagnose Ubuntu desktop problems such as slowness, crashes, failed services,
audio, networking, storage, permissions, and application launch failures.

Use when the user says fix, broken, slow, crash, no sound, network issue,
service failed, or provides an error report.

Example requests:

- "Audio stopped working after the update."
- "This app crashes on launch with this error."
- "The system is suddenly slow — find the cause."

Requires: read-only evidence first (versions, processes, resources, service
status, journals, devices, config, free space), one testable cause, smallest
reversible fix, and a repeated reproduction plus regression check.

### files-and-documents

Find, inspect, organize, rename, summarize, and export local files and
documents while preserving originals.

Use when the user asks to find a file, organize Downloads, summarize a PDF,
rename files, create notes, or prepare a document/export.

Example requests:

- "Find the invoice PDF I downloaded last week."
- "Organize Downloads without losing anything."
- "Summarize this PDF and save the notes to Documents."

Requires: Glob/Grep plus targeted reads, old-to-new manifest for batch
operations, and verification of counts, names, sizes, and readability.

### routine-automation

Turn a confirmed recurring computer task into an idempotent script and
optional schedule with logs, locking, dry-run behavior, verification, and
rollback.

Use when the user asks to automate, schedule, run regularly, create a cron
job, timer, recurring backup, or reusable setup procedure.

Example requests:

- "Run this backup every Sunday and log the result."
- "Turn these manual steps into a script I can rerun safely."
- "Schedule this report with a disable and rollback path."

Requires: an already-understood manual workflow, stdlib-only scripts,
`--dry-run` default with `--apply` for writes, idempotence, locking,
bounded retries, and syntax, dry-run, real-run, and second idempotence-run
checks before scheduling.

### opencode-db-maintenance

Diagnose and reclaim opencode.db SQLite disk usage when the database fills
the disk (event-table bloat, freelist pages, VACUUM, prune); back up chats to
opencode-backups and manage the weekly maintenance cron job.

Use ONLY when the user mentions opencode database size, disk space,
opencode.db, VACUUM, prune, chat backup, opencode-backups, cron, or DB
maintenance.

Example requests:

- "opencode.db is huge — diagnose it read-only."
- "Back up all chats before we prune anything."
- "Check whether weekly maintenance is scheduled."

Requires: `scripts/opencode-db-maintain.py`,
`scripts/opencode-chat-backup.py`, and
`scripts/opencode-maintenance-cron.sh`. Diagnosis is read-only. `--apply`
requires OpenCode to be closed (the script enforces this), plus automatic
backup and integrity checks.
