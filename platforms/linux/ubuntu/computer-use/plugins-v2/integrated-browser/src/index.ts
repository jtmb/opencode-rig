import { Plugin } from "@opencode/plugin"

import { BrowserManager, type BrowserManagerOptions } from "./manager.ts"
import { IntegratedBrowser } from "./rpc.ts"

const TOOL_ACTIONS = [
  "status", "launch", "close", "navigate", "newTab", "selectTab", "closeTab", "back", "forward", "reload",
  "snapshot", "console", "screenshot", "viewport", "click", "fill",
] as const

type ToolAction = (typeof TOOL_ACTIONS)[number]

interface ToolInput {
  readonly action?: unknown
  readonly url?: unknown
  readonly tabID?: unknown
  readonly role?: unknown
  readonly name?: unknown
  readonly value?: unknown
  readonly exact?: unknown
  readonly nth?: unknown
  readonly maxEntries?: unknown
  readonly width?: unknown
  readonly height?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function pluginOptions(value: unknown): BrowserManagerOptions {
  if (!isRecord(value)) return {}
  const viewport = isRecord(value.defaultViewport)
    ? { width: value.defaultViewport.width as number, height: value.defaultViewport.height as number }
    : undefined
  return {
    runtimeRoot: typeof value.runtimeRoot === "string" ? value.runtimeRoot : undefined,
    maxSessions: value.maxSessions as number | undefined,
    maxTabs: value.maxTabs as number | undefined,
    maxConsoleEntries: value.maxConsoleEntries as number | undefined,
    maxSnapshotChars: value.maxSnapshotChars as number | undefined,
    maxScreenshotBytes: value.maxScreenshotBytes as number | undefined,
    navigationTimeoutMs: value.navigationTimeoutMs as number | undefined,
    defaultViewport: viewport,
  }
}

function action(value: unknown): ToolAction {
  if (typeof value !== "string" || !(TOOL_ACTIONS as readonly string[]).includes(value)) throw new Error("unsupported integrated-browser action")
  return value as ToolAction
}

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

export default Plugin.define({
  id: "opencode-rig.integrated-browser",
  async setup(ctx) {
    let rpcEvents: ((sessionID: string) => Promise<void>) | undefined
    const manager = new BrowserManager({
      ...pluginOptions(ctx.options),
      onChanged: async (sessionID) => rpcEvents?.(sessionID),
    })
    const rpc = await ctx.rpc.register(IntegratedBrowser, {
      status: async (input) => manager.status((input as { sessionID: string }).sessionID),
      launch: async (input) => manager.launch((input as { sessionID: string; url: string }).sessionID, (input as { sessionID: string; url: string }).url),
      close: async (input) => manager.close((input as { sessionID: string }).sessionID),
      navigate: async (input) => {
        const value = input as { sessionID: string; url: string; tabID?: string }
        return manager.navigate(value.sessionID, value.url, value.tabID)
      },
      newTab: async (input) => manager.newTab((input as { sessionID: string; url: string }).sessionID, (input as { sessionID: string; url: string }).url),
      selectTab: async (input) => {
        const value = input as { sessionID: string; tabID: string }
        return manager.selectTab(value.sessionID, value.tabID)
      },
      closeTab: async (input) => {
        const value = input as { sessionID: string; tabID: string }
        return manager.closeTab(value.sessionID, value.tabID)
      },
      back: async (input) => {
        const value = input as { sessionID: string; tabID?: string }
        return manager.back(value.sessionID, value.tabID)
      },
      forward: async (input) => {
        const value = input as { sessionID: string; tabID?: string }
        return manager.forward(value.sessionID, value.tabID)
      },
      reload: async (input) => {
        const value = input as { sessionID: string; tabID?: string }
        return manager.reload(value.sessionID, value.tabID)
      },
      snapshot: async (input) => {
        const value = input as { sessionID: string; tabID?: string }
        return manager.snapshot(value.sessionID, value.tabID)
      },
      console: async (input) => {
        const value = input as { sessionID: string; tabID?: string; maxEntries?: number }
        return manager.consoleEntries(value.sessionID, value.tabID, value.maxEntries)
      },
      screenshot: async (input) => {
        const value = input as { sessionID: string; tabID?: string }
        return manager.screenshot(value.sessionID, value.tabID)
      },
      viewport: async (input) => {
        const value = input as { sessionID: string; tabID?: string; width: number; height: number }
        return manager.viewport(value.sessionID, value.width, value.height, value.tabID)
      },
      click: async (input) => {
        const value = input as { sessionID: string; tabID?: string; role: string; name: string; exact?: boolean; nth?: number }
        return manager.click(value.sessionID, value.role, value.name, value.exact, value.nth, value.tabID)
      },
      fill: async (input) => {
        const value = input as { sessionID: string; tabID?: string; role: string; name: string; value: string; exact?: boolean; nth?: number }
        return manager.fill(value.sessionID, value.role, value.name, value.value, value.exact, value.nth, value.tabID)
      },
    })
    rpcEvents = async (sessionID) => {
      const status = await manager.status(sessionID)
      await rpc.events.emit("changed", { sessionID, state: status.state })
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "integrated_browser",
        description: "Control the session-owned headed Chromium window through bounded navigation, tabs, accessibility, console, screenshot, viewport, and lifecycle actions. Uses a temporary isolated BrowserContext; it never attaches to a normal browser profile or exposes arbitrary JavaScript/CDP.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: TOOL_ACTIONS },
            url: { type: "string", minLength: 1, maxLength: 2_048 },
            tabID: { type: "string", pattern: "^tab-[1-9][0-9]*$", maxLength: 32 },
            role: { type: "string", maxLength: 32 },
            name: { type: "string", maxLength: 256 },
            value: { type: "string", maxLength: 4_096 },
            exact: { type: "boolean" },
            nth: { type: "integer", minimum: 1, maximum: 100 },
            maxEntries: { type: "integer", minimum: 1, maximum: 100 },
            width: { type: "integer", minimum: 320, maximum: 1_920 },
            height: { type: "integer", minimum: 240, maximum: 1_080 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(raw, context) {
          const input = raw as ToolInput
          const sessionID = String(context.sessionID)
          switch (action(input.action)) {
            case "status": return json(await manager.status(sessionID))
            case "launch": return json(await manager.launch(sessionID, input.url))
            case "close": return json(await manager.close(sessionID))
            case "navigate": return json(await manager.navigate(sessionID, input.url, input.tabID))
            case "newTab": return json(await manager.newTab(sessionID, input.url))
            case "selectTab": return json(await manager.selectTab(sessionID, input.tabID))
            case "closeTab": return json(await manager.closeTab(sessionID, input.tabID))
            case "back": return json(await manager.back(sessionID, input.tabID))
            case "forward": return json(await manager.forward(sessionID, input.tabID))
            case "reload": return json(await manager.reload(sessionID, input.tabID))
            case "snapshot": return json(await manager.snapshot(sessionID, input.tabID))
            case "console": return json(await manager.consoleEntries(sessionID, input.tabID, input.maxEntries))
            case "screenshot": return json(await manager.screenshot(sessionID, input.tabID))
            case "viewport": return json(await manager.viewport(sessionID, input.width, input.height, input.tabID))
            case "click": return json(await manager.click(sessionID, input.role, input.name, input.exact, input.nth, input.tabID))
            case "fill": return json(await manager.fill(sessionID, input.role, input.name, input.value, input.exact, input.nth, input.tabID))
          }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const value = event as unknown as { type?: string; data?: unknown }
          if (value.type !== "session.deleted" || !isRecord(value.data) || typeof value.data.sessionID !== "string") continue
          await manager.close(value.data.sessionID)
        }
      } catch {
        // The subscription ends when the plugin unloads.
      }
    })()

    return async () => {
      controller.abort()
      await manager.dispose()
    }
  },
})
