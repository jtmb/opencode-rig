import assert from "node:assert/strict"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  BrowserManager,
  type BrowserContextLike,
  type BrowserLike,
  type BrowserLocatorLike,
  type BrowserPageLike,
  type PlaywrightRuntime,
  loadPinnedRuntime,
  validateUrl,
} from "../src/manager.ts"

type Listener = (value?: unknown) => void

class FakeLocator implements BrowserLocatorLike {
  readonly clicks: number[] = []
  readonly fills: string[] = []
  readonly fillTimeouts: Array<number | undefined> = []
  private readonly index: number

  constructor(index = 0) {
    this.index = index
  }

  async click(): Promise<void> {
    this.clicks.push(this.index)
  }

  async fill(value: string, options?: { readonly timeout?: number }): Promise<void> {
    this.fills.push(value)
    this.fillTimeouts.push(options?.timeout)
  }

  nth(index: number): BrowserLocatorLike {
    return new FakeLocator(index)
  }
}

class FakePage implements BrowserPageLike {
  private readonly listeners = new Map<string, Listener[]>()
  private closed = false
  private address = "about:blank"
  private pageTitle = "Test page"
  readonly locators: FakeLocator[] = []
  viewport = { width: 1280, height: 720 }
  screenshotTimeout?: number

  url(): string {
    return this.address
  }

  async title(): Promise<string> {
    return this.pageTitle
  }

  async goto(url: string): Promise<null> {
    this.address = url
    return null
  }

  async goBack(): Promise<null> {
    return null
  }

  async goForward(): Promise<null> {
    return null
  }

  async reload(): Promise<null> {
    return null
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }

  async setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void> {
    this.viewport = { ...size }
  }

  async ariaSnapshot(): Promise<string> {
    return "- document:\n  - heading: Test page"
  }

  async screenshot(options?: { readonly timeout?: number }): Promise<Uint8Array> {
    this.screenshotTimeout = options?.timeout
    return Uint8Array.from([1, 2, 3, 4])
  }

  getByRole(): BrowserLocatorLike {
    const locator = new FakeLocator()
    this.locators.push(locator)
    return locator
  }

  isClosed(): boolean {
    return this.closed
  }

  on(event: "console" | "close", listener: Listener): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  emit(event: "console" | "close", value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

class FakeContext implements BrowserContextLike {
  readonly pageList: FakePage[] = []
  closed = false
  defaultTimeout?: number

  async newPage(): Promise<FakePage> {
    const page = new FakePage()
    this.pageList.push(page)
    return page
  }

  pages(): readonly FakePage[] {
    return this.pageList.filter((page) => !page.isClosed())
  }

  async close(): Promise<void> {
    this.closed = true
    for (const page of this.pageList) await page.close()
  }

  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout
  }
}

class FakeBrowser implements BrowserLike {
  readonly contexts: FakeContext[] = []
  closed = false
  launchTimeout?: number

  async newContext(): Promise<FakeContext> {
    const context = new FakeContext()
    this.contexts.push(context)
    return context
  }

