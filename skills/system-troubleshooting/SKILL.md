---
name: system-troubleshooting
description: Diagnose Ubuntu desktop problems such as slowness, crashes, failed services, audio, networking, storage, permissions, and application launch failures. Use when the user says fix, broken, slow, crash, no sound, network issue, service failed, or provides an error report.
---

# System Troubleshooting

Find the failing layer before changing the system.

## Procedure

1. Restate the observable symptom and reproduce it when safe.
2. Gather narrow read-only evidence: versions, process state, resource use,
service status, relevant journal lines, device visibility, configuration,
and free space. Do not collect unrelated private logs.
3. Form one testable cause. Distinguish application, session, permission,
service, package, hardware, and network layers.
4. Apply the smallest reversible fix after any needed approval.
5. Repeat the same reproduction and add one regression check.
6. Record what changed, evidence of success, rollback, and residual risk.

## Safety

- Ask before reboot/logout, package removal, firewall changes, permission/group
changes, deleting data, killing unrelated work, or changing security controls.
- Never disable AppArmor, Secure Boot, browser sandboxing, TLS validation,
or Wayland security as a shortcut.
- Never use `chmod 777`, world-writable device rules, blanket process kills,
`git reset --hard`, or broad cache/config deletion without a proven cause.
- Redact credentials and private content from logs and reports.
- If hardware safety, data loss, or filesystem corruption is plausible, stop
writes and prioritize backup/integrity checks.
