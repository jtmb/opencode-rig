import assert from "node:assert/strict"
import test from "node:test"

import { RGBA, TextAttributes, type BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

const { createSignal } = await import(import.meta.resolve("solid-js/dist/solid.js")) as {
  createSignal: <T>(value: T) => [() => T, (value: T | ((current: T) => T)) => T]
}

import { ActiveSubagentRow, ActiveSubagentsHeading } from "../src/active-subagent-row.ts"
import { SubagentsHistory } from "../src/subagent-history-view.ts"
import type { ActiveSubagentRowTheme, SubagentRow } from "../src/subagents.ts"
import type { SubagentHistoryEventRow } from "../src/subagent-history.ts"

const colors = {
  accent: RGBA.fromHex("#bb9af7"),
  text: RGBA.fromHex("#d8e1ee"),
  subdued: RGBA.fromHex("#9caec2"),
  focusedText: RGBA.fromHex("#f0d6a6"),
  background: RGBA.fromHex("#182635"),
  primary: RGBA.fromHex("#334b63"),
  selected: RGBA.fromHex("#6a4f84"),
} as const

const theme: ActiveSubagentRowTheme = {
  hue: { accent: { 200: colors.accent } },
  text: {
    default: colors.text,
    subdued: colors.subdued,
    action: { primary: { default: colors.focusedText } },
  },
  background: {
    default: colors.background,
    action: { primary: { default: colors.primary, selected: colors.selected } },
  },
  syntax: { keyword: colors.accent, type: colors.accent },
}

const fallbackTheme: ActiveSubagentRowTheme = {
  ...theme,
  text: { ...theme.text, action: { primary: {} } },
  background: { ...theme.background, action: { primary: { default: colors.primary } } },
}

const RenderableActiveSubagentRow = ActiveSubagentRow as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>
const RenderableActiveSubagentsHeading = ActiveSubagentsHeading as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>
const RENDER_ASSERTIONS_MARKER = "RIG_TOOLS_ACTIVE_SUBAGENT_RENDER_ASSERTIONS_EXECUTED"

const row = (title: string): SubagentRow => ({
  sessionID: `ses-${title.toLowerCase().replaceAll(" ", "-")}`,
  agent: "General",
  model: "openai/gpt-5.6-luna#max",
  title,
  status: "running",
})

function target(setup: TestRendererSetup, text: string) {
  for (const [y, line] of setup.captureSpans().lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      if (span.text.includes(text)) return { x: x + 1, y }
      x += span.width
    }
  }
  throw new Error(`rendered frame did not contain ${text}`)
}

function rendererFailure(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    "rig-tools rendered Active Subagents checks require a supported OpenTUI native renderer; " +
    "run this package with OpenTUI's supported Node runtime (>=26.4) instead of skipping the assertions.",
    { cause: error },
  )
}

async function renderRows(): Promise<TestRendererSetup> {
  try {
    const setup = await testRender(() => jsx("box", {
      width: 72,
      height: 9,
      flexDirection: "column",
      children: [
        jsx(RenderableActiveSubagentRow, {
          row: row("Focused selected"),
          theme,
          focused: true,
          activityFrame: "⠋",
          onOpen: () => undefined,
          onMove: () => undefined,
        }),
        jsx(RenderableActiveSubagentRow, {
          row: row("Unfocused default"),
          theme,
          focused: false,
          activityFrame: "⠋",
          onOpen: () => undefined,
          onMove: () => undefined,
        }),
        jsx(RenderableActiveSubagentRow, {
          row: row("Focused fallback"),
          theme: fallbackTheme,
          focused: true,
          activityFrame: "⠋",
          onOpen: () => undefined,
          onMove: () => undefined,
        }),
      ],
    }), { width: 72, height: 9 })
    await setup.flush()
    return setup
  } catch (error) {
    throw rendererFailure(error)
  }
}

function colorInts(color: { toInts: () => [number, number, number, number] }): [number, number, number, number] {
  return color.toInts()
}

function rowLine(
  lines: ReturnType<TestRendererSetup["captureSpans"]>["lines"],
  title: string,
  offset: number,
): (typeof lines)[number] {
  const taskIndex = lines.findIndex((candidate) => candidate.spans.some((span) => span.text.includes(`Task · ${title}`)))
  assert.ok(taskIndex >= 0, `rendered frame did not contain ${title}`)
  const line = lines[taskIndex + offset]
  assert.ok(line, `rendered frame did not contain row line ${title} (${offset})`)
  return line
}

function findSpan(line: ReturnType<TestRendererSetup["captureSpans"]>["lines"][number], text: string) {
  const span = line.spans.find((candidate) => candidate.text.includes(text))
  assert.ok(span, `rendered line did not contain ${text}`)
  return span
}

