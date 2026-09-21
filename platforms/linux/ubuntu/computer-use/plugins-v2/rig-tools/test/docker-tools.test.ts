import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createDockerTools, type DockerRunner } from "../src/docker-tools.ts"

function fakeRunner(config: unknown = { services: { app: { image: "example/app", mem_limit: 536870912, cpus: 1, pids_limit: 256 } } }) {
  const calls: string[][] = []
  let container = false
  const runner: DockerRunner = async (args) => {
    calls.push(args)
    if (args[0] === "version") return { stdout: JSON.stringify({ Client: { Version: "29.1.3" }, Server: { Version: "29.1.3", Os: "linux", Arch: "amd64" } }), stderr: "" }
    if (args.includes("config")) return { stdout: JSON.stringify(config), stderr: "" }
    if (args[0] === "container" && args[1] === "inspect") {
      if (!container) throw new Error("docker command exited 1: Error: No such object: demo")
      return { stdout: '{"State":{"Status":"running"}}\n', stderr: "" }
    }
    if (args[0] === "image" && args[1] === "inspect") throw new Error("docker command exited 1: Error response from daemon: No such image: example/app")
    if (args.includes("ps") && args.includes("--format") && args.includes("json")) return { stdout: container ? "running" : "[]", stderr: "" }
    if (args[0] === "run") { container = true; return { stdout: "container-id\n", stderr: "" } }
    if (args.includes("up")) { container = true; return { stdout: "started\n", stderr: "" } }
    return { stdout: "", stderr: "" }
  }
  return { runner, calls }
}

test("returns structured Docker version fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-docker-version-"))
  try {
    const tools = createDockerTools(root, fakeRunner().runner)
    assert.deepEqual(await tools.engine({ action: "version" }, "ses", "build"), {
      client: "29.1.3",
      server: "29.1.3",
      os: "linux",
      arch: "amd64",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("previews and applies a constrained Docker run with caller/state binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-docker-"))
  try {
    const { runner, calls } = fakeRunner()
    const tools = createDockerTools(root, runner)
    const request = { action: "run" as const, image: "example/app:latest", name: "demo", command: ["serve"] }
    const preview = await tools.engine(request, "ses", "build")
    assert.equal(preview.dryRun, true)
    const applied = await tools.engine({ ...request, apply: true, expectToken: preview.expectToken }, "ses", "build")
    assert.equal(applied.dryRun, false)
    const run = calls.find((args) => args[0] === "run")!
    assert.deepEqual(run.slice(0, 18), [
      "run", "--detach", "--name", "demo", "--network", "none",
      "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
      "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    ])
    assert.ok(run.includes("--cap-drop"))
    assert.ok(run.includes("no-new-privileges"))
    assert.ok(run.includes("--read-only"))
    assert.equal(run.includes("--privileged"), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("validates Compose config and applies project-contained up", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-compose-"))
  try {
    await writeFile(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n")
    const { runner, calls } = fakeRunner()
    const tools = createDockerTools(root, runner)
    const services = await tools.compose({ action: "services" }, "ses", "build")
    assert.deepEqual(services.services, ["app"])
    assert.deepEqual(services.resourceLimited, ["app"])
    const preview = await tools.compose({ action: "up", services: ["app"] }, "ses", "build")
    const applied = await tools.compose({ action: "up", services: ["app"], apply: true, expectToken: preview.expectToken }, "ses", "build")
    assert.equal(applied.dryRun, false)
    assert.ok(calls.some((args) => args.includes("up") && args.includes("--detach") && args.includes("app")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects privileged, device, capability, namespace, and bind-mount escapes before Compose mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-compose-deny-"))
  try {
    await writeFile(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n")
    const privileged = createDockerTools(root, fakeRunner({ services: { app: { image: "x", privileged: true } } }).runner)
    await assert.rejects(privileged.compose({ action: "up" }, "ses", "build"), /forbidden privileged/)
    const bind = createDockerTools(root, fakeRunner({ services: { app: { image: "x", volumes: [{ type: "bind", source: "/", target: "/host" }] } } }).runner)
    await assert.rejects(bind.compose({ action: "up" }, "ses", "build"), /forbidden bind mount/)
    const devices = createDockerTools(root, fakeRunner({ services: { app: { image: "x", devices: ["/dev/null:/dev/null"] } } }).runner)
    await assert.rejects(devices.compose({ action: "up" }, "ses", "build"), /forbidden devices/)
    const capabilities = createDockerTools(root, fakeRunner({ services: { app: { image: "x", cap_add: ["SYS_ADMIN"] } } }).runner)
    await assert.rejects(capabilities.compose({ action: "up" }, "ses", "build"), /forbidden cap_add/)
    const namespace = createDockerTools(root, fakeRunner({ services: { app: { image: "x", network_mode: "host" } } }).runner)
    await assert.rejects(namespace.compose({ action: "up" }, "ses", "build"), /forbidden network_mode/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("refuses to start Compose services when any hard resource limit is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-compose-resources-"))
  try {
    await writeFile(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n")
    for (const service of [
      { image: "example/app", cpus: 1, pids_limit: 256 },
      { image: "example/app", mem_limit: 536870912, pids_limit: 256 },
      { image: "example/app", mem_limit: 536870912, cpus: 1 },
    ]) {
      const tools = createDockerTools(root, fakeRunner({ services: { app: service } }).runner)
      await assert.rejects(tools.compose({ action: "up" }, "ses", "build"), /explicit memory, CPU, and PID limits/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("validates the resource limits of implicitly started Compose dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-compose-dependencies-"))
  try {
    await writeFile(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n")
    const app = { image: "example/app", mem_limit: 536870912, cpus: 1, pids_limit: 256, depends_on: ["db"] }
    const unlimited = createDockerTools(root, fakeRunner({ services: { app, db: { image: "example/db" } } }).runner)
    await assert.rejects(unlimited.compose({ action: "up", services: ["app"] }, "ses", "build"), /explicit memory, CPU, and PID limits: db/)

    const db = { image: "example/db", mem_limit: 536870912, cpus: 1, pids_limit: 256 }
    const limited = createDockerTools(root, fakeRunner({ services: { app, db } }).runner)
    const preview = await limited.compose({ action: "up", services: ["app"] }, "ses", "build")
    assert.equal(preview.dryRun, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fails closed on state-probe errors and refuses service-scoped down", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-docker-state-"))
  try {
    await writeFile(join(root, "compose.yaml"), "services:\n  app:\n    image: example/app\n")
    const broken: DockerRunner = async (args) => {
      if (args.includes("config")) return { stdout: JSON.stringify({ services: { app: { image: "example/app", mem_limit: 536870912, cpus: 1, pids_limit: 256 } } }), stderr: "" }
      throw new Error("docker daemon unavailable")
    }
    const tools = createDockerTools(root, broken)
    await assert.rejects(tools.engine({ action: "run", image: "example/app", name: "demo" }, "ses", "build"), /daemon unavailable/)
    await assert.rejects(tools.compose({ action: "up" }, "ses", "build"), /daemon unavailable/)

    const healthy = createDockerTools(root, fakeRunner().runner)
    await assert.rejects(healthy.compose({ action: "down", services: ["app"] }, "ses", "build"), /whole Compose project/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
