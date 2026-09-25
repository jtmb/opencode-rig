import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import type { FileDiffInfo } from "@opencode/client"
import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

import type { FileNode, TreeRow } from "../src/model.ts"

const { createSignal } = await import(import.meta.resolve("solid-js/dist/solid.js")) as {
  createSignal: <T>(value: T) => [() => T, (value: T | ((current: T) => T)) => T]
}
// Node's default Solid export is the server runtime; OpenTUI needs Solid's client transform and runtime.
const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const palette = { accent: "#8cc8ff", text: "#ffffff", subdued: "#888888", selected: "#333333" }
const identityTheme = {
  hue: { accent: { 200: palette.accent }, purple: { 200: "#d2a8ff" } },
  text: {
    default: palette.text,
    subdued: palette.subdued,
    action: { primary: { default: "#79c0ff", hovered: "#56d4dd" } },
    feedback: { error: { default: "#ff7b72" }, warning: { default: "#d29922" } },
  },
  background: {
    default: "#0d1117",
    surface: { offset: palette.selected },
    action: { primary: { default: "#161b22", hovered: "#30363d" } },
  },
}
const MARKERS = {
  hostile: "RIG_FILE_MANAGER_HOSTILE_RENDER_ASSERTIONS_EXECUTED",
  mouse: "RIG_FILE_MANAGER_MOUSE_RENDER_ASSERTIONS_EXECUTED",
  scroll: "RIG_FILE_MANAGER_SCROLL_RENDER_ASSERTIONS_EXECUTED",
  sidebar: "RIG_FILE_MANAGER_SIDEBAR_RENDER_ASSERTIONS_EXECUTED",
  fallback: "RIG_FILE_MANAGER_FALLBACK_RENDER_ASSERTIONS_EXECUTED",
  panel: "RIG_FILE_MANAGER_PANEL_RENDER_ASSERTIONS_EXECUTED",
} as const
const node = (path: string, type: "file" | "directory" = "file"): FileNode => ({
  name: path.split("/").at(-1) ?? path,
  path,
  type,
  ignored: false,
})
const rows = (...nodes: FileNode[]): TreeRow[] => nodes.map((entry) => ({ node: entry, depth: 0, expanded: entry.type === "directory" }))

type PresentationModule = {
  ExplorerTabs: unknown
  ExplorerTree: unknown
  explorerTabPresentation: (entry: { path: string; dirty: boolean }) => { cells: number }
  url: string
}

function resolveSourceImport(specifier: string, sourceDirectory: URL): string {
  if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
  if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
  return import.meta.resolve(specifier)
}

let presentationPromise: Promise<PresentationModule> | undefined
async function actualPresentationModule() {
  if (!presentationPromise) {
    presentationPromise = (async () => {
      const sourceURL = new URL("../src/presentation.ts", import.meta.url)
      const sourceDirectory = new URL("../src/", import.meta.url)
      const imports = await transformSolidSource(await readFile(sourceURL, "utf8"), {
        filename: sourceURL.pathname,
        moduleName: "@opentui/solid",
        resolvePath: (specifier) => resolveSourceImport(specifier, sourceDirectory),
      })
      const url = `data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`
      return { ...(await import(url) as Omit<PresentationModule, "url">), url }
    })()
  }
  return await presentationPromise
}

let filesViewPromise: Promise<{ FilesView: unknown; FilesSidebar: unknown }> | undefined
async function actualFilesViewModule() {
  if (!filesViewPromise) {
    filesViewPromise = (async () => {
      const sourceURL = new URL("../src/tui.tsx", import.meta.url)
      const source = await readFile(sourceURL, "utf8")
      const sourceDirectory = new URL("../src/", import.meta.url)
      const presentation = await actualPresentationModule()
      const imports = await transformSolidSource(source, {
        filename: sourceURL.pathname,
        moduleName: "@opentui/solid",
        resolvePath: (specifier) => resolveSourceImport(specifier, sourceDirectory),
      })
      const presentationSourceURL = new URL("../src/presentation.ts", import.meta.url).href
      const mappedImports = imports.replaceAll(presentationSourceURL, presentation.url)
      return await import(`data:text/javascript;base64,${Buffer.from(mappedImports).toString("base64")}`) as { FilesView: unknown; FilesSidebar: unknown }
    })()
  }
  return await filesViewPromise
}

async function actualFilesView() {
  return (await actualFilesViewModule()).FilesView
}

