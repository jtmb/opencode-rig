# `opencode-launcher.sh`

Runs the isolated OpenCode v2 installation with its dedicated config, data,
state, and cache directories. Normal arguments pass through unchanged to the
v2 binary.

The launcher always runs the isolated **pilot** profile. Every invocation
exports `OPENCODE_CONFIG_DIR` and the `XDG_*` roots under
`OPENCODE_V2_PILOT_DIR` (default `$HOME/.opencode-v2-pilot`). The separately
**selected shared service** is a regular profile that the launcher does not
select, inspect, or manage; its identity and plugin/provider state are
independent of the pilot's. `OPENCODE_V2_BIN` selects only the executable,
never the profile.

The launcher also restores the convenient web entry point that V2 does not
provide as a native subcommand:

```bash
opencode web
opencode web --no-open
```

`opencode web` starts the pilot profile's service idempotently, prints the
username and generated password from `opencode pair`, and opens the reported URL
in the default browser. `--no-open` prints the same access details without
opening a browser. The launcher never restarts an already healthy pilot service,
avoiding port races and disruption to other OpenCode clients.

## Read-only probe path (pilot-scoped)

Earlier revisions of this page described these fixed-argument commands as
inspecting "the selected service". That was incorrect; the original wording is
retained here as history. These argv still run under the launcher's pilot roots
and therefore never describe the selected shared service:

```bash
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh service status
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh api get /api/info
```

The launcher skips only the pilot-directory creation for these exact argv; it
still exports the pilot config and `XDG_*` roots before passing them through
without calling `service start` or `pair`. A pilot `stopped` status therefore
does not describe the selected service. On this WSL host the launcher's default
binary `$HOME/.local/opt/opencode-v2/opencode` is absent, so both commands fail
before reaching any service. A bare unauthenticated
`GET http://127.0.0.1:49374/api/info` returns HTTP 401 and is not a usable read
path.

The correct read path for current plugin, MCP, and provider state is the
in-process runtime status (`opencode_runtime_status`), not the launcher and not
an unauthenticated HTTP probe.

The orchestration policy also permits the configured installed binary directly
for the exact `api get /api/info` argv. The default protected paths include
`$HOME/.opencode/bin/opencode`; this does not change the launcher's separate
default binary at `$HOME/.local/opt/opencode-v2/opencode`. Additional arguments,
shell operators, quotes, and dynamic argv do not receive the read-only
classification.

OpenCode's `api` command may start a service when no compatible healthy service
is available. The disposable self-test uses a fake executable and fresh profile
roots; it does not contact a service or read credentials.

## Plugin reload and service restart (no established safe procedure)

Reopening or restarting the TUI does not reload server plugin code. Earlier
revisions of this page instructed a launcher `service restart` / `service
status` / `api get /api/info` sequence and then a `/restart` in the TUI. That is
preserved here as history only: on this host the launcher's default binary is
absent, so those steps fail before reaching the selected service, and `/restart`
does not reconnect the TUI client. No safe selected-service restart procedure is
established here; do not add or follow an unverified one.

V2's `service.restart` keybind restarts the **service**, not the TUI client.
Reconnecting the client requires a separately verified relaunch in the same
terminal, profile, and session, which has not been verified. Do not use
`systemctl --user restart opencode.service`: this launcher-managed setup has no
persistent user unit.

A service restart can interrupt an in-flight request, turn, or child session, so
persisted state must not be confused with completed or resumed work. The
launcher's isolated pilot config, data, and state remain on disk across
restarts; that is pilot state, not evidence about the selected service.

After the 2026-09-29 host reboot, the selected shared service auto-restarted as
a new PID (3187) on the same `127.0.0.1:49374` with OpenCode 2.0.11 and 95/95
plugins active; the pre-reboot PID 3233 is gone. That auto-restart is host
behavior, not a procedure this page teaches.

The health response is not acceptance of the omitted-model path or visible
commands. Historical pre-migration evidence remains unaccepted: the shared
service rejected an omitted-model continuation as `model <unresolved>` after a
TUI restart, while only the explicit, previously approved
`openai/gpt-5.6-luna#max` pin succeeded in that run. This does not validate the
new GPT-6 role assignments until authorized deployment and fresh resolution.
The latest visible `/session-context`, `/tools`, and `/learn` bodies were blank;
they remain broken/unverified until fresh rendered and interaction evidence
passes.

Set `OPENCODE_V2_BIN`, `OPENCODE_V2_PILOT_DIR`, or `OPENCODE_WEB_OPENER` to
override the executable, isolated pilot state root, or URL opener.
`OPENCODE_V2_BIN` changes only which executable runs; it never selects the
selected shared service's profile. The statements below describe the pilot
profile the launcher always uses.

The launcher also defaults `RIG_PARSERS_DIR` to
`$OPENCODE_V2_PILOT_DIR/cache/opencode-rig/parsers`, matching setup.
Project configuration discovery remains enabled by default, so portable project
configuration, agents, and permissions load. If a caller explicitly sets
`OPENCODE_DISABLE_PROJECT_CONFIG`, the launcher passes that value through
unchanged for both normal and `web` invocations; it never invents a disabling
value.
OAuth providers must be connected through OpenCode; only existing API-key
credentials are mapped into the isolated runtime.

Run the disposable regression check with:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-launcher-self-test.py
```

For a local rollback, restore the previous launcher copy and remove the
compatibility change from any secondary alias. The OpenCode binary, database,
and service configuration are not modified by this launcher.
