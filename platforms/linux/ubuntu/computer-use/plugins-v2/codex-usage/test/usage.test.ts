import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  compactReset,
  formatDetails,
  formatSnapshot,
  providerCompactLine,
  providerCompactStatus,
  providerDetailLine,
  providerPanelDetail,
  providerStatusLabel,
  providerTone,
  providerUsageSummary,
  relativeTime,
} from "../src/format.ts"
import { isCodexSubscriptionModel, latestSessionModel, messageModel } from "../src/model.ts"
import { createUsageStore } from "../src/store.ts"
import { codexUsage } from "../src/server.ts"
import {
  providerStates,
  readProviderCooldowns,
  withProviderCooldowns,
} from "../src/providers.ts"
import {
  accountIdFromAccessToken,
  codexLimitReached,
  CodexUsageError,
  fetchDeepSeekBalance,
  fetchCodexUsage,
  lunaReserveWindow,
  overallWeeklyWindow,
  parseDeepSeekBalance,
  parseUsagePayload,
} from "../src/usage.ts"

test("provider usage stays before the native footer so working directory remains last", async () => {
  const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
  assert.match(source, /before: "sidebar\.footer"/)
  assert.doesNotMatch(source, /append: "sidebar\.footer"/)
  assert.match(source, /provider-usage-settings-v2[^\n]+collapsed: true/)
  assert.doesNotMatch(source, /<box flexDirection="column" gap=\{0\} flexGrow/)
  assert.match(source, /attributes=\{TextAttributes\.BOLD\}[\s\S]+Provider Usage/)
  assert.match(source, /\{\(state\(\)\.providers \?\? \[\]\)\.length\}/)
  assert.match(source, /palette\(\)\.sectionCount/)
  assert.doesNotMatch(source, />•<\/text>/)
  assert.match(source, /<text wrapMode="none" truncate fg=\{palette\(\)\.primary\} attributes=\{TextAttributes\.BOLD\}>\{props\.provider\.label\}<\/text>/)
  assert.match(source, /<box flexGrow=\{1\} \/>/)
  assert.match(source, /providerDetailParts\(props\.provider\)/)
  assert.match(source, /paddingLeft=\{2\}/)
  assert.match(source, /wrapMode="word"/)
  assert.match(source, /attributes=\{TextAttributes\.DIM\}/)
  assert.match(source, /palette\.measurement/)
   assert.match(source, /<b>\{token\.text\}<\/b>/)
  assert.doesNotMatch(source.slice(source.indexOf("export function ProviderRow"), source.indexOf("function providerUpdatedLabel")), /providerCompactStatus\(props\.provider\)/)
  assert.doesNotMatch(source, /snapshot: UsageState\["snapshot"\]/)
  assert.doesNotMatch(source, /snapshot=\{state\(\)\.snapshot\}/)
  assert.match(source, /flexDirection="row"\s+width="100%"[\s\S]+palette\(\)\.primary/)
  assert.match(source, /props\.provider\.status === "available"/)
  assert.match(source, /palette\(\)\.ready/)
  assert.match(source, /palette\(\)\.offline/)
  assert.match(source, /providerPalette/)
  assert.match(source, /Refresh Codex quota, DeepSeek balance, Anthropic rate limits, and provider status\./)
  assert.match(source, /Show verified Codex limits, DeepSeek balance, Anthropic rate limits, and provider statuses\./)
  assert.doesNotMatch(source, /Refresh failed; saved values retained\./)
  assert.match(source, /<text wrapMode="none" truncate[\s\S]+fg=\{palette\(\)\.subdued\}/)
  assert.match(source, /<Show when=\{collapsed\(\) \? summary\(\) : ""\}>/)
  assert.doesNotMatch(source, /providerCompactParts/)
  assert.match(source, /paddingLeft=\{2\}/)
})

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

