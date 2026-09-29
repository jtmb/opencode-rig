# `setup-opencode.sh`

Recursively deploys the 19 complete v2 skill bundles, the four repository
commands, and the opt-in `chatgpt-private` agent as content-aware copies; it also
seeds missing v2 config files into the isolated config directory and installs
the pinned Explorer parser assets into the managed cache. It is
read-only by default; `--apply` performs the bounded writes and then verifies
the selected config directory and parser cache.

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --prepare
```

Options are `--config-dir DIR`, `--apply`, `--prepare`, `--verify-only`, and `--help`. Existing
config entries unrelated to the Open Rig model migration are preserved. The
selected server profile seeds Build/Explore/General with GPT-6 Luna `#max` and
Plan/Architect with GPT-6 Sol `#max`. Apply/prepare reconciles these five role
assignments when they are missing, use the old GPT-5.6 models, or select the wrong GPT-6
family; explicitly selected unrelated custom models are preserved. A changed
selected JSONC server config is atomically serialized to JSON and retains its
file mode. Verify-only reports stale roles without modifying the profile;
unknown custom agent roles still selecting GPT-5.6 fail closed for manual role
classification. Skill and command copies are content-aware
and idempotent; deployed bundles must contain no symlinks or extra files. Apply
mode safely replaces an older skill symlink only when it resolves to that
skill's canonical source. Command destinations may not be symlinks. When the exact locked
`tree-sitter-wasm@2.0.1` dependency is absent, apply mode runs bounded
`npm ci --ignore-scripts --no-audit --no-fund`; it then runs the manifest and
SHA-256 checked parser installer. Verify-only mode never downloads or writes:
it checks the installed dependency and every managed parser asset. Set
`RIG_PARSERS_DIR` to select a controlled parser cache; otherwise setup uses
`${OPENCODE_V2_PILOT_DIR:-~/.opencode-v2-pilot}/cache/opencode-rig/parsers`,
the same default exported by the launcher. The explicit parser target is passed
through the bounded runner. `--prepare` performs all writes, seeding, and parser verification but
defers health verification; it reports success only when every accumulated
preparation check succeeds. Any preparation failure is reported as a nonzero
exit and stops computer-assistant setup before plugin registration. This lets
plugin registration occur between seeding and the one final health check.
`--apply` delegates its final health check to `verify-opencode-v2.sh`.
The same locked install also supplies the official
`@dietrichgebert/ponytail@4.10.0` dependency for the catalog-managed
`ponytail-adapter`; its exact six-command/six-skill surface is verified before
the final health check.

The canonical `agents/chatgpt-private.md` file is copied to the selected
config's `agents/` directory. Apply replaces stale managed content; verify-only
compares exact file contents and refuses symlinked targets or ancestors. Other
agent files are preserved. Installing this profile does not change
`default_agent`; `scripts/chatgpt-private.sh` is the explicit neutral-workspace
launcher for private use outside the repository.
Before any apply or prepare dependency, parser, config, skill, or command write,
the config root, its existing ancestors, and the server/CLI config targets are
refused if symlinked. An absent final config directory is allowed when all
existing ancestors are real directories. Verify-only applies the same refusal
without writing.

When seeding the global `opencode.jsonc`, setup removes a legacy Playwright
registration (nested or flat). The portable project and global profiles use
exactly `basic-memory`, `github`, and `chatgpt`. The selected model-role
reconciliation owns only the five Open Rig agent model assignments; GitHub,
Basic Memory, other agents/models, permissions, plugins/options, timeouts, and
unrelated content are preserved. Project `opencode.json` is not modified by
setup.

Apply preflights each existing skill destination: nested symlinks, non-directory
path components, and unsupported file types fail before copying. Only a
top-level legacy symlink resolving to that skill's canonical source is converted;
extras are reported and preserved. JSONC validation accepts line/block comments
and trailing commas but rejects malformed input and duplicate keys. The focused
`setup-opencode-self-test.py` exercises these safety and idempotence guarantees,
including the real prepare → plugin registration → final verification sequence
for clean and stale targets. It verifies that canonical global MCP normalization
is idempotent, verifies local MCP wrapper contracts, rejects
malformed/symlinked config, and leaves the checked-in portable
three-server `basic-memory`/`github`/`chatgpt` configuration byte-for-byte
unchanged.

The parser installer requires the locked `tree-sitter-wasm@2.0.1` package and
validates the manifest schema, unique safe aliases/filetypes, source
containment, source hashes, and the exact managed target tree. Unexpected
files, directories, symlinks, special entries, stale temporary files, and
destination collisions fail closed in both install and verify modes; unknown
target content is never deleted.
