# `setup-qa-runtime.py`

`setup-qa-runtime.py` provisions the repository's independent Node/npm runtime
for deterministic QA. It installs only beneath the checkout's ignored
`toolchains/node/` directory; it does not change the Node `22.22.2` runtime
owned by native or WSL profile setup.

## Pins

| Artifact | Version | SHA-256 |
|---|---:|---|
| Official Linux x64 archive | Node `26.4.0` | `5c4286dcd5bbd5acb1ccc7eb0e088bd5eb1e3affad671ee9364004f8f6a4a431` |
| `bin/node` | Node `26.4.0` | `4cfdaeec2e3689e4728b4bc98932a9147a3f98162bdc7955c03c0d7fa3b8aa94` |
| `lib/node_modules/npm/bin/npm-cli.js` | npm `11.17.0` | `8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7` |

The matching `qaRuntime` object in `.opencode/rig-gates.json` binds the Node
and npm executable paths and digests used by `check-repository-qa.py` and the
repository QA gate.

## Verify and install

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/setup-qa-runtime.py --verify-only
python3 platforms/linux/ubuntu/computer-use/scripts/setup-qa-runtime.py --apply
```

`--verify-only` is the default and is read-only: it checks the gate config,
manifest, file modes, regular-file/link-count constraints, exact directory
contents, and all file digests. It does not create directories, repair a
runtime, or access the network. It exits nonzero when the runtime is absent or
stale.

`--apply` downloads only from `https://nodejs.org`, validates the archive SHA,
archive member types, safe paths, uniqueness, npm version, and the extracted
Node/npm digests. It stages the installation below `toolchains/`, verifies the
complete tree, and atomically renames it into `toolchains/node/` without
replacement. A pre-existing runtime is verified and left intact; a stale or
modified runtime fails instead of being overwritten. Filesystem support for
Linux `renameat2(RENAME_NOREPLACE)` is required for installation.

The upstream archive includes `bin/npm` and `bin/npx` as symbolic-link aliases.
The installer recognizes only those two exact official alias records, omits
both from extraction, and rejects any unexpected symlink, hardlink, device,
FIFO, duplicate path, traversal, or other unsupported member type. It writes a
regular executable `toolchains/node/bin/npm` launcher that invokes the local
Node binary and pinned npm CLI; `npm` therefore works with only the runtime
directory on `PATH`. QA also verifies and invokes the npm CLI at its declared
relative path with that same restricted `PATH`.

## Tests and automation

`setup-qa-runtime-self-test.py` uses disposable archives and repositories to
check pins, read-only verification, WSL profile isolation, path/link/type
rejection, archive and executable digests, the PATH-only npm launcher, atomic
no-replace behavior, and unchanged installation on repeat verification.
Canonical repository QA includes this self-test. GitHub Actions provisions and
verifies the same checkout-local runtime before installing locked test
dependencies and running canonical QA.

`bootstrap.sh --verify-only` verifies this toolchain on both native Ubuntu and
WSL2. Bootstrap `--apply` may download and install it before profile setup; on
WSL2 the checkout-local toolchain remains outside the isolated WSL pilot. See
[`bootstrap.md`](bootstrap.md) for the full stage order and filesystem effects.
