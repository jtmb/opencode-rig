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
Linux `MemAvailable` and the minimum remaining finite `memory.max -
memory.current` across the active cgroup and its bounded ancestors, when cgroup
limits are available. The default command budget is 40% of that effective
value. An exhausted or malformed finite ancestor fails closed.
The default swap portion is 25% of the command budget, further limited by
currently free swap and the remaining finite cgroup `memory.swap.max` budget.
If a finite cgroup memory limit is already exhausted, availability is zero and
the command is refused rather than falling back to host memory. For Node
commands, `NODE_OPTIONS` is set to 65% of the command budget as the V8 heap
ceiling.

These are percentages, not machine-specific byte limits. They therefore scale
with a laptop, workstation, CI runner, or a stricter parent cgroup. A command is
refused when the calculated budget is too small to provide a useful runtime.

## Isolation and failure behavior

- `systemd-run --user --scope` starts the command synchronously in a transient
  user scope with `MemoryMax` and `MemorySwapMax` properties. Scope mode is
  used because it naturally inherits the caller's complete environment and
  standard descriptors; the runner adds only its bounded `NODE_OPTIONS`
  override and never serializes environment values into systemd arguments.
- When a user systemd manager is not available, such as in some minimal CI
  environments, the fallback launches a fresh process group under `prlimit`
  with a generous virtual-address ceiling and monitors the aggregate RSS of
  the process tree. The RSS budget, rather than the address ceiling, is the
  actual memory limit, so V8 can reserve its normal code range.
- The fallback terminates the whole process group on RSS exceed or timeout,
  including discovered descendants, and reports its status. Descendants are
  traversed from each process's `/proc/<pid>/task/<pid>/children` list with
  bounded process, depth, and entry counts; malformed live entries fail closed.
  A process that disappears between validated status and child-list reads is a
  normal exit race, not malformed state; the monitor permits only that verified
  disappearance.
  `/proc/<pid>/stat` start times are retained and revalidated before signals to
  avoid killing a reused PID. If `prlimit`,
  `setsid`, `sleep`, or safe process inspection is unavailable, the script
  fails closed and never runs the command unbounded.
- A runtime-directory `flock` allows only one bounded command at a time. Other
  invocations wait in the lock queue for 30 seconds by default, then fail with
  a diagnostic; use `--lock-timeout SECONDS` to change that bound. Keeping one
  slot is intentional: it makes the adaptive per-command budget an aggregate
  limit rather than multiplying it across background agents.
- The runtime directory must be owned by the current user, private, and free
  of group/world writes. Existing user-owned parent directories may be
  group/world-readable (for example `0750` or `0755`); missing cache/runtime
  components are created `0700`. If `XDG_RUNTIME_DIR` is unset, a private
  `$HOME/.cache/opencode-rig/runtime` directory is created and validated; the
  lock itself must be a private regular file, never a symlink.
- Commands stop when they exceed the default fifteen-minute runtime. The
  systemd path uses `timeout` with a ten-second grace period; the RSS fallback
  supervises the process group directly and returns status 124 on timeout.
- The command's stdout and stderr remain attached to the caller through the
  inherited scope descriptors.

The wrapper does not cap OpenCode itself. It isolates the expensive child so a
failed check returns a non-zero status without killing the active session.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `--memory-fraction` | `40` | Percentage of effective available memory for the child. |
| `--swap-fraction` | `25` | Percentage of the child budget allowed as swap. |
| `--node-heap-fraction` | `65` | Percentage of the child budget assigned to Node's V8 heap. |
| `--timeout` | `15m` | Maximum command runtime. |
| `--lock-timeout` | `30` | Maximum seconds to wait for another bounded command. |
| `--print-budget` | off | Print the calculated budget without running a command. |

All percentages must be greater than zero and no greater than ninety. The
plugin package checks use the defaults; a caller can lower them for a known
memory-constrained test.

The focused coordination self-test is safe to run directly. It also installs
and verifies the pinned file-manager parser assets into a temporary target
through the forced RSS fallback, without network access:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-run-bounded-command-self-test.py
```

## Enforcement

Every local plugin package's `typecheck` and `test` scripts reference this
wrapper. `check-plugin-resource-guards.py` validates that property, and both the
pre-push hook and GitHub Actions run that validator. This prevents a future
plugin from silently reintroducing an unbounded check.
