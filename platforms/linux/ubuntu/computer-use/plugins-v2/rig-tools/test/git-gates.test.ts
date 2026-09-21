import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { boundedExec, createGitGateManager, isDeniedShellGitMutation, normalizeRequiredPaths, redactRemoteUrl, validateGateCommand, validateRemoteName, type GateProgressUpdate } from "../src/git-gates.ts"

test("documentation paths default safely and accept explicit portable overrides", () => {
  assert.deepEqual(normalizeRequiredPaths(undefined), ["HANDOFF.md", "ROADMAP.md"])
  assert.deepEqual(normalizeRequiredPaths(["RELEASE.md", "CHANGELOG.md"]), ["CHANGELOG.md", "RELEASE.md"])
  assert.deepEqual(normalizeRequiredPaths(["notes/v1..v2.md", "./docs/check.md"]), ["docs/check.md", "notes/v1..v2.md"])
  assert.throws(() => normalizeRequiredPaths(["../outside.md"]), /repository-relative/)
  assert.throws(() => normalizeRequiredPaths(["docs\\check.md"]), /repository-relative/)
})

test("gate commands reject shell interpreters and shell injection forms", () => {
  assert.throws(() => validateGateCommand(["sh", "-c", "npm test"]), /directly/)
  assert.throws(() => validateGateCommand(["npm", "-c", "test"]), /directly/)
  assert.deepEqual(validateGateCommand(["npm", "test"]), { file: "npm", args: ["test"] })
})

test("shell bypass detection parses direct Git wrappers, quoting, and global options", () => {
  const positives = [
    "/usr/bin/git commit -m x",
    "git --git-dir /tmp/x commit -m x",
    "git --git-dir=/tmp/x commit -m x",
    "git --work-tree /tmp/x push origin main",
    "git --work-tree=/tmp/x push origin main",
    "git -C /tmp/repo push origin main",
    "git -C/tmp/repo push origin main",
    "git -c user.name=x commit -m x",
    "git -cuser.name=x push origin main",
    "git --namespace ns --super-prefix=/p --config-env=k=V --exec-path /x commit -m x",
    "git --paginate --no-pager --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs push origin main",
    "git --no-optional-locks commit -m x",
    "git --no-lazy-fetch push origin main",
    "git --future-global-option commit -m x",
    "command -p -- env --chdir /tmp --unset=SECRET git commit -m x",
    "command --future-option git push origin main",
    "command env -- git commit -m x",
    "env --chdir /tmp git push origin main",
    "env --future-option git commit -m x",
    "FOO=bar env -i -uSECRET -C/tmp -S'git push' --argv0=git --block-signal TERM --default-signal HUP --ignore-signal PIPE -- origin main",
    "'git' --no-pager commit -m x",
    "\"/usr/bin/git\" -C/tmp/repo push origin main",
    "g\\it --no-pager commit -m x",
    "echo ok; git push origin main",
    "git status; env -- git commit -m x",
    "git commit 'unterminated",
    "env -S'git push origin main'",
    "env --split-string='git commit -m x'",
    "command env -S 'git push origin main'",
    "env --split-string \"git\\ push origin main\"",
    "sh -c 'git commit -m x'",
    "bash -lc \"git push origin main\"",
    "exec git commit -m x",
    "exec -a fake -c git commit -m x",
    "builtin command git push origin main",
    "/usr/bin/env git commit -m x",
    "nohup git commit -m x",
    "nohup --future-option git push origin main",
    "nice -n 5 git push origin main",
    "nice -5 git push origin main",
    "timeout --preserve-status -s TERM --kill-after=2 5 git commit -m x",
    "timeout -k2 5 git commit -m x",
    "timeout -sTERM 5 git push origin main",
    "powershell -Command \"git push origin main\"",
    "cmd /c \"git commit -m x\"",
  ]
  for (const command of positives) assert.equal(isDeniedShellGitMutation(command), true, command)
  const negatives = [
    "echo 'git commit'",
    "printf git commit",
    "echo command git push",
    "python3 -c 'import subprocess; subprocess.run([\"git\", \"push\"])'",
    "mygit commit -m x",
    "git status -- commit",
    "git log push",
    "git show commit",
    "normal-command --git-dir /tmp/x",
    "echo git status; printf push",
    "env -S'printf hello'",
    "env --split-string='git status'",
    'env -S "printf \\"git push\\""',
    "sh -c 'echo git commit'",
    "bash -lc 'git status -- commit'",
    "timeout 5 echo git push",
    "nice printf git commit",
  ]
  for (const command of negatives) assert.equal(isDeniedShellGitMutation(command), false, command)
})

