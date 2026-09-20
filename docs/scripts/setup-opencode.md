# `setup-opencode.sh`

Recursively deploys the 19 complete v2 skill bundles, the four repository commands as
content-aware copies, missing v2 config files into the isolated config
directory, and the pinned Explorer parser assets into the managed cache. It is
read-only by default; `--apply` performs the bounded writes and then verifies
the selected config directory and parser cache.

```bash
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --verify-only
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --apply
./platforms/linux/ubuntu/computer-use/scripts/setup-opencode.sh --prepare
```

Options are `--config-dir DIR`, `--apply`, `--prepare`, `--verify-only`, and `--help`. Existing
config files are never overwritten. Skill and command copies are content-aware
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
Before any apply or prepare dependency, parser, config, skill, or command write,
the config root, its existing ancestors, and the server/CLI config targets are
refused if symlinked. An absent final config directory is allowed when all
existing ancestors are real directories. Verify-only applies the same refusal
without writing.

When seeding the global `opencode.jsonc`, setup removes only the global
Playwright registration (nested or legacy flat); GitHub, Basic Memory, agents,
permissions, models, plugins/options, timeouts, and unrelated content are
preserved. Project `opencode.json` is not modified by this seed tailoring.

Apply preflights each existing skill destination: nested symlinks, non-directory
path components, and unsupported file types fail before copying. Only a
top-level legacy symlink resolving to that skill's canonical source is converted;
extras are reported and preserved. JSONC validation accepts line/block comments
and trailing commas but rejects malformed input and duplicate keys. The focused
`setup-opencode-self-test.py` exercises these safety and idempotence guarantees,
including the real prepare → plugin registration → final verification sequence
for clean and stale targets.

The parser installer requires the locked `tree-sitter-wasm@2.0.1` package and
validates the manifest schema, unique safe aliases/filetypes, source
containment, source hashes, and the exact managed target tree. Unexpected
files, directories, symlinks, special entries, stale temporary files, and
destination collisions fail closed in both install and verify modes; unknown
target content is never deleted.
