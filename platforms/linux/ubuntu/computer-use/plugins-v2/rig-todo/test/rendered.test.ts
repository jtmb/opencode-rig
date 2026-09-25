import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

const MAX_OUTPUT_BYTES = 1024 * 1024
const TIMEOUT_MS = 120_000
const ISOLATED_NODE_ARGS = process.versions.node.startsWith("26.4.") ? ["--experimental-ffi"] : []

function runIsolated(args: readonly string[]) {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [...ISOLATED_NODE_ARGS, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: environment,
    input: "",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  })
}

test("rendered TodoPanel checks run in an isolated OpenTUI subprocess", () => {
  const marker = "opentui-todo-stderr-containment-probe"
  const probe = runIsolated(["-e", `process.stderr.write(${JSON.stringify(marker)})`])
  assert.equal(probe.error, undefined)
  assert.equal(probe.status, 0)
  assert.equal(probe.stderr, marker)

  const rendered = runIsolated([
    "--experimental-strip-types",
    "--test",
    "test/rendered-fixture.ts",
  ])
  assert.equal(rendered.error, undefined)
  assert.equal(
    rendered.status,
    0,
    `isolated OpenTUI renderer failed\nstdout:\n${rendered.stdout}\nstderr:\n${rendered.stderr}`,
  )
  assert.doesNotMatch(rendered.stdout, /# SKIP\b/)
  assert.match(rendered.stdout, /RIG_TODO_RENDER_ASSERTIONS_EXECUTED/)
  assert.match(rendered.stdout, /rendered production TodoPanel keeps actionable rows wrapped/)
})

test("composed sidebar density checks run in an isolated OpenTUI subprocess", () => {
  const rendered = runIsolated([
    "--experimental-strip-types",
    "--test",
    "test/composed-rendered-fixture.ts",
  ])
  assert.equal(rendered.error, undefined)
  assert.equal(
    rendered.status,
    0,
    `isolated composed OpenTUI renderer failed\nstdout:\n${rendered.stdout}\nstderr:\n${rendered.stderr}`,
  )
  assert.doesNotMatch(rendered.stdout, /# SKIP\b/)
  assert.match(rendered.stdout, /RIG_COMPOSED_SIDEBAR_RENDER_ASSERTIONS_EXECUTED/)
  assert.match(rendered.stdout, /composed production plugin sections fit a narrow sidebar/)
})
