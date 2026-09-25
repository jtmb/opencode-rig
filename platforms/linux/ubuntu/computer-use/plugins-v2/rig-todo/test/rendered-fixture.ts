import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

// Node's default Solid export is the server runtime; OpenTUI needs Solid's client transform and runtime.
const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

import { parseTodoState, serializeTodoState, todoStatePath } from "../src/state.ts"
import { appendTodoTransitions, diffTodoTransitions, todoArchiveRoot } from "../src/archive.ts"
import { assignTodoIds, emptyTodoIdentity } from "../src/identity.ts"
import type { TodoItem } from "../src/store.ts"

const RENDER_ASSERTIONS_MARKER = "RIG_TODO_RENDER_ASSERTIONS_EXECUTED"
const sessionID = "ses-rendered-todo"

function colorInts(color: { toInts: () => [number, number, number, number] }) {
  return color.toInts()
}

let panelPromise: Promise<unknown> | undefined
async function actualTodoPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      const sourceURL = new URL("../src/tui.tsx", import.meta.url)
      const source = await readFile(sourceURL, "utf8")
      const sourceDirectory = new URL("../src/", import.meta.url)
      const imports = await transformSolidSource(source, {
        filename: sourceURL.pathname,
        moduleName: "@opentui/solid",
        resolvePath: (specifier) => {
          if (specifier === "./tasks-panel.tsx") {
            return `data:text/javascript;base64,${Buffer.from("export function TasksPanel() { return null }").toString("base64")}`
          }
          if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
          if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
          return import.meta.resolve(specifier)
        },
      })
      const module = await import(`data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`) as { TodoPanel: unknown }
      return module.TodoPanel
    })()
  }
  return await panelPromise
}

function rendererFailure(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    "rig-todo rendered TodoPanel checks require a supported OpenTUI native renderer; " +
    "run this package with OpenTUI's supported Node runtime (>=26.4) instead of skipping the assertions.",
    { cause: error },
  )
}

function panelContext(client: Context["client"] = {} as Context["client"]): Context {
  return {
    options: {},
    location: undefined,
    app: { version: "fixture", channel: "test" },
    renderer: {} as Context["renderer"],
    client,
    data: {} as Context["data"],
    attention: {} as Context["attention"],
    theme: {
      hue: { accent: { 200: "#d985b9" } },
      text: { default: "#d8e1ee", subdued: "#9caec2" },
      diff: { text: { added: "#8fd694" } },
      syntax: { keyword: "#bb9af7", type: "#bb9af7" },
    },
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: {} as Context["keymap"],
    storage: {} as Context["storage"],
    ui: {} as Context["ui"],
  } as unknown as Context
}

