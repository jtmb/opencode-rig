import assert from "node:assert/strict"
import test from "node:test"

import { activeSubagentRowStyle, activeSubagentRows, formatSubagentRow, nextSubagentIndex, resolveSubagentRows, subagentActivityLabel, subagentAnimationsEnabled, subagentStatus } from "../src/subagents.ts"

const parent = { id: "ses_parent", projectID: "project", location: { directory: "/repo" } }
const rowTheme = {
  hue: { accent: { 200: "accent-pink" } },
  text: {
    default: "default-text",
    subdued: "subdued-text",
    action: { primary: { default: "selected-text" } },
  },
  background: {
    default: "sidebar-surface",
    action: { primary: { default: "primary-surface", selected: "selection-surface" } },
  },
}

test("renders the resolved model and variant before the child title", () => {
  const rows = resolveSubagentRows([
    {
      id: "ses_child",
      parentID: "ses_parent",
      projectID: "project",
      agent: "general",
      model: { providerID: "openai", id: "gpt-5.6-luna", variant: "max" },
      title: "Repair visible commands",
      location: { directory: "/repo" },
    } as never,
    {
      id: "ses_fallback",
      parentID: "ses_parent",
      projectID: "project",
      agent: "explore",
      title: "Resolve API boundary",
      location: { directory: "/repo" },
    } as never,
    {
      id: "ses_placeholder",
      parentID: "ses_parent",
      projectID: "project",
      agent: "general",
      model: { providerID: "<unresolved>", id: "<unresolved>" },
      title: "Resolve placeholder",
      location: { directory: "/repo" },
    } as never,
  ], [
    { id: "general", name: "General", model: { providerID: "openai", id: "gpt-5.6-luna", variant: "max" } } as never,
    { id: "explore", name: "Explore", model: { providerID: "openai", id: "gpt-5.6-sol", variant: "xhigh" } } as never,
  ], new Map([["ses_child", "running"]]), parent)

  assert.equal(formatSubagentRow(rows[0]!, 120), "General · openai/gpt-5.6-luna#max: Repair visible commands")
  assert.equal(formatSubagentRow(rows[1]!, 120), "Explore · openai/gpt-5.6-sol#xhigh: Resolve API boundary")
  assert.equal(formatSubagentRow(rows[2]!, 120), "General · openai/gpt-5.6-luna#max: Resolve placeholder")
})

test("filters other repositories and keeps narrow rows within the panel width", () => {
  const rows = resolveSubagentRows([
    { id: "ses_ok", parentID: "ses_parent", projectID: "project", title: "A", location: { directory: "/repo" } },
    { id: "ses_other", parentID: "ses_parent", projectID: "other", title: "B", location: { directory: "/repo" } },
    { id: "ses_outside", parentID: "ses_parent", projectID: "project", title: "C", location: { directory: "/other" } },
  ] as never, [], new Map(), parent)

  assert.deepEqual(rows.map((row) => row.sessionID), ["ses_ok"])
  assert.ok(formatSubagentRow({ ...rows[0]!, model: "openai/gpt-5.6-luna#max" }, 24).length <= 24)
})

test("keeps only bounded running sidebar rows and wraps keyboard selection", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    sessionID: `ses_${index}`,
    agent: "General",
    model: "openai/gpt-5.6-luna#max",
    title: `Task ${index}`,
    status: index === 3 ? "idle" as const : "running" as const,
  }))
  const active = activeSubagentRows(rows)
  assert.equal(active.length, 8)
  assert.ok(active.every((row) => row.status === "running"))
  assert.equal(nextSubagentIndex(0, active.length, -1), 7)
  assert.equal(nextSubagentIndex(7, active.length, 1), 0)
  assert.equal(nextSubagentIndex(4, 0, 1), 0)
  assert.equal(subagentAnimationsEnabled(true, 120), true)
  assert.equal(subagentAnimationsEnabled(false, 120), false)
  assert.equal(subagentAnimationsEnabled(true, 80), false)
  assert.equal(subagentActivityLabel("⠋"), "⠋ running")
  assert.equal(subagentActivityLabel(), "running")
})