test("renders focused and unfocused rows as one cohesive hierarchy", async () => {
  const setup = await renderRows()
  try {
    const frame = setup.captureCharFrame()
    assert.match(frame, /Focused selected/)
    assert.match(frame, /Unfocused default/)
    assert.match(frame, /Focused fallback/)
    assert.match(frame, /Agent · General/)
    assert.match(frame, /Model · openai\/gpt-5\.6-luna#max/)
    assert.match(frame, /Task · Focused selected/)

    const lines = setup.captureSpans().lines
    const focusedAgent = findSpan(rowLine(lines, "Focused selected", -2), "Agent · General")
    const focusedModel = findSpan(rowLine(lines, "Focused selected", -1), "Model ·")
    const unfocusedAgent = findSpan(rowLine(lines, "Unfocused default", -2), "Agent · General")
    const unfocusedModel = findSpan(rowLine(lines, "Unfocused default", -1), "Model ·")
    const fallbackAgent = findSpan(rowLine(lines, "Focused fallback", -2), "Agent · General")
    const fallbackModel = findSpan(rowLine(lines, "Focused fallback", -1), "Model ·")

    assert.deepEqual(colorInts(focusedAgent.bg), colorInts(colors.background))
    assert.deepEqual(colorInts(focusedAgent.fg), colorInts(colors.text))
    assert.deepEqual(colorInts(focusedModel.bg), colorInts(colors.background))
    assert.deepEqual(colorInts(focusedModel.fg), colorInts(colors.subdued))
    assert.deepEqual(colorInts(unfocusedAgent.bg), colorInts(colors.background))
    assert.deepEqual(colorInts(unfocusedAgent.fg), colorInts(colors.text))
    assert.deepEqual(colorInts(unfocusedModel.bg), colorInts(colors.background))
    assert.deepEqual(colorInts(unfocusedModel.fg), colorInts(colors.subdued))
    assert.deepEqual(colorInts(fallbackAgent.bg), colorInts(colors.background))
    assert.deepEqual(colorInts(fallbackAgent.fg), colorInts(colors.text))
    assert.deepEqual(colorInts(fallbackModel.fg), colorInts(colors.subdued))
    assert.ok((focusedAgent.attributes & TextAttributes.BOLD) !== 0)
    assert.ok((focusedModel.attributes & TextAttributes.DIM) !== 0)
    assert.ok((unfocusedAgent.attributes & TextAttributes.BOLD) !== 0)
    assert.ok((unfocusedModel.attributes & TextAttributes.DIM) !== 0)

    const accent = findSpan(rowLine(lines, "Focused selected", -2), "running")
    assert.deepEqual(colorInts(accent.fg), colorInts(colors.accent))
    process.stdout.write(`${RENDER_ASSERTIONS_MARKER}\n`)
  } finally {
    setup.renderer.destroy()
  }
})

test("renders the expanded Active Subagents heading with its retained count", async () => {
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx(RenderableActiveSubagentsHeading, {
      count: 3,
      collapsed: false,
      textColor: colors.text,
      accentColor: colors.accent,
      onToggle: () => undefined,
    }), { width: 32, height: 1 })
    await setup.flush()
    assert.equal(setup.captureCharFrame(), "- Active Subagents 3            \n")
    const line = setup.captureSpans().lines[0]
    assert.ok(line)
    const heading = line.spans.find((span) => span.text.includes("- Active Subagents"))
    const count = line.spans.find((span) => span.text.includes("3"))
    assert.ok(heading)
    assert.ok(count)
    assert.deepEqual(colorInts(heading.fg), colorInts(colors.text))
    assert.deepEqual(colorInts(count.fg), colorInts(colors.accent))
  } finally {
    setup?.renderer.destroy()
  }
})

test("reactively updates the native heading from zero to two rendered active rows", async () => {
  const [count, setCount] = createSignal(0)
  const rows = [row("First running child"), row("Second running child")]
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx("box", {
      width: 72,
      height: 7,
      flexDirection: "column",
      children: [
        jsx(RenderableActiveSubagentsHeading, {
          get count() { return count() },
          collapsed: false,
          textColor: colors.text,
          accentColor: colors.accent,
          onToggle: () => undefined,
        }),
        jsx("box", {
          flexDirection: "column",
          get children() {
            return rows.slice(0, count()).map((child, index) => jsx(RenderableActiveSubagentRow, {
              row: child,
              theme,
              focused: index === 0,
              activityFrame: "⠋",
              onOpen: () => undefined,
              onMove: () => undefined,
            }))
          },
        }),
      ],
    }), { width: 72, height: 7 })
    await setup.flush()
    assert.match(setup.captureCharFrame(), /- Active Subagents 0/)
    await new Promise<void>((resolve) => setImmediate(() => {
      setCount(2)
      resolve()
    }))
    await setup.flush()
    assert.match(setup.captureCharFrame(), /- Active Subagents 2/)
    assert.match(setup.captureCharFrame(), /First running child/)
    assert.match(setup.captureCharFrame(), /Second running child/)
  } finally {
    setup?.renderer.destroy()
  }
})

