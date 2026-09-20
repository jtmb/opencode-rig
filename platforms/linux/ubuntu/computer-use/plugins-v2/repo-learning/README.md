# Repository learning (v2)

Server and CLI plugin for automatic bounded repository observation and read-only
review. New state starts observing; an explicit pause persists across restarts.
`/learn status` and `/learn audit` are read-only; `/learn resume` and `/learn
pause` each require a second invocation with a short-lived token bound to the
session, intent, and current state.

The server registers the authoritative recorder through a bounded RPC. The CLI
registers `/learn` and renders its result in a supported v2.0.7 dialog, without
starting a model turn, resuming the session, or writing a synthetic inbox
message. The existing `/learn-review` command and `Ctrl+Alt+L` open the separate
read-only artifact review panel.

Observation stores only event type/name, session ID, timestamp, and outcome. It
never stores prompts, tool inputs, tool outputs, transcripts, or error text.
Episodes retain at most 512 events each, 200 total, 512 KiB serialized state,
and 30 days of history.

The CLI exposes `/learn`, `/learn-review`, and `Ctrl+Alt+L`. Its panel is
read-only because no approval backend is registered. Internal synthesis, artifact, shadow,
optimization, and Basic Memory promotion modules are compiler/test surfaces
only: they do not run on the active task path, call Basic Memory, modify files,
install dependencies, alter permissions, commit, or push. Their tests enforce
namespace isolation, no auto-activation, exact preview tokens, expiry/replay
rejection, per-rule approval, and rollback metadata.

## Check

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning run check
```

Both roles are registered through the v2 role catalog. Deploy with
`scripts/deploy-plugins.sh --plugins repo-learning --apply`, restart OpenCode,
and use `/learn status` to verify observation. If the server export is not
loaded, the CLI reports that `/learn` is unavailable instead of sending a model
prompt. Use `/learn pause` when automatic observation is not wanted for this
repository.
