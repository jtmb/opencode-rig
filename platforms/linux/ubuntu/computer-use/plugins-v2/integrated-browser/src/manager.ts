import { stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const MAX_URL_LENGTH = 2_048
export const MAX_TEXT_LENGTH = 4_096
export const MAX_SNAPSHOT_CHARS = 24_000
export const MAX_CONSOLE_ENTRIES = 100
export const MAX_CONSOLE_TEXT = 2_000
export const MAX_SCREENSHOT_BYTES = 2_000_000
export const MAX_TABS = 12
export const MAX_SESSIONS = 4
export const NAVIGATION_TIMEOUT_MS = 15_000
export const ACTION_TIMEOUT_MS = 5_000

const SESSION_ID = /^ses_[A-Za-z0-9]+$/
const TAB_ID = /^tab-[1-9][0-9]*$/
const URL_PROTOCOLS = new Set(["http:", "https:"])
const ACCESSIBLE_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption",
  "cell", "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition",
  "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid",
  "gridcell", "group", "heading", "img", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none",
  "note", "option", "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row",
  "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status",
  "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox",
  "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
])

export type BrowserSessionState = "stopped" | "starting" | "ready" | "error"

export interface BrowserTabStatus {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly loading: boolean
}

export interface BrowserStatus {
  readonly sessionID: string
  readonly state: BrowserSessionState
  readonly tabs: readonly BrowserTabStatus[]
  readonly currentTabID?: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly error?: string
}

export interface ConsoleEntry {
  readonly type: string
  readonly text: string
}

export interface BrowserLocatorLike {
  click(options?: { readonly timeout?: number }): Promise<void>
  fill(value: string, options?: { readonly timeout?: number }): Promise<void>
  nth(index: number): BrowserLocatorLike
}

export interface BrowserPageLike {
  url(): string
  title(): Promise<string>
  goto(url: string, options?: { readonly timeout?: number; readonly waitUntil?: "domcontentloaded" }): Promise<unknown>
  goBack(options?: { readonly timeout?: number }): Promise<unknown>
  goForward(options?: { readonly timeout?: number }): Promise<unknown>
  reload(options?: { readonly timeout?: number; readonly waitUntil?: "domcontentloaded" }): Promise<unknown>
  close(): Promise<void>
  setViewportSize(size: { readonly width: number; readonly height: number }): Promise<void>
  ariaSnapshot(options?: { readonly mode?: "ai" | "default"; readonly timeout?: number }): Promise<string>
  screenshot(options?: { readonly type?: "jpeg" | "png"; readonly quality?: number; readonly fullPage?: boolean; readonly timeout?: number }): Promise<Uint8Array>
  getByRole(role: string, options?: { readonly name: string; readonly exact?: boolean }): BrowserLocatorLike
  bringToFront?(): Promise<void>
  isClosed?(): boolean
  on(event: "console" | "close", listener: (value?: unknown) => void): void
}

export interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>
  pages(): readonly BrowserPageLike[]
  close(): Promise<void>
  setDefaultTimeout?(timeout: number): void
}

export interface BrowserLike {
  newContext(options?: {
    readonly viewport?: { readonly width: number; readonly height: number }
    readonly acceptDownloads?: boolean
  }): Promise<BrowserContextLike>
  close(): Promise<void>
  on?(event: "disconnected", listener: () => void): void
}

export interface PlaywrightRuntime {
  readonly chromium: {
    launch(options: { readonly headless: false; readonly timeout?: number }): Promise<BrowserLike>
  }
}

export type RuntimeLoader = (runtimeRoot: string) => Promise<PlaywrightRuntime>

export interface BrowserManagerOptions {
  readonly runtimeRoot?: string
  readonly maxSessions?: number
  readonly maxTabs?: number
  readonly maxConsoleEntries?: number
  readonly maxSnapshotChars?: number
  readonly maxScreenshotBytes?: number
  readonly navigationTimeoutMs?: number
  readonly defaultViewport?: { readonly width: number; readonly height: number }
  readonly runtimeLoader?: RuntimeLoader
  readonly onChanged?: (sessionID: string) => void | Promise<void>
}

