import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const root = new URL("../", import.meta.url)

test("exports both server and CLI roles", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { exports?: Record<string, string> }
  assert.equal(packageJson.exports?.["."], "./server.ts")
  assert.equal(packageJson.exports?.["./server"], "./server.ts")
  assert.equal(packageJson.exports?.["./tui"], "./tui.tsx")
})

test("uses additive native-preserving sidebar placement", async () => {
  const source = await readFile(new URL("src/tui.tsx", root), "utf8")
  assert.match(source, /after:\s*["']sidebar\.content["']/u)
  assert.doesNotMatch(source, /replace:\s*["']sidebar\./u)
  assert.doesNotMatch(source, /prepend:\s*["']sidebar\./u)
  assert.match(source, /<b>Open Rig WSL2<\/b>/u)
  assert.match(source, /slash:\s*\{\s*name:\s*["']wsl-status["']/u)
  assert.doesNotMatch(source, /Active subagents/u)
  assert.doesNotMatch(source, /McpStatus|\.mcp\.server|createActiveChildren/u)
})

test("RPC wire schemas avoid unsupported pattern keywords", async () => {
  const source = await readFile(new URL("src/rpc.ts", root), "utf8")
  assert.doesNotMatch(source, /\bpattern\s*:/u)
})

test("registers structured PowerShell and Windows app-control tools", async () => {
  const source = await readFile(new URL("src/index.ts", root), "utf8")
  for (const tool of ["wsl_status", "powershell_status", "powershell_command", "powershell_raw", "windows_apps", "windows_find", "windows_act"]) {
    assert.match(source, new RegExp(`name:\\s*["']${tool}["']`, "u"))
  }
  assert.match(source, /permission:\s*["']wsl_powershell_raw["']/u)
  assert.match(source, /permission:\s*["']wsl_windows_act["']/u)
})
