import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { PluginContextProvider } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"

import { GoalRpc } from "../../orchestration-policy/src/goal-rpc.ts"
import { GoalFooterSummary, GoalHandoffControl } from "../src/goal-handoff-control.ts"
import type { GoalStateSnapshot } from "../src/goal-state.ts"

const { transformSolidSource } = await import(new URL("./scripts/solid-transform.js", import.meta.resolve("@opentui/solid")).href) as {
  transformSolidSource: (source: string, options: {
    filename: string
    moduleName: string
    resolvePath: (specifier: string) => string
  }) => Promise<string>
}

const location = { directory: "/tmp/goal-footer-slot-test" }
const goal = { status: "active", handoff: "manual", objective: "finish the roadmap" }
const RenderablePluginContextProvider = PluginContextProvider as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>

async function rigToolsPlugin() {
  const sourceURL = new URL("../src/tui.tsx", import.meta.url)
  const sourceDirectory = new URL("./", sourceURL)
  const hermesStub = `data:text/javascript;base64,${Buffer.from('export const HERMES_HOOKS_PANEL_NAME = "opencode-rig.rig-tools.hermes-hooks"; export function HermesHooksPanel() { return null }').toString("base64")}`
  const transformed = await transformSolidSource(await readFile(sourceURL, "utf8"), {
    filename: sourceURL.pathname,
    moduleName: "@opentui/solid",
    resolvePath: (specifier) => {
      if (specifier === "./hermes-hooks-panel.tsx") return hermesStub
      if (specifier.startsWith(".")) return new URL(specifier, sourceDirectory).href
      if (specifier === "solid-js") return import.meta.resolve("solid-js/dist/solid.js")
      return import.meta.resolve(specifier)
    },
  })
  return await import(`data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`) as {
    default: { setup: (context: Context) => (() => void) | void }
  }
}

test("native Goal slots keep the last ready Goal visible during refresh", async () => {
  const plugin = await rigToolsPlugin()
  const claims: Array<{ append?: string; after?: string; render: (input: never) => unknown }> = []
  const updated = new Set<(event: unknown) => void>()
  let currentSession = "ses_goal"
  let reads = 0
  let finishRefresh!: (value: typeof goal) => void
  const goalRpc = {
    state: async () => {
      reads += 1
      if (reads > 1) return new Promise<typeof goal>((resolve) => { finishRefresh = resolve })
      return goal
    },
    toggleHandoff: async () => goal,
    events: {
      on: (_name: string, listener: (event: unknown) => void) => {
        updated.add(listener)
        return () => updated.delete(listener)
      },
    },
  }
  const rigRpc = {
    managedScreens: async () => ({ sessions: [] }),
    events: { on: () => () => undefined },
  }
  const theme = {
    hue: { accent: { 200: "#bb9af7" } },
    text: { default: "#d8e1ee", subdued: "#9caec2" },
  }
  const context = {
    options: {},
    location,
    app: { version: "test", channel: "test" },
    client: { rpc: (protocol: { id: string }) => protocol.id === GoalRpc.id ? goalRpc : rigRpc },
    data: { location: { default: () => location }, on: () => () => undefined },
    theme,
    keymap: { layer: () => undefined },
    storage: { store: (_key: string, options: { initial: object }) => [options.initial, async () => undefined] },
    ui: {
      router: { current: () => ({ type: "session", sessionID: currentSession }) },
      slot: (claim: { append?: string; after?: string; render: (input: never) => unknown }) => {
        claims.push(claim)
        return () => undefined
      },
      panel: { open: () => true },
      dialog: { alert: async () => undefined },
      toast: { show: () => undefined },
    },
  } as unknown as Context
  const cleanup = plugin.default.setup(context)
  const footer = claims.find((claim) => claim.append === "prompt.footer.status")!
  const sidebar = claims.filter((claim) => claim.after === "sidebar.content")[1]!
  let setup: Awaited<ReturnType<typeof testRender>> | undefined

  try {
    setup = await testRender(() => jsx("box", {
      width: 120,
      height: 6,
      flexDirection: "column",
      children: [
        jsx(RenderablePluginContextProvider, {
          value: context,
          get children() { return footer.render({ sessionID: currentSession, mode: "normal", showDetails: false } as never) },
        }),
        jsx(RenderablePluginContextProvider, {
          value: context,
          get children() { return sidebar.render({ sessionID: currentSession } as never) },
        }),
      ],
    }), { width: 120, height: 6 })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await setup.flush()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.match(setup.captureCharFrame(), /Goal: active/)
    assert.match(setup.captureCharFrame(), /Goal · active/)
    assert.match(setup.captureCharFrame(), /Objective: finish the roadmap/)
    assert.equal(reads, 1)

    for (const listener of updated) listener({ data: { sessionID: currentSession }, location })
    assert.equal(reads, 2)
    for (let attempt = 0; attempt < 4; attempt += 1) await setup.flush()

    assert.match(setup.captureCharFrame(), /Goal: active/)
    assert.match(setup.captureCharFrame(), /Goal · active/)
    finishRefresh({ ...goal, status: "paused", objective: "review the roadmap" })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await setup.flush()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    assert.match(setup.captureCharFrame(), /Goal: paused/)
    assert.match(setup.captureCharFrame(), /Goal · paused/)
    assert.match(setup.captureCharFrame(), /Objective: review the roadmap/)
  } finally {
    setup?.renderer.destroy()
    if (typeof cleanup === "function") cleanup()
  }
})

const RenderableGoalFooterSummary = GoalFooterSummary as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>
const RenderableGoalHandoffControl = GoalHandoffControl as unknown as (props: Record<string, unknown>) => ReturnType<typeof jsx>

test("keeps the footer handoff control on one unbroken line while the summary yields width", async () => {
  const objective = `Repair ${Array.from({ length: 30 }, (_, index) => `segment-${index}`).join(" ")}`
  const snapshot: GoalStateSnapshot = {
    status: "ready",
    goal: { status: "active", handoff: "manual", objective },
  }
  let setup: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    setup = await testRender(() => jsx("box", {
      width: 44,
      height: 3,
      flexDirection: "row",
      gap: 1,
      children: [
        jsx(RenderableGoalFooterSummary, {
          sessionID: "ses_current",
          snapshot: () => snapshot,
          previewEnabled: false,
          textColor: "#9caec2",
          accentColor: "#bb9af7",
        }),
        jsx(RenderableGoalHandoffControl, {
          mode: "manual",
          textColor: "#9caec2",
          accentColor: "#bb9af7",
          onToggle: () => undefined,
        }),
      ],
    }), { width: 44, height: 3 })
    await setup.flush()
    const frame = setup.captureCharFrame()
    assert.ok(frame.split("\n").some((line) => line.includes("Goal · Handoff: Manual")), frame)
    for (const line of frame.split("\n")) {
      if (line.includes("Handoff: Manual")) assert.match(line, /Goal · Handoff: Manual/)
    }
  } finally {
    setup?.renderer.destroy()
  }
})
