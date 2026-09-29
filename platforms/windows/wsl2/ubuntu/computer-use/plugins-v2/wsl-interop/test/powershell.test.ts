import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { decodePowerShellOutput, executableCandidates, inspectRawScript, runBoundedPowerShell } from "../src/powershell.ts"
import { runBoundedProcess } from "../src/process-boundary.ts"

test("selects PowerShell executables deterministically", () => {
  assert.deepEqual(executableCandidates("auto"), ["pwsh.exe", "powershell.exe"])
  assert.deepEqual(executableCandidates("powershell.exe"), ["powershell.exe"])
})

test("normalizes UTF-8 and UTF-16LE output", () => {
  assert.equal(decodePowerShellOutput(Buffer.from("ready", "utf8")), "ready")
  assert.equal(decodePowerShellOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ready", "utf16le")])), "ready")
  assert.throws(() => decodePowerShellOutput(Buffer.from([0xff, 0xfe, 0x61])), /malformed/u)
  assert.throws(() => decodePowerShellOutput(Buffer.from([0xff])), /malformed/u)
})

test("raw preview inspection reports commands and blocks known bypasses", () => {
  const inspection = inspectRawScript("Get-Process | Select-Object -First 2", 1024)
  assert.deepEqual(inspection.commands, ["Get-Process", "Select-Object"])
  assert.throws(() => inspectRawScript("git push origin main", 1024), /repository gates/u)
  assert.throws(() => inspectRawScript("powershell.exe -EncodedCommand ZABpAHIA", 1024), /encoded/u)
  assert.throws(() => inspectRawScript("Invoke-Expression $payload", 1024), /dynamic/u)
  assert.throws(() => inspectRawScript("Get-Credential", 1024), /credential/u)
})

test("raw preview inspection enforces byte limits", () => {
  assert.throws(() => inspectRawScript("Get-Date", 2), /exceeds/u)
  assert.throws(() => inspectRawScript("", 10), /empty/u)
})

async function withFakePowerShell(source: string, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp("/tmp/opencode/wsl2-powershell-test-")
  const executable = join(directory, "pwsh.exe")
  const originalPath = process.env.PATH
  try {
    await writeFile(executable, source, "utf8")
    await chmod(executable, 0o700)
    process.env.PATH = `${directory}:${originalPath ?? ""}`
    await run(directory)
  } finally {
    process.env.PATH = originalPath
    await rm(directory, { recursive: true, force: true })
  }
}

test("runs fixed argv directly and passes scripts only through stdin", async () => {
  await withFakePowerShell("#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\ncat\n", async (directory) => {
    const result = await runBoundedPowerShell(join(directory, "pwsh.exe"), "Get-Date; Write-Output 'ready'\n", {
      cwd: directory,
      timeoutMs: 1_000,
      maxOutputBytes: 16_384,
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stderr.length, 0)
    assert.equal(decodePowerShellOutput(result.stdout), "-NoLogo\n-NoProfile\n-NonInteractive\n-Command\n-\nGet-Date; Write-Output 'ready'\n")
  })
})

test("does not open a writable stdin pipe when the bounded input is empty", async () => {
  const result = await runBoundedProcess("/usr/bin/true", [], "", {
    cwd: "/tmp/opencode",
    env: {},
    timeoutMs: 1_000,
    maxOutputBytes: 1_024,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.length, 0)
  assert.equal(result.stderr.length, 0)
})

test("enforces timeout, cancellation, and combined output bounds", async () => {
  await withFakePowerShell("#!/usr/bin/env bash\nsleep 2\n", async (directory) => {
    await assert.rejects(runBoundedPowerShell(join(directory, "pwsh.exe"), "Get-Date\n", {
      cwd: directory,
      timeoutMs: 50,
      maxOutputBytes: 16_384,
    }), /timed out/u)
  })
  await withFakePowerShell("#!/usr/bin/env bash\nprintf '1234567890'\nprintf 'abcdefghij' >&2\n", async (directory) => {
    await assert.rejects(runBoundedPowerShell(join(directory, "pwsh.exe"), "Get-Date\n", {
      cwd: directory,
      timeoutMs: 1_000,
      maxOutputBytes: 15,
    }), /output exceeded/u)
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runBoundedPowerShell("/usr/bin/false", "Get-Date\n", {
    cwd: "/tmp/opencode",
    timeoutMs: 1_000,
    maxOutputBytes: 16_384,
    signal: controller.signal,
  }), /cancelled/u)
})
