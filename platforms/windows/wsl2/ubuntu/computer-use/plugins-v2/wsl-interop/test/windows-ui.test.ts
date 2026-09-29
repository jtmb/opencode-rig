import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PowerShellHostClient } from "../src/powershell-host.ts"
import { RawTokenStore, type RawIntent } from "../src/token-store.ts"
import type { WslStatus } from "../src/types.ts"
import {
  canonicalSnapshot,
  captureProvenanceText,
  normalizeHostItems,
  parseFindResult,
  parseRestoreApply,
  parseRestorePreview,
  parseRestoreTarget,
  parseWindowsCapture,
  validateWindowsAct,
  validateWindowsCapture,
  validateWindowsFind,
  validateWindowsRestore,
  WindowsUiManager,
} from "../src/windows-ui.ts"

const snapshot = {
  processId: 1234,
  runtimeId: "42.7.1",
  name: "Save",
  automationId: "saveButton",
  controlType: "ControlType.Button",
  className: "Button",
  enabled: true,
  offscreen: false,
  bounds: { x: 10, y: 20, width: 100, height: 30 },
}

test("normalizes PowerShell 5.1 singleton list results", () => {
  const item = { processId: 1234, title: "Settings" }
  assert.deepEqual(normalizeHostItems(item, "Windows app"), [item])
  assert.deepEqual(normalizeHostItems([item], "Windows app"), [item])
  assert.throws(() => normalizeHostItems(null, "Windows app"), /invalid result/u)
})

test("accepts bounded exact Windows UI selectors", () => {
  assert.doesNotThrow(() => validateWindowsFind({
    processId: 1234,
    automationId: "saveButton",
    controlType: "Button",
    maxDepth: 6,
    maxNodes: 500,
    maxResults: 1,
  }))
})

test("rejects missing selectors, invalid bounds, and control separators", () => {
  assert.throws(() => validateWindowsFind({ processId: 1234 }), /selector/u)
  assert.throws(() => validateWindowsFind({ processId: 0, name: "Save" }), /processId/u)
  assert.throws(() => validateWindowsFind({ processId: 1234, name: "Save\nNow" }), /name/u)
  assert.throws(() => validateWindowsFind({ processId: 1234, name: "Save", maxNodes: 2001 }), /maxNodes/u)
})

test("requires setValue data only for the setValue action", () => {
  assert.doesNotThrow(() => validateWindowsAct({ processId: 1234, automationId: "name", action: "setValue", value: "Jane Smith" }))
  assert.throws(() => validateWindowsAct({ processId: 1234, automationId: "name", action: "setValue" }), /requires a value/u)
  assert.throws(() => validateWindowsAct({ processId: 1234, automationId: "save", action: "invoke", value: "unexpected" }), /only/u)
})

test("requires explicit complete discovery and canonical bounded snapshots", () => {
  assert.deepEqual(parseFindResult({ items: [snapshot], visited: 7, truncated: false }), {
    items: [snapshot],
    visited: 7,
    truncated: false,
  })
  assert.throws(() => parseFindResult({ items: [snapshot], visited: 7 }), /truncation/u)
  assert.throws(() => canonicalSnapshot({ ...snapshot, runtimeId: "not-an-id" }), /runtimeId/u)
  assert.throws(() => canonicalSnapshot({ ...snapshot, bounds: { ...snapshot.bounds, width: -1 } }), /width/u)
  assert.throws(() => canonicalSnapshot({ ...snapshot, name: "x".repeat(1_025) }), /unbounded/u)
})

const captureWindow = {
  processId: 19_756,
  windowHandle: "0x15028C",
  title: "OC | open-rig",
  className: "CASCADIA_HOSTING_WINDOW_CLASS",
}

const capturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p8sAAAAASUVORK5CYII=",
  "base64",
)

