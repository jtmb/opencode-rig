# OpenCode recovery CLI

`platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py` is a
bounded, agent-free recovery helper for an explicitly selected OpenCode V2
service and location. It does not start Basic Memory, create an MCP transport,
invoke `read_note`, or modify notes, SQLite state, or plugin storage.
The `rig-tools` server plugin also exposes read-only `opencode_recovery_status`
diagnostics and the preview/apply `basic_memory_recovery` tool for its current
plugin location.

## Readiness versus recovery

The CLI requires both `--server` and `--directory`. Before any marker
verification or apply, it calls the documented V2 `server.info` operation
(`GET /api/info`) through that exact `--server` and binds a stable nonempty
`version` and positive `pid` for the selected service process. V2 marks both
`/api/info` and `/api/location` as `security: []`; this service
identity/location binding is not authentication proof. In addition to the
start/end checks, the CLI rechecks the bound identity immediately before
canonical marker apply and before/after targeted MCP reconnect, and checks again
after apply. It fails closed on missing or changed identity. The response's
`urls` and `paths.tmp` fields are discarded and never printed. Directory
matching alone is not service identity: a shared and standalone service can
expose the same location directory. The exact launcher probes `service status`
and `api get /api/info` are the read-only route for discovering that identity;
the orchestration policy does not treat a targeted `basic-memory` recovery
invocation as a read-only probe.

The CLI then validates the selected service's `location.get` result against the
requested directory before marker verification or any apply. It runs a
read-only `plugin.list` against the same explicit service and reports its live
result; package installation is not activation proof. If `plugin.list` is
unavailable, the report says so with bounded sanitized evidence, but that
separate plugin observation does not block the exact-server/location Basic
Memory recovery path. It verifies the
canonical native runtime marker, optionally performs an explicitly approved
stale-state-guarded canonical repair, checks the exact configured
`basic-memory` entry, and uses the targeted CLI
`experimental.mcp.connect` call at most once. It
polls a monotonic bounded startup window and uses the canonical status:

```text
connected-awaiting_read_note
```

The separate TypeScript `basic_memory_recovery` tool uses only the current
location's `ctx.mcp.list` and `ctx.mcp.reload`; `ctx.mcp.reload` reloads the
whole MCP collection for that location and is not a targeted Basic Memory
connect/reload. It skips that collection-wide reload when Basic Memory is
already connected. The CLI's `experimental.mcp.connect` path is targeted.
`opencode_recovery_status` returns bounded MCP/plugin diagnostics and
control-plane handoffs without mutating runtime state. The in-process tools are
bound to the plugin's current location; they do not accept a remote server URL.
The `identifier` and `project` inputs are bounded labels, not a note lookup
request.

Exit code `0` means only that this readiness state was reached. The JSON report
still contains `recovered: false` and `read_note_proof: "not-verified"`.
For `diagnose`, exit `0` requires both the live `mcp` and `plugin.list` summaries
to be available; recovery readiness uses the separate status above.
Successful script exit is **not** full recovery, Basic Memory authentication
proof, or proof
that the requested note is readable. After readiness, the caller may perform a
separate actual live MCP `read_note` call belonging to the exact selected
`--server` instance and location **only if** that location exposes a usable
connected `read_note` tool. If no
such tool is available, or the call cannot succeed, leave the result pending
and do not claim full recovery. Only that successful direct live call establishes
Basic Memory authentication and note readability. Never borrow proof from
another location or infer success from service identity, `security: []`, MCP
status, plugin status, or directory matching alone. A target mismatch, marker/probe failure,
output overflow, reconnect/readiness failure, or bounded startup timeout
returns a nonzero exit code.

## Usage

The CLI selects the OpenCode executable from `--opencode-bin` when supplied,
otherwise `OPENCODE_V2_BIN`, and only then the ambient `opencode` on `PATH`.
The flag takes precedence when both are supplied. Use a portable explicit
selection rather than assuming the ambient binary is the intended installation:

```bash
OPENCODE_V2_BIN=/absolute/path/to/opencode python3 \
  platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py diagnose \
  --server http://127.0.0.1:PORT \
  --directory /absolute/selected/location
```

