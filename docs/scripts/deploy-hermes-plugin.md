# `deploy-hermes-plugin.py`

`deploy-hermes-plugin.py` installs the opt-in Hermes observer plugin (the two
checked-in files under `plugins-v2/rig-tools/hermes-plugin/`) into a Hermes
profile so the `/hooks` pipeline panel has a producer. It is read-only by
default and does not require Hermes to be installed, running, or authenticated.

```bash
# Verify the selected profile (default: $HERMES_HOME or ~/.hermes)
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-hermes-plugin.py

# Install or repair, then re-verify
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-hermes-plugin.py --apply
```

Options:

| Option | Contract |
|---|---|
| `--hermes-home DIR` | Profile root (default `$HERMES_HOME`, else `~/.hermes`). Must be absolute. |
| `--telemetry-file FILE` | Shared snapshot path to print. Must be absolute. Default: `<root>/logs/open-rig-hooks.snapshot.json`. |
| `--apply` | Copy the two files atomically, then verify. Idempotent: current files are left untouched. |
| `--verify-only` | Check only (the default). |

## Shared telemetry path

The Python writer (`HERMES_HOME`/`OPEN_RIG_HERMES_TELEMETRY_FILE`) and the
TypeScript `/hooks` reader resolve `logs/open-rig-hooks.snapshot.json` under
different profile roots when Hermes runs on Windows and the OpenCode server runs
in WSL. The script always prints the one absolute path both processes must set:

```text
OPEN_RIG_HERMES_TELEMETRY_FILE=/absolute/path/to/open-rig-hooks.snapshot.json
```

Export that exact value as `OPEN_RIG_HERMES_TELEMETRY_FILE` in **both** the
Hermes profile environment and the OpenCode server/CLI environment before
starting each process. Setting it in only one side leaves the reader on a
different root and the panel stays empty.

## Fail-closed behavior

- Missing or modified plugin files verify non-zero and never write.
- `--apply` refuses symlinked roots, plugin directories, and plugin files.
- `--apply` refuses any target inside an enclosing git checkout (detected by a
  `.git` entry), so it can never mutate a worktree or the primary checkout.
- Source file digests are compared before writing; unchanged files are not
  rewritten, so repeated `--apply` runs are byte- and inode-idempotent.
- Installed files use mode `0644`; the plugin directory uses `0700`.

## What it deliberately does not do

The script never runs `hermes plugins enable`, never edits Hermes
configuration, never restarts a service, and never contacts a provider. After
`--apply` it prints the exact `hermes plugins enable open-rig-hermes-hooks`
command the operator runs separately. Live `/hooks` acceptance still requires a
real Hermes install, an enabled plugin, and a genuine provider-backed turn; this
script only removes the manual file-copy step.

## Verification

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/deploy-hermes-plugin-self-test.py
```

The self-test installs into disposable temporary profiles only. It proves
read-only verification, idempotent install, stale repair, symlinked
root/directory/file refusal, repository-checkout refusal, relative-path
refusal, environment resolution, shared telemetry-path printing, and
mode/hash fidelity. It does not touch a real Hermes profile.
