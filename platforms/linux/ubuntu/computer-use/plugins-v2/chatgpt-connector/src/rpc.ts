import { Rpc } from "@opencode/plugin"

export const MAX_RESULT_TEXT = 32_000
export const MAX_IMAGE_BASE64 = 16_000_000
export const MAX_RESULT_SOURCES = 20

export type ChatGPTAction = "generate_image" | "web_search" | "chat"
export type ChatGPTMode = "quick" | "research"

export type ChatGPTInput = {
  action: ChatGPTAction
  sessionID: string
  prompt?: string
  query?: string
  mode?: ChatGPTMode
  projectDirectory?: string
}

export type ChatGPTSource = { title: string; url: string }

export type ChatGPTResult = {
  text: string
  imageBase64?: string
  sources?: ChatGPTSource[]
  searchPerformed?: boolean
}

export const ChatGPT = Rpc.define({
  id: "chatgpt",
  methods: {
    execute: {
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["generate_image", "web_search", "chat"] },
          sessionID: { type: "string", minLength: 5, maxLength: 128, pattern: "^ses_[A-Za-z0-9]+$" },
          prompt: { type: "string", maxLength: 8192 },
          query: { type: "string", maxLength: 2048 },
          mode: { type: "string", enum: ["quick", "research"] },
          projectDirectory: { type: "string", maxLength: 4096 },
        },
        required: ["action", "sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string", maxLength: MAX_RESULT_TEXT },
          imageBase64: { type: "string", maxLength: MAX_IMAGE_BASE64 },
          sources: {
            type: "array",
            maxItems: MAX_RESULT_SOURCES,
            items: {
              type: "object",
              properties: {
                title: { type: "string", maxLength: 512 },
                url: { type: "string", maxLength: 2048 },
              },
              required: ["title", "url"],
              additionalProperties: false,
            },
          },
          searchPerformed: { type: "boolean" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
