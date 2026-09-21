import { Rpc } from "@opencode/plugin"

export type WslInteropOutput = { text: string }

export const WslInteropRpc = Rpc.define({
  id: "opencode-rig.wsl2.interop",
  methods: {
    status: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string", maxLength: 65_536 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    powershellStatus: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string", maxLength: 32_768 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
