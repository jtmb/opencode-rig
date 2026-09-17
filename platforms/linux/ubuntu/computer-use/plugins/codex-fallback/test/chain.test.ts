import assert from "node:assert/strict"
import test from "node:test"

import { catalogFromProviderList, isTierAvailable, pickTier } from "../src/chain.ts"
import type { ModelRef } from "../src/model.ts"

const flash: ModelRef = { providerID: "deepseek", modelID: "deepseek-v4-flash" }
const pro: ModelRef = { providerID: "deepseek", modelID: "deepseek-v4-pro" }
const zen: ModelRef = { providerID: "opencode", modelID: "big-pickle" }
const chain = [flash, pro, zen]

test("builds a provider catalog from provider list output", () => {
  const catalog = catalogFromProviderList({
    connected: ["deepseek"],
    all: [
      { id: "deepseek", models: { "deepseek-v4-flash": {}, "deepseek-v4-pro": {} } },
      { id: "opencode", models: { "big-pickle": {} } },
    ],
  })

  assert.ok(catalog)
  assert.equal(catalog.connected.has("deepseek"), true)
  assert.equal(catalog.connected.has("opencode"), false)
  assert.equal(catalog.models.get("deepseek")?.has("deepseek-v4-pro"), true)
  assert.equal(isTierAvailable(catalog, flash), true)
  assert.equal(isTierAvailable(catalog, zen), false)
  assert.equal(isTierAvailable(catalog, { providerID: "deepseek", modelID: "missing" }), false)
  assert.equal(isTierAvailable(undefined, zen), true)
  assert.equal(catalogFromProviderList({}), undefined)
  assert.equal(catalogFromProviderList(undefined), undefined)
})

test("picks the first tier that is neither cooling nor unavailable", () => {
  const result = pickTier({
    chain,
    isCooling: (key) => key === "deepseek/deepseek-v4-flash",
    isAvailable: (tier) => tier.modelID === "big-pickle",
  })
  assert.deepEqual(result.tier, zen)
  assert.deepEqual(result.skipped, [
    { tier: flash, reason: "cooldown" },
    { tier: pro, reason: "unavailable" },
  ])
})

test("advances past a failed tier and reports exhaustion", () => {
  const advanced = pickTier({ chain, startIndex: 1, isCooling: () => false })
  assert.deepEqual(advanced.tier, pro)

  const exhausted = pickTier({
    chain,
    startIndex: 2,
    isCooling: () => false,
    isAvailable: () => false,
  })
  assert.equal(exhausted.tier, undefined)
  assert.equal(exhausted.skipped.length, 1)
  assert.equal(exhausted.skipped[0]?.reason, "unavailable")
})