test("derives Codex exhaustion and usage labels from the overall bucket only", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0)
  const specializedExhausted = parseUsagePayload({
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 10, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
    },
    additional_rate_limits: [{
      metered_feature: "specialized-model",
      rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 300 } },
    }],
  }, now)
  assert.equal(codexLimitReached(specializedExhausted), false)
   assert.deepEqual(codexUsage(specializedExhausted), { outcome: "ok", usage: "Weekly: 80% left", remainingRatio: 0.8 })

  const reachedType = parseUsagePayload({
    rate_limit: { allowed: true, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } },
    rate_limit_reached_type: "weekly",
  }, now)
  assert.equal(codexLimitReached(reachedType), true)
  assert.equal(codexUsage(reachedType).outcome, "empty")

  const disallowed = parseUsagePayload({
    rate_limit: { allowed: false, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } },
  }, now)
  assert.equal(codexLimitReached(disallowed), true)
  assert.equal(codexUsage(disallowed).outcome, "empty")

  const explicitlyLimited = parseUsagePayload({
    rate_limit: { limit_reached: true, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } },
  }, now)
  assert.equal(codexLimitReached(explicitlyLimited), true)
  assert.equal(codexUsage(explicitlyLimited).outcome, "empty")

  const inferredLimited = parseUsagePayload({
    rate_limit: { secondary_window: { used_percent: 100, limit_window_seconds: 604800 } },
  }, now)
  assert.equal(codexLimitReached(inferredLimited), true)
  assert.equal(codexUsage(inferredLimited).outcome, "empty")

  const explicitlyAllowed = parseUsagePayload({
    rate_limit: { allowed: true, secondary_window: { used_percent: 100, limit_window_seconds: 604800 } },
  }, now)
  assert.equal(codexLimitReached(explicitlyAllowed), false)
   assert.deepEqual(codexUsage(explicitlyAllowed), { outcome: "ok", usage: "Weekly: 0% left", remainingRatio: 0 })
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

test("derives optional OpenAI account metadata without reading auth.json", () => {
  assert.equal(accountIdFromAccessToken("opaque-token", { accountId: "account-test" }), "account-test")
  assert.equal(accountIdFromAccessToken("opaque-token", {}), undefined)
})

test("formats reset countdowns", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0)
  assert.equal(relativeTime(now / 1000 + 7500, now), "resets in 2h 5m")
  assert.equal(compactReset(now / 1000 + 7500, now), "2h 5m")
})

test("formats compact, stable provider panel labels", () => {
  assert.equal(providerStatusLabel("available"), "READY")
  assert.equal(providerStatusLabel("quota-exhausted"), "EMPTY")
  assert.equal(providerStatusLabel("usage-unavailable"), "OFFLINE")
  assert.equal(providerStatusLabel("stale"), "STALE")
  assert.equal(providerPanelDetail({
    id: "opencode-go",
    label: "OpenCode Go",
    status: "available",
    detail: "Available in provider catalog.",
  }), "Available in provider catalog.")
  assert.equal(providerPanelDetail({
    id: "deepseek",
    label: "DeepSeek",
    status: "quota-exhausted",
    detail: "Insufficient balance (USD -0.15).",
  }), "Insufficient · USD -0.15")
})

test("deduplicates repeated balance measurements while retaining distinct usage", () => {
  assert.equal(providerDetailLine({
    id: "deepseek",
    label: "DeepSeek",
    status: "quota-exhausted",
    detail: "Insufficient balance (USD -0.15).",
    usage: "Balance USD -0.15",
  }), "Insufficient · USD -0.15")
  assert.equal(providerDetailLine({
    id: "codex",
    label: "Codex",
    status: "available",
    detail: "Usage is verified.",
    usage: "Weekly: 15% left",
  }), "Usage is verified. · Weekly: 15% left")
})

test("assigns semantic tones to every provider state", () => {
  assert.equal(providerTone("available"), "success")
  for (const status of ["cooling", "stale", "usage-unavailable"] as const) {
    assert.equal(providerTone(status), "warning")
  }
  for (const status of ["quota-exhausted", "unavailable"] as const) {
    assert.equal(providerTone(status), "error")
  }
})

test("formats one-line provider summaries without inventing unavailable measurements", () => {
  const now = Date.UTC(2026, 8, 15, 12, 0, 0)
  const snapshot = parseUsagePayload({
    rate_limit: { secondary_window: { used_percent: 33, limit_window_seconds: 604800 } },
    rate_limits_by_limit_id: {
      base_model_inference: {
        limit_name: "gpt-reserve",
        primary_window: { used_percent: 48, limit_window_seconds: 604800 },
      },
    },
  }, now)
  assert.equal(providerCompactLine({
    id: "codex",
    label: "Codex",
    status: "available",
    detail: "Subscription quota available.",
  }, snapshot), "Codex READY · Weekly 67% · Reserve 52%")
  assert.equal(providerCompactStatus({
    id: "codex",
    label: "Codex",
    status: "available",
    detail: "Subscription quota available.",
  }, snapshot), "READY · Weekly 67% · Reserve 52%")
  assert.equal(providerCompactLine({
    id: "deepseek",
    label: "DeepSeek",
    status: "quota-exhausted",
    detail: "Insufficient balance (USD 0.00).",
  }), "DeepSeek EMPTY")
  assert.equal(providerCompactLine({
    id: "opencode-go",
    label: "OpenCode Go",
    status: "usage-unavailable",
    detail: "Available in provider catalog.",
  }), "OpenCode Go OFFLINE")
})

