import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createStateStore } from "../src/state.ts"

test("persists cooldowns and sessions across reloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fallback-state-"))
  const path = join(directory, "state.json")
  let nowValue = 1_000
  try {
    const store = createStateStore(path, { now: () => nowValue })
    await store.load()

    store.setCooldown("openai/gpt-5.3-codex-spark", nowValue + 5_000, "usage-limit")
    store.setSession("ses_1", {
      agent: "build",
      source: "openai/gpt-5.3-codex-spark",
      active: "deepseek/deepseek-v4-flash",
      tier: "deepseek/deepseek-v4-flash",
    })
    await store.flush()

    const raw = JSON.parse(await readFile(path, "utf8")) as {
      cooldowns: Record<string, { until: number }>
      sessions: Record<string, { active?: string }>
    }
    assert.equal(raw.cooldowns["openai/gpt-5.3-codex-spark"]?.until, 6_000)
    assert.equal(raw.sessions.ses_1?.active, "deepseek/deepseek-v4-flash")

    const reloaded = createStateStore(path, { now: () => nowValue })
    await reloaded.load()
    assert.equal(reloaded.cooling("openai/gpt-5.3-codex-spark"), true)
    assert.equal(reloaded.cooldownUntil("openai/gpt-5.3-codex-spark"), 6_000)
    assert.equal(reloaded.session("ses_1")?.tier, "deepseek/deepseek-v4-flash")

    nowValue += 10_000
    assert.equal(reloaded.cooling("openai/gpt-5.3-codex-spark"), false)
    assert.equal(reloaded.cooldownUntil("openai/gpt-5.3-codex-spark"), undefined)

    reloaded.clearCooldown("openai/gpt-5.3-codex-spark")
    reloaded.deleteSession("ses_1")
    assert.deepEqual(reloaded.snapshot().cooldowns, {})
    assert.deepEqual(reloaded.snapshot().sessions, {})
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("prunes stale records and tolerates corrupt state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fallback-state-"))
  const path = join(directory, "state.json")
  const now = 30 * 24 * 60 * 60 * 1000
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        cooldowns: { "a/b": { until: 1_000, reason: "usage-limit", setAt: 1_000 } },
        sessions: {
          old: { agent: "build", updatedAt: 1_000 },
          fresh: { agent: "plan", updatedAt: now - 1_000 },
        },
      }),
      { mode: 0o600 },
    )

    const store = createStateStore(path, { now: () => now })
    await store.load()
    assert.equal(store.snapshot().cooldowns["a/b"], undefined)
    assert.equal(store.session("old"), undefined)
    assert.equal(store.session("fresh")?.agent, "plan")

    await writeFile(path, "not json", { mode: 0o600 })
    const recovered = createStateStore(path, { now: () => now })
    await recovered.load()
    assert.deepEqual(recovered.snapshot().sessions, {})
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
