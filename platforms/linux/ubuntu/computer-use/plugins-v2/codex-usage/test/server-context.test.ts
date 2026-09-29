import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import server from "../src/server.ts"

type Event = Record<string, unknown> & { type: string }
type Hook = (event: any) => void
type HookRegistration = { name: string; callback: Hook; options?: { providerID?: string } }

function eventSource() {
  const queued: Event[] = []
  let closed = false
  let waiting: ((result: IteratorResult<Event>) => void) | undefined

  const finish = () => {
    closed = true
    waiting?.({ value: undefined, done: true })
    waiting = undefined
  }

  return {
    push(event: Event) {
      if (closed) return
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ value: event, done: false })
      } else {
        queued.push(event)
      }
    },
    subscribe({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", finish, { once: true })
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        next(): Promise<IteratorResult<Event>> {
          if (queued.length > 0) return Promise.resolve({ value: queued.shift()!, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
      }
    },
    close: finish,
  }
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function setupFakeContext(input: {
  providers: unknown[]
  integrations: unknown[]
  active?: Record<string, unknown>
  resolved?: Record<string, unknown>
  options?: Record<string, unknown>
  onProviderList?: (call: number) => Promise<void> | void
}) {
  const events = eventSource()
  const hooks: HookRegistration[] = []
  const registered: { snapshot?: (input: unknown) => Promise<unknown> } = {}
  let providerCalls = 0
  const active = input.active ?? {}
  const resolved = input.resolved ?? {}

  const context = {
    options: { refreshMs: 60_000, timeoutMs: 1_000, ...input.options },
    provider: {
      list: async () => {
        providerCalls += 1
        await input.onProviderList?.(providerCalls)
        return { data: input.providers }
      },
    },
    integration: {
      list: async () => ({ data: input.integrations }),
      connection: {
        active: async (id: string) => active[id],
        resolve: async (connection: unknown) => resolved[(connection as { id?: string }).id ?? ""] ?? undefined,
      },
    },
    session: {
      hook: async (name: string, callback: Hook, options?: { providerID?: string }) => {
        const registration = { name, callback, ...(options ? { options } : {}) }
        hooks.push(registration)
        return {
          dispose: async () => {
            const index = hooks.indexOf(registration)
            if (index >= 0) hooks.splice(index, 1)
          },
        }
      },
    },
    event: { subscribe: events.subscribe },
    rpc: {
      register: async (_definition: unknown, handlers: { snapshot: (input: unknown) => Promise<unknown> }) => {
        registered.snapshot = handlers.snapshot
        return { dispose: async () => undefined }
      },
    },
  }

  const cleanup = await server.setup(context as any)
  assert.equal(typeof registered.snapshot, "function")
  const snapshot = registered.snapshot!
  await snapshot({})
  return {
    context,
    events,
    hooks,
    snapshot,
    providerCalls: () => providerCalls,
    cleanup: async () => {
      events.close()
      await cleanup?.()
    },
  }
}

test("fake server context does not treat unresolved or expired credentials as working", async () => {
  const now = Date.now()
  const stateHome = await mkdtemp(join(tmpdir(), "codex-usage-server-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  const fake = await setupFakeContext({
    providers: [
      { id: "openai", name: "OpenAI", activation: "enabled", integrationID: "openai" },
      { id: "opencode", name: "OpenCode Zen", activation: "enabled" },
      { id: "ingenium", name: "Ingenium", activation: "enabled", integrationID: "ingenium" },
    ],
    integrations: [{ id: "openai" }, { id: "ingenium" }],
    active: {
      openai: { type: "credential", id: "expired", label: "expired" },
      ingenium: { type: "credential", id: "missing", label: "missing" },
    },
    resolved: {
      expired: { type: "oauth", access: "expired-token", expires: now - 1 },
    },
  })

  try {
    const snapshot = await fake.snapshot({}) as { rows: Array<{ id: string; status: string }> }
    assert.deepEqual(snapshot.rows, [{
      id: "opencode",
      name: "OpenCode Zen",
      status: "READY",
      detail: "OpenCode provider is enabled without an integration requirement.",
    }])
  } finally {
    await fake.cleanup()
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await rm(stateHome, { recursive: true, force: true })
  }
})

test("fake activity events are coalesced and throttled while recent use qualifies an offline row", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "codex-usage-server-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  const fake = await setupFakeContext({
    providers: [
      { id: "openai", name: "OpenAI", activation: "enabled", integrationID: "openai" },
      { id: "ingenium", name: "Ingenium", activation: "enabled", integrationID: "ingenium" },
    ],
    integrations: [{ id: "openai" }, { id: "ingenium" }],
  })

  try {
    assert.equal(fake.providerCalls(), 1)
    for (let index = 0; index < 64; index += 1) {
      fake.events.push({ type: "session.status.updated" })
    }
    await nextTurn()
    await nextTurn()
    assert.equal(fake.providerCalls(), 1)

    fake.events.push({
      type: "session.model.selected",
      created: Date.now(),
      data: { model: { providerID: "openai" } },
    })
    await nextTurn()
    await nextTurn()
    assert.equal(fake.providerCalls(), 1)

    fake.events.push({ type: "credential.updated" })
    await nextTurn()
    await nextTurn()
    const snapshot = await fake.snapshot({}) as { rows: Array<{ id: string; status: string }> }
    assert.equal(fake.providerCalls(), 2)
    assert.deepEqual(snapshot.rows.map((row) => [row.id, row.status]), [["openai", "OFFLINE"]])
  } finally {
    await fake.cleanup()
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await rm(stateHome, { recursive: true, force: true })
  }
})

