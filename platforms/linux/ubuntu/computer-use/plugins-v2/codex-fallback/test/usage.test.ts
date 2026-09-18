import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { parseUsagePayload } from "../../codex-usage/src/usage.ts"
import { createQuotaChecker, quotaFromSnapshot } from "../src/usage.ts"

const LIMITED_PAYLOAD = {
  plan_type: "pro",
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 60 },
    secondary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 3600 },
  },
}

const HEALTHY_PAYLOAD = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 60 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 3600 },
  },
}

test("derives quota state from the weekly window", () => {
  const now = 1_000_000
  const limited = quotaFromSnapshot(parseUsagePayload(LIMITED_PAYLOAD, now))
  assert.equal(limited.limitReached, true)
  assert.equal(limited.resetsAt, Math.floor(now / 1000 + 3600) * 1000)
  assert.equal(limited.planType, "pro")

  const healthy = quotaFromSnapshot(parseUsagePayload(HEALTHY_PAYLOAD, now))
  assert.equal(healthy.limitReached, false)
})

test("flags a reached type even before the weekly window fills", () => {
  const snapshot = parseUsagePayload({
    rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
    rate_limit_reached_type: "primary",
  })
  assert.equal(quotaFromSnapshot(snapshot).limitReached, true)
})

test("honors explicit allowed signals over a full weekly window", () => {
  const now = 2_000_000
  const quota = quotaFromSnapshot(
    parseUsagePayload(
      {
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 165910 },
        },
        rate_limit_reached_type: null,
      },
      now,
    ),
  )
  assert.equal(quota.limitReached, false)
  assert.equal(quota.resetsAt, Math.floor(now / 1000 + 165910) * 1000)
})

test("falls back to the weekly percent only when explicit flags are absent", () => {
  const snapshot = parseUsagePayload({
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800 } },
  })
  assert.equal(quotaFromSnapshot(snapshot).limitReached, true)
})

test("checks quota through the injected transport and caches results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fallback-usage-"))
  const authPath = join(directory, "auth.json")
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "test-token",
          refresh: "not-read",
          expires: Date.now() + 3_600_000,
          accountId: "account-test",
        },
      }),
      { mode: 0o600 },
    )

    let fetchCalls = 0
    const fetchImpl = (async () => {
      fetchCalls += 1
      return new Response(JSON.stringify(LIMITED_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    let nowValue = 1_000
    const checker = createQuotaChecker({
      authPath,
      cacheMs: 60_000,
      timeoutMs: 1_000,
      fetchImpl,
      now: () => nowValue,
    })

    const first = await checker.check()
    assert.equal(first?.limitReached, true)
    assert.equal(fetchCalls, 1)

    await checker.check()
    assert.equal(fetchCalls, 1)

    nowValue += 61_000
    await checker.check()
    assert.equal(fetchCalls, 2)

    await checker.check(true)
    assert.equal(fetchCalls, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("fails open when the usage check fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-fallback-usage-"))
  const authPath = join(directory, "auth.json")
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        openai: { type: "oauth", access: "token", expires: Date.now() + 3_600_000, accountId: "a" },
      }),
      { mode: 0o600 },
    )

    let calls = 0
    const failing = (async () => {
      calls += 1
      throw new Error("network down")
    }) as unknown as typeof fetch

    const checker = createQuotaChecker({
      authPath,
      cacheMs: 60_000,
      timeoutMs: 1_000,
      fetchImpl: failing,
    })
    assert.equal(await checker.check(), undefined)
    assert.equal(calls, 1)
    assert.equal(await checker.check(), undefined)
    assert.equal(calls, 1)

    const missing = createQuotaChecker({
      authPath: join(directory, "missing.json"),
      cacheMs: 60_000,
      timeoutMs: 1_000,
      fetchImpl: failing,
    })
    assert.equal(await missing.check(), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
