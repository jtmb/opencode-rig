// recorder.test.ts — unit tests for the repo-learning observe/record slice.
// Run with: node --experimental-strip-types --test test/recorder.test.ts

import assert from "node:assert/strict"
import test from "node:test"

import {
  createRecorder,
  isIdleHeartbeat,
  MAX_EVENT_DETAIL_BYTES,
  MAX_EVENT_KINDS,
  MAX_EVENTS_PER_SESSION,
  MAX_PENDING_BYTES,
  MAX_PENDING_SESSIONS,
  observationNotice,
  toObservedEvent,
  toStructuredSummary,
  type ObservedEvent,
} from "../src/recorder.ts"
import { containsSensitive, redactFields, redactText } from "../src/redact.ts"
import {
  addEpisode,
  createInitialState,
  EPISODE_RETENTION_MS,
  loadState,
  loadStoredState,
  MAX_EPISODE_EVENTS,
  MAX_EPISODES,
  MAX_STATE_BYTES,
  MAX_SUMMARY_BYTES,
  parseState,
  pruneEpisodes,
  serializeState,
  type LearnState,
} from "../src/storage-state.ts"
import { eventBelongsToProject, idleSessionID, initialPluginState } from "../server.ts"

const BASE = 1_700_000_000_000

function toolEvent(overrides: Partial<ObservedEvent> = {}): ObservedEvent {
  return {
    kind: "tool",
    name: "desktop_act",
    sessionID: "ses_abc123",
    timestamp: BASE,
    ok: true,
    ...overrides,
  }
}

test("plugin starts active and converts only metadata-only OpenCode events", () => {
  assert.equal(initialPluginState(undefined).schema, 2)
  assert.equal(initialPluginState("not-json").episodes.length, 0)
  assert.equal(initialPluginState(serializeState(createInitialState()), BASE).episodes.length, 0)
  assert.deepEqual(toObservedEvent({
    id: "evt_tool_input",
    type: "session.tool.input.started",
    created: BASE,
    durable: { aggregateID: "ses_abc123", seq: 1, version: 1 },
    location: { directory: "/repo/a" },
    data: { sessionID: "ses_abc123", assistantMessageID: "msg_1", id: "call_1", name: "git_diff" },
  }), {
    kind: "tool",
    name: "git_diff",
    sessionID: "ses_abc123",
    timestamp: BASE,
    ok: true,
  })
  assert.deepEqual(toObservedEvent({
    id: "evt_tool_failure",
    type: "session.tool.failed",
    created: BASE + 1,
    durable: { aggregateID: "ses_abc123", seq: 2, version: 2 },
    location: { directory: "/repo/a" },
    data: {
      sessionID: "ses_abc123",
      assistantMessageID: "msg_1",
      id: "call_1",
      error: { type: "Error", message: "ignored" },
      executed: true,
    },
  }), {
    kind: "execution",
    name: "tool-failed",
    sessionID: "ses_abc123",
    timestamp: BASE + 1,
    ok: false,
  })
  assert.equal(toObservedEvent({
    id: "evt_tool_call",
    type: "session.tool.called",
    created: BASE + 2,
    durable: { aggregateID: "ses_abc123", seq: 3, version: 1 },
    location: { directory: "/repo/a" },
    data: {
      sessionID: "ses_abc123",
      assistantMessageID: "msg_1",
      id: "call_1",
      input: { privateArgument: "not a transcript" },
      executed: true,
    },
  }), undefined)
  assert.equal(toObservedEvent({
    id: "evt_tool_success",
    type: "session.tool.success",
    created: BASE + 3,
    durable: { aggregateID: "ses_abc123", seq: 4, version: 2 },
    location: { directory: "/repo/a" },
    data: {
      sessionID: "ses_abc123",
      assistantMessageID: "msg_1",
      id: "call_1",
      content: [{ type: "text", text: "ignored" }],
      executed: true,
    },
  }), undefined)
  assert.equal(toObservedEvent({
    type: "session.tool.succeeded",
    created: BASE + 4,
    data: { sessionID: "ses_abc123" },
  }), undefined)
})

function episode(id: string, endedAt = BASE, summary = "episode"): LearnState["episodes"][number] {
  return {
    id,
    sessionID: "ses_episode",
    startedAt: endedAt,
    endedAt,
    toolCalls: 1,
    errors: 0,
    summary,
  }
}

