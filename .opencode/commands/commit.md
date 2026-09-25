---
description: Operator-only immediate commit that bypasses the agent commit gate
---

The operator invoked this override. The shell block below already ran in
OpenCode's command-evaluation shell, outside the agent tool permission flow:

!`cd "$(git rev-parse --show-toplevel)" && git add -A && git commit -m "Open Rig operator override commit $(date -u +%Y-%m-%dT%H:%M:%SZ)" --no-verify`

Do not perform another commit. Verify and report the resulting commit SHA and
whether the command succeeded.
