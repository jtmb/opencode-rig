# Application Setup Usage

This guide explains how to use the `app-setup` skill. The agent-facing
operating rules remain in [SKILL.md](./SKILL.md); OpenCode does not
automatically load this usage guide when the skill is loaded.

Category: `applications`

Tags: `applications`, `installation`, `updates`, `removal`

## Purpose and when to use it

Use `app-setup` when an application must be installed, configured, updated,
verified, or safely removed.

Appropriate requests include:

- "Install VLC and verify that it plays this file."
- "Set up this printer and print a test page."
- "Update this application without changing my settings."
- "Remove this application without touching my personal data."

This is a workflow skill. It does not provide one universal installer command
for every application.

## Prerequisites and setup verification

Before changing the system, the agent should inspect:

- OS, architecture, desktop session, and available disk space.
- Installed package or application version.
- Running application processes.
- Existing configuration and settings.
- Relevant services.
- Package source and available update candidate.

The user should identify the desired application and intended outcome. For an
upgrade or removal, they should also say whether settings, projects,
extensions, or personal data may be touched.

## How to request it

Ask in ordinary language and describe the working outcome.

Example requests:

- "Make this scanner work and verify a test scan."
- "Install this CLI and verify its version."
- "Remove the duplicate installation, but do not remove shared dependencies."

The agent translates the request into inspection, installation, configuration,
acceptance testing, and rollback planning.

## Worked workflow and expected result

A representative agent workflow is:

1. Inspect the current application and package state read-only.
2. Select the least-privileged supported installation source:
   Ubuntu repositories or the vendor's official signed package.
3. Verify release, architecture, checksum, and package metadata for an
   external artifact.
4. Preview consequential repository, permission, removal, or downgrade
   changes.
5. Preserve existing settings before an upgrade.
6. Install with the least privilege needed.
7. Configure the application without handling secrets or MFA.
8. Run the user's actual scenario as an acceptance test.
9. Report the rollback path.

A representative APT inspection pattern is:

```bash
sudo apt-get --simulate install EXAMPLE_PACKAGE
```

Package removal and downgrade simulations require the same review; a removal
simulation can reveal shared dependencies or unrelated packages that must not
be removed.

Expected result: the application performs the requested real-world task, the
agent reports `PASS`, `FAIL`, or `NOT TESTED` for each requirement, and a
specific rollback path is available.

## Verification and known limitations

Installer success alone is insufficient. The agent should verify the actual
application behavior and, where relevant, persistence across restart or login.

Known limitations:

- A package version can differ from an application's runtime version.
- Some vendors require a repository, signing key, license, account, or manual
  GUI step.
- Configuration interfaces vary by application.
- Removing one package can affect shared dependencies.
- Personal data and settings may remain after package removal unless a
  separately approved deletion is performed.

## Troubleshooting

- Missing dependency: inspect the package error and install only the proven
  missing requirement.
- Conflicting installation format: do not silently add Snap, Flatpak, APT, or
  a manual package alongside an existing installation.
- Application installed but unusable: check desktop launchers, executable
  permissions, missing services, configuration, and application logs.
- Removal would affect shared components: stop and ask before proceeding.
- Uncertainty about settings ownership: preserve everything and ask for an
  exact deletion manifest if cleanup is wanted.

## Safety, confirmation, and elevation

The agent must:

- Show consequential repository or permission changes and obtain approval.
- Obtain approval before package removal, downgrades, shared-dependency
  removal, personal-data deletion, security changes, or legal acceptance.
- Install with the least privilege needed.
- Never run a graphical application as root.
- Never add an untrusted repository, pipe a remote script into a shell,
  disable sandboxing, or weaken system security to hide an error.
- Use `pkexec` for a bounded GNOME command when administrator authentication
  is required. The user enters the credential in the trusted PolicyKit dialog;
  the agent must not request, read, pass, or type it.
- Avoid screenshots, accessibility inspection, and keyboard input while the
  authentication dialog is open.

## Related skills and documents

- [`desktop-control`](../desktop-control/README.md) configures installed GUI
  applications.
- [`system-troubleshooting`](../system-troubleshooting/README.md) diagnoses
  installation or launch failures.
- [`routine-automation`](../routine-automation/README.md) converts a proven
  manual setup into a reusable procedure.
- The canonical catalog entry is in `skills/README.md`.
