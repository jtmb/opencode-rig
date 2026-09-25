import assert from "node:assert/strict"
import test from "node:test"

import {
  computeProviderStates,
  OFFLINE_RECENCY_MS,
  providerStateInputFromOpenCode,
  type ProviderStateInput,
} from "../src/state.ts"
import {
  providerActivityFromEvent,
  providerActivityFromMessage,
  recentProviderActivity,
} from "../src/model.ts"
import { readFile } from "node:fs/promises"

const tuiSource = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")

test("provider sidebar keeps status rows separate from indented wrapped detail", () => {
  const rowSource = tuiSource.slice(tuiSource.indexOf("export function ProviderRow"), tuiSource.indexOf("function providerUpdatedLabel"))
  assert.match(rowSource, /providerStatusLabel\(props\.provider\.status\)/)
  assert.match(rowSource, /paddingLeft=\{2\}/)
  assert.match(rowSource, /wrapMode="word"/)
  assert.match(rowSource, /providerDetailParts\(props\.provider\)/)
  assert.match(rowSource, /attributes=\{TextAttributes\.DIM\}/)
  assert.doesNotMatch(rowSource, /providerCompactStatus\(props\.provider\)/)
})

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0)

function makeInput(overrides: Partial<ProviderStateInput> = {}): ProviderStateInput {
  return {
    providers: [{
      id: "opencode",
      name: "OpenCode Zen",
      activation: "enabled",
      integrationID: "opencode",
    }],
    connections: [],
    now: NOW,
    ...overrides,
  }
}

test("enabled provider without an integration is ambient READY without a quota adapter", () => {
  const result = computeProviderStates(providerStateInputFromOpenCode({
    providers: [{ id: "opencode", name: "OpenCode Zen", activation: "enabled" }],
    connections: [],
    now: NOW,
  }))
  assert.deepEqual(result.rows, [{
    id: "opencode",
    name: "OpenCode Zen",
    status: "READY",
    detail: "OpenCode provider is enabled without an integration requirement.",
  }])
})

test("a working OpenAI connection is visible without session history", () => {
  const result = computeProviderStates(makeInput({
    providers: [{ id: "openai", name: "OpenAI", activation: "auto", integrationID: "openai" }],
    connections: [{ integrationID: "openai", kind: "credential", active: true }],
  }))
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.status, "READY")
})

test("offline providers qualify only inside the inclusive two-hour window", () => {
  const offsets = [OFFLINE_RECENCY_MS - 1, OFFLINE_RECENCY_MS, OFFLINE_RECENCY_MS + 1]
  const statuses = offsets.map((offset) => computeProviderStates(makeInput({
    activities: [{ providerID: "opencode", at: NOW - offset }],
  })).rows[0]?.status)
  assert.deepEqual(statuses, ["OFFLINE", "OFFLINE", undefined])
})

test("disabled and absent providers never render historical activity", () => {
  const disabled = computeProviderStates(makeInput({
    providers: [{ id: "opencode", name: "OpenCode Zen", activation: "disabled", integrationID: "opencode" }],
    activities: [{ providerID: "opencode", at: NOW }],
  }))
  const absent = computeProviderStates(makeInput({
    providers: [{ id: "other", name: "Other", activation: "enabled", integrationID: "other" }],
    activities: [{ providerID: "opencode", at: NOW }],
  }))
  assert.deepEqual(disabled.rows, [])
  assert.deepEqual(absent.rows, [])
})

test("an online provider remains visible with no activity history", () => {
  const result = computeProviderStates(makeInput({
    runtime: [{ providerID: "opencode", ready: true }],
  }))
  assert.equal(result.rows[0]?.status, "READY")
})

test("runtime readiness is bounded and a later failure supersedes it", () => {
  const oldReady = computeProviderStates(makeInput({
    runtime: [{ providerID: "opencode", ready: true, at: NOW - OFFLINE_RECENCY_MS - 1 }],
  }))
  assert.deepEqual(oldReady.rows, [])

  const failedLater = computeProviderStates(makeInput({
    runtime: [
      { providerID: "opencode", ready: true, at: NOW - 1_000 },
      { providerID: "opencode", ready: false, at: NOW },
    ],
  }))
  assert.deepEqual(failedLater.rows, [])
})