test("shell bypass detection remains bounded and fails closed for direct-looking input", () => {
  assert.equal(isDeniedShellGitMutation(`git commit ${"x ".repeat(10_000)}`), true)
  assert.equal(isDeniedShellGitMutation("git " + Array.from({ length: 300 }, () => "x").join(" ") + " push origin main"), true)
  assert.equal(isDeniedShellGitMutation(Array.from({ length: 70 }, () => "echo ok").join("; ") + "; git commit -m x"), true)
})

test("remote names are portable and cannot become Git options or ambiguous paths", () => {
  for (const invalid of ["-h", "--upload-pack", "/name", "name/", "..", "foo//bar", "foo@{bar}", "foo\0bar"]) {
    assert.throws(() => validateRemoteName(invalid), /portable name/)
  }
  assert.equal(validateRemoteName("origin"), "origin")
  assert.equal(validateRemoteName("team/release"), "team/release")
})

test("remote URL redaction protects URL secrets without changing scp-style destinations", () => {
  assert.equal(redactRemoteUrl("https://alice:secret@example.invalid/org/repo.git?token=query-secret#fragment-secret"), "https://[redacted]@example.invalid/org/repo.git")
  assert.equal(redactRemoteUrl("ssh://alice:secret@example.invalid/org/repo.git?token=query-secret#fragment-secret"), "ssh://[redacted]@example.invalid/org/repo.git")
  assert.equal(redactRemoteUrl("alice@example.invalid:org/repo.git"), "[redacted]@example.invalid:org/repo.git")
  assert.equal(redactRemoteUrl("alice%40name:p%40ss@[2001:db8::1]:org/repo.git?secret=1#frag"), "[redacted]@[2001:db8::1]:org/repo.git")
})

test("bounded execution times out without shell interpretation", async () => {
  await assert.rejects(
    boundedExec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], process.cwd(), 1000),
    /timed out/,
  )
})

test("bounded execution enforces one combined output cap and reaps descendants", async () => {
  await assert.rejects(
    boundedExec(process.execPath, ["-e", "process.stdout.write('x'.repeat(180000)); process.stderr.write('y'.repeat(180000))"], process.cwd(), 5000),
    /output exceeded/,
  )
  const marker = join(await mkdtemp(join(tmpdir(), "rig-tools-descendant-")), "child.pid")
  try {
    await assert.rejects(
      boundedExec(process.execPath, ["-e", `const fs=require('fs'); const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},10000)']); fs.writeFileSync(${JSON.stringify(marker)},String(c.pid)); process.stdout.write('x'.repeat(400000)); setTimeout(()=>{},10000)`], process.cwd(), 5000),
      /output exceeded/,
    )
    const pid = Number(await readFile(marker, "utf8"))
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally {
    await rm(marker.slice(0, marker.lastIndexOf("/")), { recursive: true, force: true })
  }
})

test("bounded execution accepts an explicit larger cap for bounded Git plumbing", async () => {
  const result = await boundedExec(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(300000))"],
    process.cwd(),
    5000,
    {},
    "utf8",
    512 * 1024,
  )
  assert.equal(result.stdout.length, 300000)
})

