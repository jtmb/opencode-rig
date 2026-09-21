import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  compactReset,
  formatDetails,
  formatSnapshot,
  providerPanelDetail,
  providerStatusLabel,
  relativeTime,
  usageUpdatedLabel,
} from "../src/format.ts"
import { isCodexSubscriptionModel, latestSessionModel, messageModel } from "../src/model.ts"
import { createUsageStore } from "../src/store.ts"
import {
  providerStates,
  readProviderCooldowns,
  withCodexStatus,
  withDeepSeekStatus,
  withProviderCooldowns,
} from "../src/providers.ts"
import {
  CodexUsageError,
  fetchDeepSeekBalance,
  fetchCodexUsage,
  lunaReserveWindow,
  overallWeeklyWindow,
  parseDeepSeekBalance,
  parseUsagePayload,
  readDeepSeekCredential,
  readOpenAICredential,
} from "../src/usage.ts"

test("provider usage coexists with plugins that replace sidebar content", async () => {
  const source = await readFile(new URL("../src/tui.tsx", import.meta.url), "utf8")
  assert.match(source, /append: "sidebar\.footer"/)
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
        deepseek: { type: "api", key: "deepseek-test-key" },
      }),
      { mode: 0o600 },
    )
    const credential = await readOpenAICredential(authPath)
    assert.deepEqual(credential, {
      accessToken: "test-token",
      accountId: "account-test",
      expiresAt: credential.expiresAt,
    })
    assert.deepEqual(await readDeepSeekCredential(authPath), { apiKey: "deepseek-test-key" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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

test("reports provider availability without inventing balances", () => {
  const states = providerStates([
    { id: "deepseek", activation: "enabled" },
    { id: "opencode-go", canonical: "opencode", activation: "enabled" },
    { id: "opencode", canonical: "opencode-go", activation: "enabled" },
  ])
  assert.equal(states.find((provider) => provider.id === "deepseek")?.status, "available")
  assert.equal(states.find((provider) => provider.id === "opencode-go")?.status, "available")
  assert.equal(states.find((provider) => provider.id === "opencode-go")?.label, "OpenCode Go")
  assert.equal(states.find((provider) => provider.id === "opencode-zen")?.status, "available")
  assert.equal(states.find((provider) => provider.id === "opencode-zen")?.label, "OpenCode Zen")
  assert.equal(states.find((provider) => provider.id === "codex")?.status, "unavailable")
  assert.equal(providerStates([{ id: "deepseek" }]).find((provider) => provider.id === "deepseek")?.status, "available")
  const exhausted = withCodexStatus(states, { hasSnapshot: true, leftPercent: 0 })
  assert.equal(exhausted.find((provider) => provider.id === "codex")?.status, "quota-exhausted")
})

test("keeps missing and disabled provider entries offline", () => {
  const states = providerStates([{ id: "opencode-go", activation: "disabled" }])
  assert.equal(states.find((provider) => provider.id === "opencode-go")?.status, "unavailable")
  assert.equal(states.find((provider) => provider.id === "opencode-go")?.detail, "Disabled in provider catalog.")
  assert.equal(states.find((provider) => provider.id === "opencode-zen")?.status, "unavailable")
  assert.equal(providerStatusLabel(providerStates(undefined)[0]?.status ?? "unavailable"), "OFFLINE")
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

  const state = withDeepSeekStatus(providerStates([{ providerID: "deepseek" }]), { snapshot })
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
    const states = withProviderCooldowns(providerStates([
      { id: "deepseek" },
      { id: "opencode" },
      { id: "opencode-go" },
    ]), cooldowns, now)
    assert.equal(states.find((provider) => provider.id === "deepseek")?.status, "cooling")
    assert.equal(states.find((provider) => provider.id === "opencode-zen")?.status, "cooling")
    assert.equal(states.find((provider) => provider.id === "opencode-go")?.status, "cooling")
    const zenOnly = withProviderCooldowns(providerStates([{ id: "opencode" }, { id: "opencode-go" }]), {
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
    providers: providerStates([{ id: "opencode" }, { id: "opencode-go" }]),
  })
  assert.match(details, /OpenCode Go: READY — Available in provider catalog\./)
  assert.match(details, /OpenCode Zen: READY — Available in provider catalog\./)
  const forbiddenCatalogPhrase = ["catalog", "only"].join(" ")
  const forbiddenUsagePhrase = ["no", "usage", "API"].join(" ")
  assert.equal(details.includes(forbiddenCatalogPhrase), false)
  assert.equal(details.includes(forbiddenUsagePhrase), false)
})

test("marks retained provider data stale when only part of a refresh succeeds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-partial-refresh-"))
  const authPath = join(directory, "auth.json")
  let deepSeekFails = false
  try {
    await writeFile(authPath, JSON.stringify({
      openai: { type: "oauth", access: "test-token", accountId: "account-test", expires: Date.now() + 60_000 },
      deepseek: { type: "api", key: "deepseek-test-key" },
    }), { mode: 0o600 })
    const store = createUsageStore({
      authPath,
      endpoint: "https://usage.example/codex",
      deepSeekEndpoint: "https://usage.example/deepseek",
      fallbackStatePath: join(directory, "missing-fallback.json"),
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith("/deepseek")) {
          if (deepSeekFails) return new Response("failed", { status: 503 })
          return new Response(JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "USD", total_balance: "4.00", granted_balance: "4.00", topped_up_balance: "0.00" }],
          }), { status: 200, headers: { "content-type": "application/json" } })
        }
        return new Response(JSON.stringify({
          rate_limit: { secondary_window: { used_percent: 20, limit_window_seconds: 604800 } },
        }), { status: 200, headers: { "content-type": "application/json" } })
      },
    })
    store.updateProviders([{ providerID: "openai" }, { providerID: "deepseek" }])
    assert.equal((await store.refresh(true)).status, "ready")
    deepSeekFails = true
    const partial = await store.refresh(true)
    assert.equal(partial.status, "error")
    assert.equal(partial.providers?.find((provider) => provider.id === "codex")?.status, "available")
    assert.equal(partial.providers?.find((provider) => provider.id === "deepseek")?.status, "stale")
    assert.match(partial.message ?? "", /DeepSeek balance/)
    assert.match(usageUpdatedLabel(partial), /^Saved values · Updated /)
    store.dispose()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("recognizes the active subscription model from either message shape", () => {
  const user = { model: { providerID: "openai", modelID: "gpt-5.6-sol" } }
  const assistant = { providerID: "anthropic", modelID: "claude-sonnet" }
  assert.deepEqual(messageModel(user), { providerID: "openai", modelID: "gpt-5.6-sol" })
  assert.equal(isCodexSubscriptionModel(messageModel(user)), true)
  assert.equal(isCodexSubscriptionModel(latestSessionModel([user, assistant])), false)
})
