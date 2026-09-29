# Open Rig Operations

Operational patterns for the Open Rig Ubuntu computer-use and OpenCode v2
harness: canonical source, complete bundle deployment, bounded checks, and
MCP/plugin parity.

## 🔴 HARD RULEs

- **OpenCode v2 is the only current runtime target** — do not add legacy
  configuration, migration, or rollback instructions to current guidance.
- **Canonical sources stay in the repository** — skills, v2 plugins, examples,
  commands, and scripts live below `platforms/linux/ubuntu/computer-use/`.
- **Verification is read-only by default** — setup and deployment writes need
  an explicit `--apply` and an explicitly selected target.
- **Deploy complete bundles** — preserve unrelated target files and verify every
  source file, not only the entry point.

## Harness UI and tool consistency

- Interactive desktop/browser surfaces expose accessible names and states.
- UI claims require a rendered visual check and an interaction/click check.
- Loading, empty, error, and confirmation states are explicit and bounded.
- Browser automation stays isolated; desktop mutations use preview tokens.

## Runtime layering

```
OpenCode v2 → local MCP/plugin wrapper → bounded tool or script → selected target
```

Each layer validates its boundary and preserves the ownership of the next layer.
Configuration and deployment helpers must not mutate live user state while
performing verification, and must not skip the target's safety checks.

## Idempotent setup

- Skills and commands: recursively copy only missing or stale managed files;
  preserve unrelated target entries.
- Plugins and MCP declarations: update only owned entries and preserve unknown
  fields and unrelated entries.
- Config: seed only when missing unless the selected setup operation explicitly
  owns a field; write atomically and retain existing modes where applicable.
- Skills: deploy complete canonical bundles through `setup-opencode.sh`, reject
  symlinks and non-regular files, and preserve unrelated target entries.

## References

- See `references/mcp-tool-parity.md` for keeping v2 tool declarations and
  local wrappers aligned.
- See `references/layered-crud.md` for the Open Rig v2 ownership boundaries.
- See `references/dashboard-ui.md` for accessible interactive-surface patterns.