test("native heading click and keyboard toggle keep focus, count live, and body refreshable while collapsed", async () => {
  const [collapsed, setCollapsed] = createSignal(false)
  const [rows, setRows] = createSignal([row("First running child")])
  let headingFocusCount = 0
  let openCount = 0
  let toggleCount = 0
  let rowRef: { focus: () => void } | undefined
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx("box", {
      width: 72,
      height: 8,
      flexDirection: "column",
      children: [
        jsx(RenderableActiveSubagentsHeading, {
          get count() { return rows().length },
          get collapsed() { return collapsed() },
          textColor: colors.text,
          accentColor: colors.accent,
          onFocus: () => { headingFocusCount += 1 },
          onToggle: () => {
            toggleCount += 1
            setCollapsed((value) => !value)
          },
        }),
        jsx("box", {
          flexDirection: "column",
          get children() {
            if (collapsed()) return []
            return rows().map((child) => jsx(RenderableActiveSubagentRow, {
              row: child,
              theme,
              focused: false,
              activityFrame: "⠋",
              onRef: (value: BoxRenderable) => { rowRef = value },
              onOpen: () => { openCount += 1 },
              onMove: () => undefined,
            }))
          },
        }),
      ],
    }), { width: 72, height: 8 })
    await setup.flush()
    assert.match(setup.captureCharFrame(), /- Active Subagents 1/)
    assert.match(setup.captureCharFrame(), /First running child/)

    rowRef?.focus()
    await setup.flush()
    assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.row.ses-first-running-child")
    const heading = target(setup, "- Active Subagents")
    await setup.mockMouse.click(heading.x, heading.y)
    await setup.flush()
    assert.equal(toggleCount, 1)
    assert.equal(headingFocusCount, 1)
    assert.equal(openCount, 0)
    assert.equal(setup.renderer.currentFocusedRenderable?.id, "opencode-rig.active-subagents.heading")
    assert.match(setup.captureCharFrame(), /\+ Active Subagents 1/)
    assert.doesNotMatch(setup.captureCharFrame(), /First running child/)

    setRows((current) => [...current, row("Second running child")])
    await setup.flush()
    assert.match(setup.captureCharFrame(), /\+ Active Subagents 2/)
    assert.doesNotMatch(setup.captureCharFrame(), /Second running child/)

    await setup.mockInput.pressEnter()
    await setup.flush()
    assert.equal(toggleCount, 2)
    assert.equal(headingFocusCount, 2)
    assert.equal(openCount, 0)
    assert.match(setup.captureCharFrame(), /- Active Subagents 2/)
    assert.match(setup.captureCharFrame(), /First running child/)
    assert.match(setup.captureCharFrame(), /Second running child/)
  } finally {
    setup?.renderer.destroy()
  }
})

test("renders readable subagent history rows without session IDs or truncation", async () => {
  const rows: SubagentHistoryEventRow[] = [
    {
      agent: "General",
      model: "openai/gpt-6-luna#max",
      title: "Repair the durable subagent history for every archived child session",
      status: "idle",
      at: "2026-09-22T10:05:00.000Z",
      firstSeenAt: "2026-09-22T10:00:00.000Z",
    },
    {
      agent: "Explore",
      model: "openai/gpt-6-luna#max",
      title: "Audit provider usage",
      status: "running",
      at: "2026-09-22T11:00:00.000Z",
      firstSeenAt: "2026-09-22T11:00:00.000Z",
    },
  ]
  const RenderableSubagentsHistory = SubagentsHistory as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx(RenderableSubagentsHistory, {
      rows,
      page: 0,
      hasMore: true,
      truncated: false,
      loaded: true,
      textColor: colors.text,
      subduedColor: colors.subdued,
      accentColor: colors.accent,
    }), { width: 40, height: 12 })
    await setup.flush()
    const frame = setup.captureCharFrame()
    assert.match(frame, /History/)
    assert.match(frame, /Repair the/)
    assert.match(frame, /durable subagent history/)
    assert.match(frame, /Audit provider/)
    assert.match(frame, /history page 1 · more available/)
    assert.doesNotMatch(frame, /ses_/)
    assert.doesNotMatch(frame, /…/)
    assert.ok(frame.replace(/\s/g, "").includes("Repairthedurablesubagenthistoryforeveryarchivedchildsession"), frame)
  } finally {
    setup?.renderer.destroy()
  }
})