The equivalent flag form is:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py diagnose \
  --opencode-bin /absolute/path/to/opencode \
  --server http://127.0.0.1:PORT \
  --directory /absolute/selected/location
```

The selected executable is also the one used by the location/API smoke tests;
those tests do not silently fall back to another binary.

Read-only diagnosis:

```bash
OPENCODE_V2_BIN=/absolute/path/to/opencode python3 platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py diagnose \
  --server http://127.0.0.1:PORT \
  --directory /absolute/clone
```

Basic Memory readiness check:

```bash
OPENCODE_V2_BIN=/absolute/path/to/opencode python3 platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py basic-memory \
  --server http://127.0.0.1:PORT \
  --directory /absolute/clone
```

The CLI has no note/project selector because it never reads note content; its
readiness report cannot establish authentication or note readability. The API
client passes the requested location as the V2 OpenAPI deep-object parameter
`location[directory]` and sends every operation to the exact selected service.
The dotted key `location.directory` is not the deepObject parameter and can
leave the server on its default location. It refuses to trust any MCP result
unless `location.get` returns the same normalized directory. If the running
service resolves another location,
the command fails closed and does not apply a marker or reconnect. For any
full-recovery or authentication claim, the caller must make a separate
successful direct live `read_note` call through that same explicit server
instance and selected location. If no connected tool/call is available or it
fails, proof remains pending. This script never substitutes a primary-location
result.

## Marker repair

The default `basic-memory` command is preview-only when native marker
verification fails. The report returns bounded policy/state digests. A later
call may provide both unchanged digests with `--apply --approval`; digests are
only stale-state guards and never authorization. The canonical helper is
invoked with the fixed native profile argv against the shared native user
profile; it never applies clone-only marker state. The selected directory binds
the API operations only. A fresh post-apply verify is required before
readiness checks.

An explicit approved apply uses the unchanged preview digests; replace the
placeholder values with the digests from the prior preview:

```bash
OPENCODE_V2_BIN=/absolute/path/to/opencode python3 platforms/linux/ubuntu/computer-use/scripts/opencode-recovery.py basic-memory \
  --server http://127.0.0.1:PORT \
  --directory /absolute/selected/location \
  --expected-policy-digest POLICY_DIGEST_FROM_PREVIEW \
  --expected-state-digest STATE_DIGEST_FROM_PREVIEW \
  --apply --approval
```

After this command, a separate successful direct live `read_note` call through
the exact selected server and location is still required for any authentication
or content claim. Exit code `0` means readiness only; the JSON report remains
`"recovered": false`.

## Live evidence boundary

This guide documents the source contract and fixture-backed checks; it does not
claim a live recovery run. Record readiness and any successful direct
`read_note` call for the exact selected location separately. Never borrow
another location's marker, MCP status, or note-read result.

Do not use this CLI to approve ownership, QA, commit, push, credentials, or
security changes. TUI-only steps belong to the managed `screen_terminal`
preview/apply workflow. For unscriptable TUI steps, use the reusable managed
[GNU Screen fallback guidance](../plugins/screen-terminal.md); clone-specific
session details belong only in the clone handoff, not in that generic guide.

## Safety and verification

OpenCode API and canonical-helper subprocesses use concurrent fixed-cap
stdout/stderr readers with a total output bound. The TypeScript native-runtime
runner sends `SIGTERM` at the operation deadline, escalates to `SIGKILL` after
its bounded grace, and resolves only after the child's `close` event confirms
reap. Overflow follows the same path. If cleanup cannot be confirmed by the
cleanup deadline, it returns a fail-closed cleanup error; the manager propagates
execution and cleanup errors and does not offer a stale-marker preview or
continue to apply/reconnect. The built-in bounded runner's promise is awaited
directly; only injected/unbounded runtimes use the manager's outer timeout.
Overflow output cannot be parsed or treated as readiness. Fingerprints include
only the approved policy file, native marker, and exact Basic Memory
`config.json`; they reject unsafe/symlinked/oversized inputs and exclude
databases, logs, and WAL files.
Python and TypeScript bound the fingerprint phase to at most five seconds and
refuse stale-state apply if that budget expires.

Use fixture-backed tests only; they do not apply markers, reconnect, provision,
restart, commit, push, or call `read_note`.