test("canonical aliases deduplicate and map exact activity without cross-qualifying providers", () => {
  const result = computeProviderStates(makeInput({
    providers: [
      { id: "display-opencode", name: "Configured Zen", canonical: "opencode", activation: "enabled", integrationID: "zen" },
      { id: "opencode", name: "Alias Zen", canonical: "display-opencode", activation: "enabled", integrationID: "zen" },
      { id: "unrelated", name: "Unrelated", activation: "enabled", integrationID: "unrelated" },
    ],
    activities: [
      { providerID: "opencode", at: NOW },
      { providerID: "unrelated-model", at: NOW },
    ],
  }))
  assert.deepEqual(result.rows.map((row) => [row.id, row.name, row.status]), [["display-opencode", "Configured Zen", "OFFLINE"]])
})

test("optional probe failure does not turn an authoritative working provider OFFLINE", () => {
  const authFailure = computeProviderStates(makeInput({
    providers: [{ id: "openai", name: "OpenAI", activation: "enabled", integrationID: "openai" }],
    connections: [{ integrationID: "openai", kind: "credential", active: true }],
    probes: { openai: { outcome: "auth" } },
  }))
  const transientFailure = computeProviderStates(makeInput({
    providers: [{ id: "openai", name: "OpenAI", activation: "enabled", integrationID: "openai" }],
    connections: [{ integrationID: "openai", kind: "credential", active: true }],
    probes: { openai: { outcome: "transient", usage: "Weekly: 80% left" } },
  }))
  assert.equal(authFailure.rows[0]?.status, "READY")
  assert.equal(transientFailure.rows[0]?.status, "STALE")
  assert.notEqual(authFailure.rows[0]?.status, "OFFLINE")
  assert.notEqual(transientFailure.rows[0]?.status, "OFFLINE")
})

test("a retained usage value cannot keep an offline provider visible after recency expires", () => {
  const result = computeProviderStates(makeInput({
    providers: [{ id: "openai", name: "OpenAI", activation: "enabled", integrationID: "openai" }],
    connections: [],
    probes: { openai: { outcome: "transient", usage: "Weekly: 80% left" } },
    activities: [{ providerID: "openai", at: NOW - OFFLINE_RECENCY_MS - 1 }],
  }))
  assert.deepEqual(result.rows, [])
})

test("activity extraction is metadata-only and never forwards session IDs or message text", () => {
  const messageActivity = providerActivityFromMessage({
    id: "message-not-forwarded",
    sessionID: "session-not-forwarded",
    model: { providerID: "anthropic", modelID: "claude" },
    time: { created: NOW },
    text: "message content must not be retained",
  })
  const eventActivity = providerActivityFromEvent({
    id: "event-not-forwarded",
    created: NOW,
    type: "session.model.selected",
    data: {
      sessionID: "session-not-forwarded",
      model: { providerID: "anthropic", id: "claude" },
    },
  })
  assert.deepEqual(messageActivity, { providerID: "anthropic", at: NOW })
  assert.deepEqual(eventActivity, { providerID: "anthropic", at: NOW })
  const serialized = JSON.stringify({ messageActivity, eventActivity })
  assert.doesNotMatch(serialized, /session-not-forwarded|message content|message-not-forwarded|event-not-forwarded/)
})

test("bounded newest-first activity scanning stops below the recency boundary", () => {
  const activities = recentProviderActivity([
    { model: { providerID: "anthropic", modelID: "new" }, time: { created: NOW - 1 } },
    { model: { providerID: "openai", modelID: "old" }, time: { created: NOW - OFFLINE_RECENCY_MS - 1 } },
    { model: { providerID: "deepseek", modelID: "older" }, time: { created: NOW - OFFLINE_RECENCY_MS - 2 } },
  ], NOW, OFFLINE_RECENCY_MS)
  assert.deepEqual(activities, [{ providerID: "anthropic", at: NOW - 1 }])
})
