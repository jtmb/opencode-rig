import assert from "node:assert/strict"
import test from "node:test"

import type {
  MessageListInput,
  SessionInfo,
  SessionListInput,
  SessionMessageInfo,
} from "@opencode/client"

import {
  createBoundedFetch,
  createSessionContextReader,
  sessionContextCommandInput,
  truncateJsonString,
  validateServiceInfo,
} from "../src/session-context.ts"

const PROJECT = "project-one"
const CURRENT = "ses_current"
const TARGET = "ses_target"

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    projectID: PROJECT,
    cost: 0 as SessionInfo["cost"],
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 1, updated: 2 },
    title: id,
    location: { directory: "/workspace" },
    ...overrides,
  }
}

function response<T>(data: T[], next?: string) {
  return { data, cursor: { next: next ?? null, previous: null } }
}

type MockOptions = {
  sessions?: SessionInfo[]
  active?: Record<string, { type: "running" }>
  messageList?: (input: MessageListInput) => Promise<ReturnType<typeof response<SessionMessageInfo>>>
  sessionCalls?: SessionListInput[]
  messageCalls?: MessageListInput[]
}

test("service identity accepts a distinct daemon PID but not a different version", () => {
  assert.doesNotThrow(() => validateServiceInfo({ version: "2.0.7", pid: process.pid + 10 }, "2.0.7"))
  assert.throws(() => validateServiceInfo({ version: "2.0.8", pid: process.pid }, "2.0.7"), /service-version-mismatch/)
})

function mockClient(options: MockOptions = {}) {
  const sessions = options.sessions ?? [session(CURRENT), session(TARGET, { title: "Target work" })]
  return {
    server: { info: async () => ({ version: "2.0.7", pid: process.pid, urls: [], paths: { tmp: "/tmp" } }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = sessions.find((item) => item.id === sessionID)
        if (!found) throw new Error("not found")
        return found
      },
      active: async () => options.active ?? {},
      list: async (input: SessionListInput) => {
        options.sessionCalls?.push(input)
        return response(sessions)
      },
    },
    message: {
      list: async (input: MessageListInput) => {
        options.messageCalls?.push(input)
        return options.messageList ? options.messageList(input) : response([])
      },
    },
  }
}

function reader(client: ReturnType<typeof mockClient>) {
  return createSessionContextReader({
    projectID: PROJECT,
    version: "2.0.7",
    dependencies: {
      client: async () => client as never,
      wallClock: () => 1234,
    },
  })
}

test("lists only other sessions defensively matching the current project", async () => {
  const calls: SessionListInput[] = []
  const client = mockClient({
    sessions: [
      session(CURRENT),
      session(TARGET, { title: "Target work", outcome: "interrupted" }),
      session("ses_other_project", { projectID: "project-two" }),
      session(TARGET, { title: "duplicate" }),
    ],
    active: { [TARGET]: { type: "running" } },
    sessionCalls: calls,
  })
  const result = JSON.parse(await reader(client).collect(CURRENT, { action: "list" }))
  assert.equal(result.status, "ok")
  assert.deepEqual(result.sessions.map((item: { id: string }) => item.id), [TARGET])
  assert.equal(result.sessions[0].liveStatus, "running")
  assert.equal(result.sessions[0].savedOutcome, "interrupted")
  assert.equal(calls[0]?.project, PROJECT)
  assert.equal(calls[0]?.order, "desc")
})

