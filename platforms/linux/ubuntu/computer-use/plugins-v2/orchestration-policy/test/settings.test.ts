import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_ENFORCEMENTS,
  parseEnforcementSettings,
  serializeEnforcementSettings,
} from "../src/settings.ts"

// The six enforcements that existed before `requireTodoDispatch` was added.
const LEGACY_NAMES = [
  "requireTaskDeclare",
  "strictShellClassification",
  "parentDelegationOnly",
  "backgroundChildrenOnly",
  "correctionLedgers",
  "memoryReconciliation",
] as const

function canonical(names: readonly string[], values: Record<string, boolean>, mode?: string) {
  const enforcements = Object.fromEntries(names.map((name) => [name, values[name]]))
  return `${JSON.stringify({ schemaVersion: 1, enforcements, ...(mode ? { orchestrationMode: mode } : {}) }, null, 2)}\n`
}

test("a legacy settings file missing a later-added enforcement defaults it fail-closed", () => {
  const text = canonical(LEGACY_NAMES, { ...DEFAULT_ENFORCEMENTS })
  const parsed = parseEnforcementSettings(text)
  assert.deepEqual(parsed, DEFAULT_ENFORCEMENTS)
  assert.equal(parsed.requireTodoDispatch, true)
})

test("the current schema round-trips an explicit OFF value", () => {
  const text = serializeEnforcementSettings({ ...DEFAULT_ENFORCEMENTS, requireTodoDispatch: false })
  assert.deepEqual(parseEnforcementSettings(text), { ...DEFAULT_ENFORCEMENTS, requireTodoDispatch: false })
})

test("the parser still rejects unknown fields and non-canonical formatting", () => {
  const text = serializeEnforcementSettings({ ...DEFAULT_ENFORCEMENTS, requireTodoDispatch: false })
  assert.throws(() => parseEnforcementSettings(text.replace('"requireTodoDispatch": false', '"bogus": false')), /schema is invalid/)
  assert.throws(() => parseEnforcementSettings(text.replace(/\n/g, "")), /canonical JSON/)
})
