# VS Code Management Usage

This guide explains how to use the `vscode-management` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `editor`

Tags: `editor`, `vscode`, `extensions`, `workspaces`, `browser`, `testing`

## Purpose and when to use it

Use `vscode-management` to install, update, configure, operate, and
troubleshoot Microsoft Visual Studio Code on Ubuntu, including testing web apps
with its integrated browser.

Appropriate requests include:

- "Install the stable Microsoft VS Code package and verify it opens."
- "Update VS Code through the configured package repository."
- "Open this project in VS Code."
- "Test this local web app in VS Code's integrated browser."
- "Install this extension by publisher-qualified ID."
- "Diagnose why the integrated terminal or extension host is failing."

Do not confuse Microsoft VS Code with Insiders, VSCodium, Snap, Flatpak, or
distro-specific builds.

## Prerequisites and setup verification

Before changing VS Code, the agent should inspect:

- The `code` executable and version.
- The installed `code` package and architecture.
- The configured Microsoft package source when updates are involved.
- Relevant user, workspace, and profile settings.
- Installed extensions and running Code processes.
- Unsaved editors, terminals, tasks, and confirmation dialogs.
- For in-editor web testing, whether built-in browser tools are exposed and the
  `workbench.browser.enableChatTools` setting permits them.

Representative inspection commands are:

```bash
command -v code
code --version
code --list-extensions --show-versions
```

The user should identify the desired packaging variant, project path,
profile, and whether settings, extensions, projects, or personal data may be
changed.

## How to request it

Ask in ordinary language.

Example requests:

- "Open this existing repository in a new VS Code window."
- "Check whether this extension is installed."
- "Use a temporary profile to determine whether an extension causes this
  failure."
- "Start this app and verify its form flow in VS Code without opening an
  external browser."
- "Remove the VS Code package but preserve my settings and projects."

The user does not need to know CLI flags, profile paths, or packaging
details.

## Worked workflow and expected result

### Open an existing project

A representative command is:

```bash
code --new-window /home/james/repos/example-project
```

Use an isolated new window when avoiding interference with an existing
window matters. Do not pass an unverified path because VS Code can create
missing files or folders.

### Manage extensions

List installed extensions before changing them:

```bash
code --list-extensions --show-versions
```

Install or remove only an exact publisher-qualified extension ID or a
user-named VSIX file. Extensions are third-party code; identity and requested
permissions require confirmation.

### Test a web app in the integrated browser

When the agent is running in VS Code and the tools under **Built-in > Browser**
are available, it should prefer them over an external browser for interactive
local web-app testing. These tools are built into VS Code and do not require an
external MCP server.

A representative workflow is:

1. Start or locate the project's development server.
2. Open the exact app URL in the integrated browser.
3. Exercise the requested user flow and edge cases.
4. Inspect page content, accessible elements, console errors, and screenshots
   as relevant.
5. Fix any defect and repeat the same checks.

The browser can also be opened manually with **Browser: Open Integrated
Browser**. Pages opened by an agent use isolated ephemeral browser state. To
use an existing tab and its cookies or login state, the user must explicitly
select **Share with Agent**; the agent must preserve that state and continue to
follow all credential and confirmation boundaries.

Use an `editor-browser` launch or attach configuration when debugger features
such as breakpoints and stepping are needed. Do not create or modify
`.vscode/launch.json` solely for a normal preview. Fall back to the repository's
browser skills when integrated tools are unavailable, headless or standalone
operation was requested, or a specific browser engine or cross-browser result
is required. Keep repeatable regression tests in the project.

### Diagnose a failure

A representative isolation workflow is:

1. Reproduce the symptom narrowly.
2. Inspect `code --status` and relevant processes or logs.
3. Test with `--disable-extensions` when extension isolation is relevant.
4. Test with temporary `--user-data-dir` and `--extensions-dir` locations.
5. Apply one reversible fix.
6. Repeat the original reproduction and add one regression check.

Expected result: the requested editing, extension, workspace, profile, or
diagnostic outcome is verified in the actual application.

## Verification and known limitations

The agent must verify real editor behavior, not merely package installation
or command success. For web apps, it should use the integrated browser first
when running in VS Code with built-in browser tools available. Other GUI
testing should use `desktop-control` and `desktop-vision` with
observe-act-verify.

Known limitations:

- Settings paths depend on the active profile.
- Settings use JSONC; comments and formatting matter to users.
- A missing profile name creates a new profile.
- GUI accessibility data may be incomplete for Electron controls.
- Integrated-terminal use can require Workspace Trust.
- Built-in browser tools can be disabled by a user setting or organization
  policy and might not be exposed to every agent host.
- Agent-opened browser pages use isolated ephemeral state; a user-opened tab
  requires **Share with Agent** before the agent can access its existing state.
- Integrated browser validation does not establish cross-browser compatibility.
- Sign-in, Settings Sync, tunnels, publishing, and log uploads require
  explicit direction and confirmation.

## Troubleshooting

- Command missing: inspect packaging variant and installation state.
- Wrong edition or duplicate: do not silently introduce another packaging
  format.
- Extension problem: isolate extensions, then test a temporary clean profile
  before changing the real profile.
- Terminal failure: inspect shell configuration, environment, Workspace
  Trust, permissions, and extension-host logs separately.
- Browser tools missing: check whether the agent is hosted in VS Code, whether
  **Built-in > Browser** tools are exposed, and whether
  `workbench.browser.enableChatTools` is disabled by settings or policy. Use the
  appropriate repository browser skill rather than silently changing policy.
- Performance problem: inspect processes, extensions, workspace size, GPU,
  file-watcher behavior, and startup diagnostics.
- Close risk: inspect dirty editors and running tasks before closing.

## Safety, confirmation, and elevation

The agent must:

- Launch Code as the normal user, never as root.
- Ask before installing unrequested extensions, enabling network services,
  changing trust/security settings, deleting data, publishing, signing in, or
  replacing configuration.
- Preserve user settings, extensions, workspaces, and projects during package
  removal unless the user approves an exact deletion manifest.
- Never type passwords, MFA codes, tokens, payment details, or CAPTCHA
  solutions.
- Use `pkexec` for a bounded GNOME command when administrator authentication
  is required. The user enters the credential in the trusted PolicyKit dialog;
  the agent must not request, read, pass, type, capture, or otherwise observe
  it.
- Make no screenshots, accessibility queries, or keyboard input while the
  authentication dialog is open.

## Related skills and documents

- [`desktop-control`](../desktop-control/README.md) operates the VS Code GUI.
- [`desktop-vision`](../desktop-vision/README.md) verifies GUI appearance.
- [`browser-assistant`](../browser-assistant/README.md) is the visible-browser
  fallback when the integrated browser is unavailable or unsuitable.
- [`browser-headless`](../browser-headless/README.md) handles explicitly
  requested background browser work.
- [`system-troubleshooting`](../system-troubleshooting/README.md) diagnoses
  broader system or launch failures.
- The canonical catalog entry is in `skills/README.md`.
