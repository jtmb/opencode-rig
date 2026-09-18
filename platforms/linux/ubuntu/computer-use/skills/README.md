# Skills

Sixteen OpenCode skills. Complete source bundles live in `./<name>/` and are
recursively deployed to `~/.config/opencode/skills/<name>/` by
`../scripts/setup-opencode.sh --apply` (idempotent and content-aware).

Restart OpenCode after deployment. Running sessions do not hot-reload skills.

## Using skills

Ask for the desired outcome in ordinary language; users do not need to invoke
an internal loader. When the assistant loads a skill, it reads that skill's
`SKILL.md`. Each skill below also links a user-facing usage guide with
request examples, prerequisites, commands, verification, limitations, and
safety requirements. Usage guides and other references are not loaded
automatically.

Supporting commands, MCP servers, and desktop tools are execution mechanisms,
not substitutes for loading the relevant skill. Follow the exact preview and
write behavior documented in the skill-specific guide: flags and safety modes
differ by utility. Canonical skill metadata uses one category and
comma-separated tags; the category/tag index below is derived from each
`SKILL.md`.

## How they fit together

- `desktop-vision` gives the assistant eyes. `desktop-control` gives it hands.
  Every GUI mutation follows observe, act, verify with a fresh screenshot.
- `browser-assistant` shares a visible isolated Firefox window with the user.
  `browser-headless` handles explicitly requested invisible browser work.
- `game-playtest` adds canvas/WebGL screenshots, bounded gameplay input, and
  browser diagnostics for game QA.
- `github-operations` uses the GitHub MCP for context and approved mutations,
  preserving confirmation gates for publishing, merging, and other remote
  changes.
- `blender` owns safe Blender scene work. `web-3d-asset-pipeline` turns DCC
  sources into verified browser-ready GLB/glTF artifacts.
- `task-memory` carries durable context across sessions so setup is not
  repeated.
- `app-setup`, `system-troubleshooting`, `files-and-documents`, and
  `routine-automation` are the task workflows that combine vision, control,
  browser, and memory.
- `opencode-db-maintenance` keeps OpenCode itself healthy.
- `skill-maintenance` keeps skill source, routing, catalogs, and generated
  deployment consistent without automatic commits or deletions.
- `vscode-management` owns Microsoft VS Code package, CLI, settings, extension,
  workspace, profile, integrated-browser testing, GUI, and troubleshooting
  workflows.

## Category and tag index

| Skill | Usage guide | Category | Tags |
|---|---|---|---|
| [`desktop-vision`](./desktop-vision/SKILL.md) | [`README.md`](./desktop-vision/README.md) | `desktop` | `desktop,gnome,screenshot,visual-verification` |
| [`desktop-control`](./desktop-control/SKILL.md) | [`README.md`](./desktop-control/README.md) | `desktop` | `desktop,at-spi,gui,gnome` |
| [`browser-assistant`](./browser-assistant/SKILL.md) | [`README.md`](./browser-assistant/README.md) | `browser` | `browser,live,playwright,firefox` |
| [`browser-headless`](./browser-headless/SKILL.md) | [`README.md`](./browser-headless/README.md) | `browser` | `browser,headless,playwright,automation` |
| [`game-playtest`](./game-playtest/SKILL.md) | [`README.md`](./game-playtest/README.md) | `browser` | `games,playtesting,playwright,canvas,webgl` |
| [`task-memory`](./task-memory/SKILL.md) | [`README.md`](./task-memory/README.md) | `memory` | `memory,preferences,decisions,pending` |
| [`app-setup`](./app-setup/SKILL.md) | [`README.md`](./app-setup/README.md) | `applications` | `applications,installation,updates,removal` |
| [`github-operations`](./github-operations/SKILL.md) | [`README.md`](./github-operations/README.md) | `applications` | `github,mcp,repositories,issues,pull-requests,automation` |
| [`blender`](./blender/SKILL.md) | [`README.md`](./blender/README.md) | `applications` | `blender,3d,bpy,rendering,export` |
| [`system-troubleshooting`](./system-troubleshooting/SKILL.md) | [`README.md`](./system-troubleshooting/README.md) | `troubleshooting` | `troubleshooting,diagnostics,services,performance` |
| [`files-and-documents`](./files-and-documents/SKILL.md) | [`README.md`](./files-and-documents/README.md) | `files` | `files,documents,organization,pdf` |
| [`web-3d-asset-pipeline`](./web-3d-asset-pipeline/SKILL.md) | [`README.md`](./web-3d-asset-pipeline/README.md) | `files` | `3d,gltf,glb,assets,web` |
| [`routine-automation`](./routine-automation/SKILL.md) | [`README.md`](./routine-automation/README.md) | `automation` | `automation,scheduling,scripts,idempotence` |
| [`opencode-db-maintenance`](./opencode-db-maintenance/SKILL.md) | [`README.md`](./opencode-db-maintenance/README.md) | `maintenance` | `maintenance,sqlite,backup,cron` |
| [`skill-maintenance`](./skill-maintenance/SKILL.md) | [`README.md`](./skill-maintenance/README.md) | `skills` | `skills,documentation,deployment,catalog` |
| [`vscode-management`](./vscode-management/SKILL.md) | [`README.md`](./vscode-management/README.md) | `editor` | `editor,vscode,extensions,workspaces,browser,testing` |

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
`--apply`. Protected fields are redacted and cannot be read or written.
Ambiguous targets stop and list candidates instead of guessing.

