# `check-repository-qa.py`

`check-repository-qa.py` is the canonical read-only repository evidence command
used by the rig-tools QA gate. In deterministic order it runs:

1. the project-local [`check-acceptance-evidence.py`](check-acceptance-evidence.md)
   manifest gate;
2. `npm run check` for each of the twelve v2 package workspaces;
3. `bash -n` and ShellCheck error-severity checks for every script shell file
   and `.githooks/pre-push`;
4. source compilation with Python's in-memory `compile()` for every Python
   file;
5. the skill-doc, progress-tracking, Git-safety, plugin-resource, and
   documentation coverage checks;
6. every repository `*-self-test.py` in this fixed order:
   `check-skill-docs-self-test.py`, `check-progress-tracking-self-test.py`,
   `check-git-safety-policy-self-test.py`,
   `check-plugin-resource-guards-self-test.py`,
   `check-doc-coverage-self-test.py`, `deploy-plugins-self-test.py`,
   `check-run-bounded-command-self-test.py`, `setup-opencode-self-test.py`,
    `setup-ponytail-plugin-self-test.py`, `opencode-launcher-self-test.py`,
    `check-acceptance-evidence-self-test.py`, and
    `check-repository-qa-self-test.py`;
7. v2 role-catalog validation; strict JSON and JSONC parsing with duplicate-key
   rejection; SVG XML parsing; local Markdown link validation; and
    `git show --check` for `HEAD` plus unstaged and staged `git diff --check`.

The self-test list is an explicit allowlist checked against deterministic,
repository-wide discovery. A missing listed test or a newly added but unlisted
`*-self-test.py` fails the gate. The repository QA self-test imports helper
functions and never invokes canonical QA recursively. The setup integration
uses the real parser installer with the already installed, lockfile-pinned
assets; all QA child processes set npm offline mode, so QA does not download
test-time dependencies.

Commands use fixed direct argv, never a shell. Each command has a 180-second
limit and the complete QA run has one 540-second monotonic deadline. A command
receives the smaller of its per-command limit and the remaining overall
budget, so the overall deadline can expire while that command is running. The
same deadline is checked throughout deterministic JSON, JSONC, SVG, Markdown,
Python-file, shell-file, workspace, and self-test discovery traversals. Timeout
and combined stdout-plus-stderr overflow terminate the command process group
and reap its leader; missing commands fail closed.

Child processes preserve the caller's environment, including `PATH` and
`HOME`, while forcing `C.UTF-8`, noninteractive CI/Git behavior,
`PYTHONDONTWRITEBYTECODE=1`, deterministic Python hashing, and npm offline
mode. Dynamic helper imports also suppress bytecode, so canonical QA does not
create ignored `__pycache__` artifacts.

`check-repository-qa-self-test.py` uses disposable temporary roots to prove
missing-command failure, command timeout and reaping, process-group descendant
cleanup, combined stdout/stderr output overflow, an overall deadline expiring
inside a running command and inside an in-process traversal, malformed and
duplicate JSON/JSONC rejection, malformed SVG rejection, broken-link
rejection, missing and unexpected self-test detection, deterministic discovery
order, the controlled child environment, and absence of bytecode output.
`check-acceptance-evidence-self-test.py` independently covers the positive
manifest path plus empty/vacuous claims, missing visual/interaction evidence,
agent/model allowlists, background-only records, concurrency bounds, regular
files, absolute/traversal paths, symlink ancestors, and the validator's
no-subprocess boundary.
