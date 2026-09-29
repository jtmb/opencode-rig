import assert from "node:assert/strict"
import test from "node:test"

import {
  normalizeOptions,
  parseAgentFallback,
  parseChain,
  resolveEffective,
  type GlobalOptions,
} from "../src/config.ts"

function options(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return {
    defaultChain: parseChain(["deepseek/deepseek-v4-flash", "opencode/muse-spark-1.3-contributor-free"]),
    proactive: true,
    triggerOn: "quota",
    failureCooldownSeconds: 300,
    sourceCooldownSeconds: 10_800,
    usageCacheMs: 60_000,
    usageTimeoutMs: 5_000,
    debug: false,
    ...overrides,
  }
}

test("parses chains with validation and de-duplication", () => {
  assert.deepEqual(
    parseChain(["deepseek/deepseek-v4-flash", "invalid", "deepseek/deepseek-v4-flash", "a/b"]),
    [
      { providerID: "deepseek", modelID: "deepseek-v4-flash" },
      { providerID: "a", modelID: "b" },
    ],
  )
  assert.deepEqual(parseChain("not-an-array"), [])
  assert.deepEqual(parseChain(undefined), [])
})

test("parses per-agent fallback config", () => {
  assert.deepEqual(parseAgentFallback({ mode: "off" }), { mode: "off" })
  assert.deepEqual(parseAgentFallback({ enabled: false, chain: ["a/b"] }), {
    mode: "off",
    chain: [{ providerID: "a", modelID: "b" }],
  })
  assert.deepEqual(parseAgentFallback({ enabled: true, proactive: false }), {
    mode: "chain",
    proactive: false,
  })
  assert.deepEqual(
    parseAgentFallback({
      mode: "chain",
      chain: ["a/b", "c/d"],
      triggerOn: "any-retryable",
      failureCooldownSeconds: 60,
      sourceCooldownSeconds: 120,
      unknown: "ignored",
    }),
    {
      mode: "chain",
      chain: [
        { providerID: "a", modelID: "b" },
        { providerID: "c", modelID: "d" },
      ],
      triggerOn: "any-retryable",
      failureCooldownSeconds: 60,
      sourceCooldownSeconds: 120,
    },
  )
  assert.equal(parseAgentFallback("string"), undefined)
  assert.equal(parseAgentFallback(undefined), undefined)
})

test("normalizes global plugin options with defaults", () => {
  const defaults = normalizeOptions(undefined)
  assert.deepEqual(defaults.defaultChain, [])
  assert.equal(defaults.proactive, true)
  assert.equal(defaults.triggerOn, "quota")
  assert.equal(defaults.failureCooldownSeconds, 300)
  assert.equal(defaults.sourceCooldownSeconds, 10_800)
  assert.equal(defaults.debug, false)

  const custom = normalizeOptions({
    defaultChain: ["deepseek/deepseek-v4-flash"],
    proactive: false,
    triggerOn: "any-retryable",
    failureCooldownSeconds: 45,
    sourceCooldownSeconds: 900,
    usageEndpoint: "http://127.0.0.1:9/usage",
    usageCacheMs: 5_000,
    usageTimeoutMs: 2_000,
    debug: true,
  })
  assert.equal(custom.proactive, false)
  assert.equal(custom.triggerOn, "any-retryable")
  assert.equal(custom.failureCooldownSeconds, 45)
  assert.equal(custom.sourceCooldownSeconds, 900)
  assert.equal(custom.usageEndpoint, "http://127.0.0.1:9/usage")
  assert.equal(custom.usageCacheMs, 5_000)
  assert.equal(custom.usageTimeoutMs, 2_000)
  assert.equal(custom.debug, true)
})

test("resolves per-agent overrides over global defaults", () => {
  const fallbacks = new Map([
    ["plan", { mode: "off" as const }],
    [
      "general",
      {
        mode: "chain" as const,
        chain: parseChain(["opencode/big-pickle"]),
        proactive: false,
        failureCooldownSeconds: 15,
      },
    ],
  ])

  const plan = resolveEffective("plan", fallbacks, options())
  assert.equal(plan.enabled, false)
  assert.deepEqual(plan.chain, options().defaultChain)

  const general = resolveEffective("general", fallbacks, options())
  assert.equal(general.enabled, true)
  assert.deepEqual(general.chain, [{ providerID: "opencode", modelID: "big-pickle" }])
  assert.equal(general.proactive, false)
  assert.equal(general.failureCooldownSeconds, 15)

  const build = resolveEffective("build", fallbacks, options())
  assert.equal(build.enabled, true)
  assert.deepEqual(build.chain, options().defaultChain)

  const disabled = resolveEffective("anything", new Map([["anything", { chain: [] }]]), options())
  assert.equal(disabled.enabled, false)
})
