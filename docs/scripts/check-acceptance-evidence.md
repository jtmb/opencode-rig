# Acceptance-evidence gate

`check-acceptance-evidence.py` is a project-local, read-only validator that uses
only Python's standard library. It never executes manifest commands, imports an
Open Rig module, accesses the network, or depends on an Open Rig absolute path.
Copy the validator and its evidence into a consumer repository and run:

```bash
python3 path/to/check-acceptance-evidence.py --root .
```

The gate accepts only manifest version **3** and UI inventory version **3**.
Older schemas fail closed.

## Pending UI inventory

Pending mode inventories the UI source tree without asserting that tests ran or
that a UI was rendered or interacted with. It accepts only these UI-inventory
fields; source paths are relative, non-symlink paths beneath the repository root:

```json
{
  "ui_acceptance": {
    "version": 3,
    "status": "pending",
    "reason": "Fresh test receipts and authentic host evidence are incomplete.",
    "source_roots": ["src/ui"],
    "source_extensions": [".tsx"],
    "source_files": []
  }
}
```

The validator discovers matching files under `source_roots` and adds any
explicit `source_files`. A structural pass confirms that this inventory is
readable; it supplies no source digests, capture mappings, rendered-visual
paths, or interaction paths. Keep each unsupported user-visible claim
`planned` with empty evidence. Non-UI automated claims may still be `complete`
or `limited` when their own evidence is retained. The manifest as a whole must
contain at least one evidenced `complete` or `limited` claim.

## Focused execution receipts

The ready inventory requires every discovered UI source to have a unique
mapping, focused behavioral and render tests, and a digest-bound execution
artifact for each test. Each receipt binds:

- the mapped source and focused-test SHA-256 values as they existed before and
  after execution;
- the exact argv array, repository-relative working directory, and compact JSON
  command representation;
- a unique run ID, UTC start/finish timestamps, and strictly increasing
  monotonic nanosecond readings;
- a zero exit code, `passed` result, fresh observation time, and non-empty output
  whose digest matches its retained bytes.

The validator checks that argv resolves to the focused test and that every
receipt agrees with the source/test bytes now present. It never runs that argv.
Skipped, todo, or focused-only test declarations are rejected.

## Native test-renderer artifacts

A ready mapping binds a version-3 capture artifact to its source, generator,
focused render test, native fixture, runtime, and renderer. The native fixture
must retain actual `testRender` output, character frames, semantic spans, state
snapshots, and three separate `test-setup`, `test-dispatch`, and `test-teardown`
event records. The native capture run binds exact argv, run ID, timestamps,
monotonic timing, exit status, and source/test/generator inputs. Event records
bind their own IDs, native dispatch and transition IDs, run IDs, phase timing,
snapshot hashes, result, JSON outputs, and digests.

This provenance is deliberately **test-only**:

- a native test-renderer event is not a host input event;
- a frame or semantic-span file is not a host screenshot;
- `span_visualization` is a diagnostic PNG recomputed from semantic spans, not
  rendered UI or pixel-acceptance evidence;
- a TAP log or command output is automated evidence, not a screenshot.

The validator checks diagnostic PNG dimensions and decoded pixels against the
retained spans. PNG dimensions must be positive, expected scanline bytes are
capped at 16 MiB, and decompression stops at the declared scanline size plus one
byte. Incomplete or trailing zlib streams are rejected. It returns no claimable
rendered-visual or interaction paths from these artifacts. Consequently, this
native test-renderer schema cannot promote a visible claim to `complete` or
`limited`.

## Declared host-capture evidence

Ready inventories may include `ui_acceptance.host_evidence`, a bounded list of
record pairs. Each pair names digest-bound JSON records:

```json
{
  "host_evidence": [{
    "rendered_visual": {"path": "evidence/tui-render.json", "sha256": "<64 lowercase hex>"},
    "interaction": {"path": "evidence/tui-interaction.json", "sha256": "<64 lowercase hex>"}
  }]
}
```

Both version-1 records declare `kind`, `tool_id`, `capture_method`, `run_id`,
UTC `captured_at`, decimal `monotonic_ns`, and a `window` with
`identity_sha256`, `process`, and bounded `bounds` (`x`, `y`, `width`,
`height`). A rendered-visual record has an `image`; an interaction record has a
`action` whose `tool_id` is one of `screen_terminal`, `subagent`,
`subagent_cancel`, `task_declare`, or `todowrite`, plus a `result` containing the
rendered-visual record digest and its own `image`. The declared action tool must
be the tool that produced the visible TUI change. Each image binds a
repository-relative PNG path, SHA-256, width, and height to the actual retained
bytes. Records in a pair share a run and window identity, and monotonic time
increases from render to interaction.

Accepted capture declarations are `tool_id: "rig-tools.vision_capture"` with
`capture_method: "wsl-interop.windows.screenshot"`, or `tool_id:
"powershell_raw"` with `capture_method: "bounded-script"`. The validator does
not accept `integrated_browser.screenshot`. It rejects duplicate JSON keys,
unknown fields, traversal, symlinks, stale digests, non-PNG files, oversized
records/images, contradictory dimensions, and timestamps later than validation
time. These fields are declared provenance, not proof of capture origin or
window identity; the validator binds those declarations to retained PNG bytes
and dimensions only.