test("redacts github tokens, aws keys, and password assignments", () => {
  const text = "token ghp_abcdefghij1234567890 and AKIAIOSFODNN7EXAMPLE plus password=hunter2secret and sk-proj-abcdefghijklmnop1234 and password=\"correct horse battery staple\""
  const redacted = redactText(text)
  assert.ok(!redacted.includes("ghp_abcdefghij1234567890"))
  assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"))
  assert.ok(!redacted.includes("hunter2secret"))
  assert.ok(!redacted.includes("sk-proj-abcdefghijklmnop1234"))
  assert.ok(!redacted.includes("horse battery staple"))
  assert.ok(redacted.includes("[REDACTED]"))
  assert.equal(containsSensitive(text), true)
  assert.equal(containsSensitive("plain summary with no secrets"), false)
})

test("redaction is fail-closed on over-cap and non-string input", () => {
  assert.throws(() => redactText("x".repeat(64 * 1024 + 1)), /exceeds/)
  assert.throws(() => redactText("é".repeat(32 * 1024 + 1)), /exceeds/)
  assert.throws(() => redactText(42 as unknown as string), /requires a string/)
  assert.throws(() => redactFields([{ nested: true }] as unknown as Record<string, unknown>), /flat object/)
})

test("redactFields redacts strings and collapses nested structures", () => {
  const output = redactFields({ note: "key ghp_abcdefghij1234567890", raw: { transcript: "secret" }, count: 3 })
  assert.ok(!(output["note"] as string).includes("ghp_abcdefghij1234567890"))
  assert.equal(output["raw"], "[REDACTED]:nested")
  assert.equal(output["count"], 3)
  const keyed = redactFields({ "password=hunter2secret": "safe" })
  assert.ok(!Object.keys(keyed).some((key) => key.includes("hunter2secret")))
})

test("structured summaries redact detail, enforce UTF-8 bytes, and reject transcripts", () => {
  const summary = toStructuredSummary(toolEvent({ detail: "used Bearer abcdefghijklmnop1234" }))
  assert.ok(!summary.includes("abcdefghijklmnop1234"))
  assert.ok(summary.startsWith("tool:desktop_act ok=yes"))
  assert.throws(() => toStructuredSummary(toolEvent({ detail: "é".repeat(Math.floor(MAX_EVENT_DETAIL_BYTES / 2) + 1) })), /exceeds/)
  assert.throws(() => toStructuredSummary(toolEvent({ detail: "x".repeat(MAX_EVENT_DETAIL_BYTES + 1) })), /exceeds/)
  assert.throws(() => toStructuredSummary({ kind: "nope" } as unknown as ObservedEvent), /invalid event/)
  assert.deepEqual(
    createRecorder({ now: () => BASE }).recordEvent({ ...toolEvent(), transcript: "raw transcript" }),
    { stored: false, reason: "invalid-event" },
  )
})

test("recordEvent stores valid events and drops malformed or over-cap raw input fail-closed", () => {
  const recorder = createRecorder({ now: () => BASE })
  assert.deepEqual(recorder.recordEvent(toolEvent()), { stored: true, sessionID: "ses_abc123" })
  assert.deepEqual(recorder.recordEvent({ kind: "tool" }), { stored: false, reason: "invalid-event" })
  assert.deepEqual(
    recorder.recordEvent(toolEvent({ detail: "é".repeat(Math.floor(MAX_EVENT_DETAIL_BYTES / 2) + 1) })),
    { stored: false, reason: "over-cap-detail" },
  )
  assert.deepEqual(
    recorder.recordEvent(toolEvent({ name: "x".repeat(129) })),
    { stored: false, reason: "over-cap-name" },
  )
})

test("flushSession aggregates counts and stores a bounded redacted episode", () => {
  const recorder = createRecorder({ now: () => BASE })
  recorder.recordEvent(toolEvent())
  recorder.recordEvent(toolEvent({ name: "desktop_tree", timestamp: BASE + 1000 }))
  recorder.recordEvent(toolEvent({ name: "desktop_act", ok: false, timestamp: BASE + 2000, detail: "password=topsecretvalue" }))
  const episode = recorder.flushSession("ses_abc123")
  assert.ok(episode !== undefined)
  assert.equal(episode.toolCalls, 3)
  assert.equal(episode.errors, 1)
  assert.ok(!episode.summary.includes("topsecretvalue"))
  assert.ok(episode.summary.length <= MAX_SUMMARY_BYTES)
  assert.equal(recorder.state.episodes.length, 1)
  assert.equal(recorder.flushSession("ses_missing"), undefined)
  const exposed = recorder.state
  exposed.episodes.length = 0
  assert.equal(recorder.state.episodes.length, 1)
})