test("accepts only a bounded exact Windows window handle, process, and title", () => {
  assert.deepEqual(validateWindowsCapture(captureWindow), {
    processId: 19_756,
    windowHandle: "0x15028c",
    title: "OC | open-rig",
    className: "CASCADIA_HOSTING_WINDOW_CLASS",
  })
  assert.deepEqual(validateWindowsCapture({ ...captureWindow, className: undefined }), {
    processId: 19_756,
    windowHandle: "0x15028c",
    title: "OC | open-rig",
  })
  assert.throws(() => validateWindowsCapture({ ...captureWindow, processId: 0 }), /processId/u)
  assert.throws(() => validateWindowsCapture({ ...captureWindow, windowHandle: "19756" }), /windowHandle/u)
  assert.throws(() => validateWindowsCapture({ ...captureWindow, windowHandle: "0x12g4" }), /windowHandle/u)
  assert.throws(() => validateWindowsCapture({ ...captureWindow, windowHandle: `0x${"a".repeat(17)}` }), /windowHandle/u)
  assert.throws(() => validateWindowsCapture({ ...captureWindow, title: "OC\nopen-rig" }), /title/u)
  assert.throws(() => validateWindowsCapture({ ...captureWindow, title: "x".repeat(1_025) }), /title/u)
  assert.throws(() => validateWindowsCapture({ ...captureWindow, className: "x".repeat(513) }), /className/u)
})

test("decodes only a bounded PNG bound to the exact captured window identity", () => {
  const expected = validateWindowsCapture(captureWindow)
  const host = {
    windowId: "c".repeat(64),
    processId: 19_756,
    windowHandle: "0x15028C",
    title: "OC | open-rig",
    className: "CASCADIA_HOSTING_WINDOW_CLASS",
    bounds: { x: -1_287, y: 6, width: 1_294, height: 1_399 },
    mimeType: "image/png",
    data: capturePng.toString("base64"),
    bytes: capturePng.length,
    width: 1,
    height: 1,
  }
  assert.deepEqual(parseWindowsCapture(host, expected), {
    windowId: host.windowId,
    processId: 19_756,
    windowHandle: "0x15028c",
    title: "OC | open-rig",
    className: "CASCADIA_HOSTING_WINDOW_CLASS",
    bounds: { x: -1_287, y: 6, width: 1_294, height: 1_399 },
    mimeType: "image/png",
    data: host.data,
    bytes: capturePng.length,
    width: 1,
    height: 1,
  })
  assert.throws(() => parseWindowsCapture({ ...host, processId: 999 }, expected), /identity/u)
  assert.throws(() => parseWindowsCapture({ ...host, windowHandle: "0x999" }, expected), /identity/u)
  assert.throws(() => parseWindowsCapture({ ...host, title: "other" }, expected), /identity/u)
  assert.throws(() => parseWindowsCapture({ ...host, windowId: "not-a-window-id" }, expected), /identity/u)
  assert.throws(() => parseWindowsCapture({ ...host, data: "!!!!" }, expected), /base64/u)
  assert.throws(() => parseWindowsCapture({ ...host, width: 2 }, expected), /PNG/u)
})

test("reports validated provenance and bounded retention for an exact window capture", () => {
  const expected = validateWindowsCapture(captureWindow)
  const capture = parseWindowsCapture({
    windowId: "c".repeat(64),
    processId: 19_756,
    windowHandle: "0x15028C",
    title: "OC | open-rig",
    className: "CASCADIA_HOSTING_WINDOW_CLASS",
    bounds: { x: -1_287, y: 6, width: 1_294, height: 1_399 },
    mimeType: "image/png",
    data: capturePng.toString("base64"),
    bytes: capturePng.length,
    width: 1,
    height: 1,
  }, expected)

  const omitted = captureProvenanceText(capture, undefined, false)
  for (const field of ["windowId", "processId", "windowHandle", "title", "className", "bounds"]) {
    assert.match(omitted, new RegExp(`"${field}"`, "u"))
  }
  assert.match(omitted, /"windowId":"c{64}"/u)
  assert.match(omitted, /"processId":19756/u)
  assert.match(omitted, /"windowHandle":"0x15028c"/u)
  assert.match(omitted, /"title":"OC \| open-rig"/u)
  assert.match(omitted, /"bounds":\{"x":-1287,"y":6,"width":1294,"height":1399\}/u)
  assert.match(omitted, /No file was retained because savePath was omitted\./u)
  assert.match(omitted, /does not accept windows_capture as a rendered-visual capture method/u)

  const retained = captureProvenanceText(capture, {
    path: "evidence/probe.png",
    sha256: "a".repeat(64),
    dimensions: { width: 1, height: 1 },
  }, true)
  assert.match(retained, /Retained PNG: \{"path":"evidence\/probe\.png","sha256":"a{64}","dimensions":\{"width":1,"height":1\}\}/u)

  assert.match(captureProvenanceText(capture, undefined, true), /Retention failed, so no file was written\./u)
})

