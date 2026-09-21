import assert from "node:assert/strict"
import test from "node:test"

import {
  fetchCurrentBranchPullRequest,
  parseGithubRemote,
  readGithubContext,
  summarizeChecks,
  type RunGit,
} from "../src/github.ts"

test("parses GitHub HTTPS and SSH remotes but rejects other hosts", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/jtmb/opencode-rig.git"), {
    owner: "jtmb",
    repo: "opencode-rig",
  })
  assert.deepEqual(parseGithubRemote("git@github.com:jtmb/opencode-rig.git"), {
    owner: "jtmb",
    repo: "opencode-rig",
  })
  assert.equal(parseGithubRemote("https://gitlab.com/jtmb/opencode-rig.git"), undefined)
})

test("reads the current branch and configured remote through injected git", async () => {
  const git: RunGit = async (args) => {
    if (args[0] === "branch") return "feature/source-control"
    return "git@github.com:jtmb/opencode-rig.git"
  }
  assert.deepEqual(await readGithubContext("/tmp/project", "origin", git), {
    branch: "feature/source-control",
    remote: { owner: "jtmb", repo: "opencode-rig" },
  })
})

test("finds the current-branch pull request and reads its check status", async () => {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const pullRequest = await fetchCurrentBranchPullRequest(
    { owner: "jtmb", repo: "opencode-rig" },
    "feature/source-control",
    async (name, arguments_) => {
      calls.push({ name, arguments: arguments_ })
      if (name === "list_pull_requests") {
        return { structuredContent: { pullRequests: [{ number: 57, state: "OPEN", title: "Source control" }] } }
      }
      return { structuredContent: { state: "SUCCESS" } }
    },
  )

  assert.deepEqual(pullRequest, {
    number: 57,
    state: "open",
    checks: "passing",
    title: "Source control",
    url: undefined,
  })
  assert.deepEqual(calls[0], {
    name: "list_pull_requests",
    arguments: {
      owner: "jtmb",
      repo: "opencode-rig",
      state: "open",
      head: "jtmb:feature/source-control",
      fields: ["number", "state", "title", "html_url"],
    },
  })
  assert.equal(calls[1]?.name, "pull_request_read")
})

test("summarizes failing, pending, and unknown checks conservatively", () => {
  assert.equal(summarizeChecks({ structuredContent: { check_runs: [{ conclusion: "failure" }] } }), "failing")
  assert.equal(summarizeChecks({ structuredContent: { statuses: [{ state: "pending" }] } }), "pending")
  assert.equal(summarizeChecks({ structuredContent: { message: "no checks" } }), "unknown")
})
