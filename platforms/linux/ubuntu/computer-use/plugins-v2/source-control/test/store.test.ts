import assert from "node:assert/strict"
import test from "node:test"

import { createSourceControlStore } from "../src/store.ts"

test("keeps local changes and GitHub data in one refreshable state", async () => {
  const status = async () => ({
    data: [
      { file: "b.ts", additions: 2, deletions: 1, status: "modified" },
      { file: "a.ts", additions: 4, deletions: 0, status: "added" },
    ],
  })
  const store = createSourceControlStore({
    status,
    github: true,
    remoteName: "origin",
    runGit: async (args) => (args[0] === "branch" ? "feature/source-control" : "git@github.com:jtmb/opencode-rig.git"),
    githubToolCaller: async (name) =>
      name === "list_pull_requests"
        ? { structuredContent: { pullRequests: [{ number: 57, state: "open" }] } }
        : { structuredContent: { state: "SUCCESS" } },
  })

  await store.refreshLocal("/tmp/project", "feature/source-control")
  await store.refreshGithub("/tmp/project", "feature/source-control")
  assert.equal(store.getState().status, "ready")
  assert.deepEqual(store.getState().changes.map((change) => change.file), ["a.ts", "b.ts"])
  assert.equal(store.getState().pullRequest?.number, 57)

  store.dispose()
})

test("keeps the last good local data when a later refresh fails", async () => {
  let fail = false
  const store = createSourceControlStore({
    status: async () => {
      if (fail) return { error: "temporary VCS failure" }
      return { data: [{ file: "a.ts", additions: 1, deletions: 0, status: "modified" }] }
    },
    github: false,
    remoteName: "origin",
  })

  await store.refreshLocal("/tmp/project")
  fail = true
  await store.refreshLocal("/tmp/project")
  assert.equal(store.getState().changes.length, 1)
  assert.equal(store.getState().error, "temporary VCS failure")
  store.dispose()
})

test("clears stale context data when the session directory changes", async () => {
  const store = createSourceControlStore({
    status: async ({ directory }) => ({
      data: directory === "/tmp/first" ? [{ file: "a.ts", additions: 1, deletions: 0, status: "modified" }] : [],
    }),
    github: true,
    remoteName: "origin",
    runGit: async () => "git@github.com:jtmb/opencode-rig.git",
    githubToolCaller: async (name) =>
      name === "list_pull_requests"
        ? { structuredContent: { pullRequests: [{ number: 57, state: "open" }] } }
        : { structuredContent: { state: "SUCCESS" } },
  })

  await store.refreshLocal("/tmp/first", "first")
  await store.refreshGithub("/tmp/first", "first")
  await store.refreshLocal("/tmp/second", "second")
  assert.deepEqual(store.getState().changes, [])
  assert.equal(store.getState().pullRequest, undefined)
  assert.equal(store.getState().remote, undefined)
  store.dispose()
})
