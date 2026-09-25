import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

import type { SourceControlState, SourceControlStore } from "../src/store.ts"

const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const MARKER = "RIG_SOURCE_CONTROL_RENDER_ASSERTIONS_EXECUTED"

function colorInts(color: { toInts: () => [number, number, number, number] }) {
  return color.toInts()
}

let panelPromise: Promise<unknown> | undefined
async function actualPanel() {
  if (!panelPromise) {
    panelPromise = (async () => {
      const sourceURL = new URL("../src/tui.tsx", import.meta.url)
      const sourceDirectory = new URL("../src/", import.meta.url)
      const imports = await transformSolidSource(await readFile(sourceURL, "utf8"), {
        filename: sourceURL.pathname,
        moduleName: "@opentui/solid",
        resolvePath: (specifier) => {
          if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
          if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
          return import.meta.resolve(specifier)
        },
      })
      return (await import(`data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`) as { SourceControlPanel: unknown }).SourceControlPanel
    })()
  }
  return await panelPromise
}

function rendererFailure(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    "source-control rendered checks require a supported OpenTUI native renderer; " +
    "run this package with OpenTUI's supported Node runtime (>=26.4) instead of skipping the assertions.",
    { cause: error },
  )
}

function theme(action = "#8cc8ff"): Context["theme"] {
  return {
    hue: { accent: { 200: "#d985b9" }, cyan: { 200: action } },
    text: {
      default: "#d8e1ee",
      subdued: "#9caec2",
      feedback: {
        info: { default: action },
        warning: { default: "#e5c07b" },
        error: { default: "#e06c75" },
      },
    },
    diff: { text: { added: "#8fd694", removed: "#e06c75" } },
    syntax: { keyword: "#bb9af7", type: "#bb9af7" },
  } as unknown as Context["theme"]
}

type ContextFixture = {
  value: Context
  setHeight: (height: number) => void
  setTheme: (theme: Context["theme"]) => void
}

function context(dispatches: string[], height = 10): ContextFixture {
  const listeners = new Map<string, Set<() => void>>()
  const renderer = {
    height,
    on: (event: string, listener: () => void) => {
      const callbacks = listeners.get(event) ?? new Set<() => void>()
      callbacks.add(listener)
      listeners.set(event, callbacks)
    },
    off: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
  }
  const value = {
    options: {},
    location: { directory: "/tmp/source-control-fixture" },
    app: { version: "fixture", channel: "test" },
    renderer: renderer as unknown as Context["renderer"],
    client: {} as Context["client"],
    data: {} as Context["data"],
    attention: {} as Context["attention"],
    theme: theme(),
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: { dispatch: (command: string) => dispatches.push(command) } as unknown as Context["keymap"],
    storage: {} as Context["storage"],
    ui: {
      dialog: { clear: () => undefined },
      toast: { show: () => undefined },
    } as unknown as Context["ui"],
  } as unknown as Context
  const emit = (event: string) => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  return {
    value,
    setHeight: (next) => {
      renderer.height = next
      emit("resize")
    },
    setTheme: (next) => {
      ;(value as unknown as { theme: Context["theme"] }).theme = next
      emit("palette")
    },
  }
}

function fixtureStore(count = 5) {
  let state: SourceControlState = {
    status: "ready",
    isGit: true,
    branch: "feature/sidebar",
    changes: Array.from({ length: count }, (_, index) => ({
      file: `src/components/sidebar/very-long-preview-file-${index}.tsx`,
      additions: index + 1,
      deletions: index,
      status: index === 0 ? "added" as const : "modified" as const,
    })),
  }
  const listeners = new Set<(state: SourceControlState) => void>()
  const store: SourceControlStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refreshLocal: async () => undefined,
    refreshGithub: async () => undefined,
    dispose: () => listeners.clear(),
  }
  return {
    store,
    setCount: (nextCount: number) => {
      state = {
        ...state,
        changes: Array.from({ length: nextCount }, (_, index) => ({
          file: `src/components/sidebar/very-long-preview-file-${index}.tsx`,
          additions: index + 1,
          deletions: index,
          status: index === 0 ? "added" as const : "modified" as const,
        })),
      }
      for (const listener of listeners) listener(state)
    },
  }
}

