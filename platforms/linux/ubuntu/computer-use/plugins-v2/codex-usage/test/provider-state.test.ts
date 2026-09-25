import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { providerUsageSummary } from "../src/format.ts"
import {
  computeProviderStates,
  type ProviderStateInput,
  type ProviderUsageSnapshot,
} from "../src/state.ts"
import { providerStates } from "../src/providers.ts"

type ProviderInput = ProviderStateInput["providers"][number]
type ConnectionInput = ProviderStateInput["connections"][number]

function provider(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    id: "codex",
    name: "Codex",
    activation: "enabled",
    integrationID: "openai",
    modelCount: 1,
    ...overrides,
  }
}

function connection(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    integrationID: "openai",
    kind: "credential",
    active: true,
    ...overrides,
  }
}

function snapshot(input: Partial<ProviderStateInput> = {}): ProviderUsageSnapshot {
  return computeProviderStates({
    providers: [provider()],
    connections: [connection()],
    ...input,
  })
}

function onlyRow(value: ProviderUsageSnapshot) {
  assert.equal(value.rows.length, 1)
  return value.rows[0]!
}

test("V2 credential connection makes Codex READY without consulting auth.json", async () => {
  const source = await readFile(new URL("../src/state.ts", import.meta.url), "utf8")
  assert.doesNotMatch(source, /node:(?:fs|path|os)|auth\.json/)

  const result = snapshot({
    providers: [provider({ activation: "enabled", modelCount: 0 })],
    connections: [connection({ kind: "credential", active: true })],
  })
  assert.equal(onlyRow(result).status, "READY")
  assert.notEqual(onlyRow(result).status, "OFFLINE")
})

test("disabled providers are absent and hidden auto providers are not represented as OFFLINE", () => {
  assert.deepEqual(computeProviderStates({
    providers: [provider({ activation: "disabled" })],
    connections: [],
  }).rows, [])

  const hidden = computeProviderStates({
    providers: [provider({ id: "unknown-provider", name: "Unknown", activation: "auto", modelCount: 0 })],
    connections: [],
    probes: { "unknown-provider": { outcome: "auth" } },
  })
  assert.equal(hidden.rows.length, 0)
  assert.equal(hidden.rows.some((row) => row.status === "OFFLINE"), false)
})

test("auto providers require a working connection or recent authoritative activity", () => {
  const noEvidence = computeProviderStates({
    providers: [provider({ activation: "auto", modelCount: 0 })],
    connections: [],
  })
  assert.deepEqual(noEvidence.rows, [])

  const connected = computeProviderStates({
    providers: [provider({ activation: "auto", modelCount: 0 })],
    connections: [connection({ active: true })],
  })
  assert.equal(connected.rows.length, 1)
  assert.equal(connected.rows[0]?.status, "READY")

  const inventoried = computeProviderStates({
    providers: [provider({ activation: "auto", modelCount: 1 })],
    connections: [],
  })
  assert.deepEqual(inventoried.rows, [])

  const recentlyUsed = computeProviderStates({
    providers: [provider({ activation: "auto", modelCount: 1 })],
    connections: [],
    activities: [{ providerID: "codex", at: Date.now() - 1_000 }],
  })
  assert.equal(recentlyUsed.rows.length, 1)
  assert.equal(recentlyUsed.rows[0]?.status, "OFFLINE")
})

test("enabled providers without a connection are hidden until recent use qualifies OFFLINE", () => {
  const result = computeProviderStates({
    providers: [provider({ activation: "enabled", modelCount: 0 })],
    connections: [],
  })
  assert.deepEqual(result.rows, [])

  const recent = computeProviderStates({
    providers: [provider({ activation: "enabled", modelCount: 0 })],
    connections: [],
    activities: [{ providerID: "codex", at: Date.now() - 1_000 }],
  })
  assert.equal(onlyRow(recent).status, "OFFLINE")
})

test("credential and environment connections establish READY", () => {
  for (const kind of ["credential", "env"] as const) {
    const result = snapshot({ connections: [connection({ kind })] })
    assert.equal(onlyRow(result).status, "READY", kind)
  }
})

test("probe outcomes have explicit precedence and retain transient usage", () => {
  const cases = [
    { outcome: "ok", status: "READY", usage: "Weekly: 80% left" },
    { outcome: "empty", status: "EMPTY" },
    { outcome: "auth", status: "READY" },
    { outcome: "rate", status: "READY" },
    { outcome: "unavailable", status: "READY" },
    { outcome: "transient", status: "STALE", usage: "Weekly: 80% left" },
  ] as const

  for (const scenario of cases) {
    const probe = "usage" in scenario
      ? { outcome: scenario.outcome, usage: scenario.usage }
      : { outcome: scenario.outcome }
    const result = snapshot({
      probes: { codex: probe },
    })
    const row = onlyRow(result)
    assert.equal(row.status, scenario.status, scenario.outcome)
    if ("usage" in scenario) assert.equal(row.usage, scenario.usage, scenario.outcome)
    if (scenario.outcome === "rate") assert.match(row.detail, /measurement is unavailable/i)
  }

  const noAdapter = snapshot({ probes: undefined })
  const row = onlyRow(noAdapter)
  assert.equal(row.status, "READY")
  assert.equal(row.usage, undefined)
})