### Optional exact-window binding and causal action receipt

A host pair may additionally declare, atomically on both records, an
exact-window rendered-visual binding and a digest-bound causal action receipt.
Omitting both keeps every existing pair and claim valid. The rendered-visual
record may add `exact_window`; the interaction record's `action` may add
`receipt`:

```json
{
  "exact_window": {
    "window_sha256": "<canonical digest of the fields below>",
    "pid": 4242,
    "hwnd": "0x0000000000012ab4",
    "title": "OpenCode operator console",
    "wm_class": "CASCADIA_HOSTING_WINDOW_CLASS",
    "bounds": {"x": 100, "y": 50, "width": 2560, "height": 1440}
  },
  "action": {
    "tool_id": "screen_terminal",
    "event": "escape",
    "receipt": {
      "version": 1,
      "action_tool_id": "screen_terminal",
      "target_window_sha256": "<the exact_window.window_sha256>",
      "target_selector": "operator-console:goal-settings",
      "action_monotonic_ns": "150",
      "receipt_sha256": "<canonical digest of the fields above>"
    }
  }
}
```

`window_sha256` is the sorted-JSON SHA-256 of `pid`, `hwnd`, `title`,
`wm_class`, and `bounds`; `receipt_sha256` is the sorted-JSON SHA-256 of
`version`, `action_tool_id`, `target_window_sha256`, `target_selector`, and
`action_monotonic_ns`. The validator rejects a missing or mismatched target
(the receipt target must equal the rendered-visual `window_sha256`), a receipt
whose tool differs from the declared `action.tool_id` or falls outside the five
allowlisted action IDs, a receipt not strictly ordered between the
rendered-visual and interaction `monotonic_ns`, an `exact_window.bounds` that
diverges from the declared host `window.bounds`, and any `window_sha256` or
`receipt_sha256` that does not match its own fields. Declaring only one of
`exact_window` and `receipt` fails closed. These fields remain declared
provenance: they are not proof of capture origin, window ownership, or that the
declared action caused the visible change, and the action allowlist is
unchanged.

A visible `complete` or `limited` claim must cite the parsed record paths from
one matching pair in `rendered_visual` and `interaction`. Without that pair, it
must remain `planned`. Pending UI inventory mode remains structural and does
not accept host evidence. The current ready manifest contains one foreground
managed-Screen stop pair; eight other visible claims remain planned.

When multiple sources are mapped, the ready inventory also requires an
integrated scenario covering at least two mapped sources. Its source-set digest
is stable, and its capture, phase outputs, and diagnostic image cannot be reused
from another mapping or scenario.

## Claim, path, and runtime rules

- Claim evidence kinds are `automated`, `rendered_visual`, and `interaction`.
  A visible `complete` or `limited` claim requires both visual and interaction
  evidence, and every referenced evidence file must pass the relevant schema.
- UI sources cannot be cited as their own evidence. Capture paths must be
  relative forward-slash paths to regular, non-symlink files beneath the
  repository root. Traversal, duplicate JSON keys, stale digests, unknown
  fields, and oversized inputs fail closed.
- The ready test-capture catalog permits checksum-bound Node/npm and renderer
  identities. External executables must be absolute POSIX regular files and
  checksum-bound; project-provisioned executables must be repository-relative.
  Ambient `PATH` is never used by the validator.
- Background-subagent policy and evidence are validated independently. A
  pending UI inventory does not imply that the manifest's other claims or
  subagent records are accepted without their own evidence.

## Current repository boundary

`acceptance-evidence.json` has 13 claims. Its UI inventory is `ready` after a
2026-09-28 v9 generator run against the combined Goal, managed-Screen and
cross-worktree Active Subagents source, including the corrected reactive Goal sidebar/refresh source:
15 mappings, 30 focused receipts, and 16 native test captures under
`evidence/ui-acceptance/2026-09-28/v9/`. The acceptance validator passes and
canonical repository QA passed on this v9 source. The earlier
2026-09-27 v4/v3 and 2026-09-26 artifacts remain historical. Foreground
`vision_capture` PNGs in `evidence/ui-acceptance/2026-09-27/v3/host/` show the
active WSL terminal's managed-Screen sidebar transition from one detached
session to zero after an applied `screen_terminal` stop; the digest-bound
render/interaction records validate. This supports only `sidebar-coexistence`
as `limited`. Eight other user-visible claims remain `planned` with empty
evidence. The validator binds declared provenance and image bytes, not capture
origin; native span PNGs alone cannot establish foreground host acceptance.
The optional exact-window/causal-action-receipt extension is representable but
unused by the canonical manifest, so it promotes no claim; a genuine retained
pair is still required.

The copied-consumer self-test uses a disposable repository outside the Open Rig
source tree. It exercises pending structural validation, valid execution and
native test-render artifacts, missing/wrong invocation receipts, source/test
hash mismatches, test-only evidence promotion attempts, null renders, missing
dispatch provenance, exact-window and causal-action-receipt bindings with
fabricated, mismatched, missing, unordered, and unallowlisted-target
rejections, stale or contradictory artifacts, path/symlink attacks,
and the validator's no-subprocess boundary. Run it with:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-acceptance-evidence-self-test.py
```
