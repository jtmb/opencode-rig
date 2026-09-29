# `check-plugin-resource-guards-self-test.py`

This self-test exercises the resource-safe plugin-check policy without using a
large allocation. It runs the static package-script validator, asks
`run-bounded-command.sh` for its current adaptive budget, and runs a child that
must be terminated by a one-second bounded timeout. The parent remains alive
and reports success. If available memory is too low for a safe budget, the
wrapper's fail-closed refusal is also treated as a successful safety result.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-plugin-resource-guards-self-test.py
```

The test is run by the local pre-push hook and the `verify` GitHub Actions job.
The full validator behavior and memory policy are documented in
[`check-plugin-resource-guards.md`](check-plugin-resource-guards.md).
