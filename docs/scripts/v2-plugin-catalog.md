# `v2-plugin-catalog.py`

`v2-plugin-catalog.py` is the read-only validator and normalizer for
[`v2-plugin-roles.json`](../../platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json).
The deployment script and the v2 health check use its output instead of
maintaining separate package and role lists.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/v2-plugin-catalog.py \
  --catalog platforms/linux/ubuntu/computer-use/config/v2-plugin-roles.json \
  --root platforms/linux/ubuntu/computer-use --json
```

The catalog records each package's relative path, one or both v2 roles, the
role entrypoint (`server.ts` or `tui.tsx`), and the expected config file
(`opencode.jsonc` or `cli.json`). Validation rejects duplicate names or paths,
unsafe traversal, packages outside `plugins-v2`, missing directories or
entrypoints, unsupported roles, and role/config mismatches. Normalized package
and entrypoint paths are canonical absolute paths. `--rows` emits the bounded
tab-separated form consumed by `deploy-plugins.sh`.

The command is read-only and uses only Python's standard library.
