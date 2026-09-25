import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

import { serializeTodoState, todoStatePath } from "../src/state.ts"
import type { TodoItem } from "../src/store.ts"

const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const MARKER = "RIG_COMPOSED_SIDEBAR_RENDER_ASSERTIONS_EXECUTED"
const sessionID = "ses_composed_sidebar_fixture"

type Component = (props: Record<string, unknown>) => ReturnType<typeof jsx>

function dataURL(source: string) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
}

async function transformedSource(sourceURL: URL, replacements = new Map<string, string>()) {
  const sourceDirectory = new URL("./", sourceURL)
  const imports = await transformSolidSource(await readFile(sourceURL, "utf8"), {
    filename: sourceURL.pathname,
    moduleName: "@opentui/solid",
    resolvePath: (specifier) => {
      if (specifier === "./tasks-panel.tsx") return dataURL("export function TasksPanel() { return null }")
      if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
      if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
      return import.meta.resolve(specifier)
    },
  })
  let mapped = imports
  for (const [from, to] of replacements) mapped = mapped.replaceAll(from, to)
  const url = dataURL(mapped)
  return { module: await import(url) as Record<string, unknown>, url }
}

async function transformedModule(sourceURL: URL, replacements = new Map<string, string>()) {
  return (await transformedSource(sourceURL, replacements)).module
}

let componentsPromise: Promise<{
  TodoPanel: Component
  SourceControlPanel: Component
  UsagePanel: Component
  FilesSidebar: Component
}> | undefined

async function productionComponents() {
  if (!componentsPromise) {
    componentsPromise = (async () => {
      const sourceControl = await transformedModule(new URL("../../source-control/src/tui.tsx", import.meta.url))
      const codexUsage = await transformedModule(new URL("../../codex-usage/src/tui.tsx", import.meta.url))
      const presentationURL = new URL("../../file-manager/src/presentation.ts", import.meta.url)
      const presentation = await transformedSource(presentationURL)
      const fileManager = await transformedSource(
        new URL("../../file-manager/src/tui.tsx", import.meta.url),
        new Map([[presentationURL.href, presentation.url]]),
      )
      return {
        TodoPanel: (await transformedModule(new URL("../src/tui.tsx", import.meta.url))).TodoPanel as Component,
        SourceControlPanel: sourceControl.SourceControlPanel as Component,
        UsagePanel: codexUsage.UsagePanel as Component,
        FilesSidebar: fileManager.module.FilesSidebar as Component,
      }
    })()
  }
  return await componentsPromise
}

function theme(): Context["theme"] {
  return {
    hue: { accent: { 200: "#d985b9" } },
    text: {
      default: "#d8e1ee",
      subdued: "#9caec2",
      feedback: {
        info: { default: "#8cc8ff" },
        success: { default: "#8fd694" },
        warning: { default: "#e5c07b" },
        error: { default: "#e06c75" },
      },
    },
    diff: { text: { added: "#8fd694", removed: "#e06c75" } },
    border: { default: "#4f5b66" },
    background: { surface: { offset: "#27303a" } },
  } as unknown as Context["theme"]
}

function sourceStore() {
  const state = {
    status: "ready" as const,
    isGit: true,
    changes: Array.from({ length: 5 }, (_, index) => ({
      file: `src/sidebar/compact-preview-file-${index}.tsx`,
      additions: index + 1,
      deletions: index,
      status: index === 0 ? "added" as const : "modified" as const,
    })),
  }
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    refreshLocal: async () => undefined,
    refreshGithub: async () => undefined,
    dispose: () => undefined,
  }
}

function usageStore() {
  const state = {
    status: "ready" as const,
    providers: [{
      id: "deepseek",
      label: "DeepSeek",
      status: "quota-exhausted" as const,
      detail: "Verified balance is exhausted.",
      usage: "Balance USD 0.00",
    }],
  }
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    refresh: async () => state,
    dispose: () => undefined,
  }
}

