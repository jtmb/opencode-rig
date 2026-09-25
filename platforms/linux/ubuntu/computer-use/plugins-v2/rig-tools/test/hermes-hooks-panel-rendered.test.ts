import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"

const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const panelURL = new URL("../src/hermes-hooks-panel.tsx", import.meta.url)
const panelSource = await readFile(panelURL, "utf8")
const transformed = await transformSolidSource(panelSource, {
  filename: panelURL.pathname,
  moduleName: "@opentui/solid",
  resolvePath: (specifier) => {
    if (specifier.startsWith(".")) return new URL(specifier, new URL("../src/", import.meta.url)).href
    if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
    return import.meta.resolve(specifier)
  },
})
const { HermesHooksPanel } = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`) as {
  HermesHooksPanel: (props: Record<string, unknown>) => ReturnType<typeof jsx>
}

const snapshot = {
  schemaVersion: 1,
  updatedAt: "2026-09-25T12:00:05.000Z",
  events: [
    { at: "2026-09-25T12:00:01.000Z", hook: "pre_api_request", status: "started", requestRef: "aaaaaaaaaaaa", model: "gpt-6-luna", provider: "openai" },
    { at: "2026-09-25T12:00:03.000Z", hook: "post_api_request", status: "ok", requestRef: "aaaaaaaaaaaa", durationMs: 420 },
  ],
}

function context(snapshotCalls: { count: number }): Context {
  const theme = {
    hue: { accent: { 200: "#8cc8ff" } },
    text: {
      default: "#d8e1ee",
      subdued: "#9caec2",
      action: { primary: { default: "#8cc8ff", hovered: "#56d4dd" } },
      feedback: { success: { default: "#8fd694" }, error: { default: "#e06c75" } },
    },
    diff: { text: { added: "#8fd694", removed: "#e06c75" } },
    border: { default: "#4f5b66" },
    background: { surface: { offset: "#27303a" }, action: { primary: { default: "#161b22", hovered: "#30363d" } } },
    syntax: { keyword: "#bb9af7", type: "#bb9af7" },
  }
  return {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "fixture", channel: "test" },
    renderer: { width: 140, on: () => undefined, off: () => undefined },
    client: {
      rpc: () => ({
        snapshot: async () => { snapshotCalls.count += 1; return snapshot },
        events: { on: () => () => undefined },
      }),
    },
    data: {},
    attention: {},
    theme,
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => undefined },
    keymap: {},
    storage: {},
    ui: {},
  } as unknown as Context
}

test("direct Hermes /hooks panel render shows observer stages and refreshes", async () => {
  const calls = { count: 0 }
  const pluginContext = context(calls)
  const panel: PanelInput = {
    name: "opencode-rig.rig-tools.hermes-hooks",
    sessionID: "ses-hermes-render",
    width: 140,
    presentation: "fullscreen",
    focused: true,
    focus: () => undefined,
    close: () => undefined,
    toggleFullscreen: () => undefined,
  }
  const setup = await testRender(() => jsx(PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>, {
    value: pluginContext,
    get children() { return jsx(HermesHooksPanel, { panel }) },
  }), { width: 140, height: 42 })
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await setup.flush()
    }
    const frame = setup.captureCharFrame()
    assert.match(frame, /Hermes \/hooks/)
    assert.match(frame, /Recent hook events/)
    assert.match(frame, /pre_api_request/)
    assert.match(frame, /gpt-6-luna/)
    assert.equal(calls.count, 1)

    await setup.mockInput.pressKey("r")
    for (let pass = 0; pass < 4; pass += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await setup.flush()
    }
    assert.equal(calls.count, 2)
  } finally {
    setup.renderer.destroy()
  }
})
