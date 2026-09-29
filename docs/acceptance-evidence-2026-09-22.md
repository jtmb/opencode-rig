# Acceptance evidence — 2026-09-22

## Current decision

UI acceptance is **pending**. The checked-in manifest validates the source
inventory structurally, but it does not accept rendered-visual or interaction
claims. No authentic live screenshot or host-interaction proof is available in
this record. No fresh capture was generated for this correction.

`acceptance-evidence.json` contains 13 claims. Its nine user-visible claims are
all `planned` with empty evidence. The remaining claims cover automated,
non-visual evidence and retain their own limited/complete boundaries. The
manifest's pending reason identifies incomplete mapping coverage (including
mapping 13), theme switching, pagination, supporting-source digests, and
authentic host-render/interaction proof.

## Provenance correction

The prior v3 native OpenTUI artifacts are retained as historical test artifacts,
not as UI acceptance proof:

- existing execution reports do not bind every focused run to the exact argv,
  run ID, source/test hashes before and after execution, and strictly monotonic
  start/finish readings now required by the validator;
- span-derived PNGs are diagnostic visualizations, not host screenshots or
  pixel comparisons;
- mock mouse/keyboard transitions and native test-renderer phases are test
  evidence, not host interactions;
- those artifacts do not complete the source mapping and support-digest
  inventory.

The generator now records explicit command receipts and labels native renderer
events with test-only provenance. It requires distinct setup, dispatch, and
teardown phases plus run, dispatch, transition, and monotonic timing fields from
the fixture. The current fixture does not yet emit that complete contract, so
the generator was not run and no new captures were produced.

## Validation boundary

The acceptance validator's pending mode checks that the declared source roots
and explicit files are valid regular files. It returns no claimable visual or
interaction evidence in this mode. Native capture artifacts in ready mode also
return no claimable visual or interaction paths: they remain test-renderer
diagnostics. Keep every visible claim planned until an authentic, separately
validated host-evidence path is available.

Previously recorded package-test outputs, deployment verify-only results,
service health, and detached terminal text are operational or automated
observations. They do not establish live UI acceptance and do not replace
host-render or host-interaction proof.

## Checks run for this correction

- Copied-consumer acceptance self-test: passed.
- Repository acceptance validator: passed structurally for 13 claims and 3
  background-subagent records; the UI inventory remains pending.
- Capture-generator syntax check: passed. The generator was not executed.
- Documentation coverage: passed, 462 mapped files checked and 8 changed.
- Unstaged and staged `git diff --check`: passed.

## Remaining acceptance work

1. Complete the source inventory and mappings, including mapping 13 and the
   supporting sources required for theme switching and paged Source Control.
2. Refresh exact focused-test receipts only after concurrent source/test edits
   settle. Each receipt must include argv, run ID, before/after source/test
   hashes, UTC timestamps, increasing monotonic timestamps, exit status, and
   output digest.
3. Update the native fixture to emit its exact test-renderer run, phase,
   dispatch, transition, and monotonic provenance contract before running the
   generator.
4. Obtain authentic host screenshot and host-interaction evidence through a
   validator-supported schema before changing any visible claim from `planned`.

Until those requirements are met, the UI inventory and all nine visible claims
remain pending; native frames, spans, test PNGs, text dumps, and mock events
must not be described as live UI acceptance.
