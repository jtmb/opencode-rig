import assert from "node:assert/strict"
import test from "node:test"

import { setupChatGPTServer } from "../src/server.ts"
import type { ChatGPTInput } from "../src/rpc.ts"

type Event = { type: string; data?: Record<string, unknown> }
type ExecuteHandler = (input: ChatGPTInput, context: { signal: AbortSignal }) => Promise<unknown>
type TestSession = { projectID: string; directory: string; model?: unknown }

function eventSource() {
  const queue: Event[] = []
  let closed = false
  let waiting: ((result: IteratorResult<Event>) => void) | undefined
  const close = () => {
    closed = true
    waiting?.({ value: undefined, done: true })
    waiting = undefined
  }
  return {
    push(event: Event) {
      if (closed) return
      const resolve = waiting
      if (resolve) {
        waiting = undefined
        resolve({ value: event, done: false })
      } else queue.push(event)
    },
    subscribe({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", close, { once: true })
      return {
        [Symbol.asyncIterator]() { return this },
        next(): Promise<IteratorResult<Event>> {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { waiting = resolve })
        },
      }
    },
    close,
  }
}

function token(accountID: string) {
  const claims = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountID },
  })).toString("base64url")
  return `header.${claims}.signature`
}

function oauth(accountID = "account-1", expires = Date.now() + 60_000) {
  return { type: "oauth", access: token(accountID), expires, metadata: {} }
}

function makeContext(options: {
  credential?: unknown
  backend?: {
    generateImage?: (input: any) => Promise<string>
    webSearch?: (input: any) => Promise<unknown>
    chat?: (input: any) => Promise<string>
  }
  sessions?: Record<string, TestSession>
  models?: {
    available?: Array<{ providerID: string; id: unknown; enabled?: boolean }>
  }
} = {}) {
  const events = eventSource()
  const sessions = options.sessions ?? {
    ses_first1: { projectID: "project-a", directory: "/repo/a" },
    ses_second1: { projectID: "project-a", directory: "/repo/a" },
    ses_other1: { projectID: "project-b", directory: "/repo/b" },
  }
  const availableModels = options.models?.available ?? [
    { providerID: "openai", id: "gpt-5.3-codex", enabled: true },
  ]
  const captured: { execute?: ExecuteHandler } = {}
  let credential: unknown = options.credential ?? oauth()
  let backendCalls = 0
  const backend = {
    generateImage: async (input: any) => {
      backendCalls += 1
      return options.backend?.generateImage?.(input) ?? "aGVsbG8="
    },
    webSearch: async (input: any) => {
      backendCalls += 1
      return options.backend?.webSearch?.(input) ?? {
        text: "Search result",
        sources: [{ title: "OpenAI", url: "https://openai.com" }],
        searchPerformed: true,
      }
    },
    chat: async (input: any) => {
      backendCalls += 1
      return options.backend?.chat?.(input) ?? "Chat response"
    },
  }
  const context = {
    location: { directory: "/repo/a", project: { id: "project-a" } },
    provider: {
      list: async () => ({ data: [{ id: "openai", canonical: "openai", integrationID: "openai" }] }),
    },
    integration: {
      list: async () => ({ data: [{ id: "openai", name: "OpenAI" }] }),
      connection: {
        active: async () => ({ type: "credential", id: "credential-1", label: "OpenAI OAuth" }),
        resolve: async () => credential,
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const found = sessions[sessionID]
        if (!found) throw new Error("not found")
        return {
          id: sessionID,
          projectID: found.projectID,
          location: { directory: found.directory },
          model: found.model,
        }
      },
    },
    model: {
      list: async () => ({ data: availableModels.map((model) => ({ enabled: true, ...model })) }),
    },
    event: { subscribe: events.subscribe },
    rpc: {
      register: async (_definition: unknown, handlers: { execute: ExecuteHandler }) => {
        captured.execute = handlers.execute
        return { dispose: async () => undefined }
      },
    },
  }
  return {
    context,
    events,
    captured,
    backend,
    calls: () => backendCalls,
    setCredential(value: unknown) { credential = value },
  }
}

