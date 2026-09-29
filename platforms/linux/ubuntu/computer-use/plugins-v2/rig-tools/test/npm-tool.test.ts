import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createNpmTool, isolatedNpmCommand, isolatedNpmEnvironment, runNpmProcess, type NpmRunner } from "../src/npm-tool.ts"

test("lists scripts without executing npm", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-npm-list-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js", check: "npm test" } }))
    const runner: NpmRunner = async () => { throw new Error("runner must not be called") }
    const npm = createNpmTool(root, runner)
    assert.deepEqual(await npm({ action: "scripts" }, "ses", "build"), { scripts: ["check", "test"] })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("previews and applies an exact npm script through the bounded runner contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-npm-run-"))
  const calls: string[][] = []
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }))
    const runner: NpmRunner = async (args) => {
      calls.push(args)
      return { exitCode: 0, signal: null, stdout: "ok\n", stderr: "" }
    }
    const npm = createNpmTool(root, runner)
    const preview = await npm({ action: "test", args: ["--watch=false"] }, "ses", "build")
    assert.equal(preview.dryRun, true)
    assert.deepEqual(calls, [])
    const applied = await npm({ action: "test", args: ["--watch=false"], apply: true, expectToken: preview.expectToken }, "ses", "build")
    assert.equal(applied.dryRun, false)
    assert.deepEqual(calls, [["run", "test", "--", "--watch=false"]])
    assert.equal(applied.memoryPolicy, "adaptive-cgroup-or-fail-closed")
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("the system npm runner hard-codes the adaptive resource wrapper", () => {
  assert.match(runNpmProcess.toString(), /BOUNDED_RUNNER/)
  assert.match(runNpmProcess.toString(), /shell:\s*false/)
  assert.match(runNpmProcess.toString(), /memory-fraction/)
  assert.match(runNpmProcess.toString(), /swap-fraction/)
  assert.match(runNpmProcess.toString(), /node-heap-fraction/)
  assert.match(runNpmProcess.toString(), /--timeout/)
})

test("npm runs with an isolated environment and no user configuration", () => {
  const command = isolatedNpmCommand(["test"], "/opt/node/lib/npm-cli.js", "/opt/node/bin/node", "/cache/npm")
  const environment = isolatedNpmEnvironment("/opt/node/bin/node", "/cache/npm", {
    XDG_RUNTIME_DIR: "/run/user/1000",
    NODE_OPTIONS: "--inspect",
  })
  assert.deepEqual(command, ["/opt/node/lib/npm-cli.js", "test"])
  assert.equal(environment.PATH, "/opt/node/bin:/usr/bin:/bin")
  assert.equal(environment.HOME, "/nonexistent")
  assert.equal(environment.npm_config_userconfig, "/nonexistent/.npmrc")
  assert.equal(environment.npm_config_globalconfig, "/dev/null")
  assert.equal(environment.XDG_RUNTIME_DIR, "/run/user/1000")
  assert.equal("NODE_OPTIONS" in environment, false)
})

test("npm mutation tokens bind the session, agent, and project containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-npm-token-"))
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }))
    const runner: NpmRunner = async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" })
    const npm = createNpmTool(root, runner)
    const preview = await npm({ action: "test" }, "ses", "build")
    await assert.rejects(
      npm({ action: "test", apply: true, expectToken: preview.expectToken }, "other-session", "build"),
      /session, agent, and intent/,
    )
    await assert.rejects(npm({ action: "test", directory: join(root, "..") }, "ses", "build"), /inside the current project/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
