import assert from "node:assert/strict"
import test from "node:test"

import { createOpenCodeRuntimeManager, summarizeRuntimeResponses } from "../src/opencode-runtime.ts"

function responses() {
  return {
    mcp: { data: [{ name: "playwright", status: { status: "connected" } }] },
    plugins: {
      data: [
        { id: "opencode.core", source: { type: "builtin" }, features: { server: true }, state: { status: "active" } },
        { id: "opencode-rig.rig-tools", source: { type: "local", path: "/repo/rig-tools" }, features: { server: true }, state: { status: "active" } },
      ],
    },
    models: { data: [{ providerID: "openai", modelID: "one" }, { providerID: "deepseek", modelID: "two" }] },
    providers: { data: [{ id: "openai", activation: "enabled" }, { id: "deepseek", activation: "auto" }] },
  }
}

test("summarizes bounded OpenCode API responses without configuration secrets", () => {
  const raw = responses()
  const result = summarizeRuntimeResponses({
    version: "2.0.7",
    directory: "/repo",
    projectID: "project-test",
    ...raw,
  })
  assert.deepEqual(result.mcp, [{ name: "playwright", status: "connected" }])
  assert.equal(result.plugins[0]?.source, "local:/repo/rig-tools")
  assert.deepEqual(result.pluginSummary, {
    total: 2,
    active: 2,
    failed: 0,
    builtin: 1,
    external: 1,
    detailPolicy: "external-and-failed",
  })
  assert.deepEqual(result.modelsByProvider, { openai: 1, deepseek: 1 })
  assert.equal(JSON.stringify(result).includes("command"), false)
})

test("reports exact collection totals and truncates only above the bound", () => {
  const exact = Array.from({ length: 128 }, (_, index) => ({ providerID: "openai", modelID: String(index) }))
  const result = summarizeRuntimeResponses({
    version: "2.0.7",
    directory: "/repo",
    projectID: "project-test",
    mcp: { data: [] },
    plugins: { data: [] },
    models: { data: [...exact, { providerID: "deepseek", modelID: "overflow" }] },
    providers: { data: [] },
  })
  assert.equal(result.modelCount, 129)
  assert.equal(result.modelsByProvider.openai, 128)
  assert.equal(result.modelsByProvider.deepseek, undefined)
  assert.equal(result.bounded.truncated.models, true)

  const exactResult = summarizeRuntimeResponses({
    version: "2.0.7",
    directory: "/repo",
    projectID: "project-test",
    mcp: { data: [] },
    plugins: { data: [] },
    models: { data: exact },
    providers: { data: [] },
  })
  assert.equal(exactResult.bounded.truncated.models, false)
})

test("previews and applies a state-bound API reload", async () => {
  const raw = responses()
  const calls: string[] = []
  let now = 1_000
  const manager = createOpenCodeRuntimeManager({
    version: "2.0.7",
    directory: "/repo",
    projectID: "project-test",
    mcpList: async () => raw.mcp,
    pluginList: async () => raw.plugins,
    modelList: async () => raw.models,
    providerList: async () => raw.providers,
    reloadMcp: async () => { calls.push("mcp") },
    reloadModels: async () => { calls.push("models") },
    reloadProviders: async () => { calls.push("providers") },
  }, () => now)

  const preview = await manager.reload({ target: "all" }, "ses_test", "build")
  assert.equal(preview.dryRun, true)
  assert.deepEqual(calls, [])
  const applied = await manager.reload({ target: "all", action: "apply", expectToken: preview.expectToken }, "ses_test", "build")
  assert.equal(applied.dryRun, false)
  assert.deepEqual(calls, ["providers", "models", "mcp"])

  const expired = await manager.reload({ target: "mcp" }, "ses_test", "build")
  now += 60_001
  await assert.rejects(
    manager.reload({ target: "mcp", action: "apply", expectToken: expired.expectToken }, "ses_test", "build"),
    /missing or expired/,
  )
})

test("refuses reload when runtime state changes after preview", async () => {
  const raw = responses()
  const manager = createOpenCodeRuntimeManager({
    version: "2.0.7",
    directory: "/repo",
    projectID: "project-test",
    mcpList: async () => raw.mcp,
    pluginList: async () => raw.plugins,
    modelList: async () => raw.models,
    providerList: async () => raw.providers,
    reloadMcp: async () => {},
    reloadModels: async () => {},
    reloadProviders: async () => {},
  })
  const preview = await manager.reload({ target: "mcp" }, "ses_test", "build")
  raw.mcp.data[0]!.status.status = "pending"
  await assert.rejects(
    manager.reload({ target: "mcp", action: "apply", expectToken: preview.expectToken }, "ses_test", "build"),
    /state changed/,
  )
})
