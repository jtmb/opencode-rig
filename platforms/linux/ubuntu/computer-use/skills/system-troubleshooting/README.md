# System Troubleshooting Usage

This guide explains how to use the `system-troubleshooting` skill. The
agent-facing operating rules remain in [SKILL.md](./SKILL.md); OpenCode does
not automatically load this usage guide when the skill is loaded.

Category: `troubleshooting`

Tags: `troubleshooting`, `diagnostics`, `services`, `performance`

## Purpose and when to use it

Use `system-troubleshooting` for Ubuntu desktop and application failures,
including:

- Slowness or high resource use.
- Crashes or launch failures.
- Failed user/system services.
- Audio, networking, storage, display, permission, or device problems.
- Package, configuration, or update-related regressions.

The goal is to identify the failing layer before changing the system.

## Prerequisites and setup verification

The agent should preserve the current failure state and avoid unrelated
changes while gathering evidence. Useful narrow evidence includes:

- Exact symptom and reproduction steps.
- OS, desktop, package, driver, firmware, or application versions.
- Process, CPU, memory, disk, and device state.
- Relevant service status and recent journal entries.
- Configuration changes and available free space.

The user should provide the observable symptom, an error message when
available, recent changes, and whether data loss, hardware damage, or
filesystem corruption is possible.

## How to request it

Ask in ordinary language.

Example requests:

- "Audio stopped working after the update."
- "This app crashes on launch with this error."
- "The system is suddenly slow. Find the cause."
- "This service fails to start. Diagnose it without deleting my data."

The user does not need to identify the faulty subsystem. The agent forms one
testable cause at a time.

## Worked workflow and expected result

A representative agent workflow is:

1. Restate the symptom and reproduce it safely.
2. Collect narrow read-only evidence.
3. Separate application, session, permission, service, package, hardware, and
   network layers.
4. Form one testable cause.
5. Apply the smallest reversible fix after any needed approval.
6. Repeat the original reproduction.
7. Add one regression check.
8. Report the change, evidence, rollback, and residual risk.

Expected result: the original reproduction passes, the cause and fix are
identified, rollback is known, and unrelated system behavior is unchanged.

## Verification and known limitations

Verification must use the same reproduction that demonstrated the problem.
Log absence or a successful command alone is not enough when the user-facing
symptom can still occur.

Known limitations:

- Intermittent faults may require repeated observation.
- Multiple faults can resemble one another.
- Logs may identify a symptom rather than the root cause.
- Some hardware faults cannot be repaired safely in software.
- Privacy-sensitive logs should not be collected merely because they exist.

## Troubleshooting the troubleshooting work

- No clear cause: narrow the evidence or reproduce under more controlled
  conditions.
- Multiple possible causes: test them separately, one repair at a time.
- Fix does not persist: inspect startup, service enablement, configuration
  precedence, permissions, and conflicting scheduled jobs.
- Suspected hardware, data-loss, or filesystem risk: stop writes and
  prioritize backup and integrity checks.
- Application-specific GUI failure: combine this skill with
  `desktop-control` and `desktop-vision`.

## Safety, confirmation, and elevation

The agent must:

- Ask before rebooting, logging out, removing packages, changing firewall or
  permission settings, deleting data, killing unrelated work, or changing
  security controls.
- Never disable AppArmor, Secure Boot, browser sandboxing, TLS validation, or
  Wayland security as a shortcut.
- Never use world-writable permissions, blanket process kills, destructive
  Git resets, or broad cache/config deletion without a proven cause.
- Redact credentials and private content.
- Use `pkexec` for a bounded GNOME command when administrator authentication
  is required. The user enters the credential in the trusted PolicyKit dialog;
  the agent must not request, read, pass, type, capture, or otherwise observe
  it.

## Related skills and documents

- [`app-setup`](../app-setup/README.md) performs verified installation and
  removal work.
- [`desktop-control`](../desktop-control/README.md) inspects and operates
  accessible GUI applications.
- [`files-and-documents`](../files-and-documents/README.md) preserves and
  organizes diagnostic artifacts.
- The canonical catalog entry is in `skills/README.md`.