interface TabRecord {
  readonly id: string
  readonly page: BrowserPageLike
  readonly console: ConsoleEntry[]
}

interface SessionRecord {
  readonly sessionID: string
  state: BrowserSessionState
  tabs: Map<string, TabRecord>
  currentTabID?: string
  nextTabNumber: number
  viewport: { width: number; height: number }
  browser?: BrowserLike
  context?: BrowserContextLike
  error?: string
  launchPromise?: Promise<BrowserStatus>
}

interface NormalizedOptions {
  readonly runtimeRoot: string
  readonly maxSessions: number
  readonly maxTabs: number
  readonly maxConsoleEntries: number
  readonly maxSnapshotChars: number
  readonly maxScreenshotBytes: number
  readonly navigationTimeoutMs: number
  readonly defaultViewport: { readonly width: number; readonly height: number }
  readonly runtimeLoader: RuntimeLoader
  readonly onChanged?: (sessionID: string) => void | Promise<void>
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`expected integer between ${minimum} and ${maximum}`)
  }
  return value
}

function boundedText(value: string, maximum: number): string {
  return value.slice(0, maximum)
}

function cleanText(value: string, maximum: number): string {
  return boundedText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " "), maximum)
}

function cleanError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return cleanText(text, 512) || "unknown browser error"
}

function defaultRuntimeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../browser-tools")
}

export function validateSessionID(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !SESSION_ID.test(value)) {
    throw new Error("invalid OpenCode session ID")
  }
  return value
}

export function validateTabID(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !TAB_ID.test(value)) {
    throw new Error("invalid browser tab ID")
  }
  return value
}

export function validateUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error(`URL must be a non-empty string of at most ${MAX_URL_LENGTH} characters`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error("URL is not valid")
  }
  if (!URL_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("only http:// and https:// URLs without embedded credentials are allowed")
  }
  return parsed.toString()
}

