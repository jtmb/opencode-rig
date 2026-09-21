# `deploy-plugins-self-test.py`

The deployment self-test runs `deploy-plugins.sh` against disposable
temporary config directories. It does not modify the configured Open Rig
environment.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-plugins-self-test.py
```

The test covers `all`, `server`, `cli`, `both`, every individual package,
`rig-todo`'s dual server/CLI role, duplicate and malformed entries,
non-canonical paths, wrong-role placement, string-safe comments and trailing
commas, malformed and duplicate-key JSONC, unknown packages, catalog validation,
permission gating, mode preservation, no-temp-leak behavior, verify-only byte
preservation, and byte-for-byte idempotence. Temporary directories are removed
when the process exits.
