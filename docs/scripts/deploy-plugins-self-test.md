# `deploy-plugins-self-test.py`

The deployment self-test runs `deploy-plugins.sh --v2` against disposable
temporary config directories. It does not modify the pilot or v1 config.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-plugins-self-test.py
```

The test covers `all`, `server`, `cli`, `both`, every individual package,
`rig-todo`'s dual server/CLI role, duplicate and malformed entries,
non-canonical paths, wrong-role placement, invalid JSONC, unknown packages,
catalog validation, and byte-for-byte idempotence. Temporary directories are
removed when the process exits.
