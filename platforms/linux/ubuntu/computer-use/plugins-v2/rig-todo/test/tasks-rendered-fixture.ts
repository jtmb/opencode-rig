import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

import { appendTodoTransitions, diffTodoTransitions, todoArchiveRoot } from "../src/archive.ts"
import { assignTodoIds, emptyTodoIdentity } from "../src/identity.ts"
import { serializeTodoState, todoStatePath } from "../src/state.ts"
import type { TodoItem } from "../src/store.ts"

const RENDER_ASSERTIONS_MARKER = "RIG_TODO_TASKS_RENDER_ASSERTIONS_EXECUTED"
const sessionID = "ses-kanban-rendered"

function colorInts(color: { toInts: () => [number, number, number, number] }) {
  return color.toInts()
}

let panelPromise: Promise<unknown> | undefined
async function actualTasksPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      const sourceURL = new URL("../src/tasks-panel.tsx", import.meta.url)
      const source = await readFile(sourceURL, "utf8")
      const sourceDirectory = new URL("../src/", import.meta.url)
      const imports = await transformSolidSource(source, {
        filename: sourceURL.pathname,
        moduleName: "@opentui/solid",
        resolvePath: (specifier) => {
          if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
          if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
          return import.meta.resolve(specifier)
        },
      })
      const module = await import(`data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`) as { TasksPanel: unknown }
      return module.TasksPanel
    })()
  }
  return await panelPromise
}

function panelContext(theme: Record<string, any>, listeners: Map<string, Set<() => void>>): Context {
  const renderer = {
    on: (event: string, listener: () => void) => {
      const callbacks = listeners.get(event) ?? new Set<() => void>()
      callbacks.add(listener)
      listeners.set(event, callbacks)
    },
    off: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
  }
  return {
    options: {},
    location: undefined,
    app: { version: "fixture", channel: "test" },
    renderer: renderer as unknown as Context["renderer"],
    client: {} as Context["client"],
    data: {} as Context["data"],
    attention: {} as Context["attention"],
    theme: theme as Context["theme"],
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: {} as Context["keymap"],
    storage: {} as Context["storage"],
    ui: {} as Context["ui"],
  }
}

function makeTheme() {
  return {
    hue: { accent: { 200: "#d985b9" }, purple: { 200: "#bb9af7" }, green: { 200: "#9ece6a" }, cyan: { 200: "#7dcfff" } },
    text: { default: "#d8e1ee", subdued: "#9caec2", feedback: { error: { default: "#f7768e" } } },
    background: { surface: { offset: "#293044" } },
    border: { default: "#556070" },
    syntax: { keyword: "#bb9af7", type: "#bb9af7" },
    diff: { text: { added: "#8fd694" } },
  }
}

function makePanel(width: number, closed: () => void, resized: () => void): PanelInput {
  return {
    name: "opencode-rig.todo.tasks",
    sessionID,
    width,
    presentation: "fullscreen",
    focused: true,
    focus: () => undefined,
    close: closed,
    toggleFullscreen: resized,
  }
}

async function renderPanel(width: number, theme: Record<string, any>, listeners: Map<string, Set<() => void>>, closed: () => void, resized: () => void) {
  const TasksPanel = await actualTasksPanel() as (props: { panel: PanelInput }) => ReturnType<typeof jsx>
  const context = panelContext(theme, listeners)
  const panel = makePanel(width, closed, resized)
  const setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
    value: context,
    get children() {
      return jsx("box", {
        width: "100%",
        height: "100%",
        children: jsx(TasksPanel as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, { panel }),
      })
    },
  }), { width, height: 42 })
  return setup
}

async function settle(setup: TestRendererSetup): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await setup.flush()
  }
}

