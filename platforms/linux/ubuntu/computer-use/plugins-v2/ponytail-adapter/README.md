# `ponytail-adapter` — OpenCode v2 server plugin

`ponytail-adapter` is the local OpenCode v2 bridge for the official Ponytail
ruleset. It keeps the upstream package's commands and skills while translating
its instruction runtime to the v2 plugin API.

## Upstream and compatibility

- Upstream repository: [`DietrichGebert/ponytail`](https://github.com/DietrichGebert/ponytail)
- Published package: [`@dietrichgebert/ponytail`](https://www.npmjs.com/package/@dietrichgebert/ponytail)
- Current published artifact used by this integration: `4.10.0`

The published `4.10.0` package is V1-only for OpenCode's plugin API. Its
`.opencode/plugins/ponytail.mjs` entrypoint exports the V1 factory/config and
`experimental.chat.system.transform` hooks, not the OpenCode v2
`Plugin.define({ setup(ctx) { ... } })` contract. Do not register the npm
package directly in a v2 `plugins` array. Register this adapter instead; it
loads the package as bounded data and calls only the shared instruction runtime.

## Registration

The adapter is a mandatory local server plugin. The canonical role catalog and
bootstrap register its absolute deployed path in the v2 server config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-rig/platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter",
      "options": {}
    }
  ]
}
```

When `options.packageRoot` is omitted, the adapter resolves the exact dependency
from its own module with Node's package resolver:

```text
plugins-v2/node_modules/@dietrichgebert/ponytail
```

An absolute `options.packageRoot` override is retained only for disposable
tests or controlled compatibility fixtures; it is bounded and receives the
same identity, version, layout, and file checks. No HOME-relative or developer
absolute default exists. The root `opencode.json` contains one portable
repository registration for direct downstream use; deployment must not add a
second one.

The root `server.ts` re-exports `src/index.ts`; the plugin id is `ponytail`.
Restart OpenCode after changing the registration.

## Local adapter contract

At setup, the adapter accepts only a resolved regular package directory whose
`package.json` has the exact identity `@dietrichgebert/ponytail@4.10.0` and no
install lifecycle scripts. It then loads the current package layout:

- `.opencode/command/*.md`: exactly the six published commands, safe lowercase
  names, regular non-symlink files, frontmatter, and at most 64 KiB per command;
- `skills/*/SKILL.md`: exactly the six published skills, matching safe ids,
  regular non-symlink files, matching `name` frontmatter, and at most 512 KiB
  per skill; and
- `hooks/ponytail-config.js` plus `hooks/ponytail-instructions.js`, which must
  expose `getDefaultMode`, `normalizeMode`, and `getPonytailInstructions`.

The package manifest is bounded to 256 KiB. The instruction runtime is
self-checked for `lite`, `full`, and `ultra` before the plugin registers
anything. OpenCode v2 registrations use `ctx.command.transform`,
`ctx.skill.transform`, `ctx.session.hook("context", ...)`, and
`ctx.session.hook("generate", ...)`; command prompts have their mention
metadata removed before being forwarded to the session.

The repository dependency setup uses `npm ci --ignore-scripts --no-audit
--no-fund` against the canonical lockfile. Upstream lifecycle scripts are
deliberately never run. The adapter also does not execute package scripts; it
reads the bounded command, skill, and instruction files only.

## Commands and per-session modes

The published package currently contributes six commands and six skills:

| Command | Purpose |
|---|---|
| `/ponytail [lite \| full \| ultra \| off]` | Report or set the current session's level |
| `/ponytail-review` | Review the current diff for over-engineering |
| `/ponytail-audit` | Audit the repository for over-engineering |
| `/ponytail-debt` | Find deliberate `ponytail:` deferrals |
| `/ponytail-gain` | Show the upstream impact scoreboard |
| `/ponytail-help` | Show the Ponytail quick reference |

Modes are stored under the `mode/<sessionID>` key, so they are independent and
durable per session rather than one process-wide flag:

- no stored mode uses the upstream default, normally `full`;
- `/ponytail` reports the mode without changing it;
- `lite`, `full`, `ultra`, and `off` update only the current session;
- `off` skips Ponytail instruction injection; and
- an invalid level reports the valid choices and leaves the stored mode alone.

`review` is an upstream review skill, not an accepted `/ponytail` runtime
level. A service restart does not change a stored session mode; the runtime
verifier checks this persistence.

## Checks

Run the package check through the shared bounded runner:

```bash
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter run verify:package
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/ponytail-adapter run check
```

The setup script additionally runs a private runtime probe. It creates a
temporary HOME/XDG tree, a random-loopback HTTP mock provider, and an isolated
OpenCode v2 server. The mock provider returns `OK`; it uses no real provider
credentials or external model endpoint. The probe verifies plugin activation,
the six commands and six skills, mode injection, session isolation, and mode
persistence across a server restart.

The canonical dependency and bootstrap runbook is in
[`docs/scripts/setup-plugin-dependencies.md`](../../../../../../docs/scripts/setup-plugin-dependencies.md).
