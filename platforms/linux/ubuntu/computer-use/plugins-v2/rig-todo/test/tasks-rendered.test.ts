import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

const MAX_OUTPUT_BYTES = 1024 * 1024
const TIMEOUT_MS = 120_000
const NODE_RENDERER_RUNTIME = process.versions.node.startsWith("26.4.")
const BUN_VERSION = process.versions.bun?.split(".").map(Number) ?? []
const BUN_RENDERER_RUNTIME = Boolean(process.versions.bun) && (BUN_VERSION[0]! > 1 || (BUN_VERSION[0] === 1 && BUN_VERSION[1]! >= 3))
const NATIVE_RENDERER_RUNTIME = NODE_RENDERER_RUNTIME || BUN_RENDERER_RUNTIME
const CHILD_ARGS = NODE_RENDERER_RUNTIME
  ? ["--experimental-ffi", "--experimental-strip-types", "--test", "test/tasks-rendered-fixture.ts"]
  : ["test", "test/tasks-rendered-fixture.ts"]

test("full-screen Todo Kanban rendering and interactions run in an isolated OpenTUI process", {
  skip: NATIVE_RENDERER_RUNTIME ? false : "OpenTUI's native renderer requires Node 26.4+ or Bun 1.3+",
}, () => {
  const rendered = spawnSync(process.execPath, CHILD_ARGS, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    input: "",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
  })
  assert.equal(rendered.error, undefined)
  assert.equal(rendered.status, 0, `OpenTUI tasks panel failed\nstdout:\n${rendered.stdout}\nstderr:\n${rendered.stderr}`)
  assert.doesNotMatch(rendered.stdout, /# SKIP\b/)
  assert.match(rendered.stdout, new RegExp(RENDER_ASSERTIONS_MARKER))
  assert.match(rendered.stdout, /full-screen Todo board responds to theme changes/)
})

const RENDER_ASSERTIONS_MARKER = "RIG_TODO_TASKS_RENDER_ASSERTIONS_EXECUTED"