test("rendered production TodoPanel keeps actionable rows wrapped and aggregates all history", async () => {
  const xdgDataHome = await mkdtemp(path.join(tmpdir(), "opencode-rig-todo-rendered-"))
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = xdgDataHome
  await mkdir(path.dirname(todoStatePath(sessionID)), { recursive: true })
  const items: TodoItem[] = [
    { content: "in-progress text remains complete", status: "in_progress" },
    { content: "pending text remains complete", status: "pending" },
    { content: "completed text remains complete", status: "completed" },
    { content: "cancelled text remains complete", status: "cancelled" },
    ...Array.from({ length: 10 }, (_, index) => ({ content: `history entry ${index} remains complete`, status: "completed" as const })),
    ...Array.from({ length: 2 }, (_, index) => ({ content: `cancelled history entry ${index} remains complete`, status: "cancelled" as const })),
  ]
  await writeFile(todoStatePath(sessionID), serializeTodoState(items), "utf8")
  const TodoPanel = await actualTodoPanel() as (props: { sessionID: string }) => ReturnType<typeof jsx>
  let setup: TestRendererSetup | undefined
  try {
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: panelContext(),
        get children() {
          // A concrete renderer parent avoids the empty top-level Show placeholder in OpenTUI 0.5.11.
          return jsx("box", {
            width: "100%",
            height: "100%",
            children: jsx(TodoPanel as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, { sessionID }),
          })
        },
      }), { width: 42, height: 32 })
    } catch (error) {
      throw rendererFailure(error)
    }
    await setup.flush()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await setup.flush()
    const frame = setup.captureCharFrame()
    assert.match(frame, /in-progress text remains complete/)
    assert.match(frame, /pending text remains complete/)
    assert.doesNotMatch(frame, /completed text remains complete/)
    assert.doesNotMatch(frame, /cancelled text remains complete/)
    assert.match(frame, /\+14 history items hidden/)
    assert.doesNotMatch(frame, /\+\d+ more/)
    assert.match(frame, /11\/16/)
    assert.ok(frame.replace(/\s/g, "").includes("in-progresstextremainscomplete"), frame)
    assert.ok(frame.replace(/\s/g, "").includes("pendingtextremainscomplete"), frame)
    const visibleLines = frame.split("\n").filter((line) => line.trim().length > 0)
    assert.ok(visibleLines.some((line) => line.startsWith("  ") && line.includes("+14 history items hidden")), frame)
    assert.ok(visibleLines.length <= 4, frame)
    assert.ok(frame.split("\n").every((line) => line.length <= 42), frame)
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const heading = spans.find((span) => span.text.includes("Todo"))
    const active = spans.find((span) => span.text.includes("in-progress"))
    const pending = spans.find((span) => span.text.includes("pending"))
    const history = spans.find((span) => span.text.includes("history items hidden"))
    assert.ok(heading && (heading.attributes & TextAttributes.BOLD) !== 0)
    assert.ok(active)
    assert.ok(pending)
    assert.ok(history && (history.attributes & TextAttributes.DIM) !== 0)
    assert.deepEqual(colorInts(active.fg), colorInts(RGBA.fromHex("#d8e1ee")))
    assert.deepEqual(colorInts(pending.fg), colorInts(RGBA.fromHex("#9caec2")))
    assert.deepEqual(colorInts(history.fg), colorInts(RGBA.fromHex("#9caec2")))
  } finally {
    setup?.renderer.destroy()
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    await rm(xdgDataHome, { recursive: true, force: true })
  }
  process.stdout.write(`${RENDER_ASSERTIONS_MARKER}\n`)
})

test("overlays two running direct-child titles without rewriting persisted todo status", async () => {
  const xdgDataHome = await mkdtemp(path.join(tmpdir(), "opencode-rig-todo-overlay-"))
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = xdgDataHome
  const overlaySessionID = "ses-rendered-overlay"
  const items: TodoItem[] = [
    { content: "First child task — detail remains attached", status: "pending" },
    { content: "Second child task", status: "pending" },
    { content: "Unrelated pending work", status: "pending" },
    { content: "Completed history", status: "completed" },
  ]
  await mkdir(path.dirname(todoStatePath(overlaySessionID)), { recursive: true })
  await writeFile(todoStatePath(overlaySessionID), serializeTodoState(items), "utf-8")
  const client = {
    session: {
      get: async () => ({ id: "parent", projectID: "project", location: { directory: "/tmp/overlay" } }),
      list: async () => ({ data: [
        { id: "child-one", parentID: "parent", projectID: "project", location: { directory: "/tmp/overlay" }, title: "First child task" },
        { id: "child-two", parentID: "parent", projectID: "project", location: { directory: "/tmp/overlay" }, title: "Second child task" },
        { id: "other-parent", parentID: "other", projectID: "project", location: { directory: "/tmp/overlay" }, title: "Unrelated pending work" },
      ] }),
      active: async () => ({ "child-one": { type: "running" }, "child-two": { type: "running" } }),
    },
  } as unknown as Context["client"]
  const TodoPanel = await actualTodoPanel() as (props: { sessionID: string }) => ReturnType<typeof jsx>
  let setup: TestRendererSetup | undefined
  try {
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: panelContext(client),
        get children() {
          return jsx("box", {
            width: "100%",
            height: "100%",
            children: jsx(TodoPanel as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, { sessionID: overlaySessionID }),
          })
        },
      }), { width: 58, height: 12 })
    } catch (error) {
      throw rendererFailure(error)
    }
    await setup.flush()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await setup.flush()
    const frame = setup.captureCharFrame()
    assert.match(frame, /\[~\].*First child task/)
    assert.match(frame, /\[~\].*Second child task/)
    assert.match(frame, /\[ \].*Unrelated pending work/)
    assert.match(frame, /1\/4/)
    assert.match(frame, /\+1 history items hidden/)
    assert.deepEqual(parseTodoState(await readFile(todoStatePath(overlaySessionID), "utf-8")), items)
  } finally {
    setup?.renderer.destroy()
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    await rm(xdgDataHome, { recursive: true, force: true })
  }
})