test("verified normalized remaining ratios cross the provider state boundary", () => {
  const result = snapshot({
    probes: {
      codex: { outcome: "ok", usage: "Weekly: 80% left", remainingRatio: 0.8 },
    },
  })
  assert.equal(onlyRow(result).remainingRatio, 0.8)

  const retained = snapshot({
    probes: {
      codex: { outcome: "transient", usage: "Weekly: 80% left", remainingRatio: 0.8 },
    },
  })
  assert.equal(onlyRow(retained).remainingRatio, 0.8)
})

test("canonical aliases deduplicate under the first configured display name", () => {
  const result = computeProviderStates({
    providers: [
      provider({ id: "codex", name: "Configured Codex", canonical: "openai", modelCount: 0 }),
      provider({ id: "openai", name: "Alias Codex", canonical: "codex", modelCount: 0 }),
    ],
    connections: [connection({ integrationID: "openai" })],
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.name, "Configured Codex")
})

test("empty visible state produces no provider rows, no client rows, and a hidden panel", async () => {
  const result = computeProviderStates({
    providers: [provider({ activation: "auto", modelCount: 0 })],
    connections: [],
  })
  const visible = providerStates(result)
  assert.deepEqual(result.rows, [])
  assert.deepEqual(visible, [])
  assert.equal(providerUsageSummary(visible), "")

  const tui = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
  assert.match(tui, /const visible = \(\) =>/)
  assert.match(tui, /<Show when=\{visible\(\)\}>/)
})

test("collapsed summary counts only visible server rows", () => {
  const result = computeProviderStates({
    providers: [
      provider({ id: "ready", name: "Ready", integrationID: "ready", activation: "enabled", modelCount: 0 }),
      provider({ id: "empty", name: "Empty", integrationID: "empty", activation: "enabled", modelCount: 0 }),
      provider({ id: "offline", name: "Offline", integrationID: "offline", activation: "enabled", modelCount: 0 }),
      provider({ id: "hidden", name: "Hidden", integrationID: "hidden", activation: "auto", modelCount: 0 }),
    ],
    connections: [
      connection({ integrationID: "ready" }),
      connection({ integrationID: "empty" }),
    ],
    probes: {
      ready: { outcome: "ok", usage: "80% left" },
      empty: { outcome: "empty" },
    },
    activities: [{ providerID: "offline", at: Date.now() - 1_000 }],
  })
  const visible = providerStates(result)
  assert.deepEqual(visible.map((row) => row.id), ["ready", "empty", "offline"])
  assert.equal(providerUsageSummary(visible), "1 ready · 1 empty · 1 offline")
})

test("serialized snapshots and client rows never leak credential canaries", () => {
  const canaryInput = {
    providers: [provider({ modelCount: 0 })],
    connections: [connection()],
    probes: { codex: { outcome: "transient" as const, usage: "Bearer CANARY_ACCESS_TOKEN" } },
    credential: "CANARY_OAUTH_TOKEN",
    apiKey: "CANARY_API_KEY",
  } as unknown as ProviderStateInput
  const computed = computeProviderStates(canaryInput)
  const clientRows = providerStates(computed)
  const serialized = JSON.stringify({ snapshot: computed, rows: clientRows })
  assert.doesNotMatch(serialized, /CANARY_ACCESS_TOKEN|CANARY_OAUTH_TOKEN|CANARY_API_KEY/)
  assert.match(JSON.stringify(computed), /redacted/)
  assert.deepEqual(clientRows[0]?.usage, "Bearer [redacted]")
})

test("provider adapter renders exactly the server rows and never synthesizes catalog rows", () => {
  const rows = [
    { id: "one", name: "One", status: "READY" as const, detail: "verified", usage: "80% left" },
    { id: "two", name: "Two", status: "STALE" as const, detail: "retained" },
  ]
  const visible = providerStates({ generated: 1, rows, diagnostics: [] })
  assert.deepEqual(visible, [
    { id: "one", label: "One", status: "available", detail: "verified", usage: "80% left" },
    { id: "two", label: "Two", status: "stale", detail: "retained" },
  ])
  assert.deepEqual(providerStates({ generated: 1, rows: [], diagnostics: ["ignored"] }), [])
})

test("server RPC and stale refresh retain rows with sanitized diagnostics", async () => {
  const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8")
  assert.match(source, /id: "provider\.usage"/)
  assert.match(source, /snapshot:/)
  assert.match(source, /function staleSnapshot/)
  assert.match(source, /status: "STALE"/)
  assert.match(source, /previous value is retained/)
  assert.match(source, /boundedDiagnostics/)
  assert.doesNotMatch(source, /readOpenAICredential|auth\.json/)
})

test("refresh polling stays throttled while authoritative events may force and concurrent work coalesces", async () => {
  const [server, tui] = await Promise.all([
    readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/tui.tsx", import.meta.url), "utf8"),
  ])
  assert.match(server, /const MIN_REFRESH_MS = 30_000/)
  assert.match(server, /const refreshMs = positiveNumber\(ctx\.options\.refreshMs, DEFAULT_REFRESH_MS, MIN_REFRESH_MS\)/)
  assert.match(server, /const poll = setInterval\(\(\) => \{\s*void refresh\(\)\s*\}, refreshMs\)/)
  assert.doesNotMatch(server, /const poll = setInterval\(\(\) => \{\s*void refresh\(true\)/)
  assert.match(server, /snapshot: async \(input\) => \{[\s\S]*return refresh\(false\)/)
  assert.match(server, /if \(refreshTask\) \{/)
  assert.match(server, /ACTIVITY_EVENTS/)
  assert.match(server, /session\.model\.selected/)
  assert.match(server, /session\.hook\("model\.request"/)
  assert.match(server, /session\.hook\("http\.response"/)
  assert.match(
    server,
    /if \(REFRESH_EVENTS\.has\(event\.type\)\) \{[\s\S]*anthropicWorkspaceGeneration \+= 1[\s\S]*anthropicWorkspaceResolved = false[\s\S]*anthropicRateMeasurement = undefined[\s\S]*queueEventRefresh\(true\)/,
  )
  assert.match(server, /if \(activity\) rememberActivity\(activity\.providerID, activity\.at\)\s*queueEventRefresh\(false\)/)
  for (const event of ["credential.updated", "credential.switched", "integration.updated", "provider.updated"]) {
    assert.match(server, new RegExp(`"${event}"`))
  }
  assert.match(tui, /const poll = setInterval\(\(\) => void props\.store\.refresh\(\), props\.refreshMs\)/)
  assert.match(tui, /const refreshOnEvent = \(\) => void props\.store\.refresh\(true\)/)

  let resolveSnapshot: ((value: unknown) => void) | undefined
  const pending = new Promise<unknown>((resolve) => {
    resolveSnapshot = resolve
  })
  let calls = 0
  const store = (await import("../src/store.ts")).createUsageStore({
    fetchSnapshot: async () => {
      calls += 1
      return pending
    },
  })
  const first = store.refresh(true)
  const second = store.refresh(true)
  assert.strictEqual(first, second)
  assert.equal(calls, 1)
  resolveSnapshot?.({ generated: 1, rows: [], diagnostics: [] })
  await first
  store.dispose()
})

test("client snapshot integration is explicit rather than a legacy catalog fallback", async () => {
  const [providers, store, tui] = await Promise.all([
    readFile(new URL("../src/providers.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/tui.tsx", import.meta.url), "utf8"),
  ])
  assert.match(providers, /ProviderUsageSnapshot/)
  assert.match(providers, /snapshotRows/)
  assert.match(store, /ProviderUsageSnapshot/)
  assert.doesNotMatch(store, /snapshot\?: CodexUsageSnapshot|deepSeekBalance\?: DeepSeekBalanceSnapshot/)
  assert.doesNotMatch(store, /readOpenAICredential|readDeepSeekCredential|auth\.json/)
  assert.match(tui, /ProviderUsage|provider\.usage\.snapshot|context\.client\.rpc/)
  assert.doesNotMatch(tui, /context\.client\.provider\.list/)
})

test("native MCP-style provider rows remain single-line at 140, 80, and 60 columns", async () => {
  const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
  for (const width of [140, 80, 60]) {
    assert.match(source, /width="100%" height=\{1\} overflow="hidden"/, `${width} columns: row is bounded`)
    assert.match(source, /wrapMode="none"/, `${width} columns: rows do not wrap`)
    assert.match(source, /truncate/, `${width} columns: status truncates`)
    assert.match(source, /flexGrow=\{1\}/, `${width} columns: status is right-aligned`)
  }
  assert.match(source, /before: "sidebar\.footer"/)
  assert.doesNotMatch(source, /append: "sidebar\.footer"/)
  assert.doesNotMatch(source, /Refresh failed; saved values retained\./)
})