test("Anthropic hooks route first-party requests from one workspace and expose rate-limit ratios", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "codex-usage-server-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  const apiKey = "sk-ant-api03-server-context-canary"
  const fake = await setupFakeContext({
    providers: [{ id: "anthropic", name: "Anthropic", activation: "enabled", integrationID: "anthropic" }],
    integrations: [{ id: "anthropic" }],
    active: { anthropic: { type: "credential", id: "anthropic-key" } },
    resolved: {
      "anthropic-key": {
        type: "key",
        key: apiKey,
        metadata: { workspace_id: "wrkspc_primary" },
      },
    },
  })

  try {
    const requestHook = fake.hooks.find((hook) => hook.name === "http.request" && hook.options?.providerID === "anthropic")
    const responseHook = fake.hooks.find((hook) => hook.name === "http.response" && hook.options?.providerID === "anthropic")
    assert.ok(requestHook)
    assert.ok(responseHook)

    const event = {
      request: new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ model: "claude-test" }),
      }),
    }
    await requestHook.callback(event)
    assert.equal(event.request.headers.get("anthropic-workspace-id"), "wrkspc_primary")
    assert.equal(event.request.headers.get("x-api-key"), apiKey)
    assert.equal(await event.request.clone().text(), JSON.stringify({ model: "claude-test" }))

    const proxied = { request: new Request("https://proxy.example/v1/messages") }
    await requestHook.callback(proxied)
    assert.equal(proxied.request.headers.has("anthropic-workspace-id"), false)
    const responseRequest = new Request("https://api.anthropic.com/v1/messages")
    responseHook.callback({
      request: responseRequest,
      response: new Response(null, {
        status: 200,
        headers: {
          "anthropic-ratelimit-requests-limit": "100",
          "anthropic-ratelimit-requests-remaining": "40",
          "anthropic-ratelimit-tokens-limit": "1000",
          "anthropic-ratelimit-tokens-remaining": "800",
        },
      }),
    })
    for (let index = 0; index < 4; index += 1) await nextTurn()

    const snapshot = await fake.snapshot({}) as {
      rows: Array<{ id: string; status: string; usage?: string }>
      diagnostics: string[]
    }
    const row = snapshot.rows.find((candidate) => candidate.id === "anthropic")
    assert.equal(row?.status, "READY")
    assert.equal(row?.usage, "Requests: 40% left · Tokens: 80% left")
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-ant-api03-server-context-canary/)
    assert.doesNotMatch(snapshot.diagnostics.join(" "), /wrkspc_primary|sk-ant-/)
  } finally {
    await fake.cleanup()
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await rm(stateHome, { recursive: true, force: true })
  }
})

