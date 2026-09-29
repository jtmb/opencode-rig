# `setup-plugin-dependencies.sh`

The canonical Ponytail path is the repository's v2 workspace, not a separate
home-directory install. This helper verifies or installs the exact
`@dietrichgebert/ponytail@4.10.0` dependency used by
[`ponytail-adapter`](../../platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter/README.md).

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-plugin-dependencies.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-plugin-dependencies.sh --apply
```

Verification is read-only and resolves the official package from the adapter's
own module. It fails closed unless the package identity, version, hooks, exact
six commands, and exact six skills are present. `--apply` runs the canonical
workspace install through `run-bounded-command.sh` with:

```text
npm ci --ignore-scripts --no-audit --no-fund
```

The helper is used by native Ubuntu setup and the WSL2 setup before deployment.
`bootstrap.sh --verify-only` therefore fails clearly when the dependency or
Ponytail surface is absent; `--apply` installs it before role deployment.

There is no updater timer, floating `latest` lookup, version store, or
`~/.local/opt/opencode-ponytail` fallback. The retired
`setup-ponytail-plugin.sh` path must not be recreated. OpenCode v2 still loads
the local adapter because upstream 4.10.0 exposes the older OpenCode hook shape.

The focused disposable check covers successful repository resolution, missing
dependency failure, and the exact bounded install argv:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/setup-plugin-dependencies-self-test.py
```