async function renderTree(treeRows: TreeRow[], width = 30, height = 8) {
  const { ExplorerTree } = await actualPresentationModule()
  const [selected, setSelected] = createSignal(treeRows[0]?.node.path ?? "")
  let scrollBox: { scrollTop: number } | undefined
  let activations = 0
  let setup: TestRendererSetup
  try {
    setup = await testRender(() => jsx("box", {
    width,
    height,
    borderStyle: "single",
    children: jsx(ExplorerTree as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
      rows: () => treeRows,
      selected,
      width: () => width - 2,
      palette,
      scrollRef: (value: { scrollTop: number }) => (scrollBox = value),
      onActivate: (row: TreeRow) => {
        activations += 1
        setSelected(row.node.path)
      },
    }),
    }), { width, height })
  } catch (error) {
    throw rendererFailure(error)
  }
  await setup.flush()
  return { setup, selected, setSelected, get scrollBox() { return scrollBox }, get activations() { return activations } }
}

function rendererFailure(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    "file-manager rendered FilesView checks require a supported OpenTUI native renderer; " +
    "run this package with OpenTUI's supported Node runtime (>=26.4) instead of skipping the assertions.",
    { cause: error },
  )
}

function changedFile(file: string): FileDiffInfo {
  return {
    file,
    patch: `--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n-console.log("old")\n+console.log("new")`,
    additions: 1,
    deletions: 1,
    status: "modified",
  }
}

function panelContext(
  root: string,
  changes: readonly FileDiffInfo[],
  callbacks: { onOpen?: () => void; onToast?: (message: string, variant?: string) => void } = {},
  theme: () => unknown = () => identityTheme,
  themeListeners = new Set<() => void>(),
): Context {
  const workspace = { tabs: {} as Record<string, { open: string[]; active: string }> }
  return {
    options: {},
    location: { directory: root },
    app: { version: "fixture", channel: "test" },
    renderer: {
      on: (event: string, listener: () => void) => { if (event === "palette" || event === "theme_mode") themeListeners.add(listener) },
      off: (_event: string, listener: () => void) => themeListeners.delete(listener),
    } as unknown as Context["renderer"],
    client: {
      vcs: { diff: async () => ({ data: changes }) },
      session: { diff: async () => changes },
      file: { find: async () => ({ data: [] }) },
    },
    data: {
      on: () => () => undefined,
      session: {
        get: () => ({ location: { directory: root } }),
        root: () => root,
        family: () => [],
        cost: () => 0,
        status: () => "idle",
        pending: { list: () => [], sync: async () => undefined, invalidate: () => undefined },
        sync: async () => undefined,
        invalidate: () => undefined,
        message: { list: () => [], get: () => undefined, sync: async () => undefined, invalidate: () => undefined },
        permission: { list: () => [], sync: async () => undefined, invalidate: () => undefined },
        form: { list: () => [], sync: async () => undefined, invalidate: () => undefined, reply: async () => undefined, cancel: async () => undefined },
      },
      location: { default: () => ({ directory: root }) },
    },
    attention: {} as Context["attention"],
    get theme() { return theme() },
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: { layer: () => () => undefined } as unknown as Context["keymap"],
    storage: {
      store: (_key: string, options: { initial: typeof workspace }) => [
        options.initial,
        async (mutation: (draft: typeof workspace) => void) => mutation(options.initial),
      ],
    },
    ui: {
      toast: { show: (options: { message: string; variant?: string }) => callbacks.onToast?.(options.message, options.variant) },
      dialog: {
        prompt: async () => undefined,
        select: async () => undefined,
        alert: () => undefined,
      },
      panel: { open: () => { callbacks.onOpen?.(); return true }, close: () => undefined, toggleFullscreen: () => undefined },
    },
  } as unknown as Context
}

async function renderPanel(root: string, changes: readonly FileDiffInfo[], theme: () => unknown = () => identityTheme) {
  let closeCount = 0
  let fullscreenToggles = 0
  const filesView = await actualFilesView()
  const themeListeners = new Set<() => void>()
  const panel = {
    name: "file-manager.files",
    sessionID: "fixture-session",
    width: 80,
    presentation: "fullscreen" as const,
    focused: true,
    focus: () => undefined,
    close: () => { closeCount += 1 },
    toggleFullscreen: () => { fullscreenToggles += 1 },
  } as PanelInput
  let setup: TestRendererSetup
  try {
    setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
      value: panelContext(root, changes, {}, theme, themeListeners),
      get children() {
        return jsx(filesView as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
          sessionID: panel.sessionID,
          panel,
        })
      },
    }), { width: 120, height: 20 })
  } catch (error) {
    throw rendererFailure(error)
  }
  return { setup, panel, get closeCount() { return closeCount }, get fullscreenToggles() { return fullscreenToggles }, notifyThemeChange: () => themeListeners.forEach((listener) => listener()) }
}

