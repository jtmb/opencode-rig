import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { formatSnapshot, relativeTime } from "../src/format.ts"
import { isCodexSubscriptionModel, latestSessionModel, messageModel } from "../src/model.ts"
import {
  CodexUsageError,
  fetchCodexUsage,
  lunaReserveWindow,
  overallWeeklyWindow,
  parseUsagePayload,
  readOpenAICredential,
} from "../src/usage.ts"

test("parses overall and model-specific usage windows", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0)
  const snapshot = parseUsagePayload(
    {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        primary_window: { used_percent: 32.5, limit_window_seconds: 18000, reset_at: now / 1000 + 7200 },
        secondary_window: { used_percent: 77, limit_window_seconds: 604800, reset_at: now / 1000 + 300000 },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_bengalfox",
          rate_limit: {
            primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 120 },
          },
        },
      ],
      rate_limit_reset_credits: { available_count: 2 },
    },
    now,
  )

  assert.equal(snapshot.planType, "plus")
  assert.equal(snapshot.buckets.length, 2)
  assert.equal(snapshot.buckets[0]?.windows[0]?.label, "5h")
  assert.equal(snapshot.buckets[0]?.windows[0]?.leftPercent, 67.5)
  assert.equal(snapshot.buckets[0]?.windows[1]?.label, "Weekly")
  assert.equal(snapshot.buckets[1]?.name, "GPT-5.3-Codex-Spark")
  assert.equal(snapshot.buckets[1]?.windows[0]?.resetsAt, now / 1000 + 120)
  assert.equal(snapshot.resetCredits, 2)
  assert.equal(overallWeeklyWindow(snapshot)?.leftPercent, 23)

  const displayed = formatSnapshot(snapshot, now)
  assert.match(displayed, /Overall weekly limit/)
  assert.match(displayed, /23% left/)
  assert.doesNotMatch(displayed, /5h|Spark|Credits/)
})

test("clamps unexpected usage percentages", () => {
  const high = parseUsagePayload({ rate_limit: { primary_window: { used_percent: 140 } } })
  const low = parseUsagePayload({ rate_limit: { primary_window: { used_percent: -20 } } })
  assert.equal(high.buckets[0]?.windows[0]?.leftPercent, 0)
  assert.equal(low.buckets[0]?.windows[0]?.leftPercent, 100)
})

test("parses and formats the Luna Reserve weekly window", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0)
  const snapshot = parseUsagePayload(
    {
      planType: "pro",
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now / 1000 + 86_400 },
      },
      rateLimitsByLimitId: {
        base_model_inference: {
          limitId: "base_model_inference",
          limitName: "gpt-reserve",
          primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: now / 1000 + 172_800 },
        },
      },
    },
    now,
  )

  assert.equal(lunaReserveWindow(snapshot)?.leftPercent, 52)
  assert.match(formatSnapshot(snapshot, now), /Luna Reserve: 52% left/)
})

test("opts into Luna Reserve data only when requested", async () => {
  const requestHeaders: Headers[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestHeaders.push(new Headers(init?.headers))
    return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 0 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  await fetchCodexUsage(
    { accessToken: "test-token", accountId: "account-test" },
    { fetchImpl, supportsLunaReserve: true },
  )
  await fetchCodexUsage({ accessToken: "test-token", accountId: "account-test" }, { fetchImpl })

  assert.equal(requestHeaders[0]?.get("x-openai-codex-luna-reserve"), "1")
  assert.equal(requestHeaders[1]?.has("x-openai-codex-luna-reserve"), false)
})

test("rejects responses without usage windows", () => {
  assert.throws(
    () => parseUsagePayload({ rate_limit: { allowed: true } }),
    (error: unknown) => error instanceof CodexUsageError && error.code === "response",
  )
})

test("reads OpenCode OAuth metadata without requiring JWT decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-test-"))
  const authPath = join(directory, "auth.json")
  try {
    await writeFile(
      authPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "test-token",
          refresh: "not-read-by-plugin",
          expires: Date.now() + 60_000,
          accountId: "account-test",
        },
      }),
      { mode: 0o600 },
    )
    const credential = await readOpenAICredential(authPath)
    assert.deepEqual(credential, {
      accessToken: "test-token",
      accountId: "account-test",
      expiresAt: credential.expiresAt,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("formats reset countdowns", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0)
  assert.equal(relativeTime(now / 1000 + 7500, now), "resets in 2h 5m")
})

test("recognizes the active subscription model from either message shape", () => {
  const user = { model: { providerID: "openai", modelID: "gpt-5.6-sol" } }
  const assistant = { providerID: "anthropic", modelID: "claude-sonnet" }
  assert.deepEqual(messageModel(user), { providerID: "openai", modelID: "gpt-5.6-sol" })
  assert.equal(isCodexSubscriptionModel(messageModel(user)), true)
  assert.equal(isCodexSubscriptionModel(latestSessionModel([user, assistant])), false)
})
