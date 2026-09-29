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

test("rendered Source Control checks run in an isolated OpenTUI subprocess", () => {
  const rendered = runIsolated(["--experimental-strip-types", "--test", "test/rendered-fixture.ts"])
  assert.equal(rendered.error, undefined)
  assert.equal(rendered.status, 0, `isolated OpenTUI renderer failed\nstdout:\n${rendered.stdout}\nstderr:\n${rendered.stderr}`)
  assert.doesNotMatch(rendered.stdout, /# SKIP\b/)
  assert.match(rendered.stdout, /RIG_SOURCE_CONTROL_RENDER_ASSERTIONS_EXECUTED/)
  assert.match(rendered.stdout, /bounds previews to one-line rows/)
})