const restoreWindow = {
  processId: 19_756,
  windowHandle: "0x15028C",
  title: "OC | open-rig",
  className: "CASCADIA_HOSTING_WINDOW_CLASS",
}

const restoreTarget = {
  windowId: "d".repeat(64),
  processId: 19_756,
  windowHandle: "0x15028c",
  title: "OC | open-rig",
  className: "CASCADIA_HOSTING_WINDOW_CLASS",
  processStartTimeTicks: 638_000_000_000_000_000,
  iconic: true,
  visible: true,
  bounds: { x: -1_287, y: 6, width: 1_294, height: 1_399 },
  normalBounds: { x: -1_287, y: 6, width: 1_294, height: 1_399 },
  showCmd: 1,
}

const restoreCaller = { sessionID: "ses_restore", agent: "build", fingerprint: "restore-wsl-fingerprint" }

const wslStatus: WslStatus = {
  platform: "linux",
  isWsl: true,
  version: 2,
  kernel: "microsoft-standard-WSL2",
  workspace: "linux",
  systemd: { configured: true, running: true, state: "running" },
  interop: { configured: true, registered: true, pathEnabled: true },
  wslg: false,
  network: { proxyConfigured: false, customCaConfigured: false },
  fingerprint: restoreCaller.fingerprint,
}

function restoreManager(): WindowsUiManager {
  return new WindowsUiManager(
    "/workspace",
    { preferred: "auto", timeoutMs: 10_000, maxOutputBytes: 262_144 },
    { enabled: true, tokenTtlMs: 60_000, maxScriptBytes: 65_536, maxTokens: 128 },
    async () => wslStatus,
  )
}

test("accepts only a bounded exact Windows window selection for restore", () => {
  assert.deepEqual(validateWindowsRestore(restoreWindow), {
    processId: 19_756,
    windowHandle: "0x15028c",
    title: "OC | open-rig",
    className: "CASCADIA_HOSTING_WINDOW_CLASS",
  })
  assert.throws(() => validateWindowsRestore({ ...restoreWindow, processId: 0 }), /processId/u)
  assert.throws(() => validateWindowsRestore({ ...restoreWindow, windowHandle: "19756" }), /windowHandle/u)
  assert.throws(() => validateWindowsRestore({ ...restoreWindow, title: "OC\nopen-rig" }), /title/u)
})

test("binds the restore target to the exact identity and rejects every mismatch", () => {
  const expected = validateWindowsRestore(restoreWindow)
  assert.deepEqual(parseRestoreTarget(restoreTarget, expected), { ...restoreTarget })
  assert.deepEqual(parseRestorePreview({ mode: "preview", target: restoreTarget }, expected), { ...restoreTarget })
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, windowId: "not-an-id" }, expected), /identity/u)
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, processId: 999 }, expected), /process identity/u)
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, windowHandle: "0x999" }, expected), /window handle/u)
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, title: "other" }, expected), /exact title/u)
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, className: "Other" }, expected), /exact class/u)
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, processStartTimeTicks: 0 }, expected), /start time/u)
  assert.throws(() => parseRestoreTarget({ ...restoreTarget, processStartTimeTicks: 1.5 }, expected), /start time/u)
  assert.throws(() => parseRestorePreview({ mode: "preview", target: { ...restoreTarget, iconic: false } }, expected), /genuinely minimized/u)
})