test("rendered SourceControlPanel bounds previews to one-line rows and keeps diff activation", async () => {
  const SourceControlPanel = await actualPanel() as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const dispatches: string[] = []
  const fixtureContext = context(dispatches)
  const fixture = fixtureStore()
  let setup: TestRendererSetup | undefined
  try {
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: fixtureContext.value,
        get children() {
          return jsx(SourceControlPanel, {
            store: fixture.store,
            runtime: () => ({ refreshMs: 15_000, githubRefreshMs: 120_000, maxFiles: 3, startCollapsed: false }),
            setStartCollapsed: () => undefined,
            whenEmpty: "show",
          })
        },
      }), { width: 38, height: 10 })
    } catch (error) {
      throw rendererFailure(error)
    }
    await setup.flush()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const visibleLines = lines.filter((line) => line.trim().length > 0)
    assert.match(frame, /Source Control\s+5 changes/)
    assert.match(frame, /click to open the diff viewer/)
    assert.match(frame, /\+2 more files/)
    assert.equal(visibleLines.length, 6)
    assert.ok(visibleLines.every((line) => line.length <= 38), frame)
    assert.equal(visibleLines.filter((line) => line.includes("src/")).length, 3, frame)
    assert.ok(visibleLines.some((line) => line.startsWith("  ") && line.includes("+2 more files")), frame)
    assert.doesNotMatch(frame, /very-long-preview-file-3\.tsx/)
    assert.doesNotMatch(frame, /very-long-preview-file-4\.tsx/)

    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const heading = spans.find((span) => span.text.includes("Source Control"))
    const path = spans.find((span) => span.text.includes("src/"))
    const hint = spans.find((span) => span.text.includes("click to open"))
    const hidden = spans.find((span) => span.text.includes("+2 more files"))
    const added = spans.find((span) => span.text.includes("+1"))
    const removed = spans.find((span) => span.text === "-1")
    const marker = spans.find((span) => span.text === "A")
    assert.ok(heading && (heading.attributes & TextAttributes.BOLD) !== 0)
    assert.ok(path && (path.attributes & TextAttributes.UNDERLINE) !== 0)
    assert.ok(marker && (marker.attributes & TextAttributes.UNDERLINE) !== 0)
    assert.ok(hint && (hint.attributes & TextAttributes.UNDERLINE) !== 0)
    assert.ok(hidden && (hidden.attributes & TextAttributes.UNDERLINE) !== 0)
    assert.ok(added)
    assert.ok(removed)
    assert.deepEqual(colorInts(added.fg), colorInts(RGBA.fromHex("#8cc8ff")))
    assert.deepEqual(colorInts(removed.fg), colorInts(RGBA.fromHex("#e06c75")))
    assert.deepEqual(colorInts(hidden.fg), colorInts(RGBA.fromHex("#8cc8ff")))

    await setup.mockMouse.click(5, 2)
    await setup.flush()
    assert.deepEqual(dispatches, ["diff.open"])
  } finally {
    setup?.renderer.destroy()
  }
  process.stdout.write(`${MARKER}\n`)
})

function locationOf(setup: TestRendererSetup, text: string) {
  for (const [y, line] of setup.captureSpans().lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      if (span.text.includes(text)) return { x: x + 1, y }
      x += span.width
    }
  }
  throw new Error(`Could not locate native span ${text}`)
}

