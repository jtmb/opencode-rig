import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const server = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
const tui = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
const todoTui = await readFile(new URL("../../rig-todo/src/tui.tsx", import.meta.url), "utf8")
const fileManagerTui = await readFile(new URL("../../file-manager/src/tui.tsx", import.meta.url), "utf8")
const roleCatalog = JSON.parse(await readFile(new URL("../../../config/v2-plugin-roles.json", import.meta.url), "utf8")) as {
  plugins: Array<{ name: string; roles: Record<string, unknown> }>
}
const cliExample = JSON.parse(await readFile(new URL("../../../config/v2-cli.example.json", import.meta.url), "utf8")) as {
  plugins: Array<{ package: string }>
}

test("visible slash commands use the CLI dialog path, not a synthetic inbox body", () => {
  assert.doesNotMatch(server, /ctx\.command\.transform/)
  assert.doesNotMatch(server, /ctx\.session\.synthetic/)
  assert.match(server, /ctx\.rpc\.register\(RigTools/)
  assert.match(tui, /message = await run\(\)/)
  assert.match(tui, /The command failed\. Restart OpenCode if the server plugin is not loaded\./)
  assert.match(tui, /slash: \{ name: "tools", arguments: true \}/)
  assert.match(tui, /slash: \{ name: "session-context", arguments: true \}/)
  assert.match(tui, /slash: \{ name: "subagents" \}/)
  assert.match(tui, /append: "session\.panel"/)
  assert.match(tui, /const requests = new AbortController\(\)/)
  assert.match(tui, /context\.client\.session\.active\(requestOptions\)/)
  assert.match(tui, /subagentStatus\(child, active\[child\.id\]\?\.type === "running"\)/)
  assert.match(tui, /context\.data\.on\("session\.status", \(\) => \{\s+void refresh\(\)/)
  assert.match(tui, /setInterval\(\(\) => void refresh\(\), 1_000\)/)
  assert.match(tui, /clearInterval\(timer\)/)
  assert.match(tui, /requests\.abort\(\)/)
  assert.match(tui, /const opened = context\.ui\.panel\.open\(SUBAGENTS_PANEL_NAME/)
  assert.match(tui, /This view requires an active session\./)
  assert.match(tui, /formatSubagentRow\(row/)
  assert.match(tui, /useKeyboard\(\(key\) => \{/)
  assert.match(tui, /if \(!props\.panel\.focused \|\| key\.name !== "escape"\) return/)
  assert.match(tui, /key\.stopPropagation\(\)/)
  assert.match(tui, /function ActiveSubagentsSidebar/)
  assert.match(tui, /context\.ui\.router\.navigate\(\{ type: "session", sessionID \}\)/)
  assert.match(tui, /Click\/Enter opens · ↑\/↓ moves/)
  assert.match(tui, /const rpcOptions = \{ location: context\.location \}/)
  assert.match(tui, /rpc\.sessionContext\([^\n]+, rpcOptions\)/)
})

test("sidebar preserves native MCP content while adding Explorer, Todo, and active subagents", () => {
  assert.match(fileManagerTui, /before: "sidebar\.content"/)
  assert.match(tui, /after: "sidebar\.content"/)
  assert.doesNotMatch(tui, /replace: "sidebar\.content"/)
  assert.match(todoTui, /after: "sidebar\.content"/)
  assert.doesNotMatch(fileManagerTui, /append: "sidebar\.content"/)
  assert.doesNotMatch(todoTui, /append: "sidebar\.content"/)
  assert.doesNotMatch(tui, /function McpSidebar|mcpStatusText|mcpStatusCounts/)
  assert.match(tui, /<ActiveSubagentsSidebar sessionID=\{sessionID\} \/>/)
  assert.doesNotMatch(tui, /session\.composer\.top/)
})

test("canonical role catalog and CLI example register both rig-tools roles", () => {
  const roles = roleCatalog.plugins.find((plugin) => plugin.name === "rig-tools")?.roles
  assert.deepEqual(Object.keys(roles ?? {}).sort(), ["cli", "server"])
  assert.equal(cliExample.plugins.some((plugin) => plugin.package.endsWith("/plugins-v2/rig-tools")), true)
})