test("idle heartbeats are dropped without cost", () => {
  const heartbeat: ObservedEvent = { kind: "execution", name: "heartbeat", sessionID: "ses_idle", timestamp: BASE, ok: true }
  assert.equal(isIdleHeartbeat(heartbeat, undefined, BASE), false)
  assert.equal(isIdleHeartbeat(heartbeat, BASE - 20 * 60 * 1000, BASE), true)
  assert.equal(isIdleHeartbeat({ ...heartbeat, name: "failed", ok: false }, BASE - 20 * 60 * 1000, BASE), false)
  assert.equal(isIdleHeartbeat(toolEvent(), BASE - 60 * 60 * 1000, BASE), false)
  const recorder = createRecorder({ now: () => BASE })
  recorder.recordEvent({ ...heartbeat, timestamp: BASE - 20 * 60 * 1000 })
  assert.deepEqual(recorder.recordEvent(heartbeat), { stored: false, reason: "idle-heartbeat" })
})

test("pending session, event, kind, and byte caps report deterministic drops", () => {
  const sessions = createRecorder({ now: () => BASE })
  for (let index = 0; index < MAX_PENDING_SESSIONS; index += 1) {
    assert.deepEqual(
      sessions.recordEvent(toolEvent({ sessionID: `ses_pending_${index}`, timestamp: BASE + index })),
      { stored: true, sessionID: `ses_pending_${index}` },
    )
  }
  assert.deepEqual(
    sessions.recordEvent(toolEvent({ sessionID: "ses_pending_overflow", timestamp: BASE })),
    { stored: false, reason: "over-cap-sessions" },
  )

  const kinds = createRecorder({ now: () => BASE })
  assert.equal(kinds.recordEvent(toolEvent({ sessionID: "ses_kinds" })).stored, true)
  for (let index = 1; index < MAX_EVENT_KINDS; index += 1) {
    assert.equal(kinds.recordEvent(toolEvent({ sessionID: "ses_kinds", name: `tool_${index}`, timestamp: BASE + index })).stored, true)
  }
  assert.deepEqual(
    kinds.recordEvent(toolEvent({ sessionID: "ses_kinds", name: "tool_overflow", timestamp: BASE + MAX_EVENT_KINDS })),
    { stored: false, reason: "over-cap-kinds" },
  )

  const events = createRecorder({ now: () => BASE })
  for (let index = 0; index < MAX_EVENTS_PER_SESSION; index += 1) {
    assert.equal(events.recordEvent(toolEvent({ sessionID: "ses_events", timestamp: BASE + index })).stored, true)
  }
  assert.deepEqual(
    events.recordEvent(toolEvent({ sessionID: "ses_events", timestamp: BASE + MAX_EVENTS_PER_SESSION })),
    { stored: false, reason: "over-cap-events" },
  )

  const bytes = createRecorder({ now: () => BASE })
  const detail = "d".repeat(MAX_EVENT_DETAIL_BYTES)
  let result: ReturnType<typeof bytes.recordEvent> = { stored: true, sessionID: "ses_bytes" }
  for (let index = 0; index < MAX_EVENTS_PER_SESSION; index += 1) {
    result = bytes.recordEvent(toolEvent({ sessionID: "ses_bytes", timestamp: BASE + index, detail }))
    if (!result.stored) break
  }
  assert.deepEqual(result, { stored: false, reason: "over-cap-pending-bytes" })
  assert.ok(MAX_PENDING_BYTES > MAX_EVENT_DETAIL_BYTES)
})

test("30-day retention prunes expired episodes and keeps fresh ones", () => {
  assert.equal(EPISODE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000)
  let state = createInitialState()
  state = addEpisode(state, episode("old-1", BASE - EPISODE_RETENTION_MS - 1000, "old episode"))
  state = addEpisode(state, episode("fresh-1", BASE, "fresh episode"))
  const pruned = pruneEpisodes(state, BASE)
  assert.deepEqual(pruned.episodes.map((item) => item.id), ["fresh-1"])
  assert.throws(() => pruneEpisodes(state, Number.NaN), /valid nowMs/)
})

test("status and audit prune expired episodes and persist the cleaned state", () => {
  let clock = BASE
  const initial = addEpisode(createInitialState(), episode("ep-read", BASE, "read me"))
  const persisted: LearnState[] = []
  const recorder = createRecorder({ initialState: initial, now: () => clock, persistState: (state) => persisted.push(state) })
  clock = BASE + EPISODE_RETENTION_MS + 1
  const status = recorder.learnCommand("/learn status")
  assert.equal(status.mutated, false)
  assert.ok(status.text.includes("0 episodes retained"))
  assert.equal(recorder.state.episodes.length, 0)
  assert.deepEqual(persisted.at(-1)?.episodes, [])
  const audit = recorder.learnCommand("/learn audit")
  assert.equal(audit.mutated, false)
  assert.ok(!audit.text.includes("ep-read"))
})

