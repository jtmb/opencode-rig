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

The adapter registers with the v2 server API as plugin id `ponytail`. Its
default resolver asks Node to resolve `@dietrichgebert/ponytail` from the
adapter's own module and walks to that package's manifest. It never consults a
developer's `HOME` or a separate install root. The resolver and loader require
the exact official `4.10.0` identity, bounded regular non-symlink files, the
published six commands and six skills, valid frontmatter, and the three
expected CommonJS runtime functions. They reject malformed, oversized,
lookalike, wrong-version, lifecycle-script, and symlinked package inputs before
registration. An absolute `options.packageRoot` override remains only for
disposable tests or controlled compatibility fixtures and is subject to the
same validation.

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

Use the repository-owned dependency setup; verification is read-only and the
only install path uses the checked-in lockfile with lifecycle scripts disabled:

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-plugin-dependencies.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-plugin-dependencies.sh --apply
```

Native Ubuntu and WSL2 bootstrap invoke this helper before role deployment.
`deploy-plugins.sh --plugins all` owns the single catalog registration, and the
portable project `opencode.json` owns one direct repository registration.
There is no floating update lookup, user timer, separate version store, or
rollback symlink to override the canonical dependency.

The focused package check is also available:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter run verify:package
```

The runtime probe uses only a temporary loopback mock provider and an isolated
OpenCode server. It verifies six commands, six skills, `ultra` and `off` mode
behavior, session isolation, and restart persistence without contacting a real
provider.

After installation, restart OpenCode whenever the plugin or server config
changes. Do not commit or push generated installation state, package contents,
or user config.
