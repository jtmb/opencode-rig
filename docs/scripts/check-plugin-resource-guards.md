# `check-plugin-resource-guards.py`

Checks every package under `platforms/linux/ubuntu/computer-use/plugins-v2/` and
requires its `typecheck` and `test` scripts to invoke `run-bounded-command.sh`.
This prevents local checks from exhausting the host while remaining adaptable to
new v2 packages. The companion self-test also verifies timeout isolation.
