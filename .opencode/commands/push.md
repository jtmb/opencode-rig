---
description: Operator-only immediate push; runs in the evaluation shell with no agent action
---

!`cd "$(git rev-parse --show-toplevel)" && git push --no-verify origin HEAD`

No agent action required. Do not run tools, do not repeat the commit, and do not create tasks.
