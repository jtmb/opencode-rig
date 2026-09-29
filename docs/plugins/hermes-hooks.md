# Hermes `/hooks` pipeline panel

`rig-tools` exposes Hermes Agent observer activity through a fullscreen OpenCode
panel. Open `/hooks` in an active OpenCode session to view a live Session → Turn
→ Model → Tools → Subagents graph and up to 48 recent event rows. Wide
terminals render the graph horizontally; narrower terminals stack the stages
vertically. Palette and theme-mode changes refresh semantic theme colors.

The Hermes half is an opt-in directory plugin at
`platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/hermes-plugin/`. It
registers observer callbacks for session, turn, provider request, tool, and
subagent lifecycle hooks. Callbacks only observe: they never return a control
decision, modify a request, or block execution.

## Data and privacy

The plugin stores one atomic JSON snapshot at
`$HERMES_HOME/logs/open-rig-hooks.snapshot.json`, or at the absolute path named
by `OPEN_RIG_HERMES_TELEMETRY_FILE`. Set the same override in Hermes and the
OpenCode server process when their profile environments differ. The file is
created with owner-only permissions and uses a cross-process lock. Its bounded
contract retains at most 128 events and 128 KiB; the OpenCode RPC polls for file
changes every 750 ms and caps each snapshot response at 128 events.

Only allowlisted observer metadata is persisted: hook name, timestamp, outcome,
bounded duration, model/provider/tool labels, surface, and one-way 12-hex
references derived from Hermes correlation IDs. Raw session, turn, request, and
tool IDs are not retained. Prompts, conversation history, request/response
bodies, tool arguments/results, error text, commands, paths, and credentials are
never copied into the snapshot. The server validates the file as a bounded,
regular non-symlink before parsing and projects each record into a strict
allowlist before exposing it through RPC.

If the snapshot does not exist, `/hooks` shows an empty waiting state. Invalid,
oversized, or unreadable snapshots produce bounded status text without exposing
the configured filesystem path. When Hermes or OpenCode restarts, the panel
hydrates from the persisted snapshot before receiving subsequent updates.

## Enable the Hermes observer

The opt-in observer is not deployed by any automatic step. Verify or install its
two files into the selected Hermes profile with the checked-in deployment
script; verification is the default and `--apply` copies atomically, then
re-verifies:

```bash
# Verify the selected profile (default: $HERMES_HOME or ~/.hermes)
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-hermes-plugin.py

# Install or repair, then re-verify
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-hermes-plugin.py --apply
```

The script installs only `plugin.yaml` and `__init__.py`, refuses symlinked
roots/files and any target inside a git checkout, and never runs
Hermes. Then explicitly enable the plugin and start Hermes:

```bash
hermes plugins enable open-rig-hermes-hooks
```

The observer starts on the next Hermes CLI or gateway process that loads
plugins. The OpenCode server and CLI sides use the existing `rig-tools` role
registrations; load the updated source and configuration through the normal
Open Rig deployment procedure before opening `/hooks`.

### Set the shared telemetry path

The Python writer and the TypeScript `/hooks` reader each resolve
`logs/open-rig-hooks.snapshot.json` under their own profile default, so they can
read different roots when Hermes runs in a Windows profile and the OpenCode
server runs in WSL. `deploy-hermes-plugin.py` always prints the one absolute path
both processes must set:

```bash
export OPEN_RIG_HERMES_TELEMETRY_FILE="$HERMES_HOME/logs/open-rig-hooks.snapshot.json"
```

Set that **same** value in the Hermes profile environment and in the OpenCode
server/CLI environment. Setting it on only one side leaves the reader on the
other root and the panel stays empty. The `--telemetry-file` option prints a
different absolute override when a shared location outside `$HERMES_HOME` is
preferred.

Manual install remains possible for reference:

```bash
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SOURCE="platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/hermes-plugin"
TARGET="$HERMES_HOME/plugins/open-rig-hermes-hooks"
install -D -m 0644 "$SOURCE/plugin.yaml" "$TARGET/plugin.yaml"
install -D -m 0644 "$SOURCE/__init__.py" "$TARGET/__init__.py"
hermes plugins enable open-rig-hermes-hooks
```

The script does not edit Hermes configuration or run during this repository
change; a live provider-backed observer event and rendered `/hooks` panel remain
separate acceptance work.

## Snapshot RPC

The `opencode-rig.hermes-hooks` RPC exposes:

| Operation | Contract |
|---|---|
| `snapshot({ limit? })` | Returns `{ schemaVersion: 1, state, updatedAt, events }`; `limit` is clamped to 1–128. |
| `updated` event | Publishes the same bounded snapshot when persisted content changes. |

`state` is `ready`, `empty`, `unavailable`, or `invalid`. Every event includes
`at`, `hook`, and `status`; optional fields are `durationMs`, `model`,
`provider`, `tool`, `auxTask`, `surface`, `sessionRef`, `turnRef`, `requestRef`,
and `toolRef`. Additional stored fields are discarded.

## Verification

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools run check
python3 -m pytest -q platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools/hermes-plugin/tests
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-hermes-plugin-self-test.py
```

These checks cover bounded file reads, symlink refusal, privacy projection,
canonical request/turn outcomes, ring-buffer retention, concurrent observer
writes, snapshot hydration, graph state transitions, command/panel wiring, and
the deployment script's read-only verify, idempotent install, stale repair,
symlink/repository refusal, and shared telemetry-path printing.
They are source/package evidence only. Rendered and live `/hooks` UI acceptance
remains **pending** until fresh host rendering, theme switching, and panel
interaction evidence is collected.

Hermes API references:

- [Observer Hooks](https://hermes-agent.nousresearch.com/docs/developer-guide/observer-hooks)
- [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins)