  async close(): Promise<void> {
    this.closed = true
    for (const context of this.contexts) await context.close()
  }
}

function runtimeFor(browser: FakeBrowser): PlaywrightRuntime {
  return { chromium: { launch: async (options) => {
    browser.launchTimeout = options.timeout
    return browser
  } } }
}

test("validates browser URLs and rejects unsupported or credential-bearing schemes", () => {
  assert.equal(validateUrl("https://example.test"), "https://example.test/")
  assert.equal(validateUrl("http://127.0.0.1:3000/path"), "http://127.0.0.1:3000/path")
  assert.throws(() => validateUrl("file:///tmp/private.txt"), /only http/)
  assert.throws(() => validateUrl("ftp://example.test"), /only http/)
  assert.throws(() => validateUrl("https://user:password@example.test"), /embedded credentials/)
  assert.throws(() => validateUrl("not a URL"), /URL is not valid/)
})

test("loads the existing pinned Playwright runtime without launching a browser", async () => {
  const runtimeRoot = fileURLToPath(new URL("../../../../browser-tools/", import.meta.url))
  const runtime = await loadPinnedRuntime(runtimeRoot)
  assert.equal(typeof runtime.chromium.launch, "function")
})

test("launches an isolated headed context and handles bounded browser actions", async () => {
  const browser = new FakeBrowser()
  const manager = new BrowserManager({ runtimeLoader: async () => runtimeFor(browser), maxTabs: 2 })
  const started = await manager.launch("ses_one", "https://example.test")
  assert.equal(started.state, "ready")
  assert.equal(started.tabs.length, 1)
  assert.equal(browser.launchTimeout, 15_000)
  assert.equal(browser.contexts[0]?.defaultTimeout, 5_000)
  assert.equal(started.tabs[0]?.url, "https://example.test/")
  const firstTab = started.currentTabID
  assert.ok(firstTab)
  const firstPage = browser.contexts[0]?.pageList[0]
  assert.ok(firstPage)
  firstPage.emit("console", { type: () => "warning", text: () => "bounded console output" })

  await manager.navigate("ses_one", "https://example.test/next", firstTab)
  await manager.back("ses_one", firstTab)
  await manager.forward("ses_one", firstTab)
  await manager.reload("ses_one", firstTab)
  const resized = await manager.viewport("ses_one", 800, 600, firstTab)
  assert.deepEqual(resized.viewport, { width: 800, height: 600 })

  const snapshot = await manager.snapshot("ses_one", firstTab)
  assert.match(snapshot.text, /Test page/)
  const logs = await manager.consoleEntries("ses_one", firstTab)
  assert.deepEqual(logs.entries, [{ type: "warning", text: "bounded console output" }])
  const image = await manager.screenshot("ses_one", firstTab)
  assert.equal(image.mimeType, "image/jpeg")
  assert.equal(image.data, "AQIDBA==")
  assert.equal(firstPage.screenshotTimeout, 5_000)

  const second = await manager.newTab("ses_one", "http://example.test/second")
  assert.equal(second.tabs.length, 2)
  assert.notEqual(second.currentTabID, firstTab)
  await assert.rejects(manager.newTab("ses_one", "https://example.test/third"), /tab limit/)
  await manager.selectTab("ses_one", firstTab)
  await manager.click("ses_one", "button", "Continue", false, 2, firstTab)
  await manager.fill("ses_one", "textbox", "Search", "bounded text", true, undefined, firstTab)
  assert.deepEqual(firstPage.locators.at(-1)?.fillTimeouts, [5_000])
  await assert.rejects(manager.click("ses_one", "not-a-role", "Continue", false, undefined, firstTab), /supported accessible role/)
  await assert.rejects(manager.viewport("ses_one", 319, 600, firstTab), /between 320 and 1920/)
  await manager.closeTab("ses_one", second.currentTabID)
  assert.equal((await manager.status("ses_one")).tabs.length, 1)

  const stopped = await manager.close("ses_one")
  assert.equal(stopped.state, "stopped")
  assert.equal(browser.closed, true)
})

test("keeps sessions isolated, enforces limits, and reports missing runtime without installing", async () => {
  const browsers: FakeBrowser[] = []
  const manager = new BrowserManager({
    maxSessions: 1,
    runtimeLoader: async () => {
      const browser = new FakeBrowser()
      browsers.push(browser)
      return runtimeFor(browser)
    },
  })
  await manager.launch("ses_one", "https://one.test")
  await assert.rejects(manager.launch("ses_two", "https://two.test"), /session limit/)
  assert.equal((await manager.status("ses_two")).state, "stopped")
  await manager.close("ses_one")
  await manager.launch("ses_two", "https://two.test")
  assert.equal((await manager.status("ses_two")).sessionID, "ses_two")
  await manager.dispose()
  assert.equal(browsers.length, 2)

  const unavailable = new BrowserManager({ runtimeLoader: async () => { throw new Error("Chromium executable is absent") } })
  await assert.rejects(unavailable.launch("ses_missing", "https://example.test"), /Chromium executable is absent/)
  assert.equal((await unavailable.status("ses_missing")).state, "error")
  await unavailable.close("ses_missing")
  await assert.rejects(loadPinnedRuntime("/definitely/missing/browser-tools"), /installation is not performed/)
})

test("removes externally closed pages from the session status", async () => {
  const browser = new FakeBrowser()
  const manager = new BrowserManager({ runtimeLoader: async () => runtimeFor(browser) })
  const status = await manager.launch("ses_close", "https://example.test")
  const page = browser.contexts[0]?.pageList[0]
  assert.ok(page)
  await page.close()
  const afterClose = await manager.status("ses_close")
  assert.equal(afterClose.tabs.length, 0)
  assert.equal(afterClose.currentTabID, undefined)
  await manager.close("ses_close")
  assert.equal(status.state, "ready")
})

test("closing during launch waits for and cleans up late browser resources", async () => {
  const browser = new FakeBrowser()
  let release: ((runtime: PlaywrightRuntime) => void) | undefined
  const manager = new BrowserManager({
    runtimeLoader: () => new Promise((resolve) => { release = resolve }),
  })
  const launching = manager.launch("ses_race", "https://example.test")
  const closing = manager.close("ses_race")
  assert.ok(release)
  release(runtimeFor(browser))
  assert.equal((await launching).state, "stopped")
  assert.equal((await closing).state, "stopped")
  assert.equal(browser.closed, true)
  assert.equal((await manager.status("ses_race")).state, "stopped")
})

test("advisory change events cannot block browser actions", async () => {
  const browser = new FakeBrowser()
  const manager = new BrowserManager({
    runtimeLoader: async () => runtimeFor(browser),
    onChanged: () => new Promise(() => {}),
  })
  assert.equal((await manager.launch("ses_events", "https://example.test")).state, "ready")
  assert.equal((await manager.close("ses_events")).state, "stopped")
  assert.equal(browser.closed, true)
})
