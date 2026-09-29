import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { jsx } from "@opentui/solid/jsx-runtime"

import type { ProviderState } from "../src/providers.ts"

const { createSignal } = await import(import.meta.resolve("solid-js/dist/solid.js")) as {
  createSignal: <T>(value: T) => [() => T, (value: T | ((current: T) => T)) => T]
}

const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const MARKER = "RIG_CODEX_USAGE_RENDER_ASSERTIONS_EXECUTED"

function colorInts(color: { toInts: () => [number, number, number, number] }) {
  return color.toInts()
}

function exactSpan(spans: readonly { text: string; attributes: number; fg: { toInts: () => [number, number, number, number] } }[], text: string) {
  const matching = spans.filter((span) => span.text === text)
  assert.equal(matching.length, 1, `expected one exact span for ${JSON.stringify(text)}, found ${matching.length}`)
  return matching[0]!
}

// The native renderer coalesces adjacent same-style spans, so a label that
// immediately follows muted detail text is matched by its trailing suffix.
function labelSpan(spans: readonly { text: string; attributes: number; fg: { toInts: () => [number, number, number, number] } }[], suffix: string) {
  const matching = spans.filter((span) => span.text.endsWith(suffix))
  assert.equal(matching.length, 1, `expected one label span ending with ${JSON.stringify(suffix)}, found ${matching.length}`)
  return matching[0]!
}

let rowPromise: Promise<unknown> | undefined
async function actualProviderRow() {
  if (!rowPromise) {
    rowPromise = (async () => {
      const sourceURL = new URL("../src/tui.tsx", import.meta.url)
      const sourceDirectory = new URL("../src/", import.meta.url)
      const imports = await transformSolidSource(await readFile(sourceURL, "utf8"), {
        filename: sourceURL.pathname,
        moduleName: "@opentui/solid",
        resolvePath: (specifier) => {
          if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
          if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
          return import.meta.resolve(specifier)
        },
      })
      return (await import(`data:text/javascript;base64,${Buffer.from(imports).toString("base64")}`) as { ProviderRow: unknown }).ProviderRow
    })()
  }
  return await rowPromise
}

function rendererFailure(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.includes("OpenTUI native FFI is not available for this runtime yet")) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new Error(
    "codex-usage rendered checks require a supported OpenTUI native renderer; " +
    "run this package with OpenTUI's supported Node runtime (>=26.4) instead of skipping the assertions.",
    { cause: error },
  )
}

function themeVariant(variant: "one" | "two") {
  return {
    hue: {
      accent: { 200: variant === "one" ? "#d985b9" : "#79c0ff" },
      green: { 200: variant === "one" ? "#8fd694" : "#56d364" },
      orange: { 200: variant === "one" ? "#e5c07b" : "#d29922" },
      red: { 200: variant === "one" ? "#e06c75" : "#ff7b72" },
      purple: { 200: variant === "one" ? "#bb9af7" : "#d2a8ff" },
    },
    text: {
      default: variant === "one" ? "#d8e1ee" : "#f0f6fc",
      subdued: variant === "one" ? "#9caec2" : "#8b949e",
      feedback: {
        success: { default: variant === "one" ? "#8fd694" : "#56d364" },
        warning: { default: variant === "one" ? "#e5c07b" : "#d29922" },
        error: { default: variant === "one" ? "#e06c75" : "#ff7b72" },
      },
    },
    syntax: { keyword: variant === "one" ? "#bb9af7" : "#d2a8ff", type: variant === "one" ? "#bb9af7" : "#d2a8ff" },
  }
}

function context(activeTheme = themeVariant("one")): Context {
  return {
    options: {},
    location: undefined,
    app: { version: "fixture", channel: "test" },
    renderer: {} as Context["renderer"],
    client: {} as Context["client"],
    data: {} as Context["data"],
    attention: {} as Context["attention"],
    theme: activeTheme,
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: {} as Context["keymap"],
    storage: {} as Context["storage"],
    ui: {} as Context["ui"],
  } as unknown as Context
}

