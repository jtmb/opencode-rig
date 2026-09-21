import { Rpc } from "@opencode/plugin"

export type RepoLearningInput = { sessionID: string; command: string }
export type RepoLearningOutput = { text: string }

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
  },
  events: {},
})