test("summarizes collapsed provider state in a stable native-sized header", () => {
  assert.equal(providerUsageSummary([]), "")
  assert.equal(providerUsageSummary([
    { id: "codex", label: "Codex", status: "available", detail: "ready" },
    { id: "deepseek", label: "DeepSeek", status: "quota-exhausted", detail: "empty" },
    { id: "opencode-go", label: "OpenCode Go", status: "available", detail: "ready" },
    { id: "opencode-zen", label: "OpenCode Zen", status: "unavailable", detail: "offline" },
  ]), "2 ready · 1 empty · 1 offline")
})

test("reports only provider rows supplied by the usage snapshot", () => {
  const states = providerStates({
    generated: 1,
    rows: [
      { id: "deepseek", name: "DeepSeek", status: "READY", detail: "An active connection is available." },
      { id: "opencode-go", name: "OpenCode Go", status: "EMPTY", detail: "Verified usage is exhausted." },
    ],
    diagnostics: [],
  })
  assert.deepEqual(states, [
    { id: "deepseek", label: "DeepSeek", status: "available", detail: "An active connection is available." },
    { id: "opencode-go", label: "OpenCode Go", status: "quota-exhausted", detail: "Verified usage is exhausted." },
  ])
})

test("keeps empty snapshots empty instead of synthesizing offline rows", () => {
  assert.deepEqual(providerStates({ generated: 1, rows: [], diagnostics: [] }), [])
  assert.deepEqual(providerStates(undefined), [])
  assert.equal(providerStatusLabel("unavailable"), "OFFLINE")
})

test("retains the last provider snapshot as STALE when a refresh fails", async () => {
  let attempts = 0
  const store = createUsageStore({
    fetchSnapshot: async () => {
      attempts += 1
      if (attempts === 1) {
        return {
          generated: 1,
          rows: [{
            id: "codex",
            name: "Codex",
            status: "READY" as const,
            detail: "Usage is verified.",
            usage: "Weekly: 80% left",
          }],
          diagnostics: [],
        }
      }
      throw new Error("Bearer CANARY_ACCESS_TOKEN")
    },
  })

  const ready = await store.refresh(true)
  assert.equal(ready.status, "ready")
  assert.equal(ready.providers?.[0]?.status, "available")

  const stale = await store.refresh(true)
  assert.equal(stale.status, "error")
  assert.equal(stale.providers?.[0]?.status, "stale")
  assert.equal(stale.providers?.[0]?.usage, "Weekly: 80% left")
  assert.equal(stale.providerSnapshot?.rows[0]?.status, "STALE")
  assert.match(stale.message ?? "", /Bearer \[redacted\]/)
  assert.doesNotMatch(stale.message ?? "", /CANARY_ACCESS_TOKEN/)
  assert.equal(attempts, 2)
  store.dispose()
})

test("does not retain an offline row as visible STALE data after a failed refresh", async () => {
  let attempts = 0
  const store = createUsageStore({
    fetchSnapshot: async () => {
      attempts += 1
      if (attempts === 1) {
        return {
          generated: 1,
          rows: [{
            id: "ingenium",
            name: "Ingenium",
            status: "OFFLINE" as const,
            detail: "No active provider connection.",
          }],
          diagnostics: [],
        }
      }
      throw new Error("transient refresh failure")
    },
  })

  await store.refresh(true)
  const failed = await store.refresh(true)
  assert.deepEqual(failed.providers, [])
  assert.deepEqual(failed.providerSnapshot?.rows, [])
  store.dispose()
})