test("episode count cap evicts oldest-first and rejects invalid episodes", () => {
  let state = createInitialState()
  for (let index = 0; index < MAX_EPISODES + 5; index += 1) {
    state = addEpisode(state, {
      id: `ep-${index}`,
      sessionID: "ses_cap",
      startedAt: BASE + index,
      endedAt: BASE + index,
      toolCalls: 1,
      errors: 0,
      summary: `episode ${index}`,
    })
  }
  assert.equal(state.episodes.length, MAX_EPISODES)
  assert.equal(state.episodes[0].id, "ep-5")
  assert.throws(
    () =>
      addEpisode(state, {
        id: "bad!",
        sessionID: "ses_cap",
        startedAt: BASE,
        endedAt: BASE,
        toolCalls: 0,
        errors: 0,
        summary: "bad id",
      }),
    /invalid episode/,
  )
})

test("state serialization uses UTF-8 bytes and parse enforces state and nested caps", () => {
  const state = addEpisode(createInitialState(), {
    id: "ep-1",
    sessionID: "ses_1",
    startedAt: BASE,
    endedAt: BASE,
    toolCalls: 1,
    errors: 0,
    summary: "hello",
  })
  assert.deepEqual(parseState(serializeState(state)), state)
  const oldState = addEpisode(createInitialState(), episode("ep-old", BASE - EPISODE_RETENTION_MS - 1, "old"))
  assert.deepEqual(parseState(serializeState(oldState), BASE).episodes, [])
  assert.deepEqual(loadState(serializeState(state), BASE).episodes.map((item) => item.id), ["ep-1"])
  assert.throws(() => parseState("not json"), /malformed/)
  assert.throws(() => parseState(JSON.stringify({ schema: 999, episodes: [] })), /unknown schema/)
  assert.throws(() => parseState(JSON.stringify({ schema: 2, paused: false, episodes: [] })), /invalid LearnState|invalid state bounds/)
  assert.throws(
    () => parseState(JSON.stringify({ schema: 2, episodes: Array.from({ length: MAX_EPISODES + 1 }, () => episode("ep")) })),
    /episodes/,
  )
  assert.throws(
    () => parseState(JSON.stringify({ schema: 2, episodes: [{ ...episode("ep-count"), toolCalls: MAX_EPISODE_EVENTS + 1 }] })),
    /episodes|bounds/,
  )
  assert.throws(
    () => parseState(JSON.stringify({ schema: 2, episodes: [{ ...episode("ep-summary"), summary: "é".repeat(MAX_SUMMARY_BYTES) }] })),
    /episodes|bounds/,
  )
  assert.throws(
    () => parseState(JSON.stringify({ schema: 2, episodes: [{ ...episode("ep-transcript"), transcript: "raw" }] })),
    /episodes|bounds/,
  )
  assert.throws(
    () => parseState(`{"schema":2,"episodes":[],"extra":"${"é".repeat(MAX_STATE_BYTES)}"}`),
    /invalid state payload/,
  )
  assert.throws(
    () => serializeState({ ...state, episodes: [{ ...state.episodes[0], summary: "é".repeat(MAX_STATE_BYTES) }] } as LearnState),
    /exceeds/,
  )
  assert.throws(() => serializeState({ ...state, episodes: [...state.episodes, { ...episode("ep-extra"), summary: "x".repeat(2001) }] }), /invalid LearnState|invalid episode/)
})

test("legacy paused records migrate to active schema and retain bounded safe history", () => {
  const legacy = JSON.stringify({ schema: 1, paused: true, episodes: [episode("ep-legacy", BASE, "safe history")] })
  const loaded = loadStoredState(legacy, BASE)
  assert.equal(loaded.state.schema, 2)
  assert.deepEqual(loaded.state.episodes.map((item) => item.id), ["ep-legacy"])
  assert.equal("paused" in loaded.state, false)
  assert.equal(loaded.changed, true)
  assert.ok(loaded.diagnostics.some((diagnostic) => diagnostic.includes("paused=true flag was ignored")))
  assert.equal(initialPluginState(legacy, BASE).episodes[0]?.id, "ep-legacy")

  const partiallyInvalid = JSON.stringify({
    schema: 1,
    paused: true,
    episodes: [episode("ep-preserved", BASE), { ...episode("ep-invalid", BASE), transcript: "raw" }],
  })
  const recovered = loadStoredState(partiallyInvalid, BASE)
  assert.deepEqual(recovered.state.episodes.map((item) => item.id), ["ep-preserved"])
  assert.ok(recovered.diagnostics.some((diagnostic) => diagnostic.includes("retained 1 valid episode")))
})