test("local token TTL is validated and governs every preview token", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-ttl-"))
  const command = [process.execPath, "-e", "process.stdout.write('gate-ok')"]
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    git(["init", "-q"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode")); await writeFile(join(root, "HANDOFF.md"), "h\n"); await writeFile(join(root, "ROADMAP.md"), "r\n")
    await writeFile(join(root, "file.txt"), "one\n"); git(["add", "."]); git(["commit", "-q", "-m", "base"])
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command, tokenTtlMs: 30_000 }))
    const manager = createGitGateManager({ qaCommand: command, documentationCommand: command })
    const preview = JSON.parse(await manager.runGate(root, "qa", "preview", undefined, "ttl"))
    assert.ok(preview.expiresInMs <= 30_000 && preview.expiresInMs > 29_000)
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command, tokenTtlMs: 29_999 }))
    await assert.rejects(manager.runGate(root, "qa", "preview", undefined, "ttl"), /tokenTtlMs/)
    await writeFile(join(root, ".opencode/rig-gates.json"), `{"qaCommand":${JSON.stringify(command)},"qaCommand":${JSON.stringify(command)},"documentationCommand":${JSON.stringify(command)}}`)
    await assert.rejects(manager.runGate(root, "qa", "preview", undefined, "ttl"), /duplicate/)
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command, unsupported: true }))
    await assert.rejects(manager.runGate(root, "qa", "preview", undefined, "ttl"), /unsupported/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("token records have a finite live capacity and prune only expired records", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-token-cap-"))
  const command = [process.execPath, "-e", "process.stdout.write('ok')"]
  const head = "a".repeat(40)
  const tree = "b".repeat(40)
  const runner = async (file: string, args: string[], cwd: string) => {
    if (file !== "git") return { stdout: "ok", stderr: "" }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${cwd}\n`, stderr: "" }
    if (args[0] === "rev-parse" && args[1] === "--verify") return { stdout: `${head}\n`, stderr: "" }
    if (args[0] === "symbolic-ref" && args[1] === "--short") return { stdout: "main\n", stderr: "" }
    if (args[0] === "symbolic-ref" && args[1] === "--quiet") return { stdout: "refs/heads/main\n", stderr: "" }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") throw new Error("no upstream")
    if (args[0] === "rev-parse" && args[1] === "--git-path") return { stdout: `.git/${args[2]}\n`, stderr: "" }
    if (args[0] === "write-tree") return { stdout: `${tree}\n`, stderr: "" }
    return { stdout: "", stderr: "" }
  }
  try {
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command }))
    const manager = createGitGateManager({}, runner)
    for (let index = 0; index < 256; index += 1) await manager.runGate(root, "qa", "preview", undefined, `cap-${index}`)
    await assert.rejects(manager.runGate(root, "qa", "preview", undefined, "cap-full"), /capacity is full/)
    const now = Date.now
    Date.now = () => now() + 600_000
    try { await manager.runGate(root, "qa", "preview", undefined, "cap-expired") } finally { Date.now = now }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("public evidence keeps binding hashes and reviewed scope without raw secrets or unrelated worktree content", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-evidence-"))
  const command = [process.execPath, "-e", "process.stdout.write('check-output')"]
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    git(["init", "-q"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode")); await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command, requiredPaths: ["tracked.txt"] })); await writeFile(join(root, "HANDOFF.md"), "h\n"); await writeFile(join(root, "ROADMAP.md"), "r\n"); await writeFile(join(root, "tracked.txt"), "one\n")
    git(["add", "."]); git(["commit", "-q", "-m", "base"]); git(["remote", "add", "origin", "https://alice:credential-secret@example.invalid/repo.git"])
    await writeFile(join(root, "tracked.txt"), "two\n"); await writeFile(join(root, "unrelated.txt"), "unstaged-secret-content\n"); git(["add", "tracked.txt"])
    const manager = createGitGateManager({ qaCommand: command, documentationCommand: command })
    const qa = JSON.parse(await manager.runGate(root, "qa", "preview", undefined, "evidence"))
    const docs = JSON.parse(await manager.runGate(root, "documentation", "preview", undefined, "evidence"))
    const qaEvidence = JSON.parse(await manager.runGate(root, "qa", "apply", qa.token, "evidence"))
    const docsEvidence = JSON.parse(await manager.runGate(root, "documentation", "apply", docs.token, "evidence"))
    const commit = JSON.parse(await manager.commit(root, "reviewed", qaEvidence.token, docsEvidence.token, "preview", undefined, false, "evidence"))
    const evidence = JSON.stringify({ qa: qaEvidence, docs: docsEvidence, commit })
    assert.equal(evidence.includes("credential-secret"), false)
    assert.equal(evidence.includes("unstaged-secret-content"), false)
    const parsed = JSON.parse(evidence)
    assert.equal(parsed.qa.evidence.outputSha256.length, 64)
    assert.equal(parsed.qa.evidence.state.head.length, 40)
    assert.deepEqual(parsed.qa.evidence.state.stagedPaths, ["tracked.txt"])
    assert.equal(parsed.qa.evidence.state.fingerprint.length, 64)
    assert.equal(parsed.qa.evidence.state.stagedSha256.length, 64)
    assert.equal(JSON.stringify(commit).includes("unstaged-secret-content"), false)
    assert.equal(commit.stagedScopeSha256.length, 64)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit preview refuses an active merge operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-merge-state-"))
   const command = [process.execPath, "-e", "process.stdout.write('')"]
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    git(["init", "-q"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode")); await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command })); await writeFile(join(root, "HANDOFF.md"), "h\n"); await writeFile(join(root, "ROADMAP.md"), "r\n"); await writeFile(join(root, "base.txt"), "base\n")
    git(["add", "."]); git(["commit", "-q", "-m", "base"]); git(["checkout", "-q", "-b", "feature"])
    await writeFile(join(root, "feature.txt"), "feature\n"); git(["add", "feature.txt"]); git(["commit", "-q", "-m", "feature"]); git(["checkout", "-q", "-"])
    await writeFile(join(root, "main.txt"), "main\n"); git(["add", "main.txt"]); git(["commit", "-q", "-m", "main"]); git(["merge", "--no-commit", "feature"])
    const manager = createGitGateManager({ qaCommand: command, documentationCommand: command })
    await assert.rejects(manager.commit(root, "blocked merge", "missing-qa", "missing-docs", "preview", undefined, false, "merge"), /Git operation is active|MERGE_HEAD/)
    git(["merge", "--abort"]); git(["checkout", "-q", "--detach", "HEAD"])
    await assert.rejects(manager.commit(root, "blocked detached", "missing-qa", "missing-docs", "preview", undefined, false, "detached"), /detached HEAD/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("commit apply refuses index races and preserves CAS semantics for HEAD races", async () => {
  const roots: string[] = []
  const command = [process.execPath, "-e", "process.stdout.write('ok')"]
  const setup = async (label: string) => {
    const root = await mkdtemp(join(tmpdir(), `rig-tools-${label}-`)); roots.push(root)
    const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: root, encoding: "utf8", input })
    git(["init", "-q"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode")); await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command, requiredPaths: ["tracked.txt"] }))
    await writeFile(join(root, "HANDOFF.md"), "h\n"); await writeFile(join(root, "ROADMAP.md"), "r\n"); await writeFile(join(root, "tracked.txt"), "one\n")
    git(["add", "."]); git(["commit", "-q", "-m", "base"]); await writeFile(join(root, "tracked.txt"), "two\n"); git(["add", "tracked.txt"])
    return { root, git }
  }
  try {
    const indexRepo = await setup("commit-index-race")
    let indexRace = false
    const indexManager = createGitGateManager({}, async (file, args, cwd) => {
      if (file === "git" && args[0] === "write-tree" && indexRace) {
        indexRace = false; await writeFile(join(indexRepo.root, "raced.txt"), "raced\n"); indexRepo.git(["add", "raced.txt"])
      }
      return boundedExec(file, args, cwd, 30_000)
    })
    const iq = JSON.parse(await indexManager.runGate(indexRepo.root, "qa", "preview", undefined, "race"))
    const id = JSON.parse(await indexManager.runGate(indexRepo.root, "documentation", "preview", undefined, "race"))
    const iqe = JSON.parse(await indexManager.runGate(indexRepo.root, "qa", "apply", iq.token, "race"))
    const ide = JSON.parse(await indexManager.runGate(indexRepo.root, "documentation", "apply", id.token, "race"))
    const ip = JSON.parse(await indexManager.commit(indexRepo.root, "index race", iqe.token, ide.token, "preview", undefined, false, "race"))
    const indexHead = indexRepo.git(["rev-parse", "HEAD"])
    indexRace = true
    await assert.rejects(indexManager.commit(indexRepo.root, "index race", iqe.token, ide.token, "apply", ip.token, true, "race"), /stale|changed|scope/)
    assert.equal(indexRepo.git(["rev-parse", "HEAD"]), indexHead)

    const headRepo = await setup("commit-head-race")
    let headRace = true
    const headManager = createGitGateManager({}, async (file, args, cwd) => {
      if (file === "git" && args[0] === "update-ref" && headRace) {
        headRace = false
        headRepo.git(["commit", "--no-verify", "--allow-empty", "-m", "rival"])
      }
      return boundedExec(file, args, cwd, 30_000)
    })
    const hq = JSON.parse(await headManager.runGate(headRepo.root, "qa", "preview", undefined, "race"))
    const hd = JSON.parse(await headManager.runGate(headRepo.root, "documentation", "preview", undefined, "race"))
    const hqe = JSON.parse(await headManager.runGate(headRepo.root, "qa", "apply", hq.token, "race"))
    const hde = JSON.parse(await headManager.runGate(headRepo.root, "documentation", "apply", hd.token, "race"))
    const hp = JSON.parse(await headManager.commit(headRepo.root, "head race", hqe.token, hde.token, "preview", undefined, false, "race"))
    await assert.rejects(headManager.commit(headRepo.root, "head race", hqe.token, hde.token, "apply", hp.token, true, "race"), /CAS|compare|scope|changed/)
    assert.equal(headRepo.git(["log", "-1", "--format=%s"]).trim(), "rival")

    const symbolicRepo = await setup("commit-symbolic-head-race")
    symbolicRepo.git(["branch", "other"])
    const expectedBranch = symbolicRepo.git(["symbolic-ref", "HEAD"]).trim()
    const expectedBranchHead = symbolicRepo.git(["rev-parse", expectedBranch]).trim()
    let symbolicRace = true
    const symbolicManager = createGitGateManager({}, async (file, args, cwd) => {
      if (file === "git" && args[0] === "update-ref" && args[1] === expectedBranch && symbolicRace) {
        symbolicRace = false
        symbolicRepo.git(["symbolic-ref", "HEAD", "refs/heads/other"])
      }
      return boundedExec(file, args, cwd, 30_000)
    })
    const sq = JSON.parse(await symbolicManager.runGate(symbolicRepo.root, "qa", "preview", undefined, "race"))
    const sd = JSON.parse(await symbolicManager.runGate(symbolicRepo.root, "documentation", "preview", undefined, "race"))
    const sqe = JSON.parse(await symbolicManager.runGate(symbolicRepo.root, "qa", "apply", sq.token, "race"))
    const sde = JSON.parse(await symbolicManager.runGate(symbolicRepo.root, "documentation", "apply", sd.token, "race"))
    const sp = JSON.parse(await symbolicManager.commit(symbolicRepo.root, "symbolic HEAD race", sqe.token, sde.token, "preview", undefined, false, "race"))
    await assert.rejects(symbolicManager.commit(symbolicRepo.root, "symbolic HEAD race", sqe.token, sde.token, "apply", sp.token, true, "race"), /HEAD|branch ref|CAS|compare/)
    assert.equal(symbolicRepo.git(["rev-parse", expectedBranch]).trim(), expectedBranchHead)
    assert.equal(symbolicRepo.git(["symbolic-ref", "HEAD"]).trim(), "refs/heads/other")
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  }
})

test("external disposable repository gets state-bound QA/docs and commit previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-external-"))
  const command = [process.execPath, "-e", "process.stdout.write('gate-ok')"]
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
    git(["init", "-q"])
    git(["config", "user.email", "test@example.invalid"])
    git(["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command, requiredPaths: ["HANDOFF.md", "ROADMAP.md"] }))
    await writeFile(join(root, "HANDOFF.md"), "handoff\n")
    await writeFile(join(root, "ROADMAP.md"), "roadmap\n")
    await writeFile(join(root, "tracked.txt"), "one\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "initial"])
    await writeFile(join(root, "tracked.txt"), "two\n")
    await writeFile(join(root, "HANDOFF.md"), "updated\n")
    await writeFile(join(root, "ROADMAP.md"), "updated\n")
    git(["add", "HANDOFF.md", "ROADMAP.md", "tracked.txt"])
    await writeFile(join(root, "untracked.txt"), "untracked-one\n")
    const manager = createGitGateManager({ qaCommand: command, documentationCommand: command })
    const qa = JSON.parse(await manager.runGate(root, "qa", "preview", undefined, "external-session"))
    const docs = JSON.parse(await manager.runGate(root, "documentation", "preview", undefined, "external-session"))
    assert.equal(qa.phase, "preview")
    assert.equal(docs.phase, "preview")
    await writeFile(join(root, "untracked.txt"), "untracked-two\n")
    await assert.rejects(manager.runGate(root, "qa", "apply", qa.token, "external-session"), /changed|state/)
    await writeFile(join(root, "untracked.txt"), "untracked-one\n")
    const freshQa = JSON.parse(await manager.runGate(root, "qa", "preview", undefined, "external-session"))
    const freshDocs = JSON.parse(await manager.runGate(root, "documentation", "preview", undefined, "external-session"))
    await assert.rejects(manager.commit(root, "preview misuse", qa.token, docs.token, "preview", undefined, false, "external-session"), /phase|already used|bound/)
    await assert.rejects(manager.runGate(root, "documentation", "apply", freshQa.token, "external-session"), /phase|token is not/)
    await assert.rejects(manager.runGate(root, "qa", "apply", qa.token, "other-session", "other-agent"), /bound/)
    const qaEvidence = JSON.parse(await manager.runGate(root, "qa", "apply", freshQa.token, "external-session"))
    const docsEvidence = JSON.parse(await manager.runGate(root, "documentation", "apply", freshDocs.token, "external-session"))
    assert.equal(qaEvidence.phase, "evidence")
    assert.equal(docsEvidence.phase, "evidence")
    assert.notEqual(qaEvidence.token, qa.token)
    await assert.rejects(manager.commit(root, "replay", freshQa.token, freshDocs.token, "preview", undefined, false, "external-session"), /already used|bound|missing or expired/)
    const preview = JSON.parse(await manager.commit(root, "external commit", qaEvidence.token, docsEvidence.token, "preview", undefined, false, "external-session"))
    assert.equal(preview.operation, "commit")
    await assert.rejects(manager.commit(root, "external commit", qaEvidence.token, docsEvidence.token, "preview", undefined, false, "external-session"), /already used|bound|missing or expired/)
    await assert.rejects(manager.commit(root, "external commit", qaEvidence.token, docsEvidence.token, "apply", preview.token, false, "external-session"), /approval/)
    const postCommitMarker = join(root, "post-commit-ran")
    const postCommitHook = join(root, ".git", "hooks", "post-commit")
    await writeFile(postCommitHook, `#!/bin/sh\nprintf hook > ${JSON.stringify(postCommitMarker)}\n`)
    await chmod(postCommitHook, 0o755)
    const applied = JSON.parse(await manager.commit(root, "external commit", qaEvidence.token, docsEvidence.token, "apply", preview.token, true, "external-session"))
    assert.equal(applied.phase, "applied")
    assert.equal(git(["diff", "--cached", "--quiet"]), "")
    assert.equal(git(["write-tree"]), git(["rev-parse", "HEAD^{tree}"]))
    assert.equal(git(["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").length, 2)
    assert.equal(git(["log", "-1", "--format=%s"]).trim(), "external commit")
    await assert.rejects(readFile(postCommitMarker), /ENOENT/)
    await assert.rejects(manager.commit(root, "external commit", qaEvidence.token, docsEvidence.token, "apply", preview.token, true, "external-session"), /already used|bound/)
    const other = await mkdtemp(join(tmpdir(), "rig-tools-other-"))
    try {
      await assert.rejects(manager.commit(other, "wrong repo", qa.token, docs.token, "preview", undefined, false, "external-session"), /repository|Git worktree|staged|state/i)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bare remote matrix proves exact new/existing ranges and isolated push approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-push-"))
  const bare = await mkdtemp(join(tmpdir(), "rig-tools-bare-"))
  const alternateBare = await mkdtemp(join(tmpdir(), "rig-tools-alt-bare-"))
  const clone = await mkdtemp(join(tmpdir(), "rig-tools-clone-"))
  const command = [process.execPath, "-e", "process.stdout.write('gate-ok')"]
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  try {
    git(root, ["init", "-q"])
    git(root, ["config", "user.email", "test@example.invalid"])
    git(root, ["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command }))
    await writeFile(join(root, "HANDOFF.md"), "h\n")
    await writeFile(join(root, "ROADMAP.md"), "r\n")
    await writeFile(join(root, "file.txt"), "base\n")
    git(root, ["add", "."]); git(root, ["commit", "-q", "-m", "base"])
    git(bare, ["init", "--bare", "-q"]); git(alternateBare, ["init", "--bare", "-q"]); git(root, ["remote", "add", "origin", bare])
    git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"])
    git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"])
    const hostileHook = join(root, ".git", "hooks", "pre-push")
    const hookMarker = join(root, "hook-ran")
    await writeFile(hostileHook, `#!/bin/sh\nprintf hostile > ${JSON.stringify(hookMarker)}\nexit 1\n`)
    await chmod(hostileHook, 0o755)
    const manager = createGitGateManager({ qaCommand: command, documentationCommand: command })
    for (const invalidRef of ["refs/heads/bad.lock", "refs/heads/bad@{name}", "refs/heads//double", "refs/heads/dir/./name"]) {
      await assert.rejects(manager.push(root, "origin", invalidRef, "preview", undefined, false, "s1", "a1"), /explicit refs\/heads|valid Git refs\/heads/)
    }
    await assert.rejects(manager.push(root, "origin", "refs/heads/main", "preview", undefined, false, "s1", "a1"), /up to date|no-op/)

    await writeFile(join(root, "file.txt"), "local-one\n"); git(root, ["add", "file.txt"]); git(root, ["commit", "-q", "-m", "local-one"])
    const first = JSON.parse(await manager.push(root, "origin", "refs/heads/main", "preview", undefined, false, "s1", "a1"))
    assert.equal(first.outgoing.length, 1)
    const firstApplied = JSON.parse(await manager.push(root, "origin", "refs/heads/main", "apply", first.token, true, "s1", "a1"))
    assert.equal(firstApplied.result, "pushed")
    assert.equal(firstApplied.verifiedSha, first.head)
    assert.equal(firstApplied.url, bare)
    await assert.rejects(import("node:fs/promises").then(({ access }) => access(hookMarker)), /ENOENT/)
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), first.head)

    await writeFile(join(root, "file.txt"), "local-two\n"); git(root, ["add", "file.txt"]); git(root, ["commit", "-q", "-m", "local-two"])
    await assert.rejects(manager.push(root, "origin", "refs/heads/main", "apply", first.token, true, "s1", "a1"), /already used|bound/)
    const changedRemote = JSON.parse(await manager.push(root, "origin", "refs/heads/main", "preview", undefined, false, "s1", "a1"))
    git(clone, ["clone", "-q", bare, "."]); git(clone, ["config", "user.email", "other@example.invalid"]); git(clone, ["config", "user.name", "Other"])
    await writeFile(join(clone, "other.txt"), "remote-change\n"); git(clone, ["add", "other.txt"]); git(clone, ["commit", "-q", "-m", "remote-change"]); git(clone, ["push", "-q", "origin", "HEAD:refs/heads/main"])
    const remoteBefore = git(bare, ["rev-parse", "refs/heads/main"])
    await assert.rejects(manager.push(root, "origin", "refs/heads/main", "apply", changedRemote.token, true, "s1", "a1"), /stale|destination|range|non-fast-forward/)
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), remoteBefore)
    await assert.rejects(manager.push(root, "origin", "refs/heads/main", "preview", undefined, false, "s1", "a1"), /non-fast-forward/)

    git(root, ["remote", "set-url", "origin", alternateBare])
    await assert.rejects(manager.push(root, "origin", "refs/heads/main", "apply", changedRemote.token, true, "s1", "a1"), /destination|range|stale/)
    git(root, ["remote", "set-url", "origin", bare])
    git(root, ["fetch", "-q", "origin"])
    git(root, ["config", "remote.origin.pushurl", alternateBare])
    const pushUrlPreview = JSON.parse(await manager.push(root, "origin", "refs/heads/pushurl-target", "preview", undefined, false, "s1", "a1"))
    assert.equal(pushUrlPreview.url, alternateBare)
    await manager.push(root, "origin", "refs/heads/pushurl-target", "apply", pushUrlPreview.token, true, "s1", "a1")
    assert.equal(git(alternateBare, ["rev-parse", "refs/heads/pushurl-target"]), pushUrlPreview.head)
    assert.throws(() => git(bare, ["show-ref", "refs/heads/pushurl-target"]), /Command failed/)
    git(root, ["config", "--add", "remote.origin.pushurl", bare])
    await assert.rejects(manager.push(root, "origin", "refs/heads/ambiguous-pushurl", "preview", undefined, false, "s1", "a1"), /exactly one push destination/)
    git(root, ["config", "--unset-all", "remote.origin.pushurl"])
    const isolated = JSON.parse(await manager.push(root, "origin", "refs/heads/new", "preview", undefined, false, "s1", "a1"))
    assert.deepEqual(isolated.outgoing, [git(root, ["rev-parse", "HEAD"])])
    let raced = false
    const raceRunner = async (file: string, args: string[], cwd: string) => {
      if (file === "git" && args[0] === "push" && !raced) {
        raced = true
        git(bare, ["update-ref", "refs/heads/raced", git(bare, ["rev-parse", "refs/heads/main"])])
      }
      return boundedExec(file, args, cwd, 30_000)
    }
    const raceManager = createGitGateManager({}, raceRunner)
    const racePreview = JSON.parse(await raceManager.push(root, "origin", "refs/heads/raced", "preview", undefined, false, "s1", "a1"))
    await assert.rejects(raceManager.push(root, "origin", "refs/heads/raced", "apply", racePreview.token, true, "s1", "a1"), /refused|lease|changed/)
    assert.equal(git(bare, ["rev-parse", "refs/heads/raced"]), git(bare, ["rev-parse", "refs/heads/main"]))
    let localMoved = false
    const localRaceRunner = async (file: string, args: string[], cwd: string) => {
      if (file === "git" && args[0] === "push" && !localMoved) {
        localMoved = true
        await writeFile(join(root, "local-race.txt"), "local race\n")
        git(root, ["add", "local-race.txt"]); git(root, ["commit", "-q", "-m", "local race"])
      }
      return boundedExec(file, args, cwd, 30_000)
    }
    const localRaceManager = createGitGateManager({}, localRaceRunner)
    const localRacePreview = JSON.parse(await localRaceManager.push(root, "origin", "refs/heads/local-race", "preview", undefined, false, "s1", "a1"))
    const localRaceApplied = JSON.parse(await localRaceManager.push(root, "origin", "refs/heads/local-race", "apply", localRacePreview.token, true, "s1", "a1"))
    assert.equal(localRaceApplied.verifiedSha, localRacePreview.head)
    assert.equal(git(bare, ["rev-parse", "refs/heads/local-race"]), localRacePreview.head)
    assert.notEqual(git(root, ["rev-parse", "HEAD"]), localRacePreview.head)
    await assert.rejects(manager.push(root, "origin", "refs/heads/new", "apply", isolated.token, true, "other-session", "a1"), /bound/)
    await assert.rejects(manager.push(root, "origin", "refs/heads/new", "apply", isolated.token, true, "s1", "other-agent"), /bound/)
    await assert.rejects(manager.push(root, "origin", "refs/heads/other", "apply", isolated.token, true, "s1", "a1"), /destination|range|stale/)
    assert.throws(() => git(bare, ["show-ref", "refs/heads/new"]), /Command failed/)
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(bare, { recursive: true, force: true }), rm(alternateBare, { recursive: true, force: true }), rm(clone, { recursive: true, force: true })])
  }
})

