import assert from "node:assert/strict"
import test from "node:test"

import { activeSubagentRows, formatSubagentRow, nextSubagentIndex, resolveSubagentRows, subagentActivityLabel, subagentAnimationsEnabled, subagentStatus } from "../src/subagents.ts"

const parent = { id: "ses_parent", projectID: "project", location: { directory: "/repo" } }

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

test("falls back to session lifecycle fields when the active snapshot omits a running child", () => {
  assert.equal(subagentStatus({ outcome: undefined, time: { created: 1, updated: 1 } } as never, false), "running")
  assert.equal(subagentStatus({ outcome: undefined, time: { created: 1, updated: 2, idle: 2 } } as never, false), "idle")
  assert.equal(subagentStatus({ outcome: "succeeded", time: { created: 1, updated: 2 } } as never, false), "idle")
  assert.equal(subagentStatus({ outcome: "succeeded", time: { created: 1, updated: 2 } } as never, true), "running")
})