test("native pagination supports mouse and keyboard controls, resizes and clamps, keeps the footer, and opens file diffs", async () => {
  const SourceControlPanel = await actualPanel() as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const dispatches: string[] = []
  const fixtureContext = context(dispatches, 30)
  const fixture = fixtureStore(10)
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
      value: fixtureContext.value,
      get children() {
        return jsx("box", {
          width: "100%",
          height: 30,
          flexDirection: "column",
          children: [
            jsx(SourceControlPanel, {
              store: fixture.store,
              runtime: () => ({ refreshMs: 15_000, githubRefreshMs: 120_000, maxFiles: 3, startCollapsed: false }),
              setStartCollapsed: () => undefined,
              whenEmpty: "show",
            }),
            jsx("text", { height: 1, flexShrink: 0, children: "FOOTER_SENTINEL" }),
          ],
        })
      },
    }), { width: 46, height: 30 })
    await setup.flush()
    assert.match(setup.captureCharFrame(), /\+7 more files/)
    assert.match(setup.captureCharFrame(), /FOOTER_SENTINEL/)

    const more = locationOf(setup, "+7 more files")
    await setup.mockMouse.click(more.x, more.y)
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 4-9 of 10/)
    assert.match(setup.captureCharFrame(), /next >/)
    assert.doesNotMatch(setup.captureCharFrame(), /file-9\.tsx/)

    const next = setup.renderer.root.findDescendantById("opencode-rig.source-control.more.next") as { focus: () => void } | undefined
    assert.ok(next)
    next.focus()
    await setup.mockInput.pressEnter()
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 10-10 of 10/)
    assert.match(setup.captureCharFrame(), /file-9\.tsx/)
    assert.match(setup.captureCharFrame(), /FOOTER_SENTINEL/)

    const previous = locationOf(setup, "< prev")
    await setup.mockMouse.click(previous.x, previous.y)
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 4-9 of 10/)

    const nextAfterPrevious = setup.renderer.root.findDescendantById("opencode-rig.source-control.more.next") as { focus: () => void } | undefined
    assert.ok(nextAfterPrevious)
    nextAfterPrevious.focus()
    await setup.mockInput.pressEnter()
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 10-10 of 10/)

    fixtureContext.setHeight(10)
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 4-4 of 10/)
    assert.match(setup.captureCharFrame(), /next >/)
    assert.match(setup.captureCharFrame(), /FOOTER_SENTINEL/)

    const nextAfterResize = setup.renderer.root.findDescendantById("opencode-rig.source-control.more.next") as { focus: () => void } | undefined
    assert.ok(nextAfterResize)
    nextAfterResize.focus()
    await setup.mockInput.pressEnter()
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 5-5 of 10/)

    fixture.setCount(4)
    await setup.flush()
    assert.match(setup.captureCharFrame(), /More files 4-4 of 4/)
    assert.doesNotMatch(setup.captureCharFrame(), /file-9\.tsx|next >/)
    assert.match(setup.captureCharFrame(), /FOOTER_SENTINEL/)

    await setup.mockMouse.click(5, 2)
    await setup.flush()
    assert.deepEqual(dispatches, ["diff.open"])

    const close = locationOf(setup, "close")
    await setup.mockMouse.click(close.x, close.y)
    await setup.flush()
    assert.match(setup.captureCharFrame(), /\+1 more files/)
    assert.match(setup.captureCharFrame(), /FOOTER_SENTINEL/)
  } finally {
    setup?.renderer.destroy()
  }
})

test("Source Control palette events refresh semantic marker colors in place", async () => {
  const SourceControlPanel = await actualPanel() as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const dispatches: string[] = []
  const fixtureContext = context(dispatches)
  const fixture = fixtureStore(3)
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
      value: fixtureContext.value,
      get children() {
        return jsx(SourceControlPanel, {
          store: fixture.store,
          runtime: () => ({ refreshMs: 15_000, githubRefreshMs: 120_000, maxFiles: 3, startCollapsed: false }),
          setStartCollapsed: () => undefined,
          whenEmpty: "show",
        })
      },
    }), { width: 46, height: 10 })
    await setup.flush()
    const firstMarker = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "A")
    assert.ok(firstMarker)
    assert.ok((firstMarker.attributes & TextAttributes.UNDERLINE) !== 0)
    assert.deepEqual(colorInts(firstMarker.fg), colorInts(RGBA.fromHex("#8cc8ff")))

    fixtureContext.setTheme(theme("#56d4dd"))
    await setup.flush()
    const refreshedMarker = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "A")
    assert.ok(refreshedMarker)
    assert.deepEqual(colorInts(refreshedMarker.fg), colorInts(RGBA.fromHex("#56d4dd")))
  } finally {
    setup?.renderer.destroy()
  }
})
