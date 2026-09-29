import { Rpc } from "@opencode/plugin"

import { HERMES_HOOK_EVENT_LIMIT, HERMES_HOOK_NAMES, type HermesHookSnapshot } from "./hermes-hooks-snapshot.ts"

const hookEventSchema = {
  type: "object",
  properties: {
    at: { type: "string", maxLength: 40 },
    hook: { type: "string", enum: [...HERMES_HOOK_NAMES] },
    status: { type: "string", enum: ["started", "ok", "error", "blocked", "cancelled", "completed", "interrupted", "unknown"] },
    durationMs: { type: "integer", minimum: 0, maximum: 3_600_000 },
    model: { type: "string", maxLength: 64 },
    provider: { type: "string", maxLength: 64 },
    tool: { type: "string", maxLength: 64 },
    auxTask: { type: "string", maxLength: 64 },
    surface: { type: "string", maxLength: 64 },
    sessionRef: { type: "string", maxLength: 12 },
    turnRef: { type: "string", maxLength: 12 },
    requestRef: { type: "string", maxLength: 12 },
    toolRef: { type: "string", maxLength: 12 },
  },
  required: ["at", "hook", "status"],
  additionalProperties: false,
} as const

export const hermesHookSnapshotSchema = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    state: { type: "string", enum: ["ready", "empty", "unavailable", "invalid"] },
    updatedAt: { type: "string", maxLength: 40 },
    events: { type: "array", maxItems: HERMES_HOOK_EVENT_LIMIT, items: hookEventSchema },
  },
  required: ["schemaVersion", "state", "updatedAt", "events"],
  additionalProperties: false,
} as const

export const HermesHooks = Rpc.define({
  id: "opencode-rig.hermes-hooks",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: HERMES_HOOK_EVENT_LIMIT } },
        additionalProperties: false,
      },
      output: hermesHookSnapshotSchema,
    },
  },
  events: {
    updated: { schema: hermesHookSnapshotSchema },
  },
})

export type HermesHooksSnapshotOutput = HermesHookSnapshot
