# Commit and push safety gates

Repository-level agent workflows use two independent approval gates. These
are protocol gates, not local hooks that block the repository owner:

The project policy auto-approves ordinary agent actions, while later, more
specific rules keep `repo_commit` and `repo_push` on separate `ask` gates and
deny raw shell `git commit`/`git push` forms (including `git -C ...`). The CLI
must use `session.permissions: "prompt"`; `autoaccept` would bypass the intended
user-facing gate. The policy checker and its negative self-test validate this
combined ordering instead of checking the commit/push rules in isolation.

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
