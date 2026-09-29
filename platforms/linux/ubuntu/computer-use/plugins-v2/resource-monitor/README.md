# Resource monitor

`resource-monitor` is an OpenCode v2 CLI-only plugin. It adds one compact,
theme-aware token to both the home and prompt footer status rows, for example
`CPU 7% · RAM 371 MiB`.

Click the token, focus it and press Enter/Space, choose **System resources**
from the command palette, or run `/system-resources` (`/resources`) to open a
responsive system overlay. It uses the host-owned session panel inside a
session and an xlarge centered dialog on the home screen, where the V2 panel
API intentionally cannot open. The overlay reports the sanitized CPU model, physical
and logical cores, aggregate host CPU use, total/used/available RAM, swap when
present, and bounded local-filesystem capacity. It refreshes once per second
only while open and closes with Escape.

## Measurement semantics

- Each TUI instance starts at its own `process.pid`; it never measures the
  shared OpenCode server as a global service.
- The process tree is walked from the TUI PID through Linux
  `/proc/<pid>/task/<pid>/children`; the sampler does not scan unrelated PIDs.
  The walk has explicit process, depth, child-count, and children-text bounds.
  A malformed live entry or exceeded bound fails the scan, so no truncated
  total is published; only a genuinely vanished process is skipped.
  A process whose argv contains both `serve` and
  `--service` is treated as the shared service, and that process plus all of
  its descendants is excluded.
- CPU is the sum of user and system clock-tick deltas for included processes,
  divided by elapsed wall time. It is a per-machine-process-tree percentage,
  so multicore use may exceed 100% (100% means one fully busy logical CPU).
- RSS is the sum of resident pages from `stat` (shared pages are counted once
  per process), converted using the Linux page size assumption used by this
  package (4096 bytes). The first sample reports
  unknown CPU (`?%`) because a delta is not available yet. If no process data
  is readable, RSS is shown as unavailable (`? MiB`) rather than zero.
- Sampling is bounded to one local process-tree walk approximately every two
  seconds. Processes vanishing during a walk are skipped gracefully, slow
  walks never overlap, and a transient read failure retains the last sample.

## Privacy and security

The plugin reads only local process and host metadata from `/proc` plus local
filesystem counters through Node's `statfs`; it does not invoke a shell,
persist data, or contact a server. It reads argv only for visited processes to
identify a nested shared service. No process names or arguments are displayed
or transmitted. Proc reads, displayed strings, mount counts, and concurrent
refreshes are bounded.

## Configuration

The optional CLI plugin option `intervalMs` changes the interval only for finite
integer values from 1000 through 60000 ms inclusive. Other values, including
fractional, infinite, and huge values, use the 2000 ms default. The example
configuration uses the default and does not need options.

## Verification

From this package directory, run `npm run check`. Its typecheck and tests are
both routed through `computer-use/scripts/run-bounded-command.sh`.
