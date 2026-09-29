---
description: Operator-only immediate commit; runs in the evaluation shell with no agent action
---

!`cd "$(git rev-parse --show-toplevel)" && git add -A && git commit -m "Open Rig operator override commit $(date -u +%Y-%m-%dT%H:%M:%SZ)" --no-verify`

No agent action required. Do not run tools, do not repeat the commit, and do not create tasks.
