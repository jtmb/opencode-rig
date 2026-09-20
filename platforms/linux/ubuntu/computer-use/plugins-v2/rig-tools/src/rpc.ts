import { Rpc } from "@opencode/plugin"

export type RigToolsCatalogInput = { query: string }
export type RigToolsSessionContextInput = { sessionID: string; command: string }
export type RigToolsOutput = { text: string }

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
  },
  events: {},
})
