# Learn review — RLE candidate synthesis, namespaces, and promotion

The active Repository Learning Engine (RLE) observes bounded episode summaries
only after explicit resume. The modules documented below can synthesize
learning candidates and hold them for human review, but they are not registered
on the live task path. Nothing is
auto-active: synthesis output is `pending` (or `quarantined` on conflict),
acceptance is a local draft approval, and promotion to Basic Memory needs a
separate explicit exact-diff approval.

## Trust classes and provenance

| Class | Meaning | Promotion path |
|-------|---------|----------------|
| T0 | Untrusted model or observation extraction | Review required |
| T1 | Explicit user correction (immediate candidate, still pending) | Review required |
| T2 | Human-accepted local draft | May be promoted with approval |
| T3 | Reserved for a write-proven repo Basic Memory promotion | Disconnected |
| T4 | Explicitly cross-repo promoted | Separate exact-diff approval |

`mayAutoActivate()` returns `false` for every class. Source, trust, and actor
are a closed mapping: observations are `T0`/`agent`, synthesis is `T0`/`model`,
and explicit corrections are `T1`/`user` (later review may raise them to T2/T3).
A model cannot claim T4. There is no code path from synthesis to
active/promoted that skips the review queue.

## Candidate schema

Every candidate requires `provenance`, `validity`, and `conflict`:

- `provenance`: repo, actor (`user`/`agent`/`model`), ISO-8601 UTC `createdAt`,
  optional `episodeID`/`sessionID`.
- `validity`: `expiresAt` (after `createdAt`, at most 90 days later), `scope`.
- `conflict`: `none`/`suspect`/`confirmed`, with `reason` (required unless
  `none`) and optional `with` ids.
- `questions`: required whenever a conflict is reported; contradictions
  produce questions instead of silent overwrites.
- `candidate.repo` must equal `provenance.repo`, `validity.scope` must equal
  the candidate repo, and `id` must be the canonical digest-derived id for
  namespace/title/body. Optional `conflictResolution` records are validated
  and are only created by the review queue.
- Synthesis output states are `pending` or `quarantined` only; `approved`,
  `rejected`, and `promoted` are rejected by validation.

Validation is strict: unknown fields fail, over-long fields fail, and
namespace mismatches fail (`validateCandidateFor`).

## Synthesis bounds (`src/synthesize.ts`)

- Deterministic extraction first: normalize, truncate to 2,000 chars per
  summary, drop empties and exact duplicates, cap at 8 summaries.
- One `ctx.generate.text` attempt plus a single repair fallback, then fail
  closed for model output while preserving any safe explicit corrections.
  Model output over 32 KiB is truncated before
  parsing; payloads over 16 candidates are rejected.
- Input summaries are redacted before the model boundary and model candidates
  reject secret material. Explicit corrections are redacted and added before
  optional synthesis as immediate T1 candidates (still `pending`, never
  auto-active), including when summaries are empty or the provider fails.
- An optional resource gate fails closed unless the host is idle and supplies
  bounded CPU, RAM, provider-quota, and queue-depth measurements. Deferral
  does not discard explicit corrections.
- Dedupe drops incoming candidates that restate known content; conflict
  detection compares incoming candidates pairwise as well as persisted
  candidates, and quarantines explicit `contradicts` hits and same-title /
  different-body restatements, each with generated questions.

## Review queue (`src/review-queue.ts`)

States: `pending` → `approved` | `rejected`; `pending` ↔ `quarantined`.
The disconnected queue cannot mark a candidate promoted because no trusted
Basic Memory write receipt is integrated. It refuses to enqueue anything that
is not `pending` or `quarantined`.

- `/learn review [state]` — bounded list (32 entries).
- `/learn why <id>` — provenance, validity, conflict, trust, and body.
- `/learn preview <id>` — exact promotion draft for approval.
- `/learn accept <id>` — preview returns a 60-second token bound to session,
  agent, intent, and queue state; apply revalidates all four. Acceptance
  escalates T0/T1 to T2 and clears quarantine conflicts only with an explicit
  token-bound conflict-resolution record.
- `resolveConflict` records an explicit accept/reject decision through the
  same preview/apply token path. Expired candidates cannot be accepted,
  resolved, listed, audited, retrieved, or promoted; queue reads prune expired
  entries, and enqueue validates the complete runtime candidate shape and the
  90-day expiry.
- `/learn reject <id> [reason]` — same token pattern; terminal states are closed.
- `/learn audit` and `retrieve` are bounded read-only views.

## Namespaces and promotion (`src/memory-namespace.ts`)

- One shared Basic Memory project (`computer-assistant`); strict per-repo
  namespaces use a sanitized canonical remote host/owner/repo when an origin
  is supplied, plus a stable SHA-256 fingerprint. Without an origin, a
  sanitized checkout basename plus a fingerprint is used, so same-basename
  sibling checkouts cannot collide. Credentials are stripped and never
  persisted.
- Note paths are `learnings/<slug>/cand-<12 hex>.md`; traversal and
  cross-namespace paths are refused by `isPathInNamespace`.
- The plugin never calls Basic Memory directly. `buildPromotionDraft`
  produces the exact markdown plus a canonical complete `write_note` payload
  (`title`, `directory`, `content`, `project`, and `output_format`). The
  payload content must byte-match markdown, and the gate accepts only an
  approved T2/T3 candidate. `createPromotionGate` binds the
  complete payload in its state-bound approval token and rebuilds the returned
  call from the approved fields on apply; any markdown or payload-field change
  fails closed. The `write_note` title is the candidate ID, which makes Basic
  Memory's resulting filename match the validated note path. Promotion
  boundaries reject secret material. No API marks a candidate promoted until
  a future integration can prove the exact write succeeded.
- `/learn cross-repo` only parses an explicitly requested path stub. It never
  performs automatic cross-repo use or grants T4; a future path needs a
  separate exact-diff approval.

## Never-do list

- Never commit, push, weaken gates, or auto-promote untrusted content.
- Never store transcripts; summaries only.
- Never promote T0/T1 content without review acceptance.
- Never write outside the candidate's own `learnings/<slug>/` namespace.
- Never bypass the preview/apply token on accept, reject, or promote.

## Verification

From `platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/`:

```bash
npm run check
```