async function start(options: Parameters<typeof makeContext>[0] = {}) {
  const fake = makeContext(options)
  const cleanup = await setupChatGPTServer(fake.context as any, { backend: fake.backend as any })
  assert.equal(typeof fake.captured.execute, "function")
  return {
    ...fake,
    execute: fake.captured.execute!,
    cleanup: async () => {
      fake.events.close()
      await cleanup()
    },
  }
}

const signal = new AbortController().signal

test("server rejects API-key, expired, and unidentifiable OAuth credentials", async () => {
  const rejected = [
    { type: "key", key: "must-not-fallback" },
    oauth("account-expired", Date.now() - 1),
    { type: "oauth", access: "unstructured-oauth-token", expires: Date.now() + 60_000, metadata: {} },
  ]
  for (const credential of rejected) {
    const fake = await start({ credential })
    try {
      await assert.rejects(fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "Hello" }, { signal }))
      assert.equal(fake.calls(), 0)
    } finally {
      await fake.cleanup()
    }
  }
})

test("server binds MCP projectDirectory to the resolved OpenCode session", async () => {
  const fake = await start()
  try {
    await assert.rejects(
      fake.execute({
        action: "chat",
        sessionID: "ses_first1",
        prompt: "Hello",
        projectDirectory: "/repo/b",
      }, { signal }),
      /does not belong to the requested project directory/,
    )
    assert.equal(fake.calls(), 0)
  } finally {
    await fake.cleanup()
  }
})

test("server restricts every action to its invoking project location and identity", async () => {
  const fake = await start({
    sessions: {
      ses_wrongdir1: { projectID: "project-a", directory: "/repo/b" },
      ses_wrongproj1: { projectID: "project-b", directory: "/repo/a" },
    },
  })
  const actions: Array<(sessionID: string) => ChatGPTInput> = [
    (sessionID) => ({ action: "generate_image", sessionID, prompt: "A red fox" }),
    (sessionID) => ({ action: "web_search", sessionID, query: "OpenAI" }),
    (sessionID) => ({ action: "chat", sessionID, prompt: "Hello" }),
  ]
  try {
    for (const sessionID of ["ses_wrongdir1", "ses_wrongproj1"]) {
      for (const action of actions) {
        await assert.rejects(fake.execute(action(sessionID), { signal }), /does not belong to the invoking project/)
      }
    }
    assert.equal(fake.calls(), 0)
  } finally {
    await fake.cleanup()
  }
})

test("server prefers an eligible session model and otherwise uses a stable catalog choice", async () => {
  const models: string[] = []
  const fake = await start({
    sessions: {
      ses_first1: {
        projectID: "project-a",
        directory: "/repo/a",
        model: { providerID: "openai", id: "gpt-5.4-codex" },
      },
      ses_second1: { projectID: "project-a", directory: "/repo/a" },
    },
    models: {
      available: [
        { providerID: "openai", id: "gpt-5.3-codex" },
        { providerID: "openai", id: "gpt-5.4-codex" },
      ],
    },
    backend: {
      webSearch: async ({ model }) => {
        models.push(`search:${model}`)
        return { text: "Search result", sources: [{ title: "OpenAI", url: "https://openai.com" }], searchPerformed: true }
      },
      chat: async ({ model }) => {
        models.push(`chat:${model}`)
        return "Chat response"
      },
    },
  })

  try {
    await fake.execute({ action: "web_search", sessionID: "ses_first1", query: "OpenAI" }, { signal })
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "Use the session model" }, { signal })
    await fake.execute({ action: "chat", sessionID: "ses_second1", prompt: "Use the catalog fallback" }, { signal })
    assert.deepEqual(models, ["search:gpt-5.4-codex", "chat:gpt-5.4-codex", "chat:gpt-5.3-codex"])
  } finally {
    await fake.cleanup()
  }
})