test("push refuses ambiguous advertised destination matches without mutating a bare remote", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-ambiguous-"))
  const bare = await mkdtemp(join(tmpdir(), "rig-tools-ambiguous-bare-"))
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
  try {
    git(root, ["init", "-q"])
    git(root, ["config", "user.email", "test@example.invalid"])
    git(root, ["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: [process.execPath, "-e", "process.stdout.write('')"], documentationCommand: [process.execPath, "-e", "process.stdout.write('')"] }))
    await writeFile(join(root, "HANDOFF.md"), "h\n")
    await writeFile(join(root, "ROADMAP.md"), "r\n")
    await writeFile(join(root, "file.txt"), "base\n")
    git(root, ["add", "."]); git(root, ["commit", "-q", "-m", "base"])
    git(bare, ["init", "--bare", "-q"]); git(root, ["remote", "add", "origin", bare])
    git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"])
    await writeFile(join(root, "file.txt"), "next\n"); git(root, ["add", "file.txt"]); git(root, ["commit", "-q", "-m", "next"])
    const advertisedSha = git(bare, ["rev-parse", "refs/heads/main"])
    const runner = async (file: string, args: string[], cwd: string) => {
      if (file === "git" && args[0] === "ls-remote") {
        return { stdout: `${advertisedSha}\trefs/heads/main\n${advertisedSha}\trefs/heads/main\n`, stderr: "" }
      }
      return boundedExec(file, args, cwd, 30_000)
    }
    const manager = createGitGateManager({}, runner)
    const before = git(bare, ["rev-parse", "refs/heads/main"])
    await assert.rejects(manager.push(root, "origin", "refs/heads/main", "preview", undefined, false, "s", "a"), /multiple advertised objects/)
    assert.equal(git(bare, ["rev-parse", "refs/heads/main"]), before)
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(bare, { recursive: true, force: true })])
  }
})