async function flushPanel(view: { setup: TestRendererSetup }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await view.setup.flush()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test("rendered tree keeps hostile names inside one-line bordered rows", async () => {
  const view = await renderTree(rows(node("very-long\nname\t東京"), node("普通-unicode.ts")), 24, 6)
  const frame = view.setup.captureCharFrame()
  const lines = frame.split("\n")
  assert.ok(lines.length >= 6)
  assert.ok(lines.every((line) => line.length <= 24), frame)
  assert.ok(lines.some((line) => line.includes("�") || line.includes("…")))
  assert.ok(frame.includes("> "), frame)
  assert.ok(view.setup.captureSpans())
  process.stdout.write(`${MARKERS.hostile}\n`)
  view.setup.renderer.destroy()
})

test("mockMouse bubbles a row click once and tabs activate once", async () => {
  const view = await renderTree(rows(node("src", "directory"), node("file.ts")), 30, 6)
  assert.ok(view.setup.captureCharFrame().includes("> - src"), view.setup.captureCharFrame())
  await view.setup.mockMouse.click(6, 2)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await view.setup.flush()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(view.activations, 1)
  assert.equal(view.selected(), "file.ts")
  assert.ok(view.setup.captureCharFrame().includes(">   file.ts"), view.setup.captureCharFrame())
  view.setup.renderer.destroy()

  const { ExplorerTabs, explorerTabPresentation } = await actualPresentationModule()
  let active = "a.ts"
  let tabActivations = 0
  const tabs = await testRender(() => jsx(ExplorerTabs as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
    paths: () => [{ path: "a.ts", dirty: true }, { path: "b.ts", dirty: false }],
    active: () => active,
    palette,
    onActivate: (path: string) => { active = path; tabActivations += 1 },
  }), { width: 30, height: 2 })
  await tabs.flush()
  const tabFrame = tabs.captureCharFrame()
  assert.ok(tabFrame.includes("a.ts •  b.ts"), tabFrame)
  assert.ok(tabFrame.split("\n").every((line) => line.length <= 30), tabFrame)
  await tabs.mockMouse.click(explorerTabPresentation({ path: "a.ts", dirty: true }).cells + 1, 0)
  await tabs.flush()
  assert.equal(tabActivations, 1)
  assert.equal(active, "b.ts")
  process.stdout.write(`${MARKERS.mouse}\n`)
  tabs.renderer.destroy()
})

test("rendered tree scrolls the selected row into view at narrow and normal widths", async () => {
  const treeRows = rows(...Array.from({ length: 16 }, (_, index) => node(`nested-${index}-with-a-long-name.ts`)))
  for (const [width, height] of [[22, 5], [60, 8]] as const) {
    const view = await renderTree(treeRows, width, height)
    view.setSelected(treeRows.at(-1)!.node.path)
    await view.setup.flush()
    assert.ok((view.scrollBox?.scrollTop ?? 0) > 0)
    const frame = view.setup.captureCharFrame()
    assert.ok(frame.split("\n").every((line) => line.length <= width), `${width}x${height}\n${frame}`)
    view.setup.renderer.destroy()
  }
  process.stdout.write(`${MARKERS.scroll}\n`)
})

