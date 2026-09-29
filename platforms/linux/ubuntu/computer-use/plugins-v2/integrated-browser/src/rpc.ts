import { Rpc } from "@opencode/plugin"

import {
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_TEXT,
  MAX_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_CHARS,
  MAX_TABS,
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
} from "./manager.ts"

const SESSION_INPUT = { type: "string", maxLength: 128 } as const
const TAB_INPUT = { type: "string", maxLength: 32 } as const
const URL_INPUT = { type: "string", minLength: 1, maxLength: MAX_URL_LENGTH } as const
const ROLE_INPUT = { type: "string", maxLength: 32 } as const
const NAME_INPUT = { type: "string", maxLength: 256 } as const

const TAB_SCHEMA = {
  type: "object",
  properties: {
    id: TAB_INPUT,
    url: { type: "string", maxLength: MAX_URL_LENGTH },
    title: { type: "string", maxLength: MAX_TEXT_LENGTH },
    loading: { type: "boolean" },
  },
  required: ["id", "url", "title", "loading"],
  additionalProperties: false,
} as const

export const BROWSER_STATUS_SCHEMA = {
  type: "object",
  properties: {
    sessionID: SESSION_INPUT,
    state: { type: "string", enum: ["stopped", "starting", "ready", "error"] },
    tabs: { type: "array", maxItems: MAX_TABS, items: TAB_SCHEMA },
    currentTabID: TAB_INPUT,
    viewport: {
      type: "object",
      properties: { width: { type: "integer", minimum: 320, maximum: 1920 }, height: { type: "integer", minimum: 240, maximum: 1080 } },
      required: ["width", "height"],
      additionalProperties: false,
    },
    error: { type: "string", maxLength: 512 },
  },
  required: ["sessionID", "state", "tabs", "viewport"],
  additionalProperties: false,
} as const

const SESSION_ONLY = {
  input: { type: "object", properties: { sessionID: SESSION_INPUT }, required: ["sessionID"], additionalProperties: false },
  output: BROWSER_STATUS_SCHEMA,
} as const

const SESSION_TAB = {
  input: {
    type: "object",
    properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT },
    required: ["sessionID", "tabID"],
    additionalProperties: false,
  },
  output: BROWSER_STATUS_SCHEMA,
} as const

const PAGE_RESULT = {
  type: "object",
  properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT },
  required: ["sessionID", "tabID"],
  additionalProperties: false,
} as const

export const IntegratedBrowser = Rpc.define({
  id: "opencode-rig.integrated-browser",
  methods: {
    status: SESSION_ONLY,
    launch: {
      input: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, url: URL_INPUT },
        required: ["sessionID", "url"],
        additionalProperties: false,
      },
      output: BROWSER_STATUS_SCHEMA,
    },
    close: SESSION_ONLY,
    navigate: {
      input: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, url: URL_INPUT, tabID: TAB_INPUT },
        required: ["sessionID", "url"],
        additionalProperties: false,
      },
      output: BROWSER_STATUS_SCHEMA,
    },
    newTab: {
      input: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, url: URL_INPUT },
        required: ["sessionID", "url"],
        additionalProperties: false,
      },
      output: BROWSER_STATUS_SCHEMA,
    },
    selectTab: SESSION_TAB,
    closeTab: SESSION_TAB,
    back: {
      input: { type: "object", properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT }, required: ["sessionID"], additionalProperties: false },
      output: BROWSER_STATUS_SCHEMA,
    },
    forward: {
      input: { type: "object", properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT }, required: ["sessionID"], additionalProperties: false },
      output: BROWSER_STATUS_SCHEMA,
    },
    reload: {
      input: { type: "object", properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT }, required: ["sessionID"], additionalProperties: false },
      output: BROWSER_STATUS_SCHEMA,
    },
    snapshot: {
      input: { type: "object", properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT }, required: ["sessionID"], additionalProperties: false },
      output: {
        type: "object",
        properties: { ...PAGE_RESULT.properties, text: { type: "string", maxLength: MAX_SNAPSHOT_CHARS } },
        required: ["sessionID", "tabID", "text"],
        additionalProperties: false,
      },
    },
    console: {
      input: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT, maxEntries: { type: "integer", minimum: 1, maximum: MAX_CONSOLE_ENTRIES } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ...PAGE_RESULT.properties,
          entries: {
            type: "array",
            maxItems: MAX_CONSOLE_ENTRIES,
            items: {
              type: "object",
              properties: { type: { type: "string", maxLength: 32 }, text: { type: "string", maxLength: MAX_CONSOLE_TEXT } },
              required: ["type", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessionID", "tabID", "entries"],
        additionalProperties: false,
      },
    },
    screenshot: {
      input: { type: "object", properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT }, required: ["sessionID"], additionalProperties: false },
      output: {
        type: "object",
        properties: { ...PAGE_RESULT.properties, mimeType: { type: "string", enum: ["image/jpeg"] }, data: { type: "string", maxLength: MAX_SCREENSHOT_BYTES * 2 } },
        required: ["sessionID", "tabID", "mimeType", "data"],
        additionalProperties: false,
      },
    },
    viewport: {
      input: {
        type: "object",
        properties: {
          sessionID: SESSION_INPUT,
          tabID: TAB_INPUT,
          width: { type: "integer", minimum: 320, maximum: 1920 },
          height: { type: "integer", minimum: 240, maximum: 1080 },
        },
        required: ["sessionID", "width", "height"],
        additionalProperties: false,
      },
      output: BROWSER_STATUS_SCHEMA,
    },
    click: {
      input: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT, role: ROLE_INPUT, name: NAME_INPUT, exact: { type: "boolean" }, nth: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["sessionID", "role", "name"],
        additionalProperties: false,
      },
      output: BROWSER_STATUS_SCHEMA,
    },
    fill: {
      input: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, tabID: TAB_INPUT, role: ROLE_INPUT, name: NAME_INPUT, value: { type: "string", maxLength: MAX_TEXT_LENGTH }, exact: { type: "boolean" }, nth: { type: "integer", minimum: 1, maximum: 100 } },
        required: ["sessionID", "role", "name", "value"],
        additionalProperties: false,
      },
      output: BROWSER_STATUS_SCHEMA,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: SESSION_INPUT, state: { type: "string", enum: ["stopped", "starting", "ready", "error"] } },
        required: ["sessionID", "state"],
        additionalProperties: false,
      },
    },
  },
})