test("server falls back to an eligible catalog model for malformed session model values", async () => {
  const malformedModels: unknown[] = [
    null,
    "not-a-model-record",
    {},
    { providerID: "openai", id: null },
    { providerID: "openai", id: 42 },
    { providerID: "openai", id: "gpt-codex\n" },
    { providerID: "openai", id: "gpt/codex" },
    { providerID: "openai", id: `${"x".repeat(124)}codex` },
    { providerID: 42, id: "gpt-5.4-codex" },
  ]
  const sessions = Object.fromEntries(malformedModels.map((model, index) => [
    `ses_bad${index}`,
    { projectID: "project-a", directory: "/repo/a", model },
  ]))
  const dispatched: string[] = []
  const fake = await start({
    sessions,
    models: { available: [{ providerID: "openai", id: "gpt-5.3-codex" }] },
    backend: {
      chat: async ({ model }) => {
        dispatched.push(model)
        return "Chat response"
      },
    },
  })

  try {
    for (let index = 0; index < malformedModels.length; index += 1) {
      await fake.execute({ action: "chat", sessionID: `ses_bad${index}`, prompt: "Use catalog fallback" }, { signal })
    }
    assert.deepEqual(dispatched, Array(malformedModels.length).fill("gpt-5.3-codex"))
  } finally {
    await fake.cleanup()
  }
})

test("server accepts the 128-character model boundary and excludes unsafe catalog identifiers", async () => {
  const maxSafeModelID = `${"a".repeat(123)}codex`
  const invalidIDs: unknown[] = [
    `${"a".repeat(124)}codex`,
    `${"a".repeat(122)}\ncodex`,
    `${"a".repeat(122)}/codex`,
    null,
    42,
  ]
  const dispatched: string[] = []
  const fake = await start({
    models: {
      available: [
        ...invalidIDs.map((id) => ({ providerID: "openai", id })),
        { providerID: "openai", id: maxSafeModelID },
        { providerID: "openai", id: "gpt-5.3-codex" },
      ],
    },
    backend: {
      chat: async ({ model }) => {
        dispatched.push(model)
        return "Chat response"
      },
    },
  })

  try {
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "Use a bounded model" }, { signal })
    assert.equal(maxSafeModelID.length, 128)
    assert.deepEqual(dispatched, [maxSafeModelID])
  } finally {
    await fake.cleanup()
  }
})

test("server fails closed when every OpenAI Codex catalog ID is unsafe", async () => {
  const unsafeModelID = `${"x".repeat(124)}codex`
  const fake = await start({
    sessions: {
      ses_first1: {
        projectID: "project-a",
        directory: "/repo/a",
        model: { providerID: "openai", id: unsafeModelID },
      },
    },
    models: {
      available: [
        { providerID: "openai", id: unsafeModelID },
        { providerID: "openai", id: "gpt-codex\n" },
        { providerID: "openai", id: "gpt/codex" },
      ],
    },
  })

  try {
    await assert.rejects(
      fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "Must not dispatch" }, { signal }),
      /No available OpenAI Codex model is configured/,
    )
    assert.equal(fake.calls(), 0)
  } finally {
    await fake.cleanup()
  }
})

test("server uses an available OpenAI Codex model for a non-OpenAI caller", async () => {
  const dispatched: string[] = []
  const fake = await start({
    sessions: {
      ses_first1: {
        projectID: "project-a",
        directory: "/repo/a",
        model: { providerID: "anthropic", id: "claude-sonnet" },
      },
      ses_second1: {
        projectID: "project-a",
        directory: "/repo/a",
        model: { providerID: "openai", id: "gpt-5.2-codex" },
      },
    },
    models: {
      available: [
        { providerID: "openai", id: "gpt-5.4-codex" },
        { providerID: "anthropic", id: "claude-sonnet" },
        { providerID: "openai", id: "gpt-5.3-codex" },
      ],
    },
    backend: {
      chat: async ({ model }) => {
        dispatched.push(model)
        return "Chat response"
      },
    },
  })

  try {
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "Use Codex independently" }, { signal })
    await fake.execute({ action: "chat", sessionID: "ses_second1", prompt: "Use catalog fallback" }, { signal })
    assert.deepEqual(dispatched, ["gpt-5.3-codex", "gpt-5.3-codex"])
  } finally {
    await fake.cleanup()
  }
})