test("parses and fetches the documented DeepSeek balance response", async () => {
  const now = Date.UTC(2026, 8, 18, 12, 0, 0)
  const payload = {
    is_available: false,
    balance_infos: [
      { currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
    ],
  }
  const parsed = parseDeepSeekBalance(payload, now)
  assert.equal(parsed.available, false)
  assert.deepEqual(parsed.balances, [
    { currency: "USD", totalBalance: "0.00", grantedBalance: "0.00", toppedUpBalance: "0.00" },
  ])

  let authorization: string | null = null
  const snapshot = await fetchDeepSeekBalance(
    { apiKey: "test-key" },
    {
      endpoint: "https://api.deepseek.example/user/balance",
      now,
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization")
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    },
  )
  assert.equal(authorization, "Bearer test-key")
  assert.deepEqual(snapshot, parsed)

  const state = providerStates({
    generated: now,
    rows: [{ id: "deepseek", name: "DeepSeek", status: "EMPTY", detail: "Insufficient balance (USD 0.00)." }],
    diagnostics: [],
  })
  assert.equal(state.find((provider) => provider.id === "deepseek")?.status, "quota-exhausted")
  assert.match(state.find((provider) => provider.id === "deepseek")?.detail ?? "", /USD 0\.00/)
})

test("reads bounded fallback cooldowns for tracked providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-cooldown-test-"))
  const path = join(directory, "codex-fallback.json")
  const now = Date.UTC(2026, 8, 18, 12, 0, 0)
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      cooldowns: {
        "deepseek/deepseek-v4-flash": { until: now + 120_000 },
        "opencode/big-pickle": { until: now + 180_000 },
        "opencode-go/kimi-k3": { until: now + 300_000 },
      },
      sessions: {},
    }))
    const cooldowns = await readProviderCooldowns(path, now)
    assert.equal(cooldowns.deepseek, now + 120_000)
    assert.equal(cooldowns["opencode-zen"], now + 180_000)
    assert.equal(cooldowns["opencode-go"], now + 300_000)
    const states = withProviderCooldowns(providerStates({
      generated: now,
      rows: [
        { id: "deepseek", name: "DeepSeek", status: "READY", detail: "ready" },
        { id: "opencode-zen", name: "OpenCode Zen", status: "READY", detail: "ready" },
        { id: "opencode-go", name: "OpenCode Go", status: "READY", detail: "ready" },
      ],
      diagnostics: [],
    }), cooldowns, now)
    assert.equal(states.find((provider) => provider.id === "deepseek")?.status, "cooling")
    assert.equal(states.find((provider) => provider.id === "opencode-zen")?.status, "cooling")
    assert.equal(states.find((provider) => provider.id === "opencode-go")?.status, "cooling")
    const zenOnly = withProviderCooldowns(providerStates({
      generated: now,
      rows: [
        { id: "opencode-zen", name: "OpenCode Zen", status: "READY", detail: "ready" },
        { id: "opencode-go", name: "OpenCode Go", status: "READY", detail: "ready" },
      ],
      diagnostics: [],
    }), {
      "opencode-zen": now + 180_000,
    }, now)
    assert.equal(zenOnly.find((provider) => provider.id === "opencode-zen")?.status, "cooling")
    assert.equal(zenOnly.find((provider) => provider.id === "opencode-go")?.status, "available")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("formats both OpenCode rows with stable status text and no unverified measurements", () => {
  const details = formatDetails({
    status: "ready",
    providers: providerStates({
      generated: Date.now(),
      rows: [
        { id: "opencode-zen", name: "OpenCode Zen", status: "READY", detail: "Available in provider catalog." },
        { id: "opencode-go", name: "OpenCode Go", status: "READY", detail: "Available in provider catalog." },
      ],
      diagnostics: [],
    }),
  })
  assert.match(details, /OpenCode Go: READY — Available in provider catalog\./)
  assert.match(details, /OpenCode Zen: READY — Available in provider catalog\./)
  const forbiddenCatalogPhrase = ["catalog", "only"].join(" ")
  const forbiddenUsagePhrase = ["no", "usage", "API"].join(" ")
  assert.equal(details.includes(forbiddenCatalogPhrase), false)
  assert.equal(details.includes(forbiddenUsagePhrase), false)
})

test("recognizes the active subscription model from either message shape", () => {
  const user = { model: { providerID: "openai", modelID: "gpt-5.6-sol" } }
  const assistant = { providerID: "anthropic", modelID: "claude-sonnet" }
  assert.deepEqual(messageModel(user), { providerID: "openai", modelID: "gpt-5.6-sol" })
  assert.equal(isCodexSubscriptionModel(messageModel(user)), true)
  assert.equal(isCodexSubscriptionModel(latestSessionModel([user, assistant])), false)
})

test("preserves the selected model variant and omits it when the message has none", () => {
  const nested = { model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" } }
  const flat = { providerID: "openai", modelID: "gpt-5.6-sol", variant: "low" }
  const absent = { model: { providerID: "openai", modelID: "gpt-5.6-sol" } }
  assert.deepEqual(messageModel(nested), { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" })
  assert.deepEqual(messageModel(flat), { providerID: "openai", modelID: "gpt-5.6-sol", variant: "low" })
  assert.deepEqual(messageModel(absent), { providerID: "openai", modelID: "gpt-5.6-sol" })
  assert.equal("variant" in (messageModel(absent) as object), false)
})
