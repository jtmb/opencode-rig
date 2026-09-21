# Ponytail — OpenCode v2 integration

Open Rig integrates Ponytail through the local
[`ponytail-adapter`](../../platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter/README.md)
server plugin. The adapter is required because the upstream npm artifact is
not a v2 plugin.

## Upstream package

- Repository: [`github.com/DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)
- npm package: [`@dietrichgebert/ponytail`](https://www.npmjs.com/package/@dietrichgebert/ponytail)
- Published version: `4.10.0`

The published `4.10.0` entrypoint is V1-only: it exports the V1 plugin factory,
`config` hook, `experimental.chat.system.transform`, and
`command.execute.before`. Those hooks are not the OpenCode v2 plugin contract.
OpenCode v2 plugins use `Plugin.define`, `setup(ctx)`, v2 transforms, and v2
session hooks. Registering `@dietrichgebert/ponytail` directly in v2 therefore
does not work; use the adapter and let it consume the official package's
commands, skills, and instruction runtime.

## What the adapter does

The adapter registers with the v2 server API as plugin id `ponytail`. It loads
the package from `options.packageRoot`, or from
`$HOME/.local/opt/opencode-ponytail/current/node_modules/@dietrichgebert/ponytail`
when no option is supplied. It requires the exact official package name,
bounded regular non-symlink files, valid command/skill frontmatter, and the
three expected CommonJS runtime functions. It rejects malformed, oversized,
lookalike, and symlinked package inputs before registration.

It maps the package's current Markdown commands to `ctx.command.transform`,
skills to `ctx.skill.transform`, and instructions to the v2 `context` and
`generate` session hooks. The adapter uses v2 plugin storage with a
session-id-qualified key for mode state. It does not run npm lifecycle scripts
or execute anything from the package.

## Modes

Use `/ponytail` in a session:

| Input | Result |
|---|---|
| `/ponytail` | Report the current session level without changing it |
| `/ponytail lite` | Persist `lite` for this session |
| `/ponytail full` | Persist `full` for this session |
| `/ponytail ultra` | Persist `ultra` for this session |
| `/ponytail off` | Persist `off`; later context/generate hooks inject nothing |
| any other value | Report an error and leave the current mode unchanged |

The default is supplied by the upstream runtime (normally `full`). Modes are
per session, so changing one session does not affect another. Durable v2
storage preserves a session's mode through a service restart. The other five
current commands are `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`,
`/ponytail-gain`, and `/ponytail-help`.

## Install and verify

Use the read-only-by-default setup script; its full safety contract, timer,
rollback, disable, and uninstall commands are documented in
[`setup-ponytail-plugin.md`](../scripts/setup-ponytail-plugin.md):

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-ponytail-plugin.sh --apply
```

`--apply` stages the exact npm version in a versioned directory, installs with
`--ignore-scripts --no-audit --no-fund`, runs the private mock-provider probe,
atomically switches the `current` symlink, and restarts/verifies OpenCode. A
failed activation restores the prior package link and config backup.

The runtime probe uses only a temporary loopback mock provider and an isolated
OpenCode server. It verifies six commands, six skills, `ultra` and `off` mode
behavior, session isolation, and restart persistence without contacting a real
provider.

After installation, restart OpenCode whenever the plugin or server config
changes. Do not commit or push generated installation state, package contents,
or user config.