test("full-screen Todo board responds to theme changes, history paging, and keyboard close", async () => {
  const xdgDataHome = await mkdtemp(path.join(tmpdir(), "opencode-rig-tasks-rendered-"))
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = xdgDataHome
  let setup: TestRendererSetup | undefined
  let compactSetup: TestRendererSetup | undefined
  let closed = 0
  let resized = 0
  const listeners = new Map<string, Set<() => void>>()
  const theme = makeTheme()
  const current: TodoItem[] = [
    { content: "Ship the release checklist", status: "in_progress", priority: "high" },
    { content: "Review the release notes", status: "pending" },
    { content: "Run the completed build", status: "completed" },
  ]
  const history: TodoItem[] = Array.from({ length: 10 }, (_, index) => ({
    content: `archived task ${index} retains its complete description across every page`,
    status: "completed" as const,
  }))
  try {
    await mkdir(path.dirname(todoStatePath(sessionID)), { recursive: true })
    await writeFile(todoStatePath(sessionID), serializeTodoState(current), "utf8")
    const identified = assignTodoIds(emptyTodoIdentity(), history, sessionID)
    await appendTodoTransitions(
      todoArchiveRoot({ XDG_DATA_HOME: xdgDataHome }),
      diffTodoTransitions([], identified.todos, sessionID, "2026-09-22T00:00:00.000Z"),
    )

    setup = await renderPanel(132, theme, listeners, () => { closed += 1 }, () => { resized += 1 })
    await settle(setup)
    const board = setup.captureCharFrame()
    assert.match(board, /Todo tasks/)
    assert.match(board, /In Progress/)
    assert.match(board, /To Do/)
    assert.match(board, /Completed/)
    assert.match(board, /Cancelled/)
    const boardText = board.replace(/[│]/g, " ").replace(/\s+/g, " ")
    assert.ok(boardText.includes("Ship the release") && boardText.includes("checklist"), board)
    assert.ok(boardText.includes("Review the release notes"), board)
    assert.ok(boardText.includes("Run the completed build"), board)
    assert.doesNotMatch(board, /archived task 9 retains/)

    const activeBoard = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Board"))
    assert.ok(activeBoard)
    const beforeTheme = colorInts(activeBoard.fg)
    theme.hue.cyan[200] = "#00d084"
    for (const listener of listeners.get("palette") ?? []) listener()
    await settle(setup)
    const updatedBoard = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Board"))
    assert.ok(updatedBoard)
    assert.notDeepEqual(colorInts(updatedBoard.fg), beforeTheme)
    assert.deepEqual(colorInts(updatedBoard.fg), colorInts(RGBA.fromHex("#00d084")))

    setup.mockInput.pressKey("h")
    await settle(setup)
    const firstPage = setup.captureCharFrame()
    assert.match(firstPage, /History page 1/)
    assert.match(firstPage, /archived task 9 retains its complete description/)
    assert.doesNotMatch(firstPage, /archived task 0 retains/)
    assert.ok(firstPage.replace(/\s/g, "").includes("archivedtask9retainsitscompletedescriptionacrosseverypage"), firstPage)

    setup.mockInput.pressKey("n")
    await settle(setup)
    const secondPage = setup.captureCharFrame()
    assert.match(secondPage, /History page 2/)
    assert.match(secondPage, /archived task 1 retains its complete description/)
    assert.match(secondPage, /archived task 0 retains its complete description/)
    assert.doesNotMatch(secondPage, /archived task 9 retains/)

    setup.mockInput.pressKey("p")
    await settle(setup)
    assert.match(setup.captureCharFrame(), /History page 1/)
    setup.mockInput.pressEscape()
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    await settle(setup)
    assert.equal(closed, 1)

    compactSetup = await renderPanel(80, theme, listeners, () => { closed += 1 }, () => { resized += 1 })
    await settle(compactSetup)
    const compactBoard = compactSetup.captureCharFrame()
    assert.match(compactBoard, /In Progress 1/)
    assert.match(compactBoard, /To Do 1/)
    assert.match(compactBoard, /Completed 1/)
    assert.match(compactBoard, /Cancelled 0/)
    compactSetup.mockInput.pressArrow("right")
    await settle(compactSetup)
    assert.match(compactSetup.captureCharFrame(), /Review the release notes/)
    compactSetup.mockInput.pressKey("f")
    await settle(compactSetup)
    assert.equal(resized, 1)
  } finally {
    setup?.renderer.destroy()
    compactSetup?.renderer.destroy()
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    await rm(xdgDataHome, { recursive: true, force: true })
  }
  process.stdout.write(`${RENDER_ASSERTIONS_MARKER}\n`)
})
