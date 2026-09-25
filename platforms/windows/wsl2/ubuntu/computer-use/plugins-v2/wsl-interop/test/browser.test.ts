import assert from "node:assert/strict"
import test from "node:test"

import {
  WindowsBrowserManager,
  validateBrowserAction,
  validateBrowserUrl,
  type BrowserHostResponse,
  type BrowserHostTransport,
} from "../src/browser.ts"
import type { HostRequestOptions } from "../src/powershell-host.ts"
import type { PowerShellOptions, RawOptions, WslStatus } from "../src/types.ts"

const windowId = "a".repeat(64)
const elementId = "b".repeat(64)
const executablePath = "/mnt/c/Program Files/PowerShell/7/pwsh.exe"
const executableIdentity = "trusted-powershell-identity"

const window = {
  windowId,
  processId: 4_201,
  windowHandle: "0x1234",
  runtimeId: "42.1",
  title: "Default browser",
  className: "BrowserWindow",
  bounds: { x: 10, y: 20, width: 1280, height: 720 },
}

const element = {
  windowId,
  elementId,
  processId: 4_201,
  runtimeId: "42.1.7",
  name: "Search",
  automationId: "searchBox",
  controlType: "ControlType.Edit",
  className: "TextBox",
  enabled: true,
  offscreen: false,
  bounds: { x: 40, y: 80, width: 340, height: 32 },
}

const wslStatus: WslStatus = {
  platform: "linux",
  isWsl: true,
  version: 2,
  distro: "Ubuntu",
  kernel: "Microsoft WSL2",
  workspace: "linux",
  systemd: { configured: true, running: true, state: "running" },
  interop: { configured: true, registered: true, pathEnabled: true },
  wslg: true,
  network: { proxyConfigured: false, customCaConfigured: false },
  fingerprint: "wsl-fingerprint",
}

const powershell: PowerShellOptions = {
  preferred: "auto",
  timeoutMs: 10_000,
  maxOutputBytes: 262_144,
}

const raw: RawOptions = {
  enabled: true,
  tokenTtlMs: 60_000,
  maxScriptBytes: 65_536,
  maxTokens: 128,
}

type ResponseFactory = (method: string, params: Record<string, unknown>) => unknown

class FakeBrowserHost implements BrowserHostTransport {
  readonly respond: ResponseFactory
  readonly requests: Array<{
    preferred: string
    method: string
    params: Record<string, unknown>
    options?: HostRequestOptions
  }> = []
  readonly exactRequests: Array<{
    name: string
    expectedPath: string
    expectedIdentity: string
    method: string
    params: Record<string, unknown>
    options?: HostRequestOptions
  }> = []

  constructor(respond: ResponseFactory) {
    this.respond = respond
  }

  async request(
    preferred: "auto" | "pwsh.exe" | "powershell.exe",
    method: string,
    params: Record<string, unknown>,
    options?: HostRequestOptions,
  ): Promise<BrowserHostResponse> {
    this.requests.push({ preferred, method, params, options })
    return {
      executable: "pwsh.exe",
      executablePath,
      executableIdentity,
      result: this.respond(method, params),
    }
  }

  async requestExact(
    name: "pwsh.exe" | "powershell.exe",
    expectedPath: string,
    expectedIdentity: string,
    method: string,
    params: Record<string, unknown>,
    options?: HostRequestOptions,
  ): Promise<BrowserHostResponse> {
    this.exactRequests.push({ name, expectedPath, expectedIdentity, method, params, options })
    return {
      executable: name,
      executablePath: expectedPath,
      executableIdentity: expectedIdentity,
      result: this.respond(method, params),
    }
  }
}

function manager(host: BrowserHostTransport, status: WslStatus = wslStatus): WindowsBrowserManager {
  return new WindowsBrowserManager("/workspace", powershell, raw, async () => status, host)
}

function png1x1(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p8sAAAAASUVORK5CYII=", "base64")
}

test("reports default URL request acceptance without claiming observed navigation", async () => {
  const host = new FakeBrowserHost((method) => {
    assert.equal(method, "browser.open")
    return { requestAccepted: true, scheme: "https", association: "Windows.Url.Default" }
  })
  const result = await manager(host).open({ url: "https://example.test:443/start" })

  assert.deepEqual(host.requests[0], {
    preferred: "auto",
    method: "browser.open",
    params: { url: "https://example.test/start" },
    options: { signal: undefined },
  })
  assert.deepEqual(result, {
    requestAccepted: true,
    scheme: "https",
    association: "Windows default URL association",
    untrusted: true,
  })
  await assert.rejects(
    manager(new FakeBrowserHost(() => ({ opened: true, scheme: "https", association: "Windows.Url.Default" }))).open({ url: "https://example.test" }),
    /did not confirm the default-browser request/u,
  )
  assert.equal(validateBrowserUrl("http://example.test").scheme, "http")
  assert.throws(() => validateBrowserUrl("https://user:secret@example.test"), /credentials/u)
  assert.throws(() => validateBrowserUrl("file:///C:/private.txt"), /HTTP and HTTPS/u)
})

