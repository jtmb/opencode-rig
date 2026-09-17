# `run-bounded-command.sh`

Runs a compiler, test suite, or other memory-intensive repository command in a
fresh resource budget. It exists because OpenCode is a long-lived process and a
child TypeScript process must not be able to exhaust the entire desktop login.

```bash
./platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh --print-budget
./platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh -- npm run check
```

## Adaptive budget

The script recalculates its budget on every invocation. It takes the lower of
Linux `MemAvailable` and the remaining memory in the active cgroup, when a cgroup
limit is available. The default command budget is 40% of that effective value.
The default swap portion is 25% of the command budget, further limited by
currently free swap and cgroup swap. For Node commands, `NODE_OPTIONS` is set to
65% of the command budget as the V8 heap ceiling.

These are percentages, not machine-specific byte limits. They therefore scale
with a laptop, workstation, CI runner, or a stricter parent cgroup. A command is
refused when the calculated budget is too small to provide a useful runtime.

## Isolation and failure behavior

- `systemd-run --user --pipe --wait --collect` starts the command in a transient
  user service with `MemoryMax` and `MemorySwapMax` properties.
- `prlimit --as` is the bounded fallback when a user systemd manager is not
  available, such as some minimal CI environments. It supplies the memory
  ceiling without a separate swap property.
- If neither limiter exists, the script fails closed and never runs the command
  unbounded.
- A runtime-directory `flock` allows only one bounded command at a time.
- `timeout` stops commands that exceed the default fifteen-minute runtime and
  gives them ten seconds to exit before sending `KILL`.
- The command's stdout and stderr remain attached to the caller through
  `systemd-run --pipe`.

The wrapper does not cap OpenCode itself. It isolates the expensive child so a
failed check returns a non-zero status without killing the active session.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--memory-fraction` | `40` | Percentage of effective available memory for the child. |
| `--swap-fraction` | `25` | Percentage of the child budget allowed as swap. |
| `--node-heap-fraction` | `65` | Percentage of the child budget assigned to Node's V8 heap. |
| `--timeout` | `15m` | Maximum command runtime. |
| `--print-budget` | off | Print the calculated budget without running a command. |

All percentages must be greater than zero and no greater than ninety. The
plugin package checks use the defaults; a caller can lower them for a known
memory-constrained test.

## Enforcement

Every local plugin package's `typecheck` and `test` scripts reference this
wrapper. `check-plugin-resource-guards.py` validates that property, and both the
pre-push hook and GitHub Actions run that validator. This prevents a future
plugin from silently reintroducing an unbounded check.
