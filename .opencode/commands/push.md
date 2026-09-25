---
description: Operator-only immediate push that bypasses the agent push gate
---

The operator invoked this override. The shell block below already ran in
OpenCode's command-evaluation shell, outside the agent tool permission flow:

!`cd "$(git rev-parse --show-toplevel)" && git push --no-verify`

Do not perform a push. Verify and report the resulting push state.