Observed limits: some GTK4 controls expose only a window frame; custom
canvases and sandboxed apps may expose little AT-SPI data; advertised dialog
actions do not always dismiss the dialog; `default.activate` may be accepted
without raising the window. Fall back to documented keyboard navigation and
verify with a fresh screenshot.

### browser-assistant

Interact with websites in a visible Playwright Firefox window shared by the
user and agent, including navigation, forms, downloads, and verification.

Use when the user says live browser, browse with me, use the visible browser,
click a website, fill a web form, or complete an interactive web workflow.
Prefer webfetch/websearch for read-only research.

Example requests:

- "Fill this web form as a draft and show me the result."
- "Open the live browser and let me complete the login."
- "Verify the checkout flow up to, but not including, payment."

Requires: `playwright` MCP entry pointing at
`../scripts/playwright-mcp.sh` and the pinned runtime in
`../../browser-tools/`. The visible session is isolated from normal Firefox,
but the user and agent operate the same window. Never enter passwords, MFA,
payment details, or CAPTCHAs for the user.

### browser-headless

Run isolated browser tasks through Playwright Firefox without opening a visible
window.

Use only when the user explicitly asks for headless browsing, background
browser automation, or another non-interactive Playwright task. Use the live
browser whenever the user needs to see, steer, authenticate, or take over.

Example requests:

- "Check these pages in headless Playwright."
- "Run this browser smoke test without opening a window."
- "Download this public artifact in the background."

Requires: on v1, the `playwright_headless` MCP entry pointing at
`../scripts/playwright-headless-mcp.sh`; on v2, exactly one live `playwright`
MCP plus the pinned repository runtime driven from the shell through
`../scripts/run-bounded-command.sh`. Both run an isolated context that shares
no state with the live window.

### game-playtest

Playtest browser games in Playwright Firefox with accessibility-first
inspection, bounded input, mandatory canvas/WebGL screenshots, representative
state coverage, console review, responsive checks, and severity-ordered
findings.

Use when the user requests a browser-game smoke test, gameplay QA, visual
verification, HUD review, responsive testing, or a reproducible game bug report.

Example requests:

- "Smoke-test this browser game and exercise movement, pause, and restart."
- "Check the WebGL scene and HUD at desktop and narrow viewport sizes."
- "Report gameplay bugs by severity with reproduction steps."

Requires: the repository's visible Playwright Firefox by default, or headless
only when explicitly requested. Canvas/WebGL tests require screenshots in
addition to accessibility, console, and network evidence. Test screenshots are
deleted immediately after inspection.

### github-operations

Inspect GitHub repositories, code, issues, pull requests, checks, and releases,
and perform explicitly approved remote changes.

Use when the user mentions GitHub, a GitHub URL, repository, issue, pull
request, review, release, or GitHub Actions.

Example requests:

- "Summarize the open issues in this GitHub repository."
- "Review pull request 42 and report blocking concerns."
- "Check why the latest GitHub Actions run failed."

Requires: the global `github` MCP entry pointing at
`../scripts/github-mcp.sh`, the checksum-pinned official runtime under
`../../github-tools/`, and a credential from `GITHUB_PERSONAL_ACCESS_TOKEN` or
`GH_TOKEN` in OpenCode's launch environment, including values loaded from a
project `.env`, or from the logged-in `gh` CLI.
The MCP is limited to `context`, `repos`,
`issues`, and `pull_requests` with read-only and lockdown modes. Credentials,
publishing, merging, deletion, workflow/deployment actions, and security or
permission changes retain explicit user handling and confirmation gates.

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