function context(root: string): Context {
  const settings = { collapsed: false }
  return {
    options: {},
    location: { directory: root },
    app: { version: "fixture", channel: "test" },
    renderer: {} as Context["renderer"],
    client: {} as Context["client"],
    data: {
      on: () => () => undefined,
      session: { get: () => ({ location: { directory: root } }) },
      location: {
        default: () => ({ directory: root }),
        vcs: { info: () => ({ branch: { current: "main" } }), sync: async () => undefined },
      },
    } as unknown as Context["data"],
    attention: {} as Context["attention"],
    theme: theme(),
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: {} as Context["keymap"],
    storage: {
      store: () => [settings, async (mutation: (draft: typeof settings) => void) => mutation(settings)],
    } as unknown as Context["storage"],
    ui: {
      panel: { open: () => true },
      toast: { show: () => undefined },
    } as unknown as Context["ui"],
  } as unknown as Context
}

function rendererFailure(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    "the composed sidebar fixture requires a supported OpenTUI native renderer; " +
    "run it with OpenTUI's supported Node runtime (>=26.4) instead of skipping the assertions.",
    { cause: error },
  )
}

test("composed production plugin sections fit a narrow sidebar before the footer sentinel", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-rig-composed-sidebar-"))
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = root
  const todos: TodoItem[] = [
    { content: "in-progress task remains complete when wrapped in the narrow sidebar", status: "in_progress" },
    { content: "pending task remains complete when wrapped in the narrow sidebar", status: "pending" },
    { content: "completed history must not become a body essay", status: "completed" },
    { content: "cancelled history must not become a body essay", status: "cancelled" },
    ...Array.from({ length: 6 }, (_, index) => ({ content: `old completed task ${index}`, status: "completed" as const })),
  ]
  await mkdir(path.dirname(todoStatePath(sessionID)), { recursive: true })
  await writeFile(todoStatePath(sessionID), serializeTodoState(todos), "utf8")
  let setup: TestRendererSetup | undefined
  try {
    const components = await productionComponents()
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: context(root),
        get children() {
          return jsx("box", {
            width: "100%",
            height: "100%",
            flexDirection: "column",
            overflow: "hidden",
            children: [
              jsx(components.FilesSidebar, { sessionID }),
              jsx(components.TodoPanel, { sessionID }),
              jsx(components.SourceControlPanel, {
                store: sourceStore(),
                runtime: () => ({ refreshMs: 15_000, githubRefreshMs: 120_000, maxFiles: 3, startCollapsed: false }),
                setStartCollapsed: () => undefined,
                whenEmpty: "show",
              }),
              jsx(components.UsagePanel, { store: usageStore(), refreshMs: 60_000 }),
              jsx("text", { fg: theme().text.default, children: "FOOTER_SENTINEL" }),
            ],
          })
        },
      }), { width: 42, height: 28 })
    } catch (error) {
      throw rendererFailure(error)
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await setup.flush()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const visibleLines = lines.filter((line) => line.trim().length > 0)
    assert.ok(frame.replace(/\s/g, "").includes(sessionID), frame)
    assert.match(frame, /Todo/)
    assert.match(frame, /\+8 history items hidden/)
    assert.doesNotMatch(frame, /completed history must not become a body essay/)
    assert.doesNotMatch(frame, /cancelled history must not become a body essay/)
    assert.match(frame, /Source Control\s+5 changes/)
    assert.match(frame, /\+2 more files/)
    assert.match(frame, /Provider Usage/)
    assert.match(frame, /DeepSeek/)
    assert.match(frame, /EMPTY/)
    assert.match(frame, /Balance\s+USD 0\.00/)
    assert.match(frame, /FOOTER_SENTINEL/)
    assert.ok(visibleLines.length <= 28, frame)
    assert.ok(visibleLines.every((line) => line.length <= 42), frame)
    const todoIndex = visibleLines.findIndex((line) => line.includes("- Todo"))
    const sourceIndex = visibleLines.findIndex((line) => line.includes("- Source Control"))
    const providerIndex = visibleLines.findIndex((line) => line.includes("- Provider Usage"))
    const footerIndex = visibleLines.findIndex((line) => line.includes("FOOTER_SENTINEL"))
    assert.ok(todoIndex >= 0 && sourceIndex > todoIndex && providerIndex > sourceIndex && footerIndex > providerIndex, frame)
    assert.ok(!visibleLines[todoIndex]?.includes("Source Control"), frame)
    assert.ok(!visibleLines[sourceIndex]?.includes("Provider Usage"), frame)
  } finally {
    setup?.renderer.destroy()
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    await rm(root, { recursive: true, force: true })
  }
  process.stdout.write(`${MARKER}\n`)
})
