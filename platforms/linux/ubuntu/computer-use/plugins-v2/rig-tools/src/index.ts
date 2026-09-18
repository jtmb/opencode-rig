import { Plugin } from "@opencode/plugin"

import { executeDesktop, type DesktopCommandInput } from "./desktop.ts"
import { captureScreenshot, pngDataUri, type CaptureMode } from "./vision.ts"

const APP_PROPERTY = {
  type: "string",
  description: "AT-SPI application name; an exact match wins, otherwise a case-insensitive substring match",
}

const NAME_PROPERTY = {
  type: "string",
  description: "Accessible-name substring, unless exactName is set",
}

const ROLE_PROPERTY = {
  type: "string",
  description: "Exact AT-SPI role name (case-insensitive)",
}

const SHOWING_PROPERTY = {
  type: "boolean",
  description: "Keep only elements that are both showing and visible",
}

const NTH_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Select the Nth match (1-based); required when the name is ambiguous",
}

const MAX_DEPTH_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Traversal depth bound",
}

const MAX_NODES_PROPERTY = {
  type: "integer",
  minimum: 1,
  description: "Traversal node bound",
}

const INCLUDE_TEXT_PROPERTY = {
  type: "boolean",
  description: "Include text previews for non-sensitive text widgets",
}

const MATCH_PROPERTIES = {
  name: NAME_PROPERTY,
  exactName: { type: "boolean", description: "Match the accessible name exactly" },
  role: ROLE_PROPERTY,
  showing: SHOWING_PROPERTY,
  nth: NTH_PROPERTY,
  maxDepth: MAX_DEPTH_PROPERTY,
  maxNodes: MAX_NODES_PROPERTY,
}

export default Plugin.define({
  id: "opencode-rig.rig-tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "desktop_apps",
        description:
          "List accessible AT-SPI applications on the GNOME desktop as JSON (name, role, child count). Read-only. Use it first to learn exact application names for desktop_tree, desktop_find, and desktop_act.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: await executeDesktop({ verb: "apps" }) }
        },
      })

      editor.add({
        name: "desktop_tree",
        description:
          "Dump the useful accessible elements of one GNOME application over AT-SPI as JSON, including traversal completeness. Read-only. Use desktop_find when you already know the control name or role.",
        input: {
          type: "object",
          properties: {
            app: APP_PROPERTY,
            maxDepth: MAX_DEPTH_PROPERTY,
            maxNodes: MAX_NODES_PROPERTY,
            all: { type: "boolean", description: "Include nodes with no name and no actions" },
            includeText: INCLUDE_TEXT_PROPERTY,
          },
          required: ["app"],
          additionalProperties: false,
        },
        async execute(raw) {
          return { content: await executeDesktop({ ...(raw as DesktopCommandInput), verb: "tree" }) }
        },
      })

      editor.add({
        name: "desktop_find",
        description:
          "Find elements in one GNOME application by accessible name and/or role as JSON, with traversal completeness. Read-only. Provide a name and/or role; multiple matches require an explicit nth.",
        input: {
          type: "object",
          properties: {
            ...MATCH_PROPERTIES,
            app: APP_PROPERTY,
            includeText: INCLUDE_TEXT_PROPERTY,
          },
          required: ["app"],
          additionalProperties: false,
        },
        async execute(raw) {
          return { content: await executeDesktop({ ...(raw as DesktopCommandInput), verb: "find" }) }
        },
      })

      editor.add({
        name: "desktop_act",
        description:
          "Invoke an accessibility action, move keyboard focus, or replace an editable field's text in a GNOME application over AT-SPI. Mutations are previews by default and return a short-lived target_token; call again with apply=true and that expectToken to execute, then verify the result with a fresh desktop screenshot. Protected password fields are refused.",
        input: {
          type: "object",
          properties: {
            verb: {
              type: "string",
              enum: ["action", "focus", "set-text"],
              description: "action: invoke an advertised action; focus: move keyboard focus; set-text: replace field text",
            },
            app: APP_PROPERTY,
            name: NAME_PROPERTY,
            exactName: { type: "boolean", description: "Match the accessible name exactly" },
            role: ROLE_PROPERTY,
            showing: SHOWING_PROPERTY,
            nth: NTH_PROPERTY,
            maxDepth: MAX_DEPTH_PROPERTY,
            maxNodes: MAX_NODES_PROPERTY,
            action: { type: "string", description: "Action to invoke for verb=action (default: click)" },
            text: { type: "string", description: "Text to write for verb=set-text" },
            waitSeconds: {
              type: "number",
              exclusiveMinimum: 0,
              description: "Seconds to wait for focus or readback with verb=focus or set-text (default 2)",
            },
            apply: {
              type: "boolean",
              description: "Execute the mutation instead of previewing it; requires expectToken",
            },
            expectToken: {
              type: "string",
              description: "target_token returned by the immediately preceding preview call",
            },
          },
          required: ["verb", "app"],
          additionalProperties: false,
        },
        async execute(raw) {
          return { content: await executeDesktop(raw as DesktopCommandInput) }
        },
      })

      editor.add({
        name: "vision_capture",
        description:
          "Capture a GNOME screenshot and return it as an image attachment. Announce the capture to the user before calling this tool, and never call it while a password, MFA, payment, or PolicyKit dialog is open. mode=screen captures the full desktop; mode=window captures the active window. The tool triggers the trusted screenshot shortcut through the private ydotool service, waits for exactly one new PNG, returns it, and deletes the file. If ydotool is unavailable, ask the user to press PrintScreen instead.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["screen", "window"],
              description: "screen captures the full desktop (default); window captures the active window",
            },
          },
          additionalProperties: false,
        },
        async execute(raw) {
          const mode: CaptureMode = (raw as { mode?: CaptureMode }).mode === "window" ? "window" : "screen"
          const captured = await captureScreenshot(mode)
          if (!captured.ok) return { content: captured.message }

          const size = `${Math.round(captured.bytes.length / 1024)} KiB`
          const shape = captured.dimensions ? `${captured.dimensions.width}x${captured.dimensions.height}, ` : ""
          return {
            content: [
              {
                type: "text" as const,
                text: `Captured the ${mode === "window" ? "active window" : "full desktop"} (${shape}${size}). The file was deleted after reading.`,
              },
              {
                type: "file" as const,
                uri: pngDataUri(captured.bytes),
                mime: "image/png",
                name: "screenshot.png",
              },
            ],
          }
        },
      })
    })
  },
})
