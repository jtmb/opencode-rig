# `check-repository-qa.py`

`check-repository-qa.py` is the canonical bounded, read-only repository QA
command used by the rig-tools gate. It fails before package checks when the
repository has not declared a deterministic QA runtime. Run it with an
explicit root when the script is copied or wrapped by another repository:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-repository-qa.py --root .
```

## OpenCode Web QA

OpenCode Web has a separate live acceptance requirement in addition to this
host-independent QA command. Follow the [OpenCode Web QA guide](opencode-web-qa.md)
to verify the user's authenticated Windows default browser through the WSL
connector, capture a fresh real rendered screenshot and accessible snapshot,
exercise an interaction, and detect startup/browser errors. The guide binds each
capture to the exact URL/port, OpenCode service version and identity, browser,
timestamp, and evidence digests. It specifically calls out the reported
`BrowserAttachments context must be used within a context provider` startup
failure without attributing its cause to a different service version.

This live check is not run by canonical repository QA and does not make Linux
CI depend on Windows, a browser connection, or local Web authentication. Do not
use Chrome for Testing or a project Playwright MCP for Web QA. The optional
read-only documentation-contract check is portable:

```bash
python3 docs/scripts/check_opencode_web_qa_contract.py --root .
```

It verifies that the written requirements remain present; it does not perform
or imply live browser acceptance.

## Declared runtime contract

Package checks never resolve Node or npm from ambient `PATH`. The repository
must add `qaRuntime` to `.opencode/rig-gates.json`:

```json
{
  "qaRuntime": {
    "name": "node",
    "version": "26.4.0",
    "executable": "toolchains/node/bin/node",
    "sha256": "4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94",
    "packageManager": {
      "name": "npm",
      "executable": "toolchains/node/lib/node_modules/npm/bin/npm-cli.js",
      "sha256": "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7"
    }
  }
}
```

The paths must be relative forward-slash paths to executable, regular,
non-symlink files beneath the repository root. Absolute paths, traversal,
symlink components, missing files, non-Node runtimes, non-npm package managers,
and stale SHA-256 values fail closed with an actionable diagnostic. For package
checks the child environment sets `PATH` to the declared Node executable's
directory followed by the fixed system directories `/usr/bin:/bin`, and the
package command invokes the declared npm executable by its absolute, verified
path. The declared directory stays first, so Node and npm are still selected by
their committed paths rather than from `PATH`; the appended system directories
exist only so npm can spawn its script shell and the `bash` used by the curated
scripts. QA does not download or resolve dependencies; it sets
`npm_config_offline=true`.

`setup-qa-runtime.py` is the approved provisioner. `--verify-only` validates the
gate declaration, runtime manifest, modes, regular-file/link-count constraints,
and every installed file digest without writing, downloading, or repairing
anything. `--apply` downloads only the official HTTPS Node archive, verifies its
SHA-256 and archive structure, extracts into a temporary directory below
`toolchains/`, verifies the result, and atomically renames it into the ignored
`toolchains/node/` path without replacing an existing runtime. The pinned
values are:

| Artifact | Version | SHA-256 |
|---|---:|---|
| Official Linux x64 archive | Node `26.4.0` | `5c4286dcd5bbd5acb1ccc7eb0e088bd5eb1e3affad671ee9364004f8f6a4a431` |
| `bin/node` | Node `26.4.0` | `4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94` |
| `lib/node_modules/npm/bin/npm-cli.js` | npm `11.17.0` | `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7` |

The official archive carries `bin/npm` and `bin/npx` as symlinks. The
provisioner accepts only those exact upstream alias records, never materializes
them, and rejects every unexpected symlink, hardlink, device, FIFO, duplicate,
or unsafe path. It creates a regular executable `toolchains/node/bin/npm`
launcher bound to the pinned Node and npm CLI so `npm` resolves using only the
checkout-local runtime directory on `PATH`. QA itself invokes the separately
hash-pinned npm CLI by absolute path and puts that same runtime directory first
on the child `PATH`, followed by `/usr/bin:/bin` so npm can locate its script
shell.

The profile-owned Node `22.22.2` MCP runtime remains independent and unchanged;
the Node `26.4.0` QA runtime is not written into native or WSL profile state.
`setup-plugin-dependencies.sh` continues to install only lockfile-pinned plugin
dependencies and does not own QA runtime provisioning.

## Deterministic check order

After runtime selection, the command runs in this order:

1. the project-local [`check-acceptance-evidence.py`](check-acceptance-evidence.md)
   manifest gate;
2. `npm run check` for the twelve curated v2 package workspaces through the
   declared npm runtime: `codex-fallback`, `codex-usage`, `source-control`,
   `file-manager`, `orchestration-policy`, `ponytail-adapter`, `git-tool`,
   `repo-learning`, `chatgpt-connector`, `rig-tools`, `rig-todo`, and
   `resource-monitor`. This includes `chatgpt-connector` and excludes the
   retired `integrated-browser` workspace;
3. `bash -n` and ShellCheck error-severity checks for every script shell file
   and `.githooks/pre-push`. The QA script resolves `shellcheck` from the
   invoking `PATH`; when you run it with the pinned Node `PATH`, append the
   directory where `shellcheck` is installed (for example `~/.local/bin`),
   otherwise QA fails with `ShellCheck: missing command: shellcheck`;
4. source compilation with Python's in-memory `compile()` for every Python
   file, using the current Python interpreter rather than a second `PATH`
   lookup;
5. the skill-doc, progress-tracking, Git-safety, plugin-resource, and
   documentation coverage checks;
6. every repository `*-self-test.py` in this fixed order:
   `check-skill-docs-self-test.py`, `check-progress-tracking-self-test.py`,
   `check-git-safety-policy-self-test.py`,
   `check-plugin-resource-guards-self-test.py`,
   `check-doc-coverage-self-test.py`, `deploy-plugins-self-test.py`,
   `deploy-hermes-plugin-self-test.py`,
   `check-run-bounded-command-self-test.py`, `mcp-runtime-self-test.py`,
   `chatgpt-private-self-test.py`, `setup-opencode-self-test.py`,
   `setup-plugin-dependencies-self-test.py`,
    `setup-qa-runtime-self-test.py`, `opencode-launcher-self-test.py`,
    `opencode-recovery-self-test.py`,
    `recover-orchestration-lockout-self-test.py`,
   `check-acceptance-evidence-self-test.py`,
   and `check-repository-qa-self-test.py`;
7. v2 role-catalog validation; strict JSON and standard-library JSONC parsing
   with duplicate-key rejection; SVG XML parsing; local Markdown link
   validation; and `git show --check` for `HEAD` plus unstaged and staged
   `git diff --check`.

The `HEAD` check excludes `wsl-session.md`, a checked-in historical terminal
export; unstaged and staged checks still cover edits to that file. All three
checks exclude only generated native-capture character frames and snapshot
`.txt` files under `evidence/ui-acceptance/*/v3/`, whose trailing cells are
part of the rendered frame. Other source, documentation and evidence files
remain checked. The self-test verifies these exclusions alongside staged and
non-exempt `HEAD` whitespace failures.

The package workspace list is checked against an exact curated allowlist, in
addition to count, type, path, and uniqueness validation. The repository QA
self-test uses a disposable manifest containing the final twelve workspaces; it
does not alter or substitute for `plugins-v2/package.json`. If the canonical
manifest still contains a thirteenth workspace such as the retiring
`integrated-browser`, the canonical package gate will reject it even when the
focused self-test passes. The self-test list is an explicit allowlist checked
against deterministic, repository-wide discovery. A missing entry or a newly
added unlisted `*-self-test.py` fails the gate. The repository QA self-test
imports helper functions and never invokes canonical QA recursively. The copied
acceptance self-test uses a disposable consumer repository and does not depend
on the Open Rig runtime or absolute source paths.

`opencode-recovery-self-test.py` runs the fixture-backed unittest suite in
`platforms/linux/ubuntu/computer-use/scripts/tests/test_opencode_recovery.py`.
The suite verifies bounded marker fingerprints, exact server identity checks
before marker apply and reconnect, sanitized readiness reports, and refusal to
claim note proof. It uses fake API/runtime boundaries and disposable fixtures;
it does not apply native state, reconnect a live service, or call `read_note`.

Commands use fixed direct argv, never a shell. Each command has a 180-second
limit and the complete QA run has one 540-second monotonic deadline. A command
receives the smaller of its per-command limit and the remaining overall
budget, so the overall deadline can expire while that command is running. The
same deadline is checked throughout deterministic JSON, JSONC, SVG, Markdown,
Python-file, shell-file, workspace, and self-test discovery traversals.
Timeout and combined stdout-plus-stderr overflow terminate the command process
group and reap its leader; missing commands fail closed. Failed commands report
at most 400 characters split between the start and end of combined output.

Child processes preserve ordinary caller controls while forcing
`C.UTF-8`, noninteractive CI/Git behavior, `PYTHONDONTWRITEBYTECODE=1`,
deterministic Python hashing, and npm offline mode. Runtime package checks set
`PATH` to the declared runtime directory first, then the fixed `/usr/bin:/bin`
system directories so npm can spawn its script shell; Node and npm remain
resolved from the declared, digest-verified files. Dynamic parser imports are
not required, so copied QA scripts do not depend on an adjacent Open Rig
helper. QA creates no ignored Python bytecode artifacts.

`check-repository-qa-self-test.py` uses disposable temporary roots to prove
missing-command failure, command timeout and reaping, process-group descendant
cleanup, combined stdout/stderr output overflow, an overall deadline expiring
inside a running command and inside an in-process traversal, malformed and
duplicate JSON/JSONC rejection, malformed SVG rejection, broken-link
rejection, missing and unexpected self-test detection, deterministic discovery
order, bounded start/end failure context, the controlled child environment,
relative runtime selection and checksum rejection independent of `PATH`, the
composed package-check `PATH` that keeps the declared runtime first, the
narrow historical-export `HEAD` exemption while retaining staged and
non-exempt `HEAD` failures, and absence of bytecode output.
