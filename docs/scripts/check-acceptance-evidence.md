# Acceptance-evidence gate

`check-acceptance-evidence.py` is a small, project-local, read-only validator.
It uses only Python's standard library and never executes commands from the
manifest. Copy the validator and a JSON manifest into another repository; no
Open Rig package, absolute repository path, symlink, or hardlink is required.

Run it from the project root:

```bash
python3 path/to/check-acceptance-evidence.py --root .
```

The default manifest is `acceptance-evidence.json`. Its portable shape is:

```json
{
  "version": 1,
  "claims": [
    {
      "id": "settings-screen",
      "status": "complete",
      "user_visible": true,
      "runtime": true,
      "evidence": {
        "rendered_visual": ["evidence/settings.png"],
        "interaction": ["evidence/settings-click.txt"]
      }
    }
  ],
  "subagent_policy": {
    "allowed_agents": ["general"],
    "allowed_models": ["vendor/model"],
    "max_concurrency": 2
  },
  "subagent_evidence": [
    {
      "id": "qa-review",
      "agent": "general",
      "model": "vendor/model",
      "background": true,
      "evidence": ["evidence/qa-review.txt"]
    }
  ]
}
```

Every `complete` or `limited` user-visible claim must list at least one
`rendered_visual` path and one `interaction` path. `runtime: false` describes
the claim; it does not bypass the evidence requirement. Completed and limited
claims must list at least one evidence path, and the manifest must contain at
least one evidenced complete or limited claim.

Every evidence path must be a relative forward-slash path to an existing
regular file below the project root. Absolute paths, `..`, symlink components,
directories, and missing files fail closed. Subagent evidence is required,
must be a non-empty bounded batch, must set `background` to `true`, and every
record's agent and model must appear in the configured allowlists. Each
record's extra foreground/nesting fields are rejected, and the number of
records may not exceed `max_concurrency`. The manifest is limited to 1 MiB,
256 claims or evidence paths per kind, 64 allowlisted agents/models, and a
maximum concurrency of 64.

The canonical repository QA command runs this gate before its other in-process
format checks. Its focused self-test uses temporary ordinary files and covers
both passing and failing manifests.

This repository's checked-in manifest records the fresh 2026-09-19 Open Rig
pilot evidence in [`../acceptance-evidence-2026-09-19.md`](../acceptance-evidence-2026-09-19.md)
and the limited WSL2 backend and historical pre-convergence MCP evidence in
[`../wsl2-acceptance-2026-09-21.md`](../wsl2-acceptance-2026-09-21.md).
Limited claims state their runtime boundary explicitly; planned claims do not
present source or package checks as live acceptance.
