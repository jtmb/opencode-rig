# `opencode-launcher.sh`

Runs the isolated OpenCode v2 installation with its dedicated config, data,
state, and cache directories. Normal arguments pass through unchanged to the
v2 binary.

The launcher also restores the convenient web entry point that V2 does not
provide as a native subcommand:

```bash
opencode web
opencode web --no-open
```

`opencode web` starts the shared service idempotently, prints the username and
generated password from `opencode pair`, and opens the reported URL in the
default browser. `--no-open` prints the same access details without opening a
browser. The launcher never restarts an already healthy service, avoiding port
races and disruption to other OpenCode clients.

## Reload server plugins

Reopening or restarting the TUI does not reload server plugin code. Wait for
background child sessions to finish before restarting the shared service because
the restart can interrupt in-flight turns or child work. From the repository
root, run these commands in order:

```bash
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh service restart
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh service status
platforms/linux/ubuntu/computer-use/scripts/opencode-launcher.sh api get /api/info
```

The launcher's isolated config, data, and state remain on disk; a service
restart is not a state reset. It can still interrupt an in-flight request, turn,
or child session, so persisted state must not be confused with completed or
resumed work. After `/api/info` succeeds, return to the TUI and run `/restart`
to reconnect it. Do not use `systemctl --user restart opencode.service`: this
launcher-managed setup has no persistent user unit.

The health response is not acceptance of the omitted-model path or visible
commands. After `/restart`, retest a continuation without an explicit model
pin. The current evidence remains unaccepted: the shared service rejected an
omitted-model continuation as `model <unresolved>` after a TUI restart, while
only the explicit, previously approved `openai/gpt-5.6-luna#max` pin succeeded.
The latest visible `/session-context`, `/tools`, and `/learn` bodies were blank;
they remain broken/unverified until fresh rendered and interaction evidence
passes.

Set `OPENCODE_V2_BIN`, `OPENCODE_V2_PILOT_DIR`, or
`OPENCODE_WEB_OPENER` to override the binary, isolated state root, or URL opener.
The launcher also defaults `RIG_PARSERS_DIR` to
`$OPENCODE_V2_PILOT_DIR/cache/opencode-rig/parsers`, matching setup.
Project configuration discovery remains enabled by default, so the canonical
project-only Playwright registration and project agents/permissions load. If a
caller explicitly sets `OPENCODE_DISABLE_PROJECT_CONFIG`, the launcher passes
that value through unchanged for both normal and `web` invocations; it never
invents a disabling value.
OAuth providers must be connected through OpenCode; only existing API-key
credentials are mapped into the isolated runtime.

Run the disposable regression check with:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/opencode-launcher-self-test.py
```

For a local rollback, restore the previous launcher copy and remove the
compatibility change from any secondary alias. The OpenCode binary, database,
and service configuration are not modified by this launcher.
