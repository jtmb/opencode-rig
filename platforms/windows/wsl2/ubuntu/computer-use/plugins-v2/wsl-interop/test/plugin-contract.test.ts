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

test("uses CLI-safe options for the read-only status surface", async () => {
  const source = await readFile(new URL("src/tui.tsx", root), "utf8")
  assert.match(source, /parseTuiOptions\(context\.options\)/u)
  assert.match(source, /if \(!options\.enabled\) return/u)
  assert.match(source, /rpc\.status\(\{\}, rpcOptions\)/u)
  assert.doesNotMatch(source, /powershell_raw|permission\.rules/u)
})

test("RPC wire schemas avoid unsupported pattern keywords", async () => {
  const source = await readFile(new URL("src/rpc.ts", root), "utf8")
  assert.doesNotMatch(source, /\bpattern\s*:/u)
})

test("registers structured PowerShell and Windows app-control tools", async () => {
  const source = await readFile(new URL("src/index.ts", root), "utf8")
  for (const tool of ["wsl_status", "powershell_status", "powershell_command", "powershell_raw", "windows_apps", "windows_find", "windows_act", "windows_restore"]) {
    assert.match(source, new RegExp(`name:\\s*["']${tool}["']`, "u"))
  }
  assert.match(source, /permission:\s*["']wsl_powershell_raw["']/u)
  assert.match(source, /permission:\s*["']wsl_windows_act["']/u)
})

test("registers the non-activating exact-window restore tool", async () => {
  const source = await readFile(new URL("src/index.ts", root), "utf8")
  const start = source.indexOf('name: "windows_restore"')
  const end = source.indexOf('name: "windows_capture"')
  assert.ok(start >= 0 && end > start, "windows_restore must be registered before windows_capture")
  const restore = source.slice(start, end)
  assert.match(restore, /ShowWindow\(SW_SHOWNOACTIVATE\)/u)
  assert.match(restore, /never calls SW_RESTORE, SetForegroundWindow, SetWindowPos, or any input API/u)
  assert.match(restore, /hidden-but-not-minimized/u)
  assert.match(restore, /expectToken/u)
  assert.match(source, /WindowsRestoreInput/u)
})

test("registers default-browser UI Automation tools with required action data", async () => {
  const source = await readFile(new URL("src/index.ts", root), "utf8")
  for (const tool of [
    "wsl_browser_open", "wsl_browser_windows", "wsl_browser_snapshot", "wsl_browser_screenshot",
  ]) {
    assert.match(source, new RegExp(`name:\\s*["']${tool}["']`, "u"))
  }
  for (const tool of ["wsl_browser_click", "wsl_browser_focus", "wsl_browser_type", "wsl_browser_press"]) {
    assert.ok(source.includes(`addBrowserAction("${tool}"`))
  }
  assert.match(source, /options:\s*\{\s*permission:\s*["']wsl_browser_open["']/u)
  assert.match(source, /options:\s*\{\s*permission:\s*["']wsl_browser_act["']/u)
  assert.match(source, /Success confirms request acceptance only, not navigation/u)
  assert.match(source, /Capture a bounded in-memory PNG from the exact HWND/u)
  assert.match(source, /fails closed on changed identity, occlusion, blank output, or unpainted pixels/u)
  assert.match(source, /action\s*===\s*["']type["']\s*\?\s*\[["']value["']\]/u)
  assert.match(source, /action\s*===\s*["']press["']\s*\?\s*\[["']key["']\]/u)
})
