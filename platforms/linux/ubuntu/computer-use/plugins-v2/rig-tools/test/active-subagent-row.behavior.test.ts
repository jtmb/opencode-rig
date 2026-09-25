import assert from "node:assert/strict"
import test from "node:test"

import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"

import { ActiveSubagentRow } from "../src/active-subagent-row.ts"
import type { ActiveSubagentRowTheme, SubagentRow } from "../src/subagents.ts"

const theme: ActiveSubagentRowTheme = {
  hue: { accent: { 200: "#bb9af7" } },
  text: {
    default: "#d8e1ee",
    subdued: "#9caec2",
    action: { primary: { default: "#f0d6a6" } },
  },
  background: {
    default: "#182635",
    action: { primary: { default: "#334b63", selected: "#6a4f84" } },
  },
  syntax: { keyword: "#bb9af7", type: "#bb9af7" },
}

const RenderableActiveSubagentRow = ActiveSubagentRow as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>

function row(sessionID: string, title: string): SubagentRow {
  return { sessionID, agent: "General", model: "openai/gpt-6-luna#max", title, status: "running" }
}

function target(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (const [y, line] of setup.captureSpans().lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      if (span.text.includes(text)) return { x: x + 1, y }
      x += span.width
    }
  }
  throw new Error(`native frame did not contain ${text}`)
}

test("active row keyboard navigation, Enter, and mouse dispatch reach their callbacks", async () => {
  const rows = [row("ses_first", "First task"), row("ses_second", "Second task")]
  const moves: number[] = []
  const opened: string[] = []
  const setup = await testRender(() => jsx("box", {
    width: 72,
    height: 8,
    flexDirection: "column",
    children: rows.map((value) => jsx(RenderableActiveSubagentRow, {
      row: value,
      theme,
      focused: false,
      activityFrame: "⠋",
      onMove: (delta: number) => moves.push(delta),
      onOpen: () => opened.push(value.sessionID),
    })),
  }), { width: 72, height: 8 })

  try {
    setup.renderer.root.findDescendantById("opencode-rig.active-subagents.row.ses_first")?.focus()
    await setup.flush()
    await setup.mockInput.pressArrow("down")
    await setup.flush()
    assert.deepEqual(moves, [1])

    await setup.mockInput.pressEnter()
    await setup.flush()
    assert.deepEqual(opened, ["ses_first"])

    const second = target(setup, "Task · Second task")
    await setup.mockMouse.click(second.x, second.y)
    await setup.flush()
    assert.deepEqual(opened, ["ses_first", "ses_second"])
  } finally {
    setup.renderer.destroy()
  }
})
