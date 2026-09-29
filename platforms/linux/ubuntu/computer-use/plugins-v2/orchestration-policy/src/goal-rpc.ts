import { Rpc } from "@opencode/plugin"
import type { GoalHandoffMode, GoalStatus } from "./goal.ts"

export type GoalRpcCommandInput = {
  sessionID: string
  command: string
}

export type GoalRpcCommandOutput = { text: string; cancelInboxID?: string }
export type GoalRpcStateOutput = {
  status: GoalStatus
  handoff: GoalHandoffMode
  objective?: string
}

export const GoalRpc = Rpc.define({
  id: "opencode-rig.orchestration-goal",
  methods: {
    command: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1, maxLength: 128 },
          command: { type: "string", maxLength: 2_048 },
        },
        required: ["sessionID", "command"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: 65_536 },
          cancelInboxID: { type: "string", maxLength: 128 },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    state: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["awaiting-plan", "awaiting-build", "active", "paused", "blocked", "complete", "cleared", "corrupt"] },
          handoff: { type: "string", enum: ["manual", "auto"] },
          objective: { type: "string", maxLength: 2_000 },
        },
        required: ["status", "handoff"],
        additionalProperties: false,
      },
    },
    toggleHandoff: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["awaiting-plan", "awaiting-build", "active", "paused", "blocked", "complete", "cleared", "corrupt"] },
          handoff: { type: "string", enum: ["manual", "auto"] },
          objective: { type: "string", maxLength: 2_000 },
        },
        required: ["status", "handoff"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})
