# `check-plugin-resource-guards.py`

Checks every local plugin package under
`platforms/linux/ubuntu/computer-use/plugins/` plus the desktop custom-tools
package at `platforms/linux/ubuntu/computer-use/tools/package.json`, requiring
each package's `typecheck` and `test` npm scripts to reference
`run-bounded-command.sh`. A missing `tools/package.json` is reported as a
failure, so the custom-tools package cannot silently disappear.

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-plugin-resource-guards.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-plugin-resource-guards-self-test.py
```

The validator reads only package metadata, uses no third-party dependencies,
and exits non-zero with the package and script that lacks the guard. It is a
static enforcement layer: the wrapper itself supplies the runtime cgroup,
adaptive memory, timeout, serialization, and fail-closed behavior.

The self-test runs the metadata validator, asks the wrapper for its current
adaptive budget, and starts a one-second bounded timeout around a child that
sleeps for five seconds. It verifies that the child terminates non-zero while
the Python parent remains alive. If current memory is too low, the expected
fail-closed refusal is accepted as a successful safety result.