test("uses HTTPS by default and returns only explicitly identified UI Automation windows and elements", async () => {
  const host = new FakeBrowserHost((method, params) => {
    if (method === "browser.windows") return { scheme: "https", visited: 1, items: [window], truncated: false }
    if (method === "browser.snapshot") {
      assert.equal(params.windowId, windowId)
      return { window, items: [element], visited: 3, truncated: false }
    }
    throw new Error(`unexpected method ${method}`)
  })
  const browser = manager(host)

  const windows = await browser.windows()
  const snapshot = await browser.snapshot({ windowId })

  assert.deepEqual(host.requests[0]?.params, { scheme: "https", maxItems: 50 })
  assert.deepEqual(host.requests[1]?.params, { scheme: "https", windowId, maxDepth: 8, maxNodes: 1_000, maxResults: 150 })
  assert.deepEqual(windows.items, [window])
  assert.equal(snapshot.window && (snapshot.window as typeof window).windowId, windowId)
  assert.deepEqual(snapshot.items, [element])
})

test("accepts only a bounded PNG returned for the explicitly selected browser window", async () => {
  const image = png1x1()
  const host = new FakeBrowserHost((method, params) => {
    assert.equal(method, "browser.screenshot")
    assert.deepEqual(params, { scheme: "https", windowId })
    return {
      windowId,
      mimeType: "image/png",
      data: image.toString("base64"),
      bytes: image.length,
      width: 1,
      height: 1,
    }
  })

  const result = await manager(host).screenshot({ windowId })

  assert.deepEqual({
    windowId: result.windowId,
    mimeType: result.mimeType,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
  }, { windowId, mimeType: "image/png", bytes: image.length, width: 1, height: 1 })
  assert.equal(host.requests[0]?.options?.maxOutputBytes, 9 * 1024 * 1024)
})

test("previews a UIA action without exposing typed text, then applies once with the exact host identity", async () => {
  const host = new FakeBrowserHost((method) => {
    if (method === "browser.target") return { window, target: element, visited: 7, truncated: false }
    if (method === "browser.act") return { action: "type", windowId, elementId }
    throw new Error(`unexpected method ${method}`)
  })
  const browser = manager(host)
  const caller = { sessionID: "ses_test", agent: "general", fingerprint: wslStatus.fingerprint }
  const action = { windowId, elementId, action: "type" as const, value: "private search text" }

  const preview = await browser.act(action, caller)

  assert.equal(preview.action, "preview")
  assert.equal(JSON.stringify(preview).includes(action.value), false)
  await assert.rejects(browser.act({ ...action, expectToken: "" }, caller), /expectToken requires apply=true/u)
  assert.deepEqual(host.requests[0]?.params, {
    scheme: "https",
    windowId,
    elementId,
    maxDepth: 12,
    maxNodes: 2_000,
    maxResults: 2_000,
  })

  const applied = await browser.act({ ...action, apply: true, expectToken: String(preview.expectToken) }, caller)

  assert.deepEqual(applied, { action: "apply", requestedAction: "type", windowId, elementId, untrusted: true })
  assert.deepEqual(host.exactRequests[0], {
    name: "pwsh.exe",
    expectedPath: executablePath,
    expectedIdentity: executableIdentity,
    method: "browser.act",
    params: {
      scheme: "https",
      windowId,
      elementId,
      maxDepth: 12,
      maxNodes: 2_000,
      maxResults: 2_000,
      action: "type",
      value: action.value,
      key: undefined,
      expectedTarget: element,
    },
    options: { signal: undefined },
  })
  await assert.rejects(browser.act({ ...action, apply: true, expectToken: String(preview.expectToken) }, caller), /missing, expired, or already used/u)
  assert.throws(() => validateBrowserAction({ windowId, elementId, action: "press" }), /supported unmodified/u)
})

test("rejects mismatched UIA identities, bad WSL state, and malformed screenshots", async () => {
  const mismatchedHost = new FakeBrowserHost(() => ({
    window,
    target: { ...element, windowId: "c".repeat(64) },
    visited: 1,
    truncated: false,
  }))
  await assert.rejects(
    manager(mismatchedHost).act({ windowId, elementId, action: "click" }, {
      sessionID: "ses_test",
      agent: "general",
      fingerprint: wslStatus.fingerprint,
    }),
    /does not match the explicit window and element identities/u,
  )

  const validHost = new FakeBrowserHost(() => ({ requestAccepted: true, scheme: "https", association: "default" }))
  const changedStatus = { ...wslStatus, fingerprint: "changed" }
  await assert.rejects(manager(validHost, changedStatus).act({ windowId, elementId, action: "click" }, {
    sessionID: "ses_test",
    agent: "general",
    fingerprint: wslStatus.fingerprint,
  }), /WSL state changed/u)
  assert.equal(validHost.requests.length, 0)

  const malformedScreenshot = new FakeBrowserHost(() => ({
    windowId,
    mimeType: "image/png",
    data: Buffer.from("not a PNG").toString("base64"),
    bytes: 9,
    width: 1,
    height: 1,
  }))
  await assert.rejects(manager(malformedScreenshot).screenshot({ windowId }), /PNG data is malformed/u)
  await assert.rejects(manager(validHost).open({ url: "file:///C:/private.txt" }), /HTTP and HTTPS/u)
})
