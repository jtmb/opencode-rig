import { Rpc } from "@opencode/plugin"

export type RigToolsCatalogInput = { query: string }
export type RigToolsSessionContextInput = { sessionID: string; command: string }
export type RigToolsOutput = { text: string }
export type RigToolsManagedScreen = { name: string; state: string }
export type RigToolsManagedScreensOutput = { sessions: RigToolsManagedScreen[] }

export const MAX_MANAGED_SCREEN_ROWS = 8

const managedScreenSchema = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 64 },
    state: { type: "string", maxLength: 64 },
  },
  required: ["name", "state"],
  additionalProperties: false,
} as const

export const RigTools = Rpc.define({
  id: "opencode-rig.rig-tools",
  methods: {
    catalog: {
      input: {
        type: "object",
        properties: { query: { type: "string", maxLength: 128 } },
        required: ["query"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string", maxLength: 32_768 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    sessionContext: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: 128 },
          command: { type: "string", maxLength: 256 },
        },
        required: ["sessionID", "command"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string", maxLength: 65_536 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    managedScreens: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            maxItems: MAX_MANAGED_SCREEN_ROWS,
            items: managedScreenSchema,
          },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
  },
  events: {
    managedScreensChanged: {
      schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
})
