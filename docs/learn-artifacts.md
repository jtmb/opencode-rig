# Learn artifacts (repo-learning compiler boundary)

This package contains bounded compiler, shadow, review-panel, and optimization
modules. The package is registered, but these mutation-capable modules are not
wired into the active server or CLI path. Nothing here
commits, pushes, changes permissions, installs dependencies, calls Basic
Memory, performs active retrieval, or writes a promoted artifact.

## Implemented safeguards

- `src/artifacts.ts` routes to the smallest artifact kind, with question-first
  behavior. The compiler recognizes `fact`, `gotcha`, `convention`,
  `preference`, `skill`, `test`, `docs`, `tool`, `automation`, `optimization`,
  `retirement`, and `question`. Recognition is compiler support; it does not
  mean every kind has a live promotion destination.
- Artifact titles, bodies, and source-session text pass through the existing
  `redactText` utility at compilation. Manually constructed artifacts and both
  sides of a promotion preview are rejected if sensitive text remains.
- Artifact previews use a server-held gate with cryptographically random,
  short-lived (60-second), single-use tokens. The authoritative record binds
  session, agent, canonical promote intent, canonical path, base-content
  SHA-256, proposed-content SHA-256, artifact hash, and symlink state. Apply
  additionally requires `approval: true` and an `approved` artifact status.
- Preview diffs are bounded unified diffs from supplied `baseContent` to the
  proposed artifact content. Deletions, insertions, and unchanged context are
  represented; additions-only output is not used.
- `src/shadow.ts` copies and freezes task/candidate inputs and has no active
  task handle or write path. Every result reports `isolated: true` and
  `influencedActive: false`; worktree validation remains lexical-only.
- `src/optimize.ts` is a disconnected simulator. Its caller-issued approval
  records are server-held, random, expiring, single-use, and bound to the
  canonical digest of the full rule: scope, limits, fallback, rollback, and
  action. The caller label is not proof of human identity, and an `applied`
  result reports only a bounded count: no optimization effect backend exists.
  Replay and mutation are refused.
- `src/tui-panel.tsx` accepts only bounded artifact/shadow data. With no
  mutation backend registered it is explicitly read-only and does not
  advertise dead approve/reject keys. The passive footer notice is capped.

## Active package boundary

`repo-learning/package.json`, `tsconfig.json`, `server.ts`, and `tui.tsx` are
workspace and role-catalog entries. The server wires only bounded
observation state, storage, and the guarded `/learn` status/audit/pause/resume
command. It does not claim synthesis, Basic Memory promotion, active
retrieval, optimization effects, or all artifact kinds as operational. The TUI
entrypoint re-exports the bounded review panel.

## Verification

From the repository root:

```bash
bash platforms/linux/ubuntu/computer-use/scripts/run-bounded-command.sh -- \
  node --experimental-strip-types --test \
  platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning/test/artifacts.test.ts
npm --prefix platforms/linux/ubuntu/computer-use/plugins-v2/repo-learning run check
```

The package typecheck is strict and includes TSX through `tsconfig.json`; the
package check also reruns the focused artifact/shadow/optimization test set.

## Remaining runtime integration

Future work requires separate approval: connect synthesis, namespaced
promotion, active retrieval, or mutation backends only after their external
effects can be live-tested without weakening the existing approval gates.
Artifact-kind recognition remains compiler support, not an operational claim.
