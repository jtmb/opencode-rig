import { Rpc } from "@opencode/plugin"

export type RepoLearningInput = { sessionID: string; command: string }
export type RepoLearningOutput = { text: string }
export type RepoLearningCompletionInput = { sessionID: string }
export type RepoLearningCompletionOutput = {
  enabled: boolean
  ready: boolean
  required: number
  receipted: number
  missingObligationIDs: string[]
  conflictObligationIDs: string[]
}

export const RepoLearning = Rpc.define({
  id: "opencode-rig.repo-learning",
  methods: {
    learn: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: 128 },
          command: { type: "string", maxLength: 512 },
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
    checkTaskCompletion: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", maxLength: 128 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          ready: { type: "boolean" },
          required: { type: "integer", minimum: 0 },
          receipted: { type: "integer", minimum: 0 },
          missingObligationIDs: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 200 },
          conflictObligationIDs: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 200 },
        },
        required: ["enabled", "ready", "required", "receipted", "missingObligationIDs", "conflictObligationIDs"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
