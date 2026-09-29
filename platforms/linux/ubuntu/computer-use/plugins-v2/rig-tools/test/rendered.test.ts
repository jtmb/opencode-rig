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

test("rendered active-subagent checks run in an isolated OpenTUI subprocess", () => {
  const marker = "opentui-active-subagent-stderr-containment-probe"
  const probe = runIsolated(["-e", `process.stderr.write(${JSON.stringify(marker)})`])
  assert.equal(probe.error, undefined)
  assert.equal(probe.status, 0)
  assert.equal(probe.stderr, marker)

  const rendered = runIsolated([
    "--import",
    "./test/solid-resolve-hook.mjs",
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
  assert.match(rendered.stdout, /RIG_TOOLS_ACTIVE_SUBAGENT_RENDER_ASSERTIONS_EXECUTED/)
  assert.match(rendered.stdout, /renders focused and unfocused rows/)
  assert.match(rendered.stdout, /native heading click and keyboard toggle keep focus, count live, and body refreshable while collapsed/)
  assert.match(rendered.stdout, /native Goal handoff control toggles by click and keyboard/)
  assert.match(rendered.stdout, /renders the sidebar Goal and shows a bounded footer preview only while hovered or focused/)
  assert.match(rendered.stdout, /native Managed Screens subsection refreshes rows and toggles by click and keyboard/)
})