test("rendered ProviderRow keeps right-aligned status separate from wrapped subdued detail", async () => {
  const ProviderRow = await actualProviderRow() as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const provider: ProviderState = {
    id: "deepseek",
    label: "DeepSeek",
    status: "quota-exhausted",
    detail: "Insufficient balance (USD 0.00).",
    usage: "Weekly: 6% left",
  }
  let setup: TestRendererSetup | undefined
  try {
    try {
      setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
        value: context(),
        get children() {
          return jsx(ProviderRow, { provider, theme: () => context().theme })
        },
      }), { width: 34, height: 8 })
    } catch (error) {
      throw rendererFailure(error)
    }
    await setup.flush()
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const visibleLines = lines.filter((line) => line.trim().length > 0)
    const statusIndex = visibleLines.findIndex((line) => line.includes("DeepSeek") && line.includes("EMPTY"))
    const detailIndex = visibleLines.findIndex((line) => line.includes("Insufficient") || line.includes("Weekly quota"))
    assert.ok(statusIndex >= 0, frame)
    assert.ok(detailIndex > statusIndex, frame)
    assert.ok((visibleLines[detailIndex] ?? "").startsWith("  "), frame)
    assert.doesNotMatch(visibleLines[statusIndex] ?? "", /Insufficient|Weekly quota/)
    assert.ok(visibleLines.slice(detailIndex).some((line) => line.includes("6%")), frame)
    assert.ok(visibleLines.slice(detailIndex).some((line) => line.includes("left")), frame)
    assert.ok(visibleLines.every((line) => line.length <= 34), frame)
    assert.ok(visibleLines.length >= 3, frame)
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans)
    const label = spans.find((span) => span.text.includes("DeepSeek"))
    const status = spans.find((span) => span.text.includes("EMPTY"))
    const detail = spans.find((span) => span.text.includes("Insufficient"))
    const usageLabel = spans.find((span) => span.text === "Weekly: ")
    const usageValue = spans.find((span) => span.text === "6%")
    const usageLeft = spans.find((span) => span.text === " left")
    const balanceValue = spans.find((span) => span.text === "0.00")
    assert.ok(label && (label.attributes & TextAttributes.BOLD) !== 0)
    assert.ok(status && (status.attributes & TextAttributes.BOLD) !== 0)
    assert.ok(detail && (detail.attributes & TextAttributes.DIM) !== 0)
    assert.ok(usageLabel && (usageLabel.attributes & TextAttributes.BOLD) === 0)
    assert.ok(usageValue && (usageValue.attributes & TextAttributes.BOLD) !== 0)
    assert.ok(usageLeft && (usageLeft.attributes & TextAttributes.BOLD) === 0)
    assert.ok(balanceValue && (balanceValue.attributes & TextAttributes.BOLD) !== 0)
    assert.deepEqual(colorInts(label.fg), colorInts(RGBA.fromHex("#d8e1ee")))
    assert.deepEqual(colorInts(status.fg), colorInts(RGBA.fromHex("#9caec2")))
    assert.deepEqual(colorInts(detail.fg), colorInts(RGBA.fromHex("#9caec2")))
    assert.deepEqual(colorInts(usageValue.fg), colorInts(RGBA.fromHex("#e06c75")))
    assert.deepEqual(colorInts(balanceValue.fg), colorInts(RGBA.fromHex("#9caec2")))
  } finally {
    setup?.renderer.destroy()
  }
  process.stdout.write(`${MARKER}\n`)
})

