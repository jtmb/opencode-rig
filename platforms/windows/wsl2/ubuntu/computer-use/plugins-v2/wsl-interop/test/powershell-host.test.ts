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
  for (const method of ["status", "processes", "services", "path", "raw.parse", "windows.apps", "windows.find", "windows.act"]) {
    assert.match(source, new RegExp(`"${method.replace(".", "\\.")}"`, "u"))
  }
  assert.match(source, /Console\]::In\.ReadLine/u)
  assert.match(source, /Console\]::Out\.WriteLine/u)
  assert.match(source, /Automation\.Language\.Parser\]::ParseInput/u)
  assert.match(source, /expectedTarget/u)
  assert.match(source, /Assert-SnapshotEqual/u)
  assert.match(source, /refuses truncated discovery/u)
  assert.match(source, /absolute local-drive path/u)
  assert.doesNotMatch(source, /TcpListener|HttpListener|NamedPipeServerStream|Invoke-Expression/u)
})
