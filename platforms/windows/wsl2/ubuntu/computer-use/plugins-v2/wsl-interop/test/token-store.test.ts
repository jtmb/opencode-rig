import assert from "node:assert/strict"
import test from "node:test"

import { RawTokenStore, type RawIntent } from "../src/token-store.ts"

const linuxProject = ["/", "home", "alice", "project"].join("")

const intent: RawIntent = {
  sessionID: "ses_parent",
  agent: "build",
  script: "Get-Date",
  executable: "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  executableIdentity: "identity-one",
  workingDirectory: linuxProject,
  fingerprint: "wsl-fingerprint",
  timeoutMs: 10_000,
}

test("binds a single-use token to exact caller and state", () => {
  let now = 1_000
  const token = "token_1234567890abcdef"
  const store = new RawTokenStore(60_000, () => now, () => token)
  const preview = store.preview(intent)
  assert.equal(preview.expectToken, token)
  assert.match(preview.scriptSha256, /^[a-f0-9]{64}$/u)
  store.consume(token, intent)
  assert.throws(() => store.consume(token, intent), /missing|used/u)
  now += 1
})

test("rejects changed script, caller, executable, and fingerprint", () => {
  const changed: Array<RawIntent> = [
    { ...intent, script: "Get-Process" },
    { ...intent, sessionID: "ses_other" },
    { ...intent, agent: "other" },
    { ...intent, executable: "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" },
    { ...intent, executableIdentity: "identity-two" },
    { ...intent, fingerprint: "changed" },
    { ...intent, timeoutMs: 5_000 },
  ]
  for (const [index, value] of changed.entries()) {
    const token = `token_${String(index).padStart(20, "0")}`
    const store = new RawTokenStore(60_000, () => 1_000, () => token)
    store.preview(intent)
    assert.throws(() => store.consume(token, value), /state changed/u)
    assert.throws(() => store.consume(token, intent), /missing|used/u)
  }
})

test("rejects expired tokens", () => {
  let now = 1_000
  const token = "expired_1234567890abcdef"
  const store = new RawTokenStore(10_000, () => now, () => token)
  store.preview(intent)
  now = 11_001
  assert.throws(() => store.consume(token, intent), /expired|missing/u)
})

test("bounds token length, uniqueness, and outstanding capacity", () => {
  assert.throws(() => new RawTokenStore(60_000, () => 1_000, () => "short").preview(intent), /invalid token/u)
  const store = new RawTokenStore(60_000, () => 1_000, () => "capacity_1234567890abcdef", 1)
  store.preview(intent)
  assert.throws(() => store.preview(intent), /capacity/u)
})