test("rendered navigator uses repository basename and copies the full session ID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rig-"))
  const sidebarSessionID = "ses_f3dccd030ffeMFYHc1ErKiXumi"
  try {
    const filesViewModule = await actualFilesViewModule()
    const FilesSidebar = filesViewModule.FilesSidebar as (props: Record<string, unknown>) => ReturnType<typeof jsx>
    const copied: string[] = []
    const toasts: Array<{ message: string; variant?: string }> = []
    let openCount = 0
    const clipboard = {
      writeText: async (text: string) => {
        copied.push(text)
        return {
          host: { status: "not-attempted" as const },
          terminal: { status: "attempted" as const, capability: "supported" as const },
        }
      },
    }
    let setup: TestRendererSetup | undefined
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: panelContext(root, [], { onOpen: () => { openCount += 1 }, onToast: (message, variant) => toasts.push({ message, variant }) }),
        get children() {
          return jsx(FilesSidebar, { sessionID: sidebarSessionID, clipboard })
        },
      }), { width: 24, height: 5 })
    } catch (error) {
      throw rendererFailure(error)
    }
    try {
      await setup.flush()
      const frame = setup.captureCharFrame()
      assert.match(frame, /> rig-/)
      assert.ok(frame.replace(/\s/g, "").includes(sidebarSessionID), frame)
      assert.ok(frame.split("\n").every((line) => line.length <= 24), frame)
      assert.doesNotMatch(frame, /▰|⧉|�/)
      assert.doesNotMatch(frame, /Explorer/)
      assert.doesNotMatch(frame, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      const sessionSpan = setup.captureSpans().lines
        .flatMap((captured) => captured.spans)
        .find((span) => span.text.includes("ses_"))
      assert.ok(sessionSpan && (sessionSpan.attributes & TextAttributes.DIM) !== 0)
      const line = frame.split("\n").find((candidate) => candidate.includes("ses_"))
      assert.ok(line)
      const x = line.indexOf("ses_") + 1
      await setup.mockMouse.click(x, frame.split("\n").indexOf(line))
      await setup.flush()
      assert.deepEqual(copied, [sidebarSessionID])
      assert.equal(openCount, 0)
      assert.deepEqual(toasts, [{ message: "Session ID copied to clipboard.", variant: "success" }])
      process.stdout.write(`${MARKERS.sidebar}\n`)
    } finally {
      setup?.renderer.destroy()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("native pointer hover highlights and restores the session ID without changing repository identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rig-hover-"))
  const sidebarSessionID = "ses_hover_fixture"
  const interactions: string[] = []
  try {
    const FilesSidebar = (await actualFilesViewModule()).FilesSidebar as (props: Record<string, unknown>) => ReturnType<typeof jsx>
    const clipboard = {
      writeText: async () => ({
        host: { status: "not-attempted" as const },
        terminal: { status: "attempted" as const, capability: "supported" as const },
      }),
    }
    let setup: TestRendererSetup | undefined
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: panelContext(root, []),
        get children() {
          return jsx(FilesSidebar, { sessionID: sidebarSessionID, clipboard })
        },
      }), { width: 28, height: 5 })
      await setup.flush()
      const initial = setup.captureCharFrame()
      const lineIndex = initial.split("\n").findIndex((line) => line.includes("ses_hover_fixture"))
      const line = initial.split("\n")[lineIndex] ?? ""
      const x = line.indexOf("ses_hover_fixture") + 1
      assert.ok(lineIndex >= 0 && x > 0, initial)

      await setup.mockMouse.moveTo(x, lineIndex)
      await setup.flush()
      interactions.push("hover-enter")
      const entered = setup.captureSpans().lines.flatMap((captured) => captured.spans).find((span) => span.text.includes("ses_hover_fixture"))
      assert.ok(entered && (entered.attributes & TextAttributes.BOLD) !== 0)
      assert.ok(entered && (entered.attributes & TextAttributes.UNDERLINE) !== 0)
      assert.deepEqual(entered && entered.fg.toInts(), [86, 212, 221, 255])

      await setup.mockMouse.moveTo(0, Math.min(4, lineIndex + 2))
      await setup.flush()
      interactions.push("hover-leave")
      const left = setup.captureSpans().lines.flatMap((captured) => captured.spans).find((span) => span.text.includes("ses_hover_fixture"))
      assert.ok(left && (left.attributes & TextAttributes.DIM) !== 0)
      assert.ok(left && (left.attributes & TextAttributes.BOLD) === 0)
      assert.deepEqual(interactions, ["hover-enter", "hover-leave"])
    } finally {
      setup?.renderer.destroy()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rendered navigator uses the sole session ID without directory identity and reports copy failure", async () => {
  const FilesSidebar = (await actualFilesViewModule()).FilesSidebar as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const sidebarSessionID = "ses-no-directory-value-that-wraps"
  const toasts: Array<{ message: string; variant?: string }> = []
  const clipboard = {
    writeText: async () => ({
      host: { status: "unsupported" as const },
      terminal: { status: "not-attempted" as const, capability: "unsupported" as const },
    }),
  }
  let setup: TestRendererSetup | undefined
  try {
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: panelContext("", [], { onToast: (message, variant) => toasts.push({ message, variant }) }),
        get children() {
          return jsx(FilesSidebar, { sessionID: sidebarSessionID, clipboard })
        },
      }), { width: 20, height: 4 })
    } catch (error) {
      throw rendererFailure(error)
    }
    await setup.flush()
    const frame = setup.captureCharFrame()
    assert.ok(frame.replace(/\s/g, "").includes(sidebarSessionID), frame)
    assert.ok(frame.split("\n").every((line) => line.length <= 20), frame)
    assert.doesNotMatch(frame, /▰|⧉|�/)
    assert.equal((frame.match(/#/g) ?? []).length, 1)
    assert.doesNotMatch(frame, />/)
    const line = frame.split("\n").find((candidate) => candidate.includes("ses-"))
    assert.ok(line)
    await setup.mockMouse.click(line.indexOf("ses-") + 1, frame.split("\n").indexOf(line))
    await setup.flush()
    assert.deepEqual(toasts, [{ message: "Unable to copy the session ID.", variant: "error" }])
    process.stdout.write(`${MARKERS.fallback}\n`)
  } finally {
    setup?.renderer.destroy()
  }
})

