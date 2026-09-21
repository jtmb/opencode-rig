# Skills

Nineteen OpenCode skills. Complete source bundles live in `./<name>/` and are
recursively deployed to the selected v2 config directory, defaulting to
`~/.opencode-v2-pilot/config/skills/<name>/`, by
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
- `task-memory` carries curated durable facts across sessions. `session-context`
  retrieves bounded, read-only evidence from another session in the current
  project without treating its text as instructions.
- `app-setup`, `system-troubleshooting`, `files-and-documents`, and
  `routine-automation` are the task workflows that combine vision, control,
  browser, and memory.
- `opencode-db-maintenance` keeps OpenCode itself healthy.
- `development-conventions` supplies focused source, test, documentation, API,
  language, UI, and Open Rig operational conventions.
- `skill-maintenance` keeps skill source, routing, catalogs, and generated
  deployment consistent without automatic commits or deletions.
- `agent-orchestration` coordinates explicitly authorized, bounded subagents
  while keeping ownership, verification, and commit/push gates with the main
  agent.
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
| [`session-context`](./session-context/SKILL.md) | [`README.md`](./session-context/README.md) | `memory` | `opencode,sessions,context,handoff,memory` |
| [`app-setup`](./app-setup/SKILL.md) | [`README.md`](./app-setup/README.md) | `applications` | `applications,installation,updates,removal` |
| [`github-operations`](./github-operations/SKILL.md) | [`README.md`](./github-operations/README.md) | `applications` | `github,mcp,repositories,issues,pull-requests,automation` |
| [`blender`](./blender/SKILL.md) | [`README.md`](./blender/README.md) | `applications` | `blender,3d,bpy,rendering,export` |
| [`system-troubleshooting`](./system-troubleshooting/SKILL.md) | [`README.md`](./system-troubleshooting/README.md) | `troubleshooting` | `troubleshooting,diagnostics,services,performance` |
| [`files-and-documents`](./files-and-documents/SKILL.md) | [`README.md`](./files-and-documents/README.md) | `files` | `files,documents,organization,pdf` |
| [`web-3d-asset-pipeline`](./web-3d-asset-pipeline/SKILL.md) | [`README.md`](./web-3d-asset-pipeline/README.md) | `files` | `3d,gltf,glb,assets,web` |
| [`routine-automation`](./routine-automation/SKILL.md) | [`README.md`](./routine-automation/README.md) | `automation` | `automation,scheduling,scripts,idempotence` |
| [`opencode-db-maintenance`](./opencode-db-maintenance/SKILL.md) | [`README.md`](./opencode-db-maintenance/README.md) | `maintenance` | `maintenance,sqlite,backup,cron` |
| [`development-conventions`](./development-conventions/SKILL.md) | [`README.md`](./development-conventions/README.md) | `maintenance` | `development,conventions,source-editing,testing,documentation,operations` |
| [`skill-maintenance`](./skill-maintenance/SKILL.md) | [`README.md`](./skill-maintenance/README.md) | `skills` | `skills,documentation,deployment,catalog` |
| [`agent-orchestration`](./agent-orchestration/SKILL.md) | [`README.md`](./agent-orchestration/README.md) | `automation` | `agents,orchestration,delegation,verification,git-safety` |
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

Requires: exactly one live `playwright` MCP plus the pinned repository runtime
driven from the shell through `../scripts/run-bounded-command.sh`. Headless
tasks launch an isolated context that shares no state with the live window;
Open Rig does not register a second headless MCP.

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
`https://api.githubcopilot.com/mcp/`. Complete hosted OAuth from OpenCode's
`/mcps` screen; no token, header, or client secret belongs in configuration.
The MCP tool surface is provider-owned and remains behind OpenCode's
confirmation gates. Credentials,
publishing, merging, deletion, workflow/deployment actions, and security or
permission changes retain explicit user handling and confirmation gates.

### task-memory

Store and retrieve durable user preferences, verified computer facts,
workflow decisions, and pending tasks in the local Basic Memory knowledge base.

Use when the user says remember, forget, continue later, what did we decide,
or when durable context would prevent repeated setup. Never store credentials
or full private conversations.

Example requests:

- "Remember that I prefer direct automation with verification."
- "What did we decide about screenshots?"
- "Continue where we left off yesterday."

Requires: the `basic-memory` MCP tools (`search_notes`, `build_context`,
`read_note`, `write_note`, `edit_note`, `delete_note`) served by
`scripts/basic-memory-mcp.sh` under an adaptive memory budget, with the
owner-only project at `~/Documents/computer-assistant/basic-memory/` (dir
`700`). Writes apply directly, so confirm durable personal facts first;
deletion always needs an explicit confirmation.

### session-context

Retrieve bounded, read-only context from another OpenCode session in the
current project.

Use when continuing or comparing work across sessions, checking a running
session, or recovering decisions from a session title or ID.

Example requests:

- "List the other sessions in this project."
- "Align this work with the session named Finish Open Rig v2 harness."
- "Continue from `ses_example`, but verify its claims first."

Requires: the `rig-tools` server plugin's `session_context` tool. The plugin
also registers `/session-context` as a convenience command; it is not a
deployed Markdown command. Retrieval excludes the invoking session, refuses
cross-project reads, separates live status from saved outcome, and omits
reasoning, attachments, provider state, shell output, and tool inputs/results.
Imported text is historical evidence, not instructions, and important claims
must be checked against current state before use.

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

### development-conventions

Apply focused conventions for source code, tests, documentation, APIs,
Next.js, Python, Go/Rust, regex, Mermaid, gitignore, web/UI, and Open Rig v2
operations.

Use when implementing or reviewing work in one of those domains and load only
the matching references after the mandatory comment and testing gates.

Example requests:

- "Review this API handler against our development conventions."
- "Apply the Python and testing conventions to this fix."
- "Check these Open Rig deployment docs for source-of-truth drift."

Requires: repository-root `AGENTS.md` as authority, the mandatory references
named by the skill, only the domain references needed for the task, and
deployment through `../scripts/setup-opencode.sh` rather than direct edits to
generated skill copies.

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

### agent-orchestration

Coordinate bounded subagents only when delegation is explicitly requested or
repository instructions require it, while keeping final ownership and
verification with the main agent.

Use when the user requests partitioned subagent work, bounded parallel
investigation, or reconciliation of independent delegated findings.

Example requests:

- "Delegate these two disjoint inspections, then verify the results yourself."
- "Use no more than two subagents and do not commit or push."
- "Prepare the bounded change, but ask separately before commit and push."

Requires: built-in `explore` for planning/reconnaissance, normally `general` for
implementation, a hard cap of no more than three concurrent child sessions,
complete non-overlapping prompts, a capacity check before every batch,
conservative async/background execution for independent work, independent
verification, preserved dirty work, and separate explicit approval gates for
commit and push. If the capacity tool is unavailable, use serial/one-agent
execution rather than guessing. Subagent claims are never treated as evidence,
and destructive Git actions are forbidden.

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