test("unscoped Anthropic requests use the explicit option or report measurement unavailable", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "codex-usage-server-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateHome
  const apiKey = "sk-ant-api03-unscoped-canary"
  const base = {
    providers: [{ id: "anthropic", name: "Anthropic", activation: "enabled", integrationID: "anthropic" }],
    integrations: [{ id: "anthropic" }],
    active: { anthropic: { type: "credential", id: "anthropic-key" } },
    resolved: { "anthropic-key": { type: "key", key: apiKey, metadata: {} } },
  }

  try {
    const configured = await setupFakeContext({ ...base, options: { anthropicWorkspaceId: "wrkspc_selected" } })
    try {
      const requestHook = configured.hooks.find((hook) => hook.name === "http.request" && hook.options?.providerID === "anthropic")
      assert.ok(requestHook)
      const event = { request: new Request("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": apiKey } }) }
      await requestHook.callback(event)
      assert.equal(event.request.headers.get("anthropic-workspace-id"), "wrkspc_selected")
    } finally {
      await configured.cleanup()
    }

    const unconfigured = await setupFakeContext(base)
    try {
      const requestHook = unconfigured.hooks.find((hook) => hook.name === "http.request" && hook.options?.providerID === "anthropic")
      assert.ok(requestHook)
      const event = { request: new Request("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": apiKey } }) }
      await requestHook.callback(event)
      assert.equal(event.request.headers.has("anthropic-workspace-id"), false)
      const snapshot = await unconfigured.snapshot({}) as {
        rows: Array<{ id: string; status: string; detail: string }>
        diagnostics: string[]
      }
      const row = snapshot.rows.find((candidate) => candidate.id === "anthropic")
      assert.equal(row?.status, "READY")
      assert.match(row?.detail ?? "", /measurement is unavailable.*no workspace ID/i)
      assert.doesNotMatch(JSON.stringify(snapshot), /sk-ant-api03-unscoped-canary/)
    } finally {
      await unconfigured.cleanup()
    }
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await rm(stateHome, { recursive: true, force: true })
  }
})

test("DeepSeek balance-check 429 leaves provider readiness READY and balance unavailable", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "codex-usage-server-state-"))
  const previousStateHome = process.env.XDG_STATE_HOME
  const previousFetch = globalThis.fetch
  process.env.XDG_STATE_HOME = stateHome
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(null, { status: 429, headers: { "retry-after": "3" } })
  }
  const apiKey = "sk-deepseek-balance-canary"
  const fake = await setupFakeContext({
    providers: [{ id: "deepseek", name: "DeepSeek", activation: "enabled", integrationID: "deepseek" }],
    integrations: [{ id: "deepseek" }],
    active: { deepseek: { type: "credential", id: "deepseek-key" } },
    resolved: { "deepseek-key": { type: "key", key: apiKey } },
  })

  try {
    const snapshot = await fake.snapshot({}) as {
      rows: Array<{ id: string; status: string; usage?: string; detail: string }>
      diagnostics: string[]
    }
    const row = snapshot.rows.find((candidate) => candidate.id === "deepseek")
    assert.equal(row?.status, "READY")
    assert.match(row?.detail ?? "", /measurement is unavailable.*rate limited/i)
    assert.equal(row?.usage, undefined)
    assert.match(snapshot.diagnostics.join(" "), /rate limited/i)
    assert.equal(fetchCalls, 1, "a rate-limited balance probe makes no automatic retry")
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-deepseek-balance-canary/)
  } finally {
    await fake.cleanup()
    globalThis.fetch = previousFetch
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousStateHome
    await rm(stateHome, { recursive: true, force: true })
  }
})

test("many forced refresh events produce at most one pending follow-up", async () => {
  let startSecond: (() => void) | undefined
  let releaseSecond: (() => void) | undefined
  const secondStarted = new Promise<void>((resolve) => {
    startSecond = resolve
  })
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const fake = await setupFakeContext({
    providers: [],
    integrations: [],
    onProviderList: async (call) => {
      if (call === 2) {
        startSecond?.()
        await secondGate
      }
    },
  })

  try {
    fake.events.push({ type: "credential.updated" })
    await secondStarted
    for (let index = 0; index < 64; index += 1) fake.events.push({ type: "credential.updated" })
    for (let index = 0; index < 5; index += 1) await nextTurn()
    assert.equal(fake.providerCalls(), 2)
    releaseSecond?.()
    for (let index = 0; index < 10; index += 1) await nextTurn()
    assert.equal(fake.providerCalls(), 3)
  } finally {
    releaseSecond?.()
    await fake.cleanup()
  }
})
