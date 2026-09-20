import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createDockerBuildTool, fingerprintBuildContext } from "../src/docker-build.ts"
import type { DockerRunner } from "../src/docker-tools.ts"

test("fingerprints a bounded build context without loading it as one buffer", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-build-context-"))
  try {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n")
    await writeFile(join(root, "src", "value.txt"), "value\n")
    const first = await fingerprintBuildContext(root)
    await writeFile(join(root, "src", "value.txt"), "changed\n")
    const second = await fingerprintBuildContext(root)
    assert.equal(first.files, 2)
    assert.notEqual(first.sha256, second.sha256)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("classic Docker builds always include hard memory, CPU, and process limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-docker-build-"))
  const calls: string[][] = []
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n")
    const runner: DockerRunner = async (args) => {
      calls.push(args)
      if (args[0] === "image") throw new Error("missing")
      return { stdout: "built\n", stderr: "" }
    }
    const build = createDockerBuildTool(root, runner)
    const request = { tag: "example/app:test", memoryMiB: 768, cpus: 1.5 }
    const preview = await build(request, "ses", "build")
    const applied = await build({ ...request, apply: true, expectToken: preview.expectToken }, "ses", "build")
    assert.equal(applied.memoryPolicy, "explicit-hard-limit")
    const command = calls.find((args) => args[0] === "build")!
    assert.deepEqual(command.slice(0, 9), ["build", "--memory", "768m", "--memory-swap", "768m", "--cpu-period", "100000", "--cpu-quota", "150000"])
    assert.ok(command.includes("--ulimit"))
    assert.ok(command.includes("nproc=256:256"))
    assert.ok(command.includes("--security-opt"))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("buildx uses an ephemeral resource-limited docker-container builder and removes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-buildx-"))
  const calls: string[][] = []
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n")
    const runner: DockerRunner = async (args) => {
      calls.push(args)
      if (args[0] === "image") throw new Error("missing")
      return { stdout: "ok\n", stderr: "" }
    }
    const build = createDockerBuildTool(root, runner)
    const request = { backend: "buildx" as const, tag: "example/app:test", memoryMiB: 512, cpus: 1 }
    const preview = await build(request, "ses", "build")
    await build({ ...request, apply: true, expectToken: preview.expectToken }, "ses", "build")
    const create = calls.find((args) => args[0] === "buildx" && args[1] === "create")!
    assert.ok(create.includes("memory=512m"))
    assert.ok(create.includes("memory-swap=512m"))
    assert.ok(create.includes("cpu-quota=100000"))
    assert.ok(create.includes("--bootstrap"))
    const update = calls.find((args) => args[0] === "container" && args[1] === "update")!
    assert.ok(update.includes("--memory"))
    assert.ok(update.includes("--memory-swap"))
    assert.ok(update.includes("--cpu-quota"))
    assert.ok(update.includes("--pids-limit"))
    const buildCommand = calls.find((args) => args[0] === "buildx" && args[1] === "build")!
    assert.ok(buildCommand.includes("--network"))
    assert.ok(buildCommand.includes("none"))
    assert.ok(calls.some((args) => args[0] === "buildx" && args[1] === "rm" && args.includes("--force")))
  } finally { await rm(root, { recursive: true, force: true }) }
})