export function validateText(value: unknown, label: string, maximum = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be text of at most ${maximum} characters`)
  }
  return value
}

export function validateRole(value: unknown): string {
  if (typeof value !== "string" || !ACCESSIBLE_ROLES.has(value.toLowerCase())) {
    throw new Error("role must be a supported accessible role")
  }
  return value.toLowerCase()
}

export function validateNth(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("nth must be an integer between 1 and 100")
  }
  return value
}

export function validateViewport(value: { readonly width?: unknown; readonly height?: unknown }): { width: number; height: number } {
  return {
    width: boundedInteger(value.width, 1280, 320, 1920),
    height: boundedInteger(value.height, 720, 240, 1080),
  }
}

export async function loadPinnedRuntime(runtimeRoot: string): Promise<PlaywrightRuntime> {
  const entrypoint = path.join(runtimeRoot, "node_modules", "playwright", "index.mjs")
  try {
    const metadata = await stat(entrypoint)
    if (!metadata.isFile()) throw new Error("runtime entrypoint is not a regular file")
  } catch (error) {
    throw new Error(`pinned Playwright runtime is unavailable at ${entrypoint}; installation is not performed (${cleanError(error)})`)
  }
  try {
    const loaded = (await import(pathToFileURL(entrypoint).href)) as { readonly chromium?: unknown }
    if (!loaded.chromium || typeof loaded.chromium !== "object") throw new Error("playwright module has no chromium export")
    return { chromium: loaded.chromium as PlaywrightRuntime["chromium"] }
  } catch (error) {
    throw new Error(`pinned Playwright runtime could not be loaded from ${entrypoint} (${cleanError(error)})`)
  }
}

function normalizeOptions(options: BrowserManagerOptions): NormalizedOptions {
  const viewport = validateViewport(options.defaultViewport ?? {})
  return {
    runtimeRoot: path.resolve(options.runtimeRoot ?? defaultRuntimeRoot()),
    maxSessions: boundedInteger(options.maxSessions, MAX_SESSIONS, 1, MAX_SESSIONS),
    maxTabs: boundedInteger(options.maxTabs, MAX_TABS, 1, MAX_TABS),
    maxConsoleEntries: boundedInteger(options.maxConsoleEntries, MAX_CONSOLE_ENTRIES, 1, MAX_CONSOLE_ENTRIES),
    maxSnapshotChars: boundedInteger(options.maxSnapshotChars, MAX_SNAPSHOT_CHARS, 256, MAX_SNAPSHOT_CHARS),
    maxScreenshotBytes: boundedInteger(options.maxScreenshotBytes, MAX_SCREENSHOT_BYTES, 1_024, MAX_SCREENSHOT_BYTES),
    navigationTimeoutMs: boundedInteger(options.navigationTimeoutMs, NAVIGATION_TIMEOUT_MS, 1_000, NAVIGATION_TIMEOUT_MS),
    defaultViewport: viewport,
    runtimeLoader: options.runtimeLoader ?? loadPinnedRuntime,
    onChanged: options.onChanged,
  }
}

export class BrowserManager {
  private readonly options: NormalizedOptions
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(options: BrowserManagerOptions = {}) {
    this.options = normalizeOptions(options)
  }

  async launch(sessionIDInput: unknown, urlInput: unknown): Promise<BrowserStatus> {
    const sessionID = validateSessionID(sessionIDInput)
    const url = validateUrl(urlInput)
    const existing = this.sessions.get(sessionID)
    if (existing?.state === "ready") return this.status(sessionID)
    if (existing?.state === "starting" && existing.launchPromise) return existing.launchPromise
    if (existing?.state === "error") {
      await this.close(sessionID)
    }
    if (this.sessions.size >= this.options.maxSessions) throw new Error("browser session limit reached")

    const record: SessionRecord = {
      sessionID,
      state: "starting",
      tabs: new Map(),
      nextTabNumber: 1,
      viewport: { ...this.options.defaultViewport },
    }
    this.sessions.set(sessionID, record)
    record.launchPromise = this.start(record, url)
    return record.launchPromise
  }

  async close(sessionIDInput: unknown): Promise<BrowserStatus> {
    const sessionID = validateSessionID(sessionIDInput)
    const record = this.sessions.get(sessionID)
    if (!record) return this.stoppedStatus(sessionID)
    this.sessions.delete(sessionID)
    record.state = "stopped"
    await record.launchPromise?.catch(() => undefined)
    await this.closeResources(record)
    await this.emitChanged(sessionID)
    return this.stoppedStatus(sessionID)
  }

  async status(sessionIDInput: unknown): Promise<BrowserStatus> {
    const sessionID = validateSessionID(sessionIDInput)
    const record = this.sessions.get(sessionID)
    if (!record) return this.stoppedStatus(sessionID)
    this.syncPages(record)
    const tabs: BrowserTabStatus[] = []
    for (const tab of record.tabs.values()) {
      if (isPageClosed(tab.page)) continue
      let title = ""
      try {
        title = cleanText(await tab.page.title(), MAX_TEXT_LENGTH)
      } catch {
        title = ""
      }
      let url = ""
      try {
        url = cleanText(tab.page.url(), MAX_URL_LENGTH)
      } catch {
        url = ""
      }
      tabs.push({ id: tab.id, url, title, loading: false })
    }
    return {
      sessionID,
      state: record.state,
      tabs: tabs.slice(0, this.options.maxTabs),
      ...(record.currentTabID && record.tabs.has(record.currentTabID) ? { currentTabID: record.currentTabID } : {}),
      viewport: { ...record.viewport },
      ...(record.error ? { error: record.error } : {}),
    }
  }

  async navigate(sessionIDInput: unknown, urlInput: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    const url = validateUrl(urlInput)
    return this.runOnPage(sessionIDInput, tabIDInput, async (record, page) => {
      await page.goto(url, { timeout: this.options.navigationTimeoutMs, waitUntil: "domcontentloaded" })
      record.error = undefined
    })
  }

  async newTab(sessionIDInput: unknown, urlInput: unknown): Promise<BrowserStatus> {
    const session = this.readySession(sessionIDInput)
    const url = validateUrl(urlInput)
    this.syncPages(session)
    if (!session.context) throw new Error("browser context is unavailable")
    if (session.tabs.size >= this.options.maxTabs) throw new Error("browser tab limit reached")
    const page = await session.context.newPage()
    const tab = this.attachPage(session, page)
    session.currentTabID = tab.id
    try {
      await page.goto(url, { timeout: this.options.navigationTimeoutMs, waitUntil: "domcontentloaded" })
      session.error = undefined
    } catch (error) {
      session.error = cleanError(error)
      throw error
    } finally {
      await this.emitChanged(session.sessionID)
    }
    return this.status(session.sessionID)
  }

  async selectTab(sessionIDInput: unknown, tabIDInput: unknown): Promise<BrowserStatus> {
    const session = this.readySession(sessionIDInput)
    const tab = this.tab(session, tabIDInput)
    session.currentTabID = tab.id
    await tab.page.bringToFront?.()
    await this.emitChanged(session.sessionID)
    return this.status(session.sessionID)
  }

  async closeTab(sessionIDInput: unknown, tabIDInput: unknown): Promise<BrowserStatus> {
    const session = this.readySession(sessionIDInput)
    const tab = this.tab(session, tabIDInput)
    await tab.page.close()
    session.tabs.delete(tab.id)
    if (session.currentTabID === tab.id) session.currentTabID = session.tabs.keys().next().value
    await this.emitChanged(session.sessionID)
    return this.status(session.sessionID)
  }

  async back(sessionIDInput: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    return this.runOnPage(sessionIDInput, tabIDInput, async (record, page) => {
      await page.goBack({ timeout: this.options.navigationTimeoutMs })
      record.error = undefined
    })
  }

  async forward(sessionIDInput: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    return this.runOnPage(sessionIDInput, tabIDInput, async (record, page) => {
      await page.goForward({ timeout: this.options.navigationTimeoutMs })
      record.error = undefined
    })
  }

  async reload(sessionIDInput: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    return this.runOnPage(sessionIDInput, tabIDInput, async (record, page) => {
      await page.reload({ timeout: this.options.navigationTimeoutMs, waitUntil: "domcontentloaded" })
      record.error = undefined
    })
  }

  async snapshot(sessionIDInput: unknown, tabIDInput?: unknown): Promise<{ sessionID: string; tabID: string; text: string }> {
    const { session, tab } = this.pageFor(sessionIDInput, tabIDInput)
    const text = await tab.page.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT_MS })
    return { sessionID: session.sessionID, tabID: tab.id, text: cleanText(text, this.options.maxSnapshotChars) }
  }

  async consoleEntries(sessionIDInput: unknown, tabIDInput?: unknown, maxEntriesInput?: unknown): Promise<{ sessionID: string; tabID: string; entries: readonly ConsoleEntry[] }> {
    const { session, tab } = this.pageFor(sessionIDInput, tabIDInput)
    const maxEntries = boundedInteger(maxEntriesInput, this.options.maxConsoleEntries, 1, this.options.maxConsoleEntries)
    return { sessionID: session.sessionID, tabID: tab.id, entries: tab.console.slice(-maxEntries) }
  }

  async screenshot(sessionIDInput: unknown, tabIDInput?: unknown): Promise<{ sessionID: string; tabID: string; mimeType: "image/jpeg"; data: string }> {
    const { session, tab } = this.pageFor(sessionIDInput, tabIDInput)
    const bytes = await tab.page.screenshot({ type: "jpeg", quality: 60, fullPage: false, timeout: ACTION_TIMEOUT_MS })
    if (bytes.byteLength > this.options.maxScreenshotBytes) throw new Error("viewport screenshot exceeds the configured byte limit")
    return { sessionID: session.sessionID, tabID: tab.id, mimeType: "image/jpeg", data: Buffer.from(bytes).toString("base64") }
  }

  async viewport(sessionIDInput: unknown, widthInput: unknown, heightInput: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    const viewport = validateViewport({ width: widthInput, height: heightInput })
    const session = this.readySession(sessionIDInput)
    const tab = this.tab(session, tabIDInput ?? session.currentTabID)
    await tab.page.setViewportSize(viewport)
    session.viewport = viewport
    await this.emitChanged(session.sessionID)
    return this.status(session.sessionID)
  }

  async click(sessionIDInput: unknown, roleInput: unknown, nameInput: unknown, exactInput?: unknown, nthInput?: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    const locator = this.locator(sessionIDInput, roleInput, nameInput, exactInput, nthInput, tabIDInput)
    await locator.click({ timeout: ACTION_TIMEOUT_MS })
    const sessionID = validateSessionID(sessionIDInput)
    await this.emitChanged(sessionID)
    return this.status(sessionID)
  }

  async fill(sessionIDInput: unknown, roleInput: unknown, nameInput: unknown, valueInput: unknown, exactInput?: unknown, nthInput?: unknown, tabIDInput?: unknown): Promise<BrowserStatus> {
    const value = validateText(valueInput, "value")
    const locator = this.locator(sessionIDInput, roleInput, nameInput, exactInput, nthInput, tabIDInput)
    await locator.fill(value, { timeout: ACTION_TIMEOUT_MS })
    const sessionID = validateSessionID(sessionIDInput)
    await this.emitChanged(sessionID)
    return this.status(sessionID)
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.keys()]
    for (const sessionID of sessions) await this.close(sessionID)
  }

  private async start(record: SessionRecord, url: string): Promise<BrowserStatus> {
    try {
      const runtime = await this.options.runtimeLoader(this.options.runtimeRoot)
      record.browser = await runtime.chromium.launch({ headless: false, timeout: this.options.navigationTimeoutMs })
      record.browser.on?.("disconnected", () => {
        if (record.state === "ready") {
          record.state = "error"
          record.error = "Chromium window disconnected"
          void this.emitChanged(record.sessionID)
        }
      })
      record.context = await record.browser.newContext({ viewport: record.viewport, acceptDownloads: false })
      record.context.setDefaultTimeout?.(ACTION_TIMEOUT_MS)
      const page = await record.context.newPage()
      const tab = this.attachPage(record, page)
      record.currentTabID = tab.id
      record.state = "ready"
      try {
        await page.goto(url, { timeout: this.options.navigationTimeoutMs, waitUntil: "domcontentloaded" })
        record.error = undefined
      } catch (error) {
        record.error = cleanError(error)
      }
      await this.emitChanged(record.sessionID)
      return this.status(record.sessionID)
    } catch (error) {
      record.state = "error"
      record.error = cleanError(error)
      await this.closeResources(record)
      await this.emitChanged(record.sessionID)
      throw new Error(record.error)
    }
  }

  private async runOnPage(sessionIDInput: unknown, tabIDInput: unknown, action: (record: SessionRecord, page: BrowserPageLike) => Promise<void>): Promise<BrowserStatus> {
    const { session, tab } = this.pageFor(sessionIDInput, tabIDInput)
    try {
      await action(session, tab.page)
    } catch (error) {
      session.error = cleanError(error)
      await this.emitChanged(session.sessionID)
      throw error
    }
    await this.emitChanged(session.sessionID)
    return this.status(session.sessionID)
  }

  private locator(sessionIDInput: unknown, roleInput: unknown, nameInput: unknown, exactInput?: unknown, nthInput?: unknown, tabIDInput?: unknown): BrowserLocatorLike {
    const { tab } = this.pageFor(sessionIDInput, tabIDInput)
    const role = validateRole(roleInput)
    const name = validateText(nameInput, "accessible name", 256)
    const exact = exactInput === undefined ? false : exactInput === true
    const nth = validateNth(nthInput)
    const locator = tab.page.getByRole(role, { name, exact })
    return nth === undefined ? locator : locator.nth(nth - 1)
  }

  private readySession(sessionIDInput: unknown): SessionRecord {
    const sessionID = validateSessionID(sessionIDInput)
    const record = this.sessions.get(sessionID)
    if (!record || record.state !== "ready") {
      throw new Error(record?.error ? `browser is unavailable: ${record.error}` : "browser session is not launched")
    }
    this.syncPages(record)
    return record
  }

  private pageFor(sessionIDInput: unknown, tabIDInput?: unknown): { session: SessionRecord; tab: TabRecord } {
    const session = this.readySession(sessionIDInput)
    return { session, tab: this.tab(session, tabIDInput ?? session.currentTabID) }
  }

  private tab(session: SessionRecord, tabIDInput: unknown): TabRecord {
    const tabID = validateTabID(tabIDInput)
    const tab = session.tabs.get(tabID)
    if (!tab || isPageClosed(tab.page)) throw new Error("browser tab is not available")
    session.currentTabID = tab.id
    return tab
  }

  private syncPages(record: SessionRecord): void {
    if (!record.context) return
    let pages: readonly BrowserPageLike[]
    try {
      pages = record.context.pages()
    } catch {
      return
    }
    for (const page of pages.slice(0, this.options.maxTabs)) {
      if (![...record.tabs.values()].some((tab) => tab.page === page)) this.attachPage(record, page)
    }
    for (const page of pages.slice(this.options.maxTabs)) void page.close().catch(() => undefined)
    for (const [tabID, tab] of record.tabs) {
      if (isPageClosed(tab.page)) record.tabs.delete(tabID)
    }
    if (record.currentTabID && !record.tabs.has(record.currentTabID)) record.currentTabID = record.tabs.keys().next().value
  }

  private attachPage(record: SessionRecord, page: BrowserPageLike): TabRecord {
    const tab: TabRecord = { id: `tab-${record.nextTabNumber++}`, page, console: [] }
    record.tabs.set(tab.id, tab)
    page.on("console", (value) => {
      const message = (value ?? {}) as { type?: () => unknown; text?: () => unknown }
      const type = typeof message.type === "function" ? String(message.type()) : "log"
      const text = typeof message.text === "function" ? String(message.text()) : String(value ?? "")
      tab.console.push({ type: cleanText(type, 32), text: cleanText(text, MAX_CONSOLE_TEXT) })
      if (tab.console.length > this.options.maxConsoleEntries) tab.console.splice(0, tab.console.length - this.options.maxConsoleEntries)
      void this.emitChanged(record.sessionID)
    })
    page.on("close", () => {
      record.tabs.delete(tab.id)
      if (record.currentTabID === tab.id) record.currentTabID = record.tabs.keys().next().value
      void this.emitChanged(record.sessionID)
    })
    return tab
  }

  private async closeResources(record: SessionRecord): Promise<void> {
    const context = record.context
    const browser = record.browser
    record.context = undefined
    record.browser = undefined
    record.tabs.clear()
    record.currentTabID = undefined
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }

  private stoppedStatus(sessionID: string): BrowserStatus {
    return { sessionID, state: "stopped", tabs: [], viewport: { ...this.options.defaultViewport } }
  }

  private emitChanged(sessionID: string): void {
    try {
      void Promise.resolve(this.options.onChanged?.(sessionID)).catch(() => undefined)
    } catch {
      // Status events are advisory; browser actions remain authoritative.
    }
  }
}

function isPageClosed(page: BrowserPageLike): boolean {
  try {
    return page.isClosed?.() === true
  } catch {
    return true
  }
}