test("disabled recorder reports status and audit without observing or persisting", () => {
  const initial = addEpisode(createInitialState(), episode("ep-disabled", BASE, "retained history"))
  const persisted: LearnState[] = []
  const recorder = createRecorder({
    enabled: false,
    initialState: initial,
    now: () => BASE,
    persistState: (state) => persisted.push(state),
  })
  assert.deepEqual(recorder.recordEvent(toolEvent()), { stored: false, reason: "disabled" })
  assert.equal(recorder.flushSession("ses_abc123", BASE), undefined)
  let subscriptions = 0
  recorder.attach({ subscribe: () => { subscriptions += 1 } })
  assert.equal(subscriptions, 0)

  const status = recorder.learnCommand("/learn status", BASE)
  assert.ok(status.text.includes("disabled by configuration"))
  assert.equal(status.mutated, false)
  const audit = recorder.learnCommand("/learn audit", BASE)
  assert.ok(audit.text.includes("ep-disabled"))
  assert.deepEqual(persisted, [])
})

test("uses current idle events and filters observation to the plugin repository", async () => {
  assert.equal(idleSessionID({ type: "session.status", data: { sessionID: "ses_1", status: { type: "idle" } } }), "ses_1")
  assert.equal(idleSessionID({ type: "session.status", data: { sessionID: "ses_1", status: { type: "busy" } } }), undefined)
  assert.equal(idleSessionID({ type: "session.idle", data: { sessionID: "ses_legacy" } }), "ses_legacy")

  const target = { directory: "/repo/a", projectID: "project-a" }
  assert.equal(await eventBelongsToProject(
    { type: "session.created", location: { directory: "/repo/a" }, data: { sessionID: "ses_1", projectID: "project-a" } },
    target,
    async () => { throw new Error("direct event location should be authoritative") },
  ), true)
  assert.equal(await eventBelongsToProject(
    { type: "session.status", location: { directory: "/repo/b" }, data: { sessionID: "ses_2", status: { type: "idle" } } },
    target,
    async () => ({ projectID: "project-a", location: { directory: "/repo/a" } }),
  ), false)
  assert.equal(await eventBelongsToProject(
    { type: "session.execution.failed", data: { sessionID: "ses_3" } },
    target,
    async () => ({ projectID: "project-a", location: { directory: "/repo/a" } }),
  ), true)
  assert.equal(await eventBelongsToProject(
    { type: "session.execution.failed", data: { sessionID: "ses_4" } },
    target,
    async () => ({ projectID: "project-b", location: { directory: "/repo/b" } }),
  ), false)
})

test("/learn status and audit stay read-only; pause and resume are not commands", () => {
  const recorder = createRecorder({ now: () => BASE })
  recorder.recordEvent(toolEvent())
  recorder.flushSession("ses_abc123", BASE)
  const before = serializeState(recorder.state)
  const status = recorder.learnCommand("/learn status", BASE)
  assert.equal(status.mutated, false)
  assert.ok(status.text.includes("observing"))
  const audit = recorder.learnCommand("audit", BASE)
  assert.equal(audit.mutated, false)
  assert.ok(audit.text.includes("ses_abc123"))
  assert.equal(serializeState(recorder.state), before)
  assert.throws(() => recorder.learnCommand("/learn pause", BASE), /expected status\|audit/)
  assert.throws(() => recorder.learnCommand("/learn resume", BASE), /expected status\|audit/)
  assert.throws(() => recorder.learnCommand("/learn pause approval-token", BASE), /expected status\|audit/)
  assert.throws(() => recorder.learnCommand("/learn explode", BASE), /unknown \/learn subcommand/)
})

test("attach subscribes to execution and tool topics", () => {
  const recorder = createRecorder({ now: () => BASE })
  const topics: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  recorder.attach({
    subscribe: (topic, handler) => {
      topics.push(topic)
      handlers.set(topic, handler)
    },
  })
  assert.deepEqual(topics, ["session.execution", "session.tool"])
  handlers.get("session.tool")?.(toolEvent({ sessionID: "ses_attached" }))
  const stored = recorder.flushSession("ses_attached", BASE)
  assert.equal(stored?.toolCalls, 1)
})

test("observation notice announces summaries-only recording", () => {
  const notice = observationNotice()
  assert.ok(notice.toast.includes("on by default"))
  assert.ok(!notice.toast.includes("pause"))
  assert.ok(notice.status.includes("30d"))
})