test("rendered measurement spans switch semantic health colors with the active theme", async () => {
  const ProviderRow = await actualProviderRow() as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const [activeTheme, setActiveTheme] = createSignal(themeVariant("one"))
  const provider: ProviderState = {
    id: "codex",
    label: "Codex",
    status: "available",
    detail: "Usage is verified.",
    usage: "API allowance: $98 requests",
    remainingRatio: 0.8,
  }
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(() => jsx(ProviderRow, { provider, theme: activeTheme }), { width: 44, height: 5 })
    await setup.flush()
    const first = setup.captureSpans().lines.flatMap((line) => line.spans)
    const firstValue = first.find((span) => span.text.includes("$98"))
    const firstLabel = first.find((span) => span.text.includes("API allowance"))
    assert.ok(firstValue && (firstValue.attributes & TextAttributes.BOLD) !== 0)
    assert.ok(firstLabel && (firstLabel.attributes & TextAttributes.BOLD) === 0)
    assert.deepEqual(colorInts(firstValue.fg), colorInts(RGBA.fromHex("#8fd694")))

    setActiveTheme(themeVariant("two"))
    await setup.flush()
    const second = setup.captureSpans().lines.flatMap((line) => line.spans)
    const secondValue = second.find((span) => span.text.includes("$98"))
    assert.ok(secondValue && (secondValue.attributes & TextAttributes.BOLD) !== 0)
    assert.deepEqual(colorInts(secondValue.fg), colorInts(RGBA.fromHex("#56d364")))
  } finally {
    setup?.renderer.destroy()
  }
})

test("DeepSeek and Anthropic token spans use only verified semantic ratios and react to theme changes", async () => {
  const ProviderRow = await actualProviderRow() as (props: Record<string, unknown>) => ReturnType<typeof jsx>
  const [activeTheme, setActiveTheme] = createSignal(themeVariant("one"))
  const providers: ProviderState[] = [
    {
      id: "codex",
      label: "Codex",
      status: "available",
      detail: "Usage is verified.",
      usage: "Allowance: 14 requests",
      remainingRatio: 0.8,
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      status: "available",
      detail: "Balance measurement is available.",
      usage: "Balance USD 4.25",
      remainingRatio: 0.1,
    },
    {
      id: "anthropic",
      label: "Anthropic",
      status: "available",
      detail: "Inference rate limits observed.",
      usage: "Tokens: 1234 total · Requests: 40% left",
    },
  ]
  const renderRows = () => jsx("box", {
    flexDirection: "column",
    children: providers.map((provider) => jsx(ProviderRow, { provider, theme: activeTheme })),
  })
  let setup: TestRendererSetup | undefined
  try {
    setup = await testRender(renderRows, { width: 90, height: 12 })
    await setup.flush()
    const first = setup.captureSpans().lines.flatMap((line) => line.spans)
    const firstGreen = exactSpan(first, "14 requests")
    const firstRed = exactSpan(first, "4.25")
    const firstAmber = exactSpan(first, "40%")
    const firstNeutral = exactSpan(first, "1234")
    const firstLabel = labelSpan(first, "Tokens: ")
    for (const token of [firstGreen, firstRed, firstAmber, firstNeutral]) {
      assert.ok((token.attributes & TextAttributes.BOLD) !== 0, token.text)
    }
    assert.ok((firstLabel.attributes & TextAttributes.BOLD) === 0)
    assert.deepEqual(colorInts(firstGreen.fg), colorInts(RGBA.fromHex("#8fd694")))
    assert.deepEqual(colorInts(firstRed.fg), colorInts(RGBA.fromHex("#e06c75")))
    assert.deepEqual(colorInts(firstAmber.fg), colorInts(RGBA.fromHex("#e5c07b")))
    assert.deepEqual(colorInts(firstNeutral.fg), colorInts(RGBA.fromHex("#9caec2")))
    assert.deepEqual(colorInts(firstLabel.fg), colorInts(RGBA.fromHex("#9caec2")))

    setActiveTheme(themeVariant("two"))
    await setup.flush()
    const second = setup.captureSpans().lines.flatMap((line) => line.spans)
    assert.deepEqual(colorInts(exactSpan(second, "14 requests").fg), colorInts(RGBA.fromHex("#56d364")))
    assert.deepEqual(colorInts(exactSpan(second, "4.25").fg), colorInts(RGBA.fromHex("#ff7b72")))
    assert.deepEqual(colorInts(exactSpan(second, "40%").fg), colorInts(RGBA.fromHex("#d29922")))
    assert.deepEqual(colorInts(exactSpan(second, "1234").fg), colorInts(RGBA.fromHex("#8b949e")))
    assert.deepEqual(colorInts(labelSpan(second, "Tokens: ").fg), colorInts(RGBA.fromHex("#8b949e")))
  } finally {
    setup?.renderer.destroy()
  }
})