function targetPoint(setup: TestRendererSetup, predicate: (texts: string[], span: { text: string; width: number }) => boolean) {
  for (const [y, line] of setup.captureSpans().lines.entries()) {
    const texts = line.spans.map((span) => span.text)
    let x = 0
    for (const span of line.spans) {
      if (predicate(texts, span)) return { x: x + Math.max(0, Math.floor(span.width / 2)), y }
      x += span.width
    }
  }
  throw new Error("rendered frame did not contain the requested target")
}

test("opening the opt-in history shows readable archived rows and pages through all of them", async () => {
  const xdgDataHome = await mkdtemp(path.join(tmpdir(), "opencode-rig-todo-history-"))
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = xdgDataHome
  const historySessionID = "ses-rendered-history"
  const current: TodoItem[] = [
    { content: "current work stays first", status: "in_progress" },
    { content: "completed seed item", status: "completed" },
  ]
  const archived: TodoItem[] = Array.from({ length: 10 }, (_, index) => ({
    content: `archived task ${index} keeps every word readable without truncation`,
    status: "completed" as const,
  }))
  await mkdir(path.dirname(todoStatePath(historySessionID)), { recursive: true })
  await writeFile(todoStatePath(historySessionID), serializeTodoState(current), "utf8")
  await appendTodoTransitions(
    todoArchiveRoot({ XDG_DATA_HOME: xdgDataHome }),
    diffTodoTransitions([], assignTodoIds(emptyTodoIdentity(), archived, historySessionID).todos, historySessionID, "2026-09-22T00:00:00.000Z"),
  )

  const TodoPanel = await actualTodoPanel() as (props: { sessionID: string }) => ReturnType<typeof jsx>
  let setup: TestRendererSetup | undefined
  try {
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: panelContext(),
        get children() {
          return jsx("box", {
            width: "100%",
            height: "100%",
            children: jsx(TodoPanel as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, { sessionID: historySessionID }),
          })
        },
      }), { width: 42, height: 40 })
    } catch (error) {
      throw rendererFailure(error)
    }
    const settle = async () => {
      await setup!.flush()
      await new Promise<void>((resolve) => setImmediate(resolve))
      await setup!.flush()
    }
    await settle()
    // Default view is unchanged: current work first, no archived body text.
    assert.match(setup.captureCharFrame(), /current work stays first/)
    assert.doesNotMatch(setup.captureCharFrame(), /archived task 9 keeps/)

    const history = targetPoint(setup, (texts, span) =>
      span.text.includes("history") && !texts.join(" ").includes("history items hidden"),
    )
    await setup.mockMouse.click(history.x, history.y)
    await settle()
    const firstPage = setup.captureCharFrame()
    assert.match(firstPage, /archived task 9 keeps every word/)
    assert.match(firstPage, /history page 1/)
    assert.doesNotMatch(firstPage, /archived task 0 keeps/)
    assert.ok(firstPage.replace(/\s/g, "").includes("archivedtask9keepseverywordreadablewithouttruncation"), firstPage)

    const older = targetPoint(setup, (_texts, span) => span.text.includes("older"))
    await setup.mockMouse.click(older.x, older.y)
    await settle()
    const secondPage = setup.captureCharFrame()
    assert.match(secondPage, /history page 2/)
    assert.match(secondPage, /archived task 0 keeps every word/)
    assert.doesNotMatch(secondPage, /archived task 9 keeps/)
  } finally {
    setup?.renderer.destroy()
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    await rm(xdgDataHome, { recursive: true, force: true })
  }
})