test("server fails closed when no available OpenAI Codex model exists", async () => {
  const fake = await start({
    sessions: {
      ses_first1: {
        projectID: "project-a",
        directory: "/repo/a",
        model: { providerID: "openai", id: "gpt-5.4-codex" },
      },
    },
    models: {
      available: [
        { providerID: "anthropic", id: "claude-sonnet" },
        { providerID: "openai", id: "gpt-5.4", enabled: true },
        { providerID: "openai", id: "gpt-5.4-codex", enabled: false },
      ],
    },
  })

  try {
    await assert.rejects(
      fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "Must not dispatch" }, { signal }),
      /No available OpenAI Codex model is configured/,
    )
    assert.equal(fake.calls(), 0)
  } finally {
    await fake.cleanup()
  }
})

test("chat history is isolated by session, account, and project and resets on session events", async () => {
  const requests: Array<{ accountID: string; messages: Array<{ role: string; text: string }> }> = []
  const fake = await start({
    sessions: {
      ses_first1: { projectID: "project-a", directory: "/repo/a" },
      ses_second1: { projectID: "project-a", directory: "/repo/a" },
      ses_third1: { projectID: "project-a", directory: "/repo/a" },
      ses_other1: { projectID: "project-b", directory: "/repo/b" },
    },
    backend: {
      chat: async ({ credential, messages }) => {
        requests.push({ accountID: credential.accountID, messages: messages.map((message: any) => ({ ...message })) })
        return `answer-${requests.length}`
      },
    },
  })

  try {
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "private session A" }, { signal })
    await fake.execute({ action: "chat", sessionID: "ses_second1", prompt: "private session B" }, { signal })
    await fake.execute({ action: "chat", sessionID: "ses_third1", prompt: "private session C" }, { signal })
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "continue A" }, { signal })
    await assert.rejects(
      fake.execute({ action: "chat", sessionID: "ses_other1", prompt: "private project B" }, { signal }),
      /does not belong to the invoking project/,
    )
    assert.equal(requests.length, 4)

    assert.deepEqual(requests[0]?.messages.map((message) => message.text), ["private session A"])
    assert.deepEqual(requests[1]?.messages.map((message) => message.text), ["private session B"])
    assert.deepEqual(requests[2]?.messages.map((message) => message.text), ["private session C"])
    assert.deepEqual(requests[3]?.messages.map((message) => message.text), [
      "private session A",
      "answer-1",
      "continue A",
    ])
    assert.equal(requests[3]?.messages.some((message) => message.text.includes("session B") || message.text.includes("session C")), false)

    fake.setCredential(oauth("account-2"))
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "new account" }, { signal })
    assert.deepEqual(requests[4]?.messages.map((message) => message.text), ["new account"])
    assert.equal(requests[4]?.accountID, "account-2")

    fake.events.push({ type: "session.updated", data: { sessionID: "ses_first1" } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await fake.execute({ action: "chat", sessionID: "ses_first1", prompt: "after reset" }, { signal })
    assert.deepEqual(requests[5]?.messages.map((message) => message.text), ["after reset"])
  } finally {
    await fake.cleanup()
  }
})

test("server rejects search results without verified source links", async () => {
  const fake = await start({
    backend: {
      webSearch: async () => ({ text: "unsupported", sources: [], searchPerformed: false }),
    },
  })
  try {
    await assert.rejects(
      fake.execute({ action: "web_search", sessionID: "ses_first1", query: "OpenAI" }, { signal }),
      /verified source links/,
    )
  } finally {
    await fake.cleanup()
  }
})

test("server caps verified search sources at twenty", async () => {
  const fake = await start({
    backend: {
      webSearch: async () => ({
        text: "Research summary",
        searchPerformed: true,
        sources: Array.from({ length: 25 }, (_, index) => ({
          title: `Source ${index + 1}`,
          url: `https://example.com/${index + 1}`,
        })),
      }),
    },
  })

  try {
    const result = await fake.execute({
      action: "web_search",
      sessionID: "ses_first1",
      query: "bounded sources",
    }, { signal }) as { sources?: Array<{ title: string; url: string }> }
    assert.equal(result.sources?.length, 20)
    assert.equal(new Set(result.sources?.map((source) => source.url)).size, 20)
  } finally {
    await fake.cleanup()
  }
})
