# Commit and push safety gates

Repository-level agent workflows use two independent approval gates. These
are protocol gates, not local hooks that block the repository owner:

The project policy auto-approves ordinary agent actions, while later, more
specific rules keep `repo_commit` and `repo_push` on separate `ask` gates and
deny raw shell `git commit`/`git push` forms (including `git -C ...`). The CLI
must use `session.permissions: "prompt"`; `autoaccept` would bypass the intended
user-facing gate. The policy checker and its negative self-test validate this
combined ordering instead of checking the commit/push rules in isolation.
The same checker also verifies Basic Memory management-tool denies in both
project-wide permissions and Build's later agent rules for `opencode.json` and
the portable `v2-opencode.example.jsonc`: Build's `allow */*` would otherwise
override a top-level deny. Its self-test rejects missing or misordered denies.
The opted-in project keeps bounded `list_memory_projects` discovery allowed,
while the portable example denies it as the closed default and documents the
opt-in by removal;
see [Memory](../memory.md) for the separate cross-project opt-in.

## Commit gate

1. Inspect the worktree and preserve unrelated dirty work.
2. Stage only the intended files.
3. Show the user the exact reviewed scope with `git status --short` and
   `git diff --cached` (including the staged path list and relevant diff).
4. Ask for explicit approval to commit **that staged scope**.
5. If any staged path or staged content changes, show the new scope and ask
   again. Without approval, do not run `git commit`.

## Push gate

1. Treat push as a new approval decision, even immediately after an approved
   commit. Commit approval never implies push approval.
2. Verify the intended destination and ref, for example:

   ```bash
   git remote get-url origin
   git branch --show-current
   git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
   git ls-remote origin refs/heads/main
   ```

   Use the actual remote and ref when they differ; report the verified values
   and the exact commit range to the user.
3. Ask separately for explicit approval to push that commit range to that
   destination and ref. Without approval, do not run `git push`.
4. If the destination, ref, or commit range changes, repeat verification and
   request approval again.

The versioned pre-push hook remains a documentation/resource check. It does
not manufacture user approval, and missing hook checkers fail closed. The gated
push implementation uses `--no-verify` only after its dedicated approval and
lease checks, so an arbitrary local pre-push hook cannot add post-approval side
effects. `--no-verify` does not authorize a commit or push. CI validates that
this policy remains documented:

```bash
python3 platforms/linux/ubuntu/computer-use/scripts/check-git-safety-policy.py
python3 platforms/linux/ubuntu/computer-use/scripts/check-git-safety-policy-self-test.py
```

## Operator override commands

The project-local [`/commit` command](../../.opencode/commands/commit.md) is an
operator-only immediate commit override. Its command body contains no task for
the agent: the fixed shell block stages all changes accepted by `git add -A`,
including unrelated working-tree changes, and commits them using a UTC
timestamped message with `--no-verify`; it squashes nothing. The
[`/push` command](../../.opencode/commands/push.md) immediately runs
`git push --no-verify origin HEAD`, targeting the explicit `origin HEAD`
destination and ref. It does not stage or commit changes, and it squashes
nothing. Both bodies end with a single line stating that no agent action is
required.

OpenCode v2 evaluates each `!` shell block in the command-evaluation shell,
outside the agent tool permission flow by design. The shell block runs before
the prompt is submitted, so the Git action occurs even if the follow-up turn
fails. Invoking each command is the operator's explicit decision for that
operation; `--no-verify` skips Git hooks but is not itself authorization.
Commit and push remain separate operator decisions: `/commit` never pushes, and
`/push` never commits.

Agents must never suggest, invoke, or rely on these commands as a substitute for
the normal gated flow. After an operator invokes one, the agent should verify
and report the resulting commit SHA or push state using read-only inspection,
without performing or retrying the Git operation itself.

## Portable project configuration

Any repository loading `rig-tools` can copy this project-local configuration
shape. Commands are argv arrays, not shell strings; replace them with commands
that exist in that repository. Omitting either command fails closed.

```jsonc
{
  "plugins": [{
    "package": "/path/to/opencode-rig/platforms/linux/ubuntu/computer-use/plugins-v2/rig-tools",
    "options": {
      "qaCommand": ["npm", "test"],
      "documentationCommand": ["npm", "run", "docs:check"],
      "timeoutMs": 30000,
      "requiredPaths": ["HANDOFF.md", "ROADMAP.md"]
    }
  }]
}
```

`requiredPaths` defaults to `HANDOFF.md` and `ROADMAP.md`; maintainers must
explicitly replace it with equivalent paths when a repository uses a different
handoff/roadmap convention. The plugin rejects raw shell `git commit`/`git
push`, runs both configured gates against the canonical repository, and binds
evidence and separate commit/push approval tokens to that repository's state.
Repository-local `tokenTtlMs` is validated and governs every issued token. Public
evidence contains only bounded reviewed staged scope plus hashes/fingerprint;
raw remotes and unrelated unstaged contents remain internal. Commit mutation is
refused during merge, rebase, cherry-pick, revert, or bisect operations. Apply
builds the reviewed object with `commit-tree`, verifies symbolic `HEAD`, moves
only the reviewed branch with compare-and-swap, and restores that branch with a
second compare-and-swap if any post-update HEAD/index postcondition races.

For canonical repository QA, `.opencode/rig-gates.json` also declares a
checkout-local Node runtime and npm CLI by relative path and SHA-256. The
provisioner and QA runner verify the same pins; do not replace them with ambient
`PATH` entries or external absolute paths:

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

See [`check-repository-qa.md`](check-repository-qa.md) for the runtime contract
and [`setup-qa-runtime.md`](setup-qa-runtime.md) for verify/apply behavior.

## Live repository-gate status

`repo_qa_gate` and `repo_documentation_gate` send best-effort live status updates
through the tool progress surface. Each run reports the ordered phases
`checking`, `running`, `verifying`, and `complete`, with its gate kind and
preview/apply action; the configured command is included only when it is safe to
display. Progress metadata is status-only: it never contains command output,
staged diffs, tokens, extra repository paths, or secrets. A progress-delivery
failure does not change the gate result.

`apply` intentionally reruns the configured command. It first rechecks the
preview token's repository fingerprint, executes the command again, and then
rechecks the fingerprint before issuing fresh evidence. This prevents a stale
preview from being treated as a completed apply and proves the applied run did
not change the reviewed state.

## External-repository acceptance

In a disposable repository outside this checkout, configure both commands and
the plugin, stage a change including every required path, and run
`repo_qa_gate` and `repo_documentation_gate` with a session ID. Preview
`repo_commit`, change an unstaged or untracked file, and confirm apply rejects
the token; repeat the gates and confirm commit apply reports its hash. Preview
`repo_push` with an explicit `remote` and `refs/heads/<branch>`, confirm a
different remote/ref or session rejects apply, then use a separately approved
token. Verify raw shell commit/push is denied and no unrelated dirty files are
staged, reset, stashed, checked out, or cleaned.
