import assert from "node:assert/strict"
import test from "node:test"

import {
  HEALTHY_REMAINING_RATIO,
  WARNING_REMAINING_RATIO,
  remainingRatioFromPercent,
  tokenizeUsage,
  usageHealthForRemainingRatio,
} from "../src/usage-health.ts"

test("uses deterministic remaining-ratio health boundaries", () => {
  assert.equal(usageHealthForRemainingRatio(1), "healthy")
  assert.equal(usageHealthForRemainingRatio(HEALTHY_REMAINING_RATIO), "healthy")
  assert.equal(usageHealthForRemainingRatio(HEALTHY_REMAINING_RATIO - 0.0001), "warning")
  assert.equal(usageHealthForRemainingRatio(WARNING_REMAINING_RATIO), "warning")
  assert.equal(usageHealthForRemainingRatio(WARNING_REMAINING_RATIO - 0.0001), "critical")
  assert.equal(usageHealthForRemainingRatio(0), "critical")
  assert.equal(usageHealthForRemainingRatio(undefined), "neutral")
  assert.equal(usageHealthForRemainingRatio(Number.NaN), "neutral")
  assert.equal(remainingRatioFromPercent(100), 1)
  assert.equal(remainingRatioFromPercent(0), 0)
  assert.equal(remainingRatioFromPercent(6), 0.06)
})

test("emphasizes only the measurement token and leaves labels and prose plain", () => {
  assert.deepEqual(tokenizeUsage("Weekly: 6% left"), [
    { text: "Weekly: ", emphasized: false, health: "neutral" },
    { text: "6%", emphasized: true, health: "critical" },
    { text: " left", emphasized: false, health: "neutral" },
  ])
  assert.deepEqual(tokenizeUsage("Weekly: 100% left"), [
    { text: "Weekly: ", emphasized: false, health: "neutral" },
    { text: "100%", emphasized: true, health: "healthy" },
    { text: " left", emphasized: false, health: "neutral" },
  ])
  assert.deepEqual(tokenizeUsage("Balance USD 0.00"), [
    { text: "Balance USD ", emphasized: false, health: "neutral" },
    { text: "0.00", emphasized: true, health: "neutral" },
  ])
  assert.deepEqual(tokenizeUsage("Allowance $98"), [
    { text: "Allowance ", emphasized: false, health: "neutral" },
    { text: "$98", emphasized: true, health: "neutral" },
  ])
  assert.deepEqual(tokenizeUsage("Allowance 98$"), [
    { text: "Allowance ", emphasized: false, health: "neutral" },
    { text: "98$", emphasized: true, health: "neutral" },
  ])
})

test("uses a provider-derived ratio for raw allowance units and preserves localized formatting", () => {
  assert.deepEqual(tokenizeUsage("API allowance: 98 requests", { remainingRatio: 0.8 }), [
    { text: "API allowance: ", emphasized: false, health: "neutral" },
    { text: "98 requests", emphasized: true, health: "healthy" },
  ])
  assert.deepEqual(tokenizeUsage("Balance EUR 98,50", { remainingRatio: 0.1 }), [
    { text: "Balance EUR ", emphasized: false, health: "neutral" },
    { text: "98,50", emphasized: true, health: "critical" },
  ])
  assert.deepEqual(tokenizeUsage("Weekly: 6% left", { remainingRatio: 0.9 }), [
    { text: "Weekly: ", emphasized: false, health: "neutral" },
    { text: "6%", emphasized: true, health: "critical" },
    { text: " left", emphasized: false, health: "neutral" },
  ])
  assert.deepEqual(tokenizeUsage("Weekly: 80% left; resets in 5m", { remainingRatio: 0.8 }), [
    { text: "Weekly: ", emphasized: false, health: "neutral" },
    { text: "80%", emphasized: true, health: "healthy" },
    { text: " left; resets in 5m", emphasized: false, health: "neutral" },
  ])
})

test("retained stale/offline values remain neutral rather than implying current health", () => {
  for (const status of ["stale", "unavailable", "cooling"] as const) {
    const tokens = tokenizeUsage("Weekly: 80% left", { remainingRatio: 0.8, status })
    assert.deepEqual(tokens[1], { text: "80%", emphasized: true, health: "neutral" }, status)
  }
})