test("rendered Explorer panel tolerates a minimal theme through open, navigation, diff, toggle, and close", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-file-manager-"))
  try {
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "src", "app.ts"), 'console.log("new")\n')
    await writeFile(path.join(root, "src", "second.ts"), 'export const second = true\n')
    const [theme, setTheme] = createSignal(identityTheme)
    const view = await renderPanel(root, [changedFile("src/app.ts")], theme)
    try {
      await flushPanel(view)
      await view.setup.waitForFrame((frame) => frame.includes("> + src"), { maxPasses: 100 })
      assert.doesNotMatch(view.setup.captureCharFrame(), /Explorer/)
      assert.match(view.setup.captureCharFrame(), /fixture-session/)

      view.setup.mockInput.pressEnter()
      await flushPanel(view)
      assert.match(view.setup.captureCharFrame(), /app\.ts/)

      view.setup.mockInput.pressArrow("down")
      view.setup.mockInput.pressEnter()
      await flushPanel(view)
      assert.match(view.setup.captureCharFrame(), /console\.log\("new"\)/)

      const sessionIDColors = () => view.setup.captureSpans().lines
        .flatMap((line) => line.spans)
        .filter((span) => span.text.includes("fixture-session"))
        .map((span) => span.fg.toInts())
      const beforeThemeSwitch = sessionIDColors()
      assert.ok(beforeThemeSwitch.some((color) => color.join(",") === "136,136,136,255"), JSON.stringify(beforeThemeSwitch))
      setTheme({ ...identityTheme, text: { ...identityTheme.text, subdued: "#ff00aa" } })
      view.notifyThemeChange()
      await flushPanel(view)
      const afterThemeSwitch = sessionIDColors()
      assert.ok(afterThemeSwitch.some((color) => color.join(",") === "255,0,170,255"), JSON.stringify(afterThemeSwitch))
      assert.notDeepEqual(afterThemeSwitch, beforeThemeSwitch)
      process.stdout.write("RIG_FILE_MANAGER_THEME_SWITCH_RENDER_ASSERTIONS_EXECUTED\n")

      view.setup.mockInput.pressKey("n")
      await flushPanel(view)
      assert.match(view.setup.captureCharFrame(), /second\.ts/)

      view.setup.mockInput.pressKey("a")
      await flushPanel(view)
      const splitFrame = view.setup.captureCharFrame()
      assert.match(splitFrame, /1 changed/)
      assert.match(splitFrame, /\[Diff: side by side\]/)

      view.setup.mockInput.pressKey("v")
      await flushPanel(view)
      const unifiedFrame = view.setup.captureCharFrame()
      assert.match(unifiedFrame, /\[Diff: full width\]/)
      assert.notEqual(unifiedFrame, splitFrame)

      view.setup.mockInput.pressKey("t")
      await flushPanel(view)
      const hiddenTreeFrame = view.setup.captureCharFrame()
      view.setup.mockInput.pressKey("t")
      await flushPanel(view)
      assert.notEqual(hiddenTreeFrame, view.setup.captureCharFrame())

      view.setup.mockInput.pressKey("q")
      await flushPanel(view)
      assert.equal(view.closeCount, 1)
      process.stdout.write(`${MARKERS.panel}\n`)
    } finally {
      view.setup.renderer.destroy()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
