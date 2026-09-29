import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { createRpcRequest, parseRpcResponse, resolvePowerShellExecutable } from "../src/powershell-host.ts"

test("creates a bounded JSON-RPC 2.0 envelope", () => {
  assert.deepEqual(createRpcRequest("windows.apps", { maxItems: 5 }), {
    jsonrpc: "2.0",
    id: 1,
    method: "windows.apps",
    params: { maxItems: 5 },
  })
  assert.throws(() => createRpcRequest("", {}), /method/u)
  assert.throws(() => createRpcRequest("x".repeat(129), {}), /method/u)
})

test("accepts matching results and rejects errors or mismatched responses", () => {
  assert.deepEqual(parseRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"ready":true}}'), { ready: true })
  assert.throws(() => parseRpcResponse("not-json"), /malformed/u)
  assert.throws(() => parseRpcResponse('{"jsonrpc":"2.0","id":2,"result":null}'), /mismatched/u)
  assert.throws(() => parseRpcResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"blocked"}}'), /blocked/u)
})

test("rejects PATH candidates outside expected Windows installation roots", async () => {
  await assert.rejects(resolvePowerShellExecutable("pwsh.exe", "/tmp:/usr/bin"), /expected absolute Windows installation path/u)
})

test("PowerShell host exposes only fixed methods over standard input and output", async () => {
  const source = await readFile(new URL("../powershell/OpenRig.WindowsHost.ps1", import.meta.url), "utf8")
  for (const method of [
    "status", "processes", "services", "path", "raw.parse", "windows.apps", "windows.find", "windows.act", "windows.screenshot", "windows.capture", "windows.restore",
    "browser.open", "browser.windows", "browser.snapshot", "browser.screenshot", "browser.target", "browser.act",
  ]) {
    assert.match(source, new RegExp(`"${method.replace(".", "\\.")}"`, "u"))
  }
  assert.match(source, /Console\]::In\.ReadLine/u)
  assert.match(source, /Console\]::Out\.WriteLine/u)
  assert.match(source, /Automation\.Language\.Parser\]::ParseInput/u)
  assert.match(source, /expectedTarget/u)
  assert.match(source, /Assert-SnapshotEqual/u)
  assert.match(source, /refuses truncated discovery/u)
  assert.match(source, /absolute local-drive path/u)
  assert.match(source, /CopyFromScreen/u)
  assert.match(source, /MemoryStream/u)
  assert.match(source, /6291456/u)
  const elementSnapshot = source.slice(source.indexOf("function Get-ElementSnapshot"), source.indexOf("\nfunction Get-ExpectedSnapshot"))
  assert.match(elementSnapshot, /\[double\]::IsNaN/u)
  assert.match(elementSnapshot, /\[double\]::IsInfinity/u)
  assert.match(elementSnapshot, /10000000/u)
  assert.match(elementSnapshot, /\$rectangle\.Width -le 0 -or \$rectangle\.Height -le 0/u)
  assert.match(elementSnapshot, /offscreen = \[bool\]\$current\.IsOffscreen -or -not \$boundsValid/u)
  assert.match(elementSnapshot, /x = 0\.0; y = 0\.0; width = 0\.0; height = 0\.0/u)
  const uiAction = source.slice(source.indexOf("function Invoke-UiAction"), source.indexOf("\nwhile ($null -ne ($line"))
  assert.match(uiAction, /if \(-not \$found\.items\[0\]\.enabled -or \$found\.items\[0\]\.offscreen\)/u)
  assert.match(source, /Assert-BrowserParams/u)
  assert.match(source, /UseShellExecute\s*=\s*\$true/u)
  assert.match(source, /requestAccepted\s*=\s*\$true/u)
  assert.match(source, /UrlAssociations/u)
  assert.match(source, /public static extern bool PrintWindow/u)
  assert.match(source, /DwmGetWindowAttribute/u)
  assert.match(source, /processStartTimeTicks/u)
  const screenshot = source.slice(source.indexOf("function Get-BrowserScreenshot"), source.indexOf("\nfunction Invoke-BrowserAction"))
  assert.match(screenshot, /PrintWindow/u)
  assert.match(screenshot, /Get-BrowserCaptureIdentity/u)
  assert.match(screenshot, /Assert-BrowserWindowUnoccluded/u)
  assert.match(screenshot, /Assert-BrowserCapturePixels/u)
  assert.doesNotMatch(screenshot, /SetForegroundWindow|CopyFromScreen/u)
  const exactCapture = source.slice(source.indexOf("function Get-ExactWindowId"), source.indexOf("\nfunction Get-BrowserScreenshot"))
  assert.match(exactCapture, /Get-WindowsCapture/u)
  assert.match(exactCapture, /Assert-BrowserWindowUnoccluded/u)
  assert.match(exactCapture, /Assert-BrowserCapturePixels/u)
  assert.match(exactCapture, /PrintWindow/u)
  assert.match(exactCapture, /DwmGetWindowAttribute/u)
  assert.match(exactCapture, /processStartTimeTicks/u)
  assert.doesNotMatch(exactCapture, /SetForegroundWindow|CopyFromScreen|SendInput|mouse_event/u)
  assert.doesNotMatch(source, /TcpListener|HttpListener|NamedPipeServerStream|Invoke-Expression/u)
})

test("occlusion rejection names a bounded occluder without any window title", async () => {
  const source = await readFile(new URL("../powershell/OpenRig.WindowsHost.ps1", import.meta.url), "utf8")
  const unoccluded = source.slice(source.indexOf("function Assert-BrowserWindowUnoccluded"), source.indexOf("\nfunction Get-BrowserCaptureProbeColor"))
  assert.match(unoccluded, /occluded by another visible window/u)
  assert.match(unoccluded, /throw \$occlusionError/u)
  assert.match(unoccluded, /::ProcessId\(\$handle\)/u)
  assert.match(unoccluded, /::ClassName\(\$handle\)/u)
  assert.match(unoccluded, /hwnd=\$occluderHandle/u)
  assert.match(unoccluded, /Substring\(0, 64\)/u)
  assert.match(unoccluded, /Substring\(0, 256\)/u)
  assert.match(unoccluded, /bounds=\(\$\(\$rectangle\.Left\)/u)
  assert.doesNotMatch(unoccluded, /::Title\(/u)
  assert.doesNotMatch(unoccluded, /Shell_TrayWnd|taskbar/iu)
})