test("gate progress reports ordered status-only phases and apply reruns the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-tools-progress-"))
  const command = ["gate-program", "check"]
  let executions = 0
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
  try {
    git(["init", "-q"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Gate Test"])
    await mkdir(join(root, ".opencode"))
    await writeFile(join(root, ".opencode/rig-gates.json"), JSON.stringify({ qaCommand: command, documentationCommand: command }))
    await writeFile(join(root, "HANDOFF.md"), "handoff\n"); await writeFile(join(root, "ROADMAP.md"), "roadmap\n"); await writeFile(join(root, "tracked.txt"), "one\n")
    git(["add", "."]); git(["commit", "-q", "-m", "base"])
    await writeFile(join(root, "tracked.txt"), "two\n"); git(["add", "tracked.txt"])
    const manager = createGitGateManager({}, async (file, args, cwd) => {
      if (file === command[0]) {
        executions += 1
        return { stdout: "raw-command-output", stderr: "stderr-secret" }
      }
      return boundedExec(file, args, cwd, 30_000)
    })
    const updates: GateProgressUpdate[] = []
    const report = async (update: GateProgressUpdate) => { updates.push(update) }
    const preview = JSON.parse(await manager.runGate(root, "qa", "preview", undefined, "progress-session", "progress-agent", report))
    assert.deepEqual(updates, [
      { phase: "checking", kind: "qa", action: "preview" },
      { phase: "running", kind: "qa", action: "preview", command: { file: command[0], args: [command[1]] } },
      { phase: "verifying", kind: "qa", action: "preview", command: { file: command[0], args: [command[1]] } },
      { phase: "complete", kind: "qa", action: "preview", command: { file: command[0], args: [command[1]] } },
    ])
    assert.equal(JSON.stringify(updates).includes("raw-command-output"), false)
    assert.equal(JSON.stringify(updates).includes("stderr-secret"), false)

    updates.length = 0
    const evidence = JSON.parse(await manager.runGate(root, "qa", "apply", preview.token, "progress-session", "progress-agent", report))
    assert.deepEqual(updates.map((update) => update.phase), ["checking", "running", "verifying", "complete"])
    assert.equal(evidence.refreshed, true)
    assert.equal(executions, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