### blender

Operate Blender 5.0 on Ubuntu for safe scene inspection, scripted edits,
versioned saves, rendering, and import/export verification without assuming a
Blender MCP server.

Use for `.blend` inspection or edits, bounded `bpy` automation, renders, scene
save/reopen checks, and verified 3D imports or exports.

Example requests:

- "Inspect this Blender scene and report missing external textures."
- "Create a versioned scene copy, render frame 24, and verify the image."
- "Export this collection to GLB and verify a clean reimport."

Requires: Blender's own executable for `bpy`, safe background flags and timeout,
preserved source files, unused versioned outputs, independent-process reopen,
and visual inspection of requested renders. Interactive viewport work combines
`desktop-control` and `desktop-vision`.

### system-troubleshooting

Diagnose Ubuntu desktop problems such as slowness, crashes, failed services,
audio, networking, storage, permissions, and application launch failures.

Use when the user says fix, broken, slow, crash, no sound, network issue,
service failed, or provides an error report.

Example requests:

- "Audio stopped working after the update."
- "This app crashes on launch with this error."
- "The system is suddenly slow - find the cause."

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

### web-3d-asset-pipeline

Prepare and verify runtime-ready browser 3D assets, including units, pivots,
transforms, hierarchy, naming, materials, textures, GLB export, clean reimport,
optional approved compression, and Firefox load checks.

Use when cleaning, optimizing, exporting, or diagnosing a GLB/glTF asset for a
web project.

Example requests:

- "Prepare this Blender prop for Three.js as a GLB and preserve the source."
- "Find why this model has the wrong scale and pivot at runtime."
- "Validate this GLB's hierarchy, materials, size, and Firefox load."

Requires: an explicit runtime contract, preserved sources and shipping assets,
a new versioned output, clean reimport, and a load through the project's existing
Firefox loader. It does not install undeclared optimization dependencies. This
bundle independently adapts MIT-licensed OpenAI Game Studio guidance and carries
its provenance and license files.

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

Use ONLY when the user mentions opencode database size, opencode.db disk
space, opencode.db, VACUUM, prune, chat backup, opencode-backups, maintenance
cron, or DB maintenance.

Example requests:

- "opencode.db is huge - diagnose it read-only."
- "Back up all chats before we prune anything."
- "Check whether weekly maintenance is scheduled."

Requires: `scripts/opencode-db-maintain.py`,
`scripts/opencode-chat-backup.py`, and
`scripts/opencode-maintenance-cron.sh`. Diagnosis is read-only. `--apply`
requires OpenCode to be closed (the script enforces this), plus automatic
backup and integrity checks.

### skill-maintenance

Create, update, audit, catalog, deploy, rename, or retire OpenCode skills in
this repository while keeping changes bounded and reviewable.

Use when skill coverage is missing or stale, a `SKILL.md` or reference bundle
changes, the catalog drifts, deployment needs verification, or the user asks
for skill maintenance.

Example requests:

- "Audit all skills for stale paths and unsafe instructions."
- "Create a skill for this repeated workflow."
- "Deploy this updated split skill and verify every reference file."

Requires: root `AGENTS.md` as routing authority, canonical source under this
directory, explicit reading of the relevant bundled reference, recursive
deployment through `../scripts/setup-opencode.sh --apply`, and a fresh OpenCode
session for runtime discovery. It never commits or deletes automatically.

### vscode-management

Install, update, configure, operate, test with the integrated browser, and
troubleshoot Microsoft Visual Studio Code on Ubuntu.

Use when the user mentions VS Code, Visual Studio Code, the `code` command,
editor settings, profiles, workspaces, extensions, the integrated terminal or
browser, in-editor web testing, or VS Code startup and performance problems.

Example requests:

- "Install the stable Microsoft VS Code package and verify it opens."
- "Test this local web app in VS Code without opening an external browser."
- "Install this extension by publisher-qualified ID."
- "Diagnose why the integrated terminal or extension host is failing."

Requires: package and architecture inspection, APT simulation, Microsoft
package/hash verification for installation, exact extension IDs, preservation
of user and workspace settings, and `desktop-control` plus `desktop-vision` for
GUI workflows. When hosted in VS Code, agents prefer available built-in browser
tools for local web-app testing and use repository browser skills when those
tools are unavailable or browser-specific coverage is required. Repository,
security, sign-in, publishing, and deletion changes retain their normal
confirmation gates.
