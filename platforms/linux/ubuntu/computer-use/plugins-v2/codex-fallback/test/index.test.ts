import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import plugin from "../src/index.ts"
import { modelKey, type ModelRef } from "../src/model.ts"

type Hook = (event: Record<string, any>) => Promise<void> | void

type SwitchCall = {
  sessionID: string
  model: { providerID: string; id: string; variant?: string }
}

type Harness = {
  hooks: Map<string, Hook>
  current: Map<string, ModelRef>
  switches: SwitchCall[]
  setCatalogFailure(value: boolean): void
  dispose(): Promise<void>
}

const availableModels = [
  { providerID: "primary", modelID: "source" },
  { providerID: "fake", modelID: "tier-1" },
  { providerID: "fake", modelID: "tier-2" },
  { providerID: "manual", modelID: "choice" },
]

async function makeHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const dataHome = await mkdtemp(join(tmpdir(), "codex-fallback-plugin-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dataHome

  const hooks = new Map<string, Hook>()
  const current = new Map<string, ModelRef>()
  const switches: SwitchCall[] = []
  const reenterContext = overrides.reenterContext === true
  const staleContext = overrides.staleContext === true
  let catalogFailure = false

  const context = {
    options: {
      defaultChain: ["fake/tier-1#fast", "fake/tier-2#deep"],
      proactive: false,
      triggerOn: "quota",
      failureCooldownSeconds: 1,
      sourceCooldownSeconds: 1,
      usageCacheMs: 1_000,
      usageTimeoutMs: 500,
      ...overrides,
    },
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
      switchModel: async (input: SwitchCall) => {
        const previous = current.get(input.sessionID)
        const model = {
          providerID: input.model.providerID,
          modelID: input.model.id,
          ...(input.model.variant ? { variant: input.model.variant } : {}),
        }
        current.set(input.sessionID, model)
        switches.push({
          sessionID: input.sessionID,
          model: { ...input.model },
        })
        if (reenterContext) {
          await hooks.get("context")?.({
            sessionID: input.sessionID,
            agent: "build",
            model: eventModel(staleContext && previous ? previous : model),
          })
        }
      },
    },
    model: {
      list: async () => {
        if (catalogFailure) throw new Error("fake catalog unavailable")
        return { data: availableModels }
      },
    },
    event: {
      subscribe: async function* () {},
    },
  }

  try {
    const cleanup = await plugin.setup(context as any)
    return {
      hooks,
      current,
      switches,
      setCatalogFailure(value) {
        catalogFailure = value
      },
      async dispose() {
        await cleanup?.()
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
        await rm(dataHome, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    await rm(dataHome, { recursive: true, force: true })
    throw error
  }
}

function eventModel(model: ModelRef) {
  return {
    providerID: model.providerID,
    id: model.modelID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

async function runContext(harness: Harness, sessionID: string, model: ModelRef): Promise<ModelRef> {
  if (!harness.current.has(sessionID)) harness.current.set(sessionID, model)
  const hook = harness.hooks.get("context")
  assert.ok(hook)
  await hook({ sessionID, agent: "build", model: eventModel(model) })
  return harness.current.get(sessionID) ?? model
}

async function runRetry(
  harness: Harness,
  sessionID: string,
  model: ModelRef,
  attempt: number,
): Promise<Record<string, any>> {
  const hook = harness.hooks.get("retry")
  assert.ok(hook)
  const event: Record<string, any> = {
    sessionID,
    agent: "build",
    model: eventModel(model),
    error: { name: "APIError", data: { message: "usage limit reached", statusCode: 429 } },
    attempt,
    decision: { retry: false },
  }
  await hook(event)
  return event
}

async function runFakeTurn(harness: Harness, sessionID: string): Promise<ModelRef[]> {
  let model: ModelRef = { providerID: "primary", modelID: "source", variant: "balanced" }
  const requests: ModelRef[] = []

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    model = await runContext(harness, sessionID, model)
    requests.push(model)
    if (modelKey(model) === "fake/tier-2") return requests

    const retry = await runRetry(harness, sessionID, model, attempt)
    if (!retry.decision.retry) return requests
    model = harness.current.get(sessionID) ?? model
  }

  return requests
}

test("routes a failed fake-provider turn through tier one and then tier two", async () => {
  const harness = await makeHarness({ reenterContext: true })
  try {
    const requests = await runFakeTurn(harness, "ses_fake_turn")

    assert.deepEqual(requests, [
      { providerID: "primary", modelID: "source", variant: "balanced" },
      { providerID: "fake", modelID: "tier-1", variant: "fast" },
      { providerID: "fake", modelID: "tier-2", variant: "deep" },
    ])
    assert.deepEqual(harness.switches.map((call) => call.model), [
      { providerID: "fake", id: "tier-1", variant: "fast" },
      { providerID: "fake", id: "tier-2", variant: "deep" },
    ])
  } finally {
    await harness.dispose()
  }
})

test("does not replay a duplicate retry event for the same attempt", async () => {
  const harness = await makeHarness()
  try {
    const sessionID = "ses_duplicate"
    const source = { providerID: "primary", modelID: "source" }
    await runContext(harness, sessionID, source)

    const first = await runRetry(harness, sessionID, source, 1)
    const duplicate = await runRetry(harness, sessionID, source, 1)

    assert.equal(first.decision.retry, true)
    assert.equal(duplicate.decision.retry, false)
    assert.equal(harness.switches.length, 1)
  } finally {
    await harness.dispose()
  }
})

test("recovers from a fallback tier after the source cooldown expires", async () => {
  const harness = await makeHarness({ reenterContext: true, staleContext: true })
  try {
    const sessionID = "ses_recovery"
    const source = { providerID: "primary", modelID: "source", variant: "balanced" }
    await runContext(harness, sessionID, source)
    await runRetry(harness, sessionID, source, 1)

    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await runContext(harness, sessionID, harness.current.get(sessionID)!)

    assert.deepEqual(harness.switches.at(-1)?.model, {
      providerID: "primary",
      id: "source",
      variant: "balanced",
    })
  } finally {
    await harness.dispose()
  }
})

test("honors a manual model selection instead of treating it as a fallback route", async () => {
  const harness = await makeHarness()
  try {
    const sessionID = "ses_manual"
    await runContext(harness, sessionID, { providerID: "primary", modelID: "source" })

    const manual = { providerID: "manual", modelID: "choice" }
    harness.current.set(sessionID, manual)
    await runContext(harness, sessionID, manual)

    assert.equal(harness.switches.length, 0)
    assert.deepEqual(harness.current.get(sessionID), manual)
  } finally {
    await harness.dispose()
  }
})

test("fails open when the fake provider catalog is unavailable", async () => {
  const harness = await makeHarness()
  try {
    harness.setCatalogFailure(true)
    const sessionID = "ses_catalog_failure"
    const source = { providerID: "primary", modelID: "source" }
    await runContext(harness, sessionID, source)
    const retry = await runRetry(harness, sessionID, source, 1)

    assert.equal(retry.decision.retry, true)
    assert.deepEqual(harness.switches[0]?.model, {
      providerID: "fake",
      id: "tier-1",
      variant: "fast",
    })
  } finally {
    await harness.dispose()
  }
})
