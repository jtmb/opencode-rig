import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const source = await readFile(new URL("../src/tui-panel.tsx", import.meta.url), "utf8")
const server = await readFile(new URL("../server.ts", import.meta.url), "utf8")
const rpc = await readFile(new URL("../src/rpc.ts", import.meta.url), "utf8")

test("review panel keeps /learn-review separate from the visible /learn command", () => {
  assert.match(source, /LEARN_SLASH = \{ name: "learn-review", aliases: \[\] \}/)
})

test("visible /learn uses the CLI dialog path, not a synthetic inbox body", () => {
  assert.doesNotMatch(server, /ctx\.command\.transform/)
  assert.doesNotMatch(server, /ctx\.session\.synthetic/)
  assert.match(server, /ctx\.rpc\.register\(RepoLearning/)
  assert.match(source, /context\.ui\.dialog\.alert\(\{ title: "Repo learning", message: result\.text \}\)/)
  assert.match(source, /The command failed\. Restart OpenCode if the server plugin is not loaded\./)
  assert.match(source, /LEARN_COMMAND_SLASH = \{ name: "learn", arguments: true as const \}/)
  assert.match(source, /const opened = context\.ui\.panel\.open\(LEARN_PANEL_NAME\)/)
  assert.match(source, /This review view requires an active session\./)
  assert.match(source, /const rpcOptions = \{ location: context\.location \}/)
  assert.match(source, /rpc\.learn\([^\n]+, rpcOptions\)/)
})

test("the RPC avoids unsupported schema patterns and validates session IDs in the handler", () => {
  assert.doesNotMatch(rpc, /pattern:/)
  assert.match(server, /if \(!\/\^ses_\[A-Za-z0-9\]\+\$\/\.test\(sessionID\)\)/)
})

test("deployed review panel stays passive without mutation callbacks", () => {
  assert.match(source, /<ReviewList artifacts=\{artifacts\} shadows=\{shadows\} \/>/)
  assert.match(source, /Read-only scaffold: no approve\/reject action is advertised\./)
  assert.match(source, /passive notice; no action taken/)
})