test("confirms an applied restore only when identity and normal placement are unchanged", () => {
  const expected = validateWindowsRestore(restoreWindow)
  const restored = { ...restoreTarget, iconic: false, visible: true }
  assert.deepEqual(parseRestoreApply({ mode: "apply", restored: true, target: restoreTarget, after: restored }, expected), {
    target: { ...restoreTarget },
    after: { ...restored },
  })
  assert.throws(() => parseRestoreApply({ mode: "apply", restored: false, target: restoreTarget, after: restored }, expected), /did not confirm/u)
  assert.throws(() => parseRestoreApply({ mode: "apply", restored: true, target: { ...restoreTarget, iconic: false }, after: restored }, expected), /genuinely minimized/u)
  assert.throws(() => parseRestoreApply({ mode: "apply", restored: true, target: restoreTarget, after: { ...restored, iconic: true } }, expected), /visible and unminimized/u)
  assert.throws(() => parseRestoreApply({ mode: "apply", restored: true, target: restoreTarget, after: { ...restored, visible: false } }, expected), /visible and unminimized/u)
  assert.throws(() => parseRestoreApply({ mode: "apply", restored: true, target: restoreTarget, after: { ...restored, windowId: "e".repeat(64) } }, expected), /target identity/u)
  assert.throws(() => parseRestoreApply({ mode: "apply", restored: true, target: restoreTarget, after: { ...restored, normalBounds: { ...restored.normalBounds, x: 0 } } }, expected), /normal placement/u)
})

