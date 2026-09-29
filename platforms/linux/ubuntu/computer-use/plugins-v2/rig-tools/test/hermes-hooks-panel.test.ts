import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { hermesPipelineStages } from "../src/hermes-hooks-graph.ts"
import { emptyHermesHookSnapshot, parseHermesHookSnapshot } from "../src/hermes-hooks-snapshot.ts"

test("pipeline graph tracks concurrent lifecycle starts and closes correlated stages", () => {
  const snapshot = parseHermesHookSnapshot({
    schemaVersion: 1,
    updatedAt: "2026-09-23T10:00:05.000Z",
    events: [
      { at: "2026-09-23T10:00:00.000Z", hook: "pre_llm_call", status: "started", turnRef: "aaaaaaaaaaaa" },
      { at: "2026-09-23T10:00:01.000Z", hook: "pre_api_request", status: "started", requestRef: "bbbbbbbbbbbb", model: "gpt-6-luna" },
      { at: "2026-09-23T10:00:02.000Z", hook: "post_api_request", status: "ok", requestRef: "bbbbbbbbbbbb", durationMs: 420 },
      { at: "2026-09-23T10:00:03.000Z", hook: "pre_tool_call", status: "started", toolRef: "cccccccccccc", tool: "read_file" },
      { at: "2026-09-23T10:00:04.000Z", hook: "subagent_start", status: "started", sessionRef: "dddddddddddd" },
    ],
  })

  const stages = hermesPipelineStages(snapshot)
  assert.deepEqual(stages.map((stage) => stage.id), ["session", "turn", "model", "tools", "subagents"])
  assert.equal(stages.find((stage) => stage.id === "turn")?.status, "active")
  assert.equal(stages.find((stage) => stage.id === "model")?.status, "complete")
  assert.equal(stages.find((stage) => stage.id === "model")?.count, 2)
  assert.equal(stages.find((stage) => stage.id === "tools")?.status, "active")
  assert.equal(stages.find((stage) => stage.id === "subagents")?.status, "active")
})

test("pipeline graph exposes failed outcomes as errors without event content", () => {
  const snapshot = parseHermesHookSnapshot({
    schemaVersion: 1,
    updatedAt: "2026-09-23T10:00:02.000Z",
    events: [
      { at: "2026-09-23T10:00:00.000Z", hook: "pre_api_request", status: "started", requestRef: "bbbbbbbbbbbb" },
      { at: "2026-09-23T10:00:02.000Z", hook: "api_request_error", status: "error", requestRef: "bbbbbbbbbbbb", request: "private payload" },
    ],
  })

  const model = hermesPipelineStages(snapshot).find((stage) => stage.id === "model")
  assert.equal(model?.status, "error")
  assert.equal(model?.detail, "error")
  assert.equal(JSON.stringify(snapshot).includes("private payload"), false)
  assert.equal(hermesPipelineStages(emptyHermesHookSnapshot())[0]?.status, "idle")
})

test("the /hooks command opens the themed panel and rehydrates from server snapshots", async () => {
  const tui = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
  const panel = await readFile(new URL("../src/hermes-hooks-panel.tsx", import.meta.url), "utf8")
  const server = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(tui, /slash: \{ name: "hooks" \}/)
  assert.match(tui, /presentation: "fullscreen"/)
  assert.match(tui, /append: "session\.panel"/)
  assert.match(tui, /after: "sidebar\.content"/)
  assert.match(tui, /ActiveSubagentsSidebar sessionID=\{sessionID\}/)
  assert.match(panel, /client\.snapshot\(/)
  assert.match(panel, /client\.events\.on\("updated"/)
  assert.match(panel, /renderer\.on\("palette"/)
  assert.match(panel, /renderer\.on\("theme_mode"/)
  assert.match(panel, /renderer\.off\("palette"/)
  assert.match(panel, /renderer\.off\("theme_mode"/)
  assert.match(server, /readHermesHookSnapshot\(telemetryPath\)/)
  assert.match(server, /hermesRpc\.events\.emit\("updated"/)
})