test("reads a checkpoint plus a settled chronological suffix without sensitive payloads", async () => {
  const messageCalls: MessageListInput[] = []
  const checkpoint = {
    id: "msg_checkpoint",
    type: "compaction",
    status: "completed",
    reason: "auto",
    time: { created: 10 },
    summary: "Objective and decisions",
    recent: "raw recent tool output must not appear",
  } as SessionMessageInfo
  const user = { id: "msg_user", type: "user", time: { created: 20 }, text: "Continue the work" } as SessionMessageInfo
  const assistant = {
    id: "msg_assistant",
    type: "assistant",
    time: { created: 30, completed: 40 },
    agent: "build",
    model: { providerID: "openai", id: "test" },
    finish: "tool-calls",
    content: [
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: "Visible progress" },
      {
        type: "tool",
        id: "call_one",
        name: "shell",
        executed: true,
        time: { created: 31, ran: 32, completed: 39 },
        state: {
          status: "completed",
          input: { secret: "must not appear" },
          content: [{ type: "text", text: "large tool output" }],
        },
      },
    ],
  } as SessionMessageInfo
  const incomplete = {
    id: "msg_incomplete",
    type: "assistant",
    time: { created: 50 },
    agent: "build",
    model: { providerID: "openai", id: "test" },
    content: [{ type: "text", text: "partial" }],
  } as SessionMessageInfo
  const afterIncomplete = { id: "msg_after", type: "user", time: { created: 60 }, text: "not settled" } as SessionMessageInfo
  const client = mockClient({
    active: { [TARGET]: { type: "running" } },
    messageCalls,
    messageList: async (input) => {
      if (input.type === "compaction") return response([checkpoint])
      if (input.type === "user") return response([afterIncomplete, user])
      if (input.type === "assistant") return response([incomplete, assistant])
      throw new Error("unexpected type")
    },
  })
  const text = await reader(client).collect(CURRENT, { action: "read", sessionID: TARGET })
  const result = JSON.parse(text)
  assert.equal(result.status, "ok")
  assert.equal(result.session.liveStatus, "running")
  assert.equal(result.checkpoint.summary, "Objective and decisions")
  assert.equal(result.checkpoint.recentOmitted, true)
  assert.deepEqual(result.entries.map((item: { id: string }) => item.id), ["msg_user", "msg_assistant"])
  assert.match(text, /Visible progress/)
  assert.doesNotMatch(text, /private reasoning|must not appear|large tool output|raw recent|not settled|partial/)
  assert.deepEqual(result.coverage.truncation, ["unsettled-tail"])
  assert.deepEqual(messageCalls.map((call) => call.type), ["compaction", "user", "assistant"])
})

test("assistant pagination follows next cursors without repeating order", async () => {
  const calls: MessageListInput[] = []
  const first = {
    id: "msg_new",
    type: "assistant",
    time: { created: 30, completed: 31 },
    agent: "build",
    model: { providerID: "openai", id: "test" },
    content: [{ type: "text", text: "new" }],
  } as SessionMessageInfo
  const older = {
    id: "msg_old",
    type: "assistant",
    time: { created: 20, completed: 21 },
    agent: "build",
    model: { providerID: "openai", id: "test" },
    content: [{ type: "text", text: "old" }],
  } as SessionMessageInfo
  const client = mockClient({
    messageCalls: calls,
    messageList: async (input) => {
      if (input.type === "compaction" || input.type === "user") return response([])
      return input.cursor ? response([older]) : response([first], "assistant-next")
    },
  })
  const result = JSON.parse(await reader(client).collect(CURRENT, { action: "read", sessionID: TARGET }))
  assert.deepEqual(result.entries.map((item: { id: string }) => item.id), ["msg_old", "msg_new"])
  const assistantCalls = calls.filter((call) => call.type === "assistant")
  assert.equal(assistantCalls[0]?.order, "desc")
  assert.equal(assistantCalls[1]?.cursor, "assistant-next")
  assert.equal(assistantCalls[1]?.order, undefined)
})

test("compaction pagination selects the newest completed checkpoint", async () => {
  const calls: MessageListInput[] = []
  const failed = {
    id: "msg_failed",
    type: "compaction",
    status: "failed",
    reason: "auto",
    time: { created: 30 },
    error: { type: "test", message: "omitted" },
  } as SessionMessageInfo
  const completed = {
    id: "msg_completed",
    type: "compaction",
    status: "completed",
    reason: "auto",
    time: { created: 20 },
    summary: "latest completed",
    recent: "omitted",
  } as SessionMessageInfo
  const client = mockClient({
    messageCalls: calls,
    messageList: async (input) => {
      if (input.type === "compaction") {
        return input.cursor ? response([completed]) : response([failed], "compaction-next")
      }
      return response([])
    },
  })
  const result = JSON.parse(await reader(client).collect(CURRENT, { action: "read", sessionID: TARGET }))
  assert.equal(result.checkpoint.id, "msg_completed")
  assert.equal(result.checkpoint.summary, "latest completed")
  const compactionCalls = calls.filter((call) => call.type === "compaction")
  assert.equal(compactionCalls[0]?.order, "desc")
  assert.equal(compactionCalls[1]?.cursor, "compaction-next")
  assert.equal(compactionCalls[1]?.order, undefined)
})