test("the restore method uses SW_SHOWNOACTIVATE and exposes no activation, focus, move, or input API", async () => {
  const source = await readFile(new URL("../powershell/OpenRig.WindowsHost.ps1", import.meta.url), "utf8")
  const start = source.indexOf("function Invoke-WindowRestore")
  const end = source.indexOf("\nfunction Get-BrowserScreenshot")
  assert.ok(start >= 0 && end > start, "Invoke-WindowRestore must exist before Get-BrowserScreenshot")
  const restore = source.slice(start, end)
  assert.match(restore, /SW_SHOWNOACTIVATE/u)
  assert.match(restore, /ShowWindow\(\$before\.handle/u)
  assert.match(restore, /IsIconic/u)
  assert.match(restore, /hidden but not minimized/u)
  assert.doesNotMatch(restore, /SW_RESTORE|SetForegroundWindow|SetWindowPos|SetCursorPos|SendInput|mouse_event|SetFocus|SetActiveWindow|BringWindowToTop/u)

  const nativeStart = source.indexOf("function Import-RestoreNative")
  const nativeEnd = source.indexOf("\nfunction Get-BrowserScheme")
  assert.ok(nativeStart >= 0 && nativeEnd > nativeStart, "Import-RestoreNative must exist before Get-BrowserScheme")
  const native = source.slice(nativeStart, nativeEnd)
  assert.match(native, /ShowWindow/u)
  assert.doesNotMatch(native, /SetForegroundWindow|SetWindowPos|SetCursorPos|SendInput|mouse_event|SetFocus|SetActiveWindow|BringWindowToTop/u)
})

test("restore preview is read-only and apply requires the exact single-use token", async () => {
  const originalRequest = PowerShellHostClient.prototype.request
  const originalRequestExact = PowerShellHostClient.prototype.requestExact
  const calls: Array<{ kind: string; method: string; params: Record<string, unknown> }> = []
  PowerShellHostClient.prototype.request = async (_preferred, method, params) => {
    calls.push({ kind: "request", method, params })
    return {
      executable: "pwsh.exe",
      executablePath: "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
      executableIdentity: "identity-one",
      result: { mode: "preview", target: restoreTarget },
    }
  }
  PowerShellHostClient.prototype.requestExact = async (_name, _path, _identity, method, params) => {
    calls.push({ kind: "requestExact", method, params })
    return {
      executable: "pwsh.exe",
      executablePath: "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
      executableIdentity: "identity-one",
      result: { mode: "apply", restored: true, target: restoreTarget, after: { ...restoreTarget, iconic: false } },
    }
  }
  try {
    const manager = restoreManager()
    const preview = await manager.restore({ ...restoreWindow }, restoreCaller)
    assert.equal(preview.action, "preview")
    assert.equal(typeof preview.expectToken, "string")
    assert.equal(calls.filter((call) => call.kind === "request").length, 1)
    assert.equal(calls.filter((call) => call.kind === "requestExact").length, 0, "preview must not mutate the window")

    const applied = await manager.restore({ ...restoreWindow, apply: true, expectToken: String(preview.expectToken) }, restoreCaller)
    assert.equal(applied.action, "apply")
    const exact = calls.find((call) => call.kind === "requestExact")
    assert.ok(exact, "apply must call the exact host method")
    assert.equal(exact.method, "windows.restore")
    assert.deepEqual(exact.params.expectedTarget, restoreTarget)

    await assert.rejects(
      () => manager.restore({ ...restoreWindow, apply: true, expectToken: String(preview.expectToken) }, restoreCaller),
      /missing, expired, or already used|previewed state changed/u,
    )
    await assert.rejects(
      () => manager.restore({ ...restoreWindow, apply: true }, restoreCaller),
      /requires expectToken/u,
    )
  } finally {
    PowerShellHostClient.prototype.request = originalRequest
    PowerShellHostClient.prototype.requestExact = originalRequestExact
  }
})

test("restore rejects a foreign caller, a changed target, and a non-minimized target", async () => {
  const originalRequest = PowerShellHostClient.prototype.request
  let currentTarget: Record<string, unknown> = { ...restoreTarget }
  PowerShellHostClient.prototype.request = async () => ({
    executable: "pwsh.exe",
    executablePath: "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
    executableIdentity: "identity-one",
    result: { mode: "preview", target: currentTarget },
  })
  try {
    const manager = restoreManager()
    const foreign = await manager.restore({ ...restoreWindow }, restoreCaller)
    await assert.rejects(
      () => manager.restore({ ...restoreWindow, apply: true, expectToken: String(foreign.expectToken) }, { ...restoreCaller, sessionID: "ses_other" }),
      /previewed state changed/u,
    )

    const changed = await manager.restore({ ...restoreWindow }, restoreCaller)
    currentTarget = { ...restoreTarget, bounds: { ...restoreTarget.bounds, x: -1_200 } }
    await assert.rejects(
      () => manager.restore({ ...restoreWindow, apply: true, expectToken: String(changed.expectToken) }, restoreCaller),
      /previewed state changed/u,
    )

    currentTarget = { ...restoreTarget, iconic: false, visible: true }
    await assert.rejects(() => manager.restore({ ...restoreWindow }, restoreCaller), /genuinely minimized/u)
  } finally {
    PowerShellHostClient.prototype.request = originalRequest
  }
})

test("restore intent tokens reject stale, replayed, and foreign replays", () => {
  let now = 1_000
  const token = "restore_token_1234567890"
  const store = new RawTokenStore(10_000, () => now, () => token)
  const intent: RawIntent = {
    sessionID: restoreCaller.sessionID,
    agent: restoreCaller.agent,
    script: JSON.stringify({ operation: { ...restoreWindow }, target: restoreTarget }),
    executable: "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
    executableIdentity: "identity-one",
    workingDirectory: "/workspace",
    fingerprint: restoreCaller.fingerprint,
    timeoutMs: 10_000,
  }
  const replay = store.preview(intent)
  store.consume(replay.expectToken, intent)
  assert.throws(() => store.consume(replay.expectToken, intent), /missing, expired, or already used/u)

  const foreign = store.preview(intent)
  assert.throws(() => store.consume(foreign.expectToken, { ...intent, sessionID: "ses_other" }), /state changed/u)

  const stale = store.preview(intent)
  now = 11_001
  assert.throws(() => store.consume(stale.expectToken, intent), /missing, expired, or already used/u)
})