test("live active count includes a subsequent running child even while the body is collapsed", () => {
  const first = {
    sessionID: "ses_first",
    agent: "General",
    model: "openai/gpt-5.6-luna#max",
    title: "First child",
    status: "running" as const,
  }
  const second = {
    sessionID: "ses_second",
    agent: "General",
    model: "openai/gpt-5.6-luna#max",
    title: "Second child",
    status: "running" as const,
  }
  const render = (rows: readonly typeof first[], collapsed: boolean) => ({
    count: activeSubagentRows(rows).length,
    body: collapsed ? [] : activeSubagentRows(rows),
  })
  const initial = render([first], true)
  const refreshed = render([first, second], true)
  const restored = render([first, second], false)

  assert.equal(initial.count, 1)
  assert.deepEqual(initial.body, [])
  assert.equal(refreshed.count, 2)
  assert.deepEqual(refreshed.body, [])
  assert.deepEqual(restored.body.map((row) => row.sessionID), ["ses_first", "ses_second"])
})

test("keeps focused rows on the shared sidebar surface with muted supporting text", () => {
  const focused = activeSubagentRowStyle(rowTheme, true)
  const unfocused = activeSubagentRowStyle(rowTheme, false)

  assert.equal(focused.backgroundColor, "sidebar-surface")
  assert.equal(focused.backgroundToken, "background.default")
  assert.equal(focused.markerColor, "accent-pink")
  assert.equal(focused.markerToken, "hue.accent.200")
  assert.equal(focused.agentColor, "default-text")
  assert.equal(focused.modelColor, "subdued-text")
  assert.equal(focused.taskColor, "subdued-text")
  assert.equal(focused.agentToken, "text.default")
  assert.equal(focused.modelToken, "text.subdued")
  assert.equal(focused.taskToken, "text.subdued")

  assert.equal(unfocused.backgroundColor, "sidebar-surface")
  assert.equal(unfocused.backgroundToken, "background.default")
  assert.equal(unfocused.agentColor, "default-text")
  assert.equal(unfocused.modelColor, "subdued-text")
  assert.equal(unfocused.taskColor, "subdued-text")
  assert.equal(focused.backgroundColor, unfocused.backgroundColor)
})

test("active row styles never introduce black or an undefined background fallback", () => {
  for (const focused of [false, true]) {
    const style = activeSubagentRowStyle(rowTheme, focused)
    assert.notEqual(style.backgroundColor, undefined)
    assert.notEqual(style.backgroundColor, "black")
    assert.notEqual(style.backgroundColor, "#000")
    assert.notEqual(style.backgroundColor, "#000000")
    assert.notEqual(style.backgroundColor, "0x000000")
  }

  const missingSelected = activeSubagentRowStyle({
    ...rowTheme,
    background: { default: "sidebar-surface", action: { primary: { default: "primary-surface" } } },
  }, true)
  assert.equal(missingSelected.backgroundColor, "sidebar-surface")
  assert.equal(missingSelected.backgroundToken, "background.default")
  assert.notEqual(missingSelected.backgroundColor, undefined)

  const missingFocusedText = activeSubagentRowStyle({
    ...rowTheme,
    text: { ...rowTheme.text, action: { primary: {} } },
  }, true)
  assert.equal(missingFocusedText.agentColor, "default-text")
  assert.equal(missingFocusedText.modelColor, "subdued-text")
  assert.equal(missingFocusedText.taskColor, "subdued-text")
  assert.equal(missingFocusedText.agentToken, "text.default")
  assert.equal(missingFocusedText.modelToken, "text.subdued")
  assert.equal(missingFocusedText.taskToken, "text.subdued")
})

test("falls back to session lifecycle fields when the active snapshot omits a running child", () => {
  assert.equal(subagentStatus({ outcome: undefined, time: { created: 1, updated: 1 } } as never, false), "running")
  assert.equal(subagentStatus({ outcome: undefined, time: { created: 1, updated: 2, idle: 2 } } as never, false), "idle")
  assert.equal(subagentStatus({ outcome: "succeeded", time: { created: 1, updated: 2 } } as never, false), "idle")
  assert.equal(subagentStatus({ outcome: "succeeded", time: { created: 1, updated: 2 } } as never, true), "running")
})
