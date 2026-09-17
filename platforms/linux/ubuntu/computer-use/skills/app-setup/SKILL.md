---
name: app-setup
description: Install, configure, update, verify, and safely remove desktop or CLI applications on Ubuntu. Use when the user asks to install, set up, update, configure, uninstall, or make an application work. Treat acceptance tests, preserved settings, and rollback as part of completion.
metadata:
  schema-version: "1"
  category: "applications"
  tags: "applications,installation,updates,removal"
---

# Application Setup

Deliver the requested workflow, not merely a successful installer exit.

## Procedure

1. Inspect OS, architecture, session, installed versions, running processes,
existing configuration, disk space, and relevant services read-only.
2. Prefer Ubuntu repositories or the vendor's official signed package.
For external artifacts, verify the exact release, architecture, checksum,
and package metadata before execution.
3. Show consequential permission or repository changes and obtain approval.
Review APT's simulation for removals and downgrades.
4. Preserve existing settings before upgrade. Do not downgrade a newer
working installation or introduce a second packaging format silently.
5. Install with the least privilege needed. Never run a graphical app as root.
When authentication is required in GNOME, invoke only the bounded privileged
command through `pkexec` and let the user complete the trusted PolicyKit
dialog. Make no screenshots, accessibility queries, or keyboard input while it
is open; verify package state after it closes.
6. Configure with `desktop-control`; let the user handle secrets and MFA.
7. Test the user's actual scenario in the actual target applications,
including restart/login persistence when required.
8. Report PASS, FAIL, or NOT TESTED for each requirement and record a
specific rollback path.

## Rules

- Do not add random PPAs, pipe remote scripts into a shell, disable sandboxing,
or weaken AppArmor/Secure Boot/Wayland security to hide an error.
- Keep package caches and transient downloads out of the final artifact path.
- Do not remove shared dependencies or personal data without evidence they
belong only to this setup and explicit approval.
- Make one repair at a time and rerun the failing acceptance test.
- Never request a password in chat, pipe it to a command, or type it for the
  user. PolicyKit provides the user-controlled elevation path.

## Usage guide

When the user asks how to use this skill, also read
[README.md](./README.md) for request examples, prerequisites, verification,
and safety requirements.