test("entry limits keep the newest projected activity and report truncation", async () => {
  const assistants = Array.from({ length: 20 }, (_, index) => ({
    id: `msg_${index.toString().padStart(2, "0")}`,
    type: "assistant",
    time: { created: index + 1, completed: index + 1 },
    agent: "build",
    model: { providerID: "openai", id: "test" },
    content: [{ type: "text", text: `entry ${index}` }],
  })) as SessionMessageInfo[]
  const client = mockClient({
    messageList: async (input) => (input.type === "assistant" ? response(assistants.reverse()) : response([])),
  })
  const result = JSON.parse(await reader(client).collect(CURRENT, { action: "read", sessionID: TARGET }))
  assert.equal(result.entries.length, 16)
  assert.equal(result.entries[0].id, "msg_04")
  assert.equal(result.entries.at(-1).id, "msg_19")
  assert.ok(result.coverage.truncation.includes("entry-limit"))
})

test("final JSON remains valid and bounded when projected text is large", async () => {
  const assistants = Array.from({ length: 16 }, (_, index) => ({
    id: `msg_large_${index}`,
    type: "assistant",
    time: { created: index + 1, completed: index + 1 },
    agent: "build",
    model: { providerID: "openai", id: "test" },
    content: [{ type: "text", text: `entry ${index} ${"😀".repeat(2_000)}` }],
  })) as SessionMessageInfo[]
  const client = mockClient({
    messageList: async (input) => (input.type === "assistant" ? response([...assistants].reverse()) : response([])),
  })
  const text = await reader(client).collect(CURRENT, { action: "read", sessionID: TARGET })
  const result = JSON.parse(text)
  assert.equal(result.status, "ok")
  assert.ok(Buffer.byteLength(text, "utf8") <= 64 * 1024)
  assert.ok(result.coverage.truncation.includes("byte-limit"))
})

test("title reads fail closed on ambiguity and never read messages", async () => {
  const messageCalls: MessageListInput[] = []
  const client = mockClient({
    sessions: [session(CURRENT), session("ses_one", { title: "Same" }), session("ses_two", { title: "Same" })],
    messageCalls,
  })
  const result = JSON.parse(await reader(client).collect(CURRENT, { action: "read", search: "Same" }))
  assert.equal(result.status, "ambiguous")
  assert.equal(result.sessions.length, 2)
  assert.equal(messageCalls.length, 0)
})

test("refuses current-session and cross-project reads before message access", async () => {
  const messageCalls: MessageListInput[] = []
  const client = mockClient({
    sessions: [session(CURRENT), session("ses_foreign", { projectID: "project-two" })],
    messageCalls,
  })
  const same = JSON.parse(await reader(client).collect(CURRENT, { action: "read", sessionID: CURRENT }))
  const foreign = JSON.parse(await reader(client).collect(CURRENT, { action: "read", sessionID: "ses_foreign" }))
  assert.equal(same.code, "current-session-refused")
  assert.equal(foreign.code, "cross-project-refused")
  assert.equal(messageCalls.length, 0)
})

test("command arguments select list, exact ID, or title search", () => {
  assert.deepEqual(sessionContextCommandInput(""), { action: "list" })
  assert.deepEqual(sessionContextCommandInput("/session-context ses_abc123"), {
    action: "read",
    sessionID: "ses_abc123",
  })
  assert.deepEqual(sessionContextCommandInput("session-context ses_abc123"), {
    action: "read",
    sessionID: "ses_abc123",
  })
  assert.deepEqual(sessionContextCommandInput("Finish Open Rig v2 harness"), {
    action: "read",
    search: "Finish Open Rig v2 harness",
  })
})

test("UTF-8 truncation preserves complete code points and JSON bounds", () => {
  const value = truncateJsonString("😀😀😀 control\u0000tail", 24)
  assert.doesNotThrow(() => JSON.stringify(value))
  assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= 24)
  assert.doesNotMatch(value, /�/)
})

test("bounded fetch rejects a declared oversized response", async () => {
  const fetch = createBoundedFetch(async () => new Response("small", { headers: { "content-length": "3000000" } }))
  await assert.rejects(() => fetch("http://example.invalid"), /response-too-large/)
})
